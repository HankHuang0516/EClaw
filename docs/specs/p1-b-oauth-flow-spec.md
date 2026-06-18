# P1-B: OAuth Flow — System Browser + Loopback + PKCE Token Exchange

> **狀態**: v0.1 (2026-06-18) · **作者**: Mac_C #4 · **審查者**: LOBSTER #2
> **依賴卡**: `card_dd7e7e3a9d3056df71f1aca3` · **上游**: Phase 1 Core Spec §2 + ADR-001 §OAuth

---

## 1. 目標

實作 **Authorization Code + PKCE（S256）** OAuth flow，讓用戶透過系統瀏覽器完成 Google 登入，並將 tokens 存放至 OS Credential Store（P1-C）。

重點：
- PKCE 防範 authorization code 攔截攻擊
- System browser（不走 WebView）確保 credentials 不進 renderer
- Loopback redirect（`127.0.0.1:<port>/callback`）接收 auth code
- Tokens **只能**寫入 OS Credential Store，renderer 永遠拿不到 refresh token

---

## 2. OAuth 流程詳細設計

### 2.1 PKCE 參數生成

```rust
// 在 Rust command: oauth_start() 中執行
use rand::Rng;
use sha2::{Sha256, Digest};

fn generate_pkce_pair() -> (code_verifier: String, code_challenge: String) {
    // code_verifier: 43-128 chars random URL-safe Base64
    let verifier_bytes: Vec<u8> = (0..64).map(|_| rand::thread_rng().gen()).collect();
    let code_verifier = base64_url::encode(&verifier_bytes);

    // code_challenge: BASE64URL(SHA256(code_verifier))
    let mut hasher = Sha256::new();
    hasher.update(code_verifier.as_bytes());
    let hash = hasher.finalize();
    let code_challenge = base64_url::encode(&hash);

    (code_verifier, code_challenge)
}
```

### 2.2 State + Nonce

```rust
fn generate_state() -> String {
    // 32 bytes random, base64url encoded
    let bytes: [u8; 32] = rand::thread_rng().gen();
    base64_url::encode(&bytes)
}

fn generate_nonce() -> String {
    // 16 bytes random, base64url encoded
    let bytes: [u8; 16] = rand::thread_rng().gen();
    base64_url::encode(&bytes)
}
```

### 2.3 Authorization URL 建構

```
https://accounts.google.com/o/oauth2/v2/auth?
  client_id={GOOGLE_CLIENT_ID}
  &redirect_uri=http://127.0.0.1:{PORT}/callback
  &response_type=code
  &scope=openid%20profile%20email
  &code_challenge={CODE_CHALLENGE}
  &code_challenge_method=S256
  &state={STATE}
  &nonce={NONCE}
  &access_type=offline
  &prompt=consent
```

### 2.4 Loopback Listener

```rust
use std::net::TcpListener;

fn pick_available_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

fn start_callback_server(port: u16, state: String, code_verifier: String) {
    // Spawn async server on 127.0.0.1:port
    // Wait for GET /callback?code=XXX&state=YYY
    // Validate state → if mismatch, return error
    // Exchange code + verifier for tokens
    // Store tokens via credential_store() (P1-C)
    // Shutdown immediately after success or 60s timeout
}
```

### 2.5 Token Exchange

```rust
// POST https://oauth2.googleapis.com/token
// Content-Type: application/x-www-form-urlencoded
//
// grant_type=authorization_code
// &code={AUTH_CODE}
// &redirect_uri=http://127.0.0.1:{PORT}/callback
// &client_id={GOOGLE_CLIENT_ID}
// &code_verifier={CODE_VERIFIER}
//
```

Expected response:
```json
{
  "access_token": "...",
  "refresh_token": "...",
  "id_token": "...",
  "expires_in": 3599,
  "token_type": "Bearer"
}
```

### 2.6 Error Handling

| 場景 | 處理 |
|------|------|
| User closes browser before auth | Loopback listener timeout (60s) → return "cancelled" |
| State mismatch | Log error, return "invalid_state" |
| Nonce mismatch | Log error, return "invalid_nonce" |
| Token exchange network failure | Retry once after 5s, then return "network_error" |
| HTTP 400 on exchange | Return "invalid_code" |
| Any other error | Log redacted, return "auth_failed" |

---

## 3. Tauri Commands

