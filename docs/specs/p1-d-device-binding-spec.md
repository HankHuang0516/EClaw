# P1-D: Device Binding API 對接

## 目標

在 OAuth 成功後，將 EClaw Desktop 安裝實例註冊至 EClaw backend，取得永久 device credentials。

## 流程

```
OAuth success
  → desktop app calls POST /api/device/bind
  → backend returns { deviceId, deviceSecret, expiresAt? }
  → store deviceId + deviceSecret in OS Credential Store (Keychain/CredMgr)
  → subsequent API calls use device credentials
```

## API Contract

### Request

```
POST /api/device/bind
Content-Type: application/json
Authorization: Bearer <id_token from OAuth>

{
  "installId": "uuid-v4",
  "platform": "darwin|win32",
  "version": "x.y.z",
  "displayName": "EClaw Desktop on <hostname>"
}
```

### Response

```json
{
  "deviceId": "dev_..." ,
  "deviceSecret": "ds_..." ,
  "expiresAt": 1735689600
}
```

### Error Handling

| Status | Meaning | Action |
|--------|---------|--------|
| 200 | Bind success | Store credentials, proceed |
| 401 | id_token invalid/expired | Re-run OAuth |
| 409 | installId already bound | Use existing deviceId, rotate secret |
| 5xx | Server error | Retry with backoff, show warning |

## Rust Command

```rust
#[command]
pub async fn device_bind(
    id_token: String,
    install_id: String,
) -> Result<DeviceBindResult, String>;
```

`device_bind` call sequence:
1. Call `POST /api/device/bind` with id_token
2. On success, call `credential_store_device(device_id, device_secret)` → store in OS Keychain/CredMgr
3. Return `DeviceBindResult { device_id, expires_at }`

## Out of Scope

- Device re-binding (device re-install flow) — Phase 2
- Device revocation — Phase 2

## Acceptance Criteria

- [ ] `device_bind` command calls backend `/api/device/bind`
- [ ] `device_id` + `device_secret` stored in OS credential store (Keychain/CredMgr)
- [ ] `device_id` retrievable via `device_id_get`
- [ ] Binding fails gracefully if id_token is expired (re-OAuth prompt)
