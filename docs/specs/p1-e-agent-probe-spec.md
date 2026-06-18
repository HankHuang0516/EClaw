# P1-E: Agent Probe Mechanism

> **狀態**: v0.1 (2026-06-18) · **作者**: Mac_C #4 · **審查者**: LOBSTER #2
> **依賴卡**: `card_630f5575ed11a8bc35a04e0f` · **上游**: Phase 1 Core Spec §3

---

## 1. 目標

實作本地 Agent 自動探測機制，支援四種 Agent 類型：
- **Hermes**: EClaw 核心服務（HTTP /api/whoami）
- **Codex**: Anthropic Claude CLI（`claude --version` subprocess）
- **HTTP**: 已知的 HTTP agent（HTTP HEAD with `X-EClaw-Agent` header）
- **Subprocess**: 自訂命令 + stdout JSON handshake

核心原則：**探測不改變任何配置，只做唯讀識別。**

---

## 2. Agent 類型詳細設計

### 2.1 Hermes Agent

```
識別方式: HTTP GET http://localhost:18792/api/whoami
         Authorization: Bearer {access_token_from_credential}
預期回應:
{
  "entityId": "entity_5",
  "deviceId": "...",
  "version": "1.x.x"
}
```

```rust
async fn probe_hermes(url: &str, token: Option<&str>) -> Result<AgentInfo, ProbeError> {
    let client = reqwest::Client::new();
    let mut req = client.get(format!("{}/api/whoami", url));
    if let Some(t) = token {
        req = req.header("Authorization", format!("Bearer {}", t));
    }

    let resp = req.send().await?;
    let body: serde_json::Value = resp.json().await?;

    Ok(AgentInfo {
        agent_type: "hermes".to_string(),
        name: "EClaw Hermes".to_string(),
        version: body.get("version").and_then(|v| v.as_str()).map(String::from),
        endpoint: Some(url.to_string()),
        health: Some("ok".to_string()),
    })
}
```

### 2.2 Codex Agent

```
識別方式: subprocess spawn "claude --version"
預期 stdout: "Claude ai-4.20250618..."
         OR "claude version 1.0.0..."
```

**重要安全紅旗**：嚴禁 `claude --print-password` 或任何讀取憑證的命令。只用 `--version` 做身份識別。

```rust
async fn probe_codex(command: &str) -> Result<AgentInfo, ProbeError> {
    use std::process::Command;

    let output = Command::new(command)
        .arg("--version")
        .output()
        .await
        .map_err(|e| ProbeError::NotFound)?;

    if !output.status.success() {
        return Err(ProbeError::NotFound);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let version = stdout.trim().to_string();

    Ok(AgentInfo {
        agent_type: "codex".to_string(),
        name: "EClaw Codex".to_string(),
        version: Some(version),
        endpoint: Some(command.to_string()),
        health: Some("ok".to_string()),
    })
}
```

### 2.3 HTTP Agent

```
識別方式: HTTP HEAD http://{host}:{port}/
預期 header: X-EClaw-Agent: EClaw/1.x.x
```

```rust
async fn probe_http_agent(host: &str, port: u16) -> Result<AgentInfo, ProbeError> {
    let url = format!("http://{}:{}/", host, port);
    let client = reqwest::Client::new();

    let resp = client.head(&url).send().await?;
    let agent_header = resp.headers()
        .get("X-EClaw-Agent")
        .and_then(|v| v.to_str().ok());

    match agent_header {
        Some(header) => {
            Ok(AgentInfo {
                agent_type: "http".to_string(),
                name: header.to_string(),
                version: None,
                endpoint: Some(url),
                health: Some("ok".to_string()),
            })
        }
        None => Err(ProbeError::NotFound),
    }
}
```

### 2.4 Subprocess Agent

```
識別方式: spawn {command} {argv...}
預期 stdout: JSON { "name": "...", "version": "...", "type": "..." }
```

```rust
async fn probe_subprocess(command: &str, args: Vec<String>) -> Result<AgentInfo, ProbeError> {
    use std::process::Command;

    let output = Command::new(command)
        .args(&args)
        .output()
        .await
        .map_err(|_| ProbeError::NotFound)?;

    if !output.status.success() {
        return Err(ProbeError::NotFound);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let body: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|_| ProbeError::InvalidResponse)?;

    Ok(AgentInfo {
        agent_type: body.get("type").and_then(|v| v.as_str()).unwrap_or("subprocess").to_string(),
        name: body.get("name").and_then(|v| v.as_str()).unwrap_or("Unknown").to_string(),
        version: body.get("version").and_then(|v| v.as_str()).map(String::from),
        endpoint: Some(format!("{} {}", command, args.join(" "))),
        health: Some("ok".to_string()),
    })
}
```

