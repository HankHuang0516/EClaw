# iOS 完整帳號系統實作計劃

> **建立日期**: 2026-04-14
> **方案**: C — Email + Sign in with Apple + Google + Facebook + 裝置認證並存
> **目的**: 取代現行純裝置認證，加入完整用戶帳號系統，達到 Web Portal feature parity，並滿足 Apple Review §4.8 規範
> **依據**: [ios-app-spec.md](../specs/ios-app-spec.md)、[backend/auth.js](../../backend/auth.js)、Apple HIG + Review Guidelines

---

## 背景

### 現況問題
iOS 目前是**純裝置認證**（`deviceId` + `deviceSecret` 存於 SecureStore），無用戶帳號概念。問題：
1. 換 iPhone → 資料全失
2. App 重裝 → 變新用戶
3. 無法與 Web Portal（email 帳號）互通
4. 審查員可能質疑「BRM 有餘額/合約，無帳號太不安全」

### 選擇方案 C 的理由
- 達成 Web Portal + iOS 完整 feature parity
- 滿足 Apple §4.8（**因為加了 Google/FB，必須同時有 Sign in with Apple**）
- 用戶可跨裝置同步錢包、合約、聊天記錄
- 既有用戶（純裝置認證）可平滑升級（綁定 email）

### 後端既有資源（無需新增）

| Endpoint | 用途 |
|---------|------|
| `POST /api/auth/register` | Email + 密碼註冊 |
| `POST /api/auth/login` | Email + 密碼登入 |
| `POST /api/auth/device-login` | 裝置認證登入（取 JWT） |
| `POST /api/auth/verify-email` | Email 驗證 |
| `POST /api/auth/forgot-password` | 忘記密碼 |
| `POST /api/auth/reset-password` | 重設密碼 |
| `POST /api/auth/bind-email` | 將 email 綁定到現有裝置帳號 |
| `POST /api/auth/oauth/google` | Google OAuth 交換 JWT |
| `POST /api/auth/oauth/facebook` | Facebook OAuth 交換 JWT |
| `POST /api/auth/oauth/oidc` | OIDC 通用（可用於 Apple） |
| `GET /api/auth/providers` | 列出可用登入方式 |
| `GET /api/auth/me` | 取得當前用戶資訊 |
| `POST /api/auth/logout` | 登出（撤銷 JWT） |
| `DELETE /api/auth/account` | 刪除帳號 |

**需新增 1 個 endpoint**：
- `POST /api/auth/oauth/apple` — 專為 Sign in with Apple（可用 OIDC 通用端點 adapter，或獨立實作）

---

## 架構設計

### 認證矩陣

| 登入方式 | 需 Apple 同時存在？ | iOS 支援 | 後端已就緒 |
|---------|-------------------|---------|-----------|
| Email + 密碼 | 是（§4.8） | ✅ 必加 | ✅ |
| **Sign in with Apple** | — | ✅ 必加 | ⚠️ 需新增 apple endpoint |
| Google OAuth | 是 | ✅ 必加 | ✅ |
| Facebook OAuth | 是 | ✅ 必加 | ✅ |
| 裝置認證 | 否 | ✅ 保留（power user / 從 Android 匯入） | ✅ |

### Token 生命週期

```
登入成功
    ↓
後端回 { authToken (JWT), user: {...}, deviceId, deviceSecret }
    ↓
iOS 存入 SecureStore：
    - auth_token        (JWT, 過期 30 天)
    - device_id         (裝置識別)
    - device_secret     (裝置認證備援)
    - user_email        (顯示用)
    - user_id           (對應後端 user_accounts.id)
    ↓
所有 API 請求 header 帶 Authorization: Bearer <authToken>
    ↓
JWT 過期 → 401 → 觸發 refresh 或回登入頁
    ↓
用戶登出 → 清除 auth_token + user_*（保留 device_* 供下次裝置認證用）
```

### Store 架構變更

`authStore.ts` 需擴充：

```typescript
interface AuthState {
  // 既有
  deviceId: string | null;
  deviceSecret: string | null;
  isInitialized: boolean;

  // 新增
  authToken: string | null;
  user: {
    id: string;
    email: string | null;
    displayName: string | null;
    avatarUrl: string | null;
    provider: 'email' | 'apple' | 'google' | 'facebook' | 'device';
  } | null;

  // Actions 新增
  loginWithEmail: (email: string, password: string) => Promise<void>;
  loginWithApple: () => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  loginWithFacebook: () => Promise<void>;
  loginWithDevice: (deviceId: string, deviceSecret: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  bindEmail: (email: string, password: string) => Promise<void>;  // 將 email 綁到現有 device
  logout: () => Promise<void>;
  deleteAccount: () => Promise<void>;
  refreshToken: () => Promise<void>;
  forgotPassword: (email: string) => Promise<void>;
}
```

