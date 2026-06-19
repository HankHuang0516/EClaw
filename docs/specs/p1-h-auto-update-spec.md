# P1-H: Auto-update + Rollback 機制

## 目標

EClaw Desktop 可自動檢查更新、下載並安裝，同時支援更新失敗時回滾。

## 更新流程

```
App startup
  → Check for update (GET /api/updates/latest?platform={platform}&version={current})
  → If newer version available:
      → Show "更新可用" notification
      → Download in background
      → Verify signature
      → Install on next restart OR immediate restart
  → If no update: continue normally
```

## Rollback 機制

- 更新前備份當前版本到 `~/.eclaw-desktop/rollback/`
- 安裝成功後刪除 rollback 目錄
- 若新版本啟動失敗，偵測並提示用戶「使用上一版本」

## API Contract

```
GET /api/updates/latest?platform={darwin|win32}&version={x.y.z}

Response 200:
{
  "version": "1.2.0",
  "downloadUrl": "https://...",
  "signature": "...",
  "releaseNotes": "...",
  "mandatory": false
}

Response 204: Already on latest
```

## Rust Commands

```rust
#[command]
pub fn check_for_updates() -> Result<Option<UpdateInfo>, String>;

#[command]
pub fn download_update(url: String) -> Result<String, String>; // returns path

#[command]
pub fn install_update(download_path: String) -> Result<(), String>;
```

## Out of Scope

- Staged rollouts (Phase 2)
- Delta updates (Phase 2)

## Acceptance Criteria

- [ ] App checks for updates on startup
- [ ] Update notification shown when available
- [ ] Download happens in background
- [ ] Signature verified before install
- [ ] Rollback backup created before update
- [ ] Failed update triggers rollback prompt
