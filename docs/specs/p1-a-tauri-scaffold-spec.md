# P1-A: Tauri 2 Scaffold + 本地 UI Bundle

> **狀態**: v0.1 (2026-06-18) · **作者**: Mac_C #4 · **審查者**: LOBSTER #2
> **依賴卡**: `card_384e86ee07b38cca3d29c6a9` · **上游**: Phase 1 Core Spec §1-2

---

## 1. 目標

建立 EClaw Desktop 的 Tauri 2 專案骨架，提供：
- 可在本機啟動的空白 window（無遠程內容）
- Rust command layer 框架（placeholder commands，未實作具體業務）
- CSP 鎖死的 WebView（不允許載入遠程 JS/CSS）
- 基本 window 管理

這是 Phase 1 所有其餘子卡（P1-B/C/D/E/F/G/H/I）的基礎設施。

---

## 2. 專案初始化

### 2.1 初始化指令

```bash
npm create tauri-app@latest eclaw-desktop -- --template vanilla-ts --manager npm
cd eclaw-desktop
```

### 2.2 目錄結構

```
eclaw-desktop/
├── src/                      # WebView 前端（TypeScript/HTML/CSS）
│   ├── main.ts               # 入口
│   ├── styles.css            # 樣式
│   ├── index.html            # 殼層 HTML
│   └── lib/                  # 本地 UI 組件
├── src-tauri/                # Rust 後端
│   ├── src/
│   │   ├── main.rs           # 入口（已生成）
│   │   └── lib.rs            # Tauri command 模組（新增）
│   ├── Cargo.toml            # Rust 依賴（新增 keyring / reqwest / tokio）
│   ├── tauri.conf.json       # Tauri 配置（修改 window / CSP / permissions）
│   └── capabilities/         # Tauri 2 capabilities（新增）
├── package.json
└── tsconfig.json
```

### 2.3 關鍵 npm scripts

| script | 用途 |
|--------|------|
| `npm run tauri dev` | 本機 development 啟動 |
| `npm run tauri build` | Production build |
| `npm run tauri build -- --debug` | Debug build（包含 symbols） |

---

## 3. Tauri 配置（tauri.conf.json）

### 3.1 Window 設定

```json
{
  "productName": "EClaw Desktop",
  "identifier": "com.eclaw.desktop",
  "version": "0.1.0",
  "build": {
    "devtools": true
  },
  "app": {
    "withGlobalTauri": false,
    "security": {
      "assetProtocol": {
        "enable": false
      }
    },
    "windows": [
      {
        "title": "EClaw Desktop",
        "width": 480,
        "height": 640,
        "minWidth": 400,
        "minHeight": 500,
        "center": true,
        "resizable": true,
        "fullscreen": false,
        "decorations": true,
        "transparent": false
      }
    ]
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
}
```

**重要**：`devtools: true` 讓開發時可開 WebView inspector；production build 時由 CI gate 移除。

### 3.2 Capabilities 配置

Tauri 2 的權限需在 `src-tauri/capabilities/` 下宣告：

**`default.json`**：
```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Default capability for EClaw Desktop",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:window:allow-close",
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-set-title",
    "shell:allow-open"
  ]
}
```

---

## 4. CSP 嚴格化

### 4.1 WebView CSP Header

在 `src-tauri/src/lib.rs` 的 window 建立時設定 CSP：

```rust
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            window.eval(
                r#"document.querySelector('meta[http-equiv="Content-Security-Policy"]')"#,
            )?;
            // 強制 CSP：只允許本地 asset
            window.eval(
                r#"(function() {
                    var meta = document.createElement('meta');
                    meta.httpEquiv = 'Content-Security-Policy';
                    meta.content = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://eclawbot.com https://eclaw.up.railway.app";
                    document.head.appendChild(meta);
                })()"#,
            )?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**CSP 規則**：
- `default-src 'self'` — 預設只允許同源
- `script-src 'self'` — 禁止 inline script，禁止外部 JS
- `connect-src 'self' https://eclawbot.com https://eclaw.up.railway.app` — 允許連接 EClaw API（必要）
- `img-src 'self' data:` — 允許本地 data URI 圖片
- `style-src 'self' 'unsafe-inline'` — 允許 inline style（必要，框架標注）