---

## 頁面結構

### 新增頁面

| 路徑 | 用途 |
|------|------|
| `app/login.tsx` | 登入頁（4 種登入方式） |
| `app/register.tsx` | Email 註冊頁 |
| `app/forgot-password.tsx` | 忘記密碼頁 |
| `app/(auth)/_layout.tsx` | 未登入時的 stack layout |
| `app/bind-email.tsx` | 裝置用戶綁定 Email 頁（Settings 入口） |

### Navigation Flow

```
App 開啟 → authStore.initialize()
    ↓
讀取 SecureStore
    ↓
    ├─ 有 authToken → 驗證 /api/auth/me
    │     ├─ 200 → 進 (tabs)/
    │     └─ 401 → 清除 token → 進 login
    │
    ├─ 只有 device_id + device_secret（老用戶）→ 直接進 (tabs)/ + 顯示 "綁定 email" banner
    │
    └─ 完全空白（新用戶）→ 進 login
```

### 登入頁 UI（`login.tsx`）

```
┌─────────────────────────────────────────┐
│                                         │
│         🦞 EClawbot                     │
│                                         │
│   ┌─────────────────────────────────┐   │
│   │    Sign in with Apple           │   │  ← Apple 標準黑色按鈕
│   └─────────────────────────────────┘   │
│                                         │
│   ┌─────────────────────────────────┐   │
│   │    Sign in with Google          │   │
│   └─────────────────────────────────┘   │
│                                         │
│   ┌─────────────────────────────────┐   │
│   │    Sign in with Facebook        │   │
│   └─────────────────────────────────┘   │
│                                         │
│   ─────────── or ──────────             │
│                                         │
│   Email    [________________]           │
│   Password [________________]           │
│   ┌─────────────────────────────────┐   │
│   │          Login                   │   │
│   └─────────────────────────────────┘   │
│                                         │
│   Register | Forgot Password            │
│                                         │
│   ─────────────────────                 │
│   [裝置認證登入 (進階)]  ← 可折疊       │
│                                         │
└─────────────────────────────────────────┘
```

**Apple 政策要點**：
- Sign in with Apple 按鈕**必須在最上方**或至少與其他社群登入同等突出
- 不得只用小字連結

---

## 實作分期

### Phase 1：後端 — Apple OAuth Endpoint（1 天）

**新增 `POST /api/auth/oauth/apple`**

在 `backend/auth.js` 加入：

```javascript
// Apple Sign-In token 驗證 JWKS
const APPLE_JWKS_URI = 'https://appleid.apple.com/auth/keys';
let appleJWKSCache = { keys: null, fetchedAt: 0 };

async function getApplePublicKey(kid) {
  if (!appleJWKSCache.keys || Date.now() - appleJWKSCache.fetchedAt > 86400000) {
    const res = await fetch(APPLE_JWKS_URI);
    appleJWKSCache = { keys: (await res.json()).keys, fetchedAt: Date.now() };
  }
  return appleJWKSCache.keys.find(k => k.kid === kid);
}

app.post('/api/auth/oauth/apple', async (req, res) => {
  const { identityToken, authorizationCode, fullName, email } = req.body;
  try {
    const decoded = jwt.decode(identityToken, { complete: true });
    const pubKey = await getApplePublicKey(decoded.header.kid);
    const verified = jwt.verify(identityToken, jwkToPem(pubKey), {
      audience: 'com.eclawbot.app',
      issuer: 'https://appleid.apple.com',
    });

    // 以 sub (Apple user ID) 為唯一鍵，找或建 user
    let user = await db.getUserByProviderId('apple', verified.sub);
    if (!user) {
      user = await db.createUser({
        email: verified.email || email,
        display_name: fullName || 'Apple User',
        provider: 'apple',
        provider_id: verified.sub,
        email_verified: true,
      });
    }

    const authToken = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, authToken, user, deviceId: null, deviceSecret: null });
  } catch (err) {
    res.status(401).json({ success: false, error: 'Apple sign-in failed: ' + err.message });
  }
});
```