---

## 3. 配置端點清單

Endpoints stored in `~/.eclaw-desktop/config.json`:

```json
{
  "endpoints": [
    { "type": "hermes", "url": "http://localhost:18792", "enabled": true },
    { "type": "codex", "command": "claude", "enabled": true },
    { "type": "http", "host": "localhost", "port": 8080, "enabled": false },
    { "type": "subprocess", "command": "/usr/local/bin/eclaw-agent", "argv": ["--probe"], "enabled": false }
  ]
}
```

---

## 4. Tauri Commands

### 4.1 `agent_probe`

```rust
#[command]
pub async fn agent_probe() -> Result<Vec<AgentInfo>, String>
```

Runs all enabled probes in parallel (via `tokio::task::join_all`). Returns deduplicated list.

### 4.2 `agent_probe_single`

```rust
#[command]
pub async fn agent_probe_single(
    agent_type: String,
    url: Option<String>,
    command: Option<String>,
    host: Option<String>,
    port: Option<u16>,
) -> Result<AgentInfo, String>
```

Probes a single configured endpoint. Used by renderer to refresh a specific agent.

### 4.3 `agent_config_get`

```rust
#[command]
pub fn agent_config_get() -> Result<Vec<AgentEndpointConfig>, String>
```

Returns the full `endpoints` list from config.

### 4.4 `agent_config_set`

```rust
#[command]
pub fn agent_config_set(endpoints: Vec<AgentEndpointConfig>) -> Result<(), String>
```

Updates the `endpoints` list in config. **Does not write to Keychain** — just config.

---

## 5. Deduplication Logic

If the same agent is reachable via multiple paths (e.g., Hermes at localhost:18792 AND as HTTP on same port), show only one entry with priority: `hermes > http > codex > subprocess`.

```rust
fn deduplicate(agents: Vec<AgentInfo>) -> Vec<AgentInfo> {
    let priority = |t: &str| match t {
        "hermes" => 0,
        "http" => 1,
        "codex" => 2,
        "subprocess" => 3,
        _ => 4,
    };

    let mut seen: HashMap<String, AgentInfo> = HashMap::new();
    for mut agent in agents {
        let key = format!("{}:{}", agent.agent_type, agent.endpoint.as_ref().unwrap_or(&"".to_string()));
        let entry = seen.entry(key).or_insert(agent.clone());
        if priority(&agent.agent_type) < priority(&entry.agent_type) {
            *entry = agent;
        }
    }
    seen.into_values().collect()
}
```

---

## 6. 前端 Renderer 介面

```typescript
interface AgentInfo {
  agent_type: string;
  name: string;
  version: string | null;
  endpoint: string | null;
  health: string | null;
}

async function probeAgents(): Promise<AgentInfo[]> {
  return await window.__TAURI__.core.invoke<AgentInfo[]>("agent_probe");
}
```

---

## 7. Error Handling

| 場景 | 結果 |
|------|------|
| Agent not found | 不顯示（不當錯誤）|
| Network timeout | health = "timeout" |
| HTTP error | health = "error: {status}" |
| Invalid JSON response | health = "invalid_response" |
| Process not found | 不顯示 |

Probe 失敗的 endpoint **不阻擋流程**，只顯示 warning badge。

---

## 8. Rust Dependencies (Cargo.toml additions)

```toml
reqwest = { version = "0.12", features = ["json"] }
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

Already included from P1-A: `tauri`, `tokio`.

---

## 9. Acceptance Criteria

- [ ] `agent_probe()` returns Hermes / Codex / HTTP / Subprocess agents found
- [ ] Unknown or unreachable agents do not appear in results (not errors)
- [ ] Deduplication: same agent reachable via multiple paths → one entry
- [ ] Probe is read-only: no config written during probe
- [ ] Probe errors shown as warning badges, not blocking
- [ ] `agent_config_get()` returns configured endpoints list
- [ ] `agent_config_set()` updates config without touching tokens
- [ ] Health includes latency or HTTP status where applicable
- [ ] `claude --version` used for Codex (NOT `--print-password` or any credential access)
- [ ] All probes run in parallel (non-blocking UI)

---

## 10. Dependencies

- P1-A: Tauri scaffold + command registration (required)
- P1-C: `install_id_get()` for credential access (needed for Hermes Bearer token)

---

## 11. Excluded

- Actual agent binding/config mutation — handled by P1-D (Device Binding)
- Multi-agent simultaneous binding — Phase 2
- Automatic endpoint discovery (mDNS / bonjour) — Phase 2
- Non-EClaw agents — out of scope