### 3.1 `oauth_start`

```rust
#[command]
pub async fn oauth_start() -> Result<OAuthStartResult, String>
```

Returns:
```json
{
  "auth_url": "https://accounts.google.com/o/oauth2/v2/auth?...",
  "port": 48231,
  "state": "base64...",
  "code_verifier": "base64...",
  "nonce": "base64..."
}
```

Renderer opens `auth_url` in system browser via `tauri plugin shell`.

### 3.2 `oauth_exchange`

```rust
#[command]
pub async fn oauth_exchange(code: String, state: String) -> Result<(), OAuthError>
```

Called by the loopback server after intercepting the callback. Validates state, exchanges code for tokens, stores via `credential_store()`.

### 3.3 `oauth_cancel`

```rust
#[command]
pub async fn oauth_cancel() -> Result<(), String>
```

Cancels the ongoing OAuth flow (shuts down listener, clears in-memory state).

---

## 4. Rust Dependencies (Cargo.toml additions)

```toml
rand = "0.8"
sha2 = "0.10"
base64-url = "2"
reqwest = { version = "0.12", features = ["json"] }
tokio = { version = "1", features = ["full"] }
```

---

## 5. 前端呼叫介面（Renderer）

```typescript
async function startOAuth() {
  const { auth_url, port, state, code_verifier, nonce } =
    await window.__TAURI__.core.invoke<OAuthStartResult>("oauth_start");

  // Store state/nonce for callback validation
  sessionStorage.setItem("oauth_state", state);
  sessionStorage.setItem("oauth_nonce", nonce);
  sessionStorage.setItem("oauth_port", String(port));

  // Open system browser
  await window.__TAURI__.shell.open(auth_url);
}
```

**重要**：`sessionStorage` 只存 state/nonce（非 tokens），callback 時比對用。

---

## 6. Security Requirements

- [ ] `code_verifier` 只在記憶體中，never persisted to disk
- [ ] Loopback listener 只監聽 `127.0.0.1`，不監聽 `0.0.0.0`
- [ ] Listener timeout 60s，到期後自動 shutdown
- [ ] State + nonce 高熵隨機（≥32 bytes）
- [ ] Redirect URI 固定 `http://127.0.0.1:{port}/callback`，port 每次隨機
- [ ] Authorization code 只可使用一次
- [ ] Renderer 從不接觸 refresh token

---

## 7. Google OAuth App 設定

| 設定項 | 值 |
|--------|-----|
| Application type | Desktop app (or Web application) |
| Authorized redirect URIs | `http://127.0.0.1/callback` |
| Scopes | `openid profile email` |
| Access type | Offline (to get refresh_token) |

Client ID / Client Secret 存放於 environment variables 或 CI secrets，not in source code.

---

## 8. i18n Strings

| Key | EN | ZH-TW |
|-----|-----|-------|
| oauth.title | Connecting to Google... | 正在連接到 Google... |
| oauth.success | Google sign-in complete! | Google 登入完成！ |
| oauth.cancelled | Sign-in was cancelled. | 登入已取消。 |
| oauth.error | Sign-in failed. Please try again. | 登入失敗，請重試。 |
| oauth.timeout | Sign-in timed out. Please try again. | 登入逾時，請重試。 |

---

## 9. Acceptance Criteria

- [ ] `oauth_start()` returns valid Google auth URL + port + state + verifier
- [ ] System browser opens to correct auth URL (visible in OS browser)
- [ ] Loopback listener starts on random available port
- [ ] Callback correctly intercepts `code` + `state`
- [ ] State mismatch is detected and rejected
- [ ] Token exchange returns access_token + refresh_token + id_token
- [ ] `credential_store()` is called with tokens (P1-C integration point)
- [ ] Listener shuts down immediately after successful exchange
- [ ] 60s timeout closes listener if no callback
- [ ] Renderer cannot read refresh_token
- [ ] `oauth_cancel()` cleanly shuts down listener
- [ ] i18n strings for all user-facing messages

---

## 10. Dependencies

- P1-A: Tauri scaffold (required)
- P1-C: `credential_store()` command must exist (can be stub that stores in-memory for testing)

---

## 11. Excluded

- Actual Google OAuth app registration (handled separately, in CI secrets)
- Token refresh logic (handled in P1-D or P1-C when implementing refresh)
- Multi-account UI (Phase 2)