### 4.2 assetProtocol 禁用

確保 `tauri.conf.json` 中 `app.security.assetProtocol.enable = false`，防止 WebView 載入遠程 HTML/JS。

---

## 5. Rust Command Layer 框架

### 5.1 初始 Command 結構

`src-tauri/src/lib.rs`：

```rust
use serde::{Deserialize, Serialize};
use tauri::command;

#[derive(Debug, Serialize, Deserialize)]
pub struct HealthStatus {
    pub app_version: String,
    pub platform: String,
    pub rust_version: String,
}

/// 健康檢查（mock）
#[command]
pub fn health_check() -> HealthStatus {
    HealthStatus {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        rust_version: rust_version::RUSTVERSION.to_string(),
    }
}

/// 存根：啟動 OAuth flow（P1-B 實作）
#[command]
pub async fn oauth_start() -> Result<String, String> {
    Err("P1-B not implemented".to_string())
}

/// 存根：讀取 credential（P1-C 實作）
#[command]
pub async fn credential_get() -> Result<Option<serde_json::Value>, String> {
    Err("P1-C not implemented".to_string())
}

/// 存根：Agent 探測（P1-E 實作）
#[command]
pub async fn agent_probe() -> Result<Vec<serde_json::Value>, String> {
    Err("P1-E not implemented".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            health_check,
            oauth_start,
            credential_get,
            agent_probe,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### 5.2 Cargo.toml 初始依賴

```toml
[package]
name = "eclaw-desktop"
version = "0.1.0"
edition = "2021"