**DB schema 確認**：`user_accounts` 需有 `provider` 和 `provider_id` 欄位（應已存在，因為 Google/FB OAuth 已用）。

**新增 Jest test**：`backend/tests/jest/apple-oauth.test.js`

---

### Phase 2：iOS — AuthStore 重構（1 天）

1. 安裝套件：
   ```bash
   cd ios-app
   npx expo install expo-apple-authentication
   npx expo install expo-auth-session expo-crypto expo-web-browser
   ```

2. 重寫 `store/authStore.ts` 按上述 Store 架構

3. 更新 `services/api.ts`：
   - Interceptor 改為優先用 `Authorization: Bearer ${authToken}`
   - 若 401 → 自動 retry with refresh token 或清除 token

---

### Phase 3：iOS — Login / Register 頁面（2 天）

1. 建立 `app/(auth)/_layout.tsx`

2. 建立 `app/login.tsx`：
   ```tsx
   import * as AppleAuthentication from 'expo-apple-authentication';

   const handleAppleSignIn = async () => {
     try {
       const credential = await AppleAuthentication.signInAsync({
         requestedScopes: [
           AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
           AppleAuthentication.AppleAuthenticationScope.EMAIL,
         ],
       });
       await authStore.loginWithApple(credential);
     } catch (err) {
       if (err.code === 'ERR_CANCELED') return;
       showError(t('auth.apple_failed'));
     }
   };
   ```

3. 建立 `app/register.tsx`、`app/forgot-password.tsx`

4. 修改 `app/_layout.tsx` 加入 auth gate：
   ```tsx
   const { isInitialized, authToken, deviceId } = useAuthStore();
   if (!isInitialized) return <Splash />;
   const isAuthed = !!(authToken || (deviceId && deviceSecret));
   return (
     <Stack>
       {isAuthed ? (
         <Stack.Screen name="(tabs)" />
       ) : (
         <Stack.Screen name="(auth)" />
       )}
     </Stack>
   );
   ```

---

### Phase 4：iOS — Settings 整合（1 天）

在 `app/(tabs)/settings.tsx` 加入：
- 顯示目前登入方式（Apple/Google/FB/Email/Device）
- 裝置用戶顯示「綁定 Email」CTA → 開 `bind-email.tsx`
- 登出按鈕
- 刪除帳號按鈕（依 Apple §5.1.1(v) 要求）

---

### Phase 5：i18n 補齊（0.5 天）

新增 i18n keys（14 國語系）：
```json
{
  "auth.login": "Login",
  "auth.register": "Register",
  "auth.forgot_password": "Forgot Password?",
  "auth.sign_in_with_apple": "Sign in with Apple",
  "auth.sign_in_with_google": "Sign in with Google",
  "auth.sign_in_with_facebook": "Sign in with Facebook",
  "auth.or_divider": "or",
  "auth.email_placeholder": "Email",
  "auth.password_placeholder": "Password",
  "auth.device_login_advanced": "Device Login (Advanced)",
  "auth.login_failed": "Login failed",
  "auth.apple_failed": "Apple sign-in failed",
  "auth.bind_email_banner": "Bind an email to secure your account across devices",
  "auth.bind_email_cta": "Bind Email",
  "auth.logout": "Logout",
  "auth.delete_account": "Delete Account",
  "auth.delete_account_confirm": "This will permanently delete your account and all data.",
  "auth.current_provider_apple": "Signed in with Apple",
  "auth.current_provider_google": "Signed in with Google",
  "auth.current_provider_facebook": "Signed in with Facebook",
  "auth.current_provider_email": "Signed in with Email",
  "auth.current_provider_device": "Device-only authentication"
}
```

---

### Phase 6：E2E 測試（1 天）

按 [ios-rental-e2e-test-scenarios.md](./2026-04-14-ios-rental-e2e-test-scenarios.md) 劇本 D（Sign in with Apple）跑完整流程，另新增：

- 劇本 D1：Email 註冊 + 驗證
- 劇本 D2：Email 登入
- 劇本 D3：Apple 登入（首次 / 再次）
- 劇本 D4：Google 登入
- 劇本 D5：Facebook 登入
- 劇本 D6：裝置認證登入
- 劇本 D7：從裝置認證 → 綁定 Email → 登出 → Email 登入 → 資料保留
- 劇本 D8：登出 → 再登入 → 資料恢復
- 劇本 D9：刪除帳號 → 資料清除確認

---

### Phase 7：App Store Connect 設定（0.5 天）