[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
rustversion = "1"

[profile.release]
strip = true
lto = true
codegen-units = 1
panic = "abort"
```

---

## 6. 前端殼層（src/）

### 6.1 index.html

```html
<!doctype html>
<html lang="zh-TW">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://eclawbot.com https://eclaw.up.railway.app"
    />
    <title>EClaw Desktop</title>
  </head>
  <body>
    <div id="app">
      <h1>EClaw Desktop</h1>
      <p>載入中...</p>
    </div>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

### 6.2 main.ts

```typescript
import "./styles.css";

interface HealthStatus {
  app_version: string;
  platform: string;
  rust_version: string;
}

async function init() {
  const app = document.getElementById("app")!;
  try {
    const status: HealthStatus = await (window as any).__TAURI__.core.invoke("health_check");
    app.innerHTML = `
      <h1>EClaw Desktop</h1>
      <p>v${status.app_version} (${status.platform})</p>
      <p>Rust ${status.rust_version}</p>
      <button id="btn-oauth">開始設定</button>
    `;
    const btn = document.getElementById("btn-oauth");
    btn?.addEventListener("click", async () => {
      const result = await (window as any).__TAURI__.core.invoke("oauth_start");
      console.log("oauth_start:", result);
    });
  } catch (e) {
    app.innerHTML = `<h1>EClaw Desktop</h1><p>連接失敗：${e}</p>`;
  }
}

init();
```

### 6.3 styles.css

```css
* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #f7f7f7;
  color: #222;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
}

#app {
  background: white;
  border-radius: 12px;
  padding: 2rem;
  box-shadow: 0 2px 16px rgba(0, 0, 0, 0.1);
  width: 100%;
  max-width: 400px;
  text-align: center;
}

h1 {
  font-size: 1.25rem;
  margin-bottom: 0.5rem;
}

p {
  color: #666;
  margin-bottom: 1rem;
  font-size: 0.875rem;
}

button {
  background: #2563eb;
  color: white;
  border: none;
  padding: 0.75rem 1.5rem;
  border-radius: 8px;
  font-size: 1rem;
  cursor: pointer;
  width: 100%;
}

button:hover {
  background: #1d4ed8;
}
```

---

## 7. 環境要求

### 7.1 必要工具

| 工具 | 版本 | 用途 |
|------|------|------|
| Node.js | ≥ 20 | 前端 build |
| Rust | ≥ 1.75 | Tauri 2 需要 |
| cargo | (bundled with Rust) | Rust build |
| Xcode CLT | ≥ 15（macOS only） | macOS build |
| Visual Studio Build Tools | 2022（Windows only） | Windows build |

### 7.2 驗證腳本

```bash
#!/bin/bash
# scripts/verify-p1-a.sh

set -e

echo "=== P1-A Verification ==="

# 1. Check Rust version
rustc --version

# 2. Check Node version
node --version

# 3. Check tauri CLI
npm list -g @tauri-apps/cli || npm install -g @tauri-apps/cli

# 4. Run tauri build (dry-run / type-check only)
cd eclaw-desktop
npm install
npm run tauri build -- --debug 2>&1 | head -50

echo "=== Build artifacts ==="
ls -la src-tauri/target/debug/bundle/ 2>/dev/null || echo "No bundle yet"

echo "=== DONE ==="
```

---

## 8. 依賴順序

| 卡片 | 依賴 P1-A | 備註 |
|------|-----------|------|
| P1-B | ✅ | OAuth flow 需要 command layer |
| P1-C | ✅ | Credential store 需要 command layer |
| P1-D | ❌ | 依賴 P1-B |
| P1-E | ✅ | Agent probe 需要 command layer |
| P1-F | ❌ | 依賴 P1-B |
| P1-G | ✅ | Installer build 需要 scaffold |
| P1-H | ✅ | Auto-update 需要 scaffold |
| P1-I | ❌ | 依賴所有其餘卡片 |

---

## 9. Acceptance Criteria

- [ ] `npm create tauri-app` 成功，選擇 vanilla-ts template
- [ ] `npm run tauri dev` 本機可啟動，window 正常顯示
- [ ] `health_check` command 回傳 `{app_version, platform, rust_version}`
- [ ] WebView CSP 阻止 `script-src` 外部載入（可通過 WebView inspector 驗證 network tab）
- [ ] `assetProtocol` 為 disabled
- [ ] `window.eval()` 可正常執行（本質上就是這樣）
- [ ] macOS build (`npm run tauri build`) 產生 `.app` bundle
- [ ] Windows build 產生 `.exe`
- [ ] 前端 TypeScript 編譯無錯誤（`tsc --noEmit`）
- [ ] Rust 編譯無錯誤（`cargo check`）

---

## 10. 排除範圍

以下項目由對應子卡負責，不在本卡範圍：

| 排除項目 | 負責卡片 |
|----------|----------|
| OAuth flow（P1-B placeholder 返回 "P1-B not implemented"） | P1-B |
| Credential store（P1-C placeholder 返回 error） | P1-C |
| Agent probe（command 返回 error） | P1-E |
| 任何真實 API 調用 | P1-B/P1-D |
| UI 設計（只做殼層） | P1-F |
| Installer 簽名 | P1-G |
| 更新機制 | P1-H |

---

## 11. Review Checklist

- [ ] Tauri 2 使用的是 vanilla-ts template（不是 React/Vue/Svelte）
- [ ] CSP 明確鎖死 `script-src 'self'`，無 `unsafe-eval`
- [ ] `assetProtocol.enable = false`
- [ ] 所有 placeholder commands 在 lib.rs 中注册到 `invoke_handler`
- [ ] 前端只使用本地 TypeScript，無外部 CDN
- [ ] package.json 不含任何非 trusted CDN 依賴
- [ ] `devtools: true` 只在 build.devtools 中設定（非使用者面向）
- [ ] Rust edition 2021，MSRV ≥ 1.75