1. Capabilities → Sign in with Apple 啟用
2. `app.json` `ios.usesAppleSignIn: true` 或等效 config
3. Bundle ID 在 Apple Developer → Identifiers 啟用 Sign in with Apple
4. `backend/.env` 新增（若未有）：
   - `APPLE_BUNDLE_ID=com.eclawbot.app`
5. 審查員測試帳號（Apple ID 免，但準備 email/password demo account）

---

## 既有用戶遷移策略

**關鍵原則：無痛升級**

### 場景 A：現有 iOS 用戶（已有 device_id + device_secret）

App 更新到新版後：
1. `initialize()` 讀到 device_id + device_secret，無 authToken
2. 呼叫 `POST /api/auth/device-login` 用 device credential 換 JWT
3. 進 Dashboard，顯示 banner：「綁定 Email 以保護帳號」
4. 用戶可忽略（繼續用裝置認證）或點按綁定

### 場景 B：全新用戶

1. `initialize()` 讀到空值
2. 導向 `/login` 頁
3. 選登入方式（Apple/Google/FB/Email）
4. 登入成功後後端自動 create user + device + bind

### 場景 C：Web Portal 既有用戶（已有 email）

1. 在 iOS `/login` 頁用同 email 登入
2. 後端看到 email 已存在 → 驗證密碼 / OAuth → 發 JWT
3. Web Portal 和 iOS 共用同一 user account（wallet、chat、rental 跨平台同步）

---

## 時間與風險

### 總時程

| Phase | 內容 | 工時 |
|-------|------|------|
| 1 | 後端 Apple endpoint | 1 天 |
| 2 | iOS authStore 重構 | 1 天 |
| 3 | iOS Login / Register / Forgot pages | 2 天 |
| 4 | Settings 整合 | 1 天 |
| 5 | i18n | 0.5 天 |
| 6 | E2E 測試 | 1 天 |
| 7 | App Store Connect 設定 | 0.5 天 |
| **合計** | | **7 天** |

（若含 buffer 建議抓 10 天）

### 風險

| 風險 | 影響 | 緩解 |
|------|------|------|
| Apple JWT 驗證複雜度 | 高 | 用 `jsonwebtoken` + `jwk-to-pem` 成熟套件 |
| expo-apple-authentication 在 Expo Go 不支援 | 中 | 用 EAS preview build 測試 |
| Email 驗證流程需信件 | 中 | 後端已就緒（Resend），只需 iOS UI |
| Apple Review 對「綁定 email banner」UX 敏感 | 中 | Banner 可關閉，不強制 |
| 裝置用戶升級資料遺失 | 高 | device-login JWT 保留 device 所有資料 |

---

## 成功標準

- ✅ 4 種登入方式全部可用（Apple/Google/FB/Email）
- ✅ 裝置認證保留（向下相容）
- ✅ iOS 和 Web Portal 可用同 email 互通
- ✅ JWT 過期自動 refresh 或轉登入頁
- ✅ 所有 API 走 `Authorization: Bearer` header
- ✅ Apple Review §4.8 不觸發拒絕
- ✅ 符合 Apple §5.1.1(v) 提供帳號刪除功能
- ✅ i18n 14 語系全補齊
- ✅ E2E 劇本 D1–D9 全 PASS

---

## 後續工作（Phase 8+，上架後）

- **Android 也加入 Sign in with Apple**（跨裝置互通）
- **Web Portal 也加 Apple 登入**（三平台一致）
- **2FA / MFA**（BRM 有金流，長期必要）
- **Passkeys**（iOS 16+，取代密碼）

---

## 相關文件

- [ios-app-spec.md §6 認證規範](../specs/ios-app-spec.md) — 需根據本計劃更新
- [ios-app-store-submission-checklist.md P0 §4](./2026-04-14-ios-app-store-submission-checklist.md) — 移除「方案 A 不加 Apple Sign-In」的 TBD 狀態
- [ios-rental-e2e-test-scenarios.md 劇本 D](./2026-04-14-ios-rental-e2e-test-scenarios.md) — 擴展為 D1–D9
- [backend/auth.js](../../backend/auth.js) — 後端實作
- [backend/auth_schema.sql](../../backend/auth_schema.sql) — user_accounts schema

---

## 版本歷史

| 版本 | 日期 | 說明 |
|------|------|------|
| 1.0.0 | 2026-04-14 | 初版計劃，方案 C 完整帳號系統 |
