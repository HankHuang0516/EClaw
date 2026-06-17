# ADR: Tauri 2.x as the UniversalAuth Desktop + Mobile Runtime

- **Status**: Accepted (spike outcome, direction ratified)
- **Date**: 2026-06-17
- **Deciders**: #6 (technical direction ruling), #2 (spike author)
- **Kanban card**: `card_ee0c1adc66c9b5af4b0d4b53` — `[UniversalAuth/P3] Tauri auth/deep-link spike + ADR (timeboxed, #6 裁定方向)`
- **Scope**: Doc-only spike. This ADR records the selection rationale, the OAuth deep-link flow, secure token storage, the cross-platform matrix, the Globe-user abstraction constraint, and a Phase-1 breakdown. It does **not** scaffold a full app.

> Facts about Tauri are stated as of 2026-06-17 (Tauri v2 stable since 2024-10-02, current release line v2.10.x as of 2026-03). Items that should be re-verified against the live plugin matrix before Phase-1 code starts are marked **[RE-VERIFY]**.

---

## 1. Context

EClaw needs a **UniversalAuth** desktop + mobile story: a single sign-in/token-acquisition experience that works across macOS, Windows, Linux, iOS, and Android, and that hands authenticated sessions to the existing EClaw `/api` auth backend.

The two realistic cross-platform shells were **Electron** and **Tauri 2.x**. #6 ruled the direction on 2026-06-17: **Tauri 2.x, not Electron.** This ADR documents why and how.

### Why Tauri over Electron

| Dimension | Electron | Tauri 2.x | Why it matters for EClaw |
|---|---|---|---|
| Bundle size | ~85–150 MB (ships a full Chromium + Node) | **< 10 MB** typical (uses the OS WebView) | Faster downloads/updates; lighter footprint for a thin auth shell |
| Idle memory | ~120–250 MB | **~30–50 MB** | Auth shell should be lightweight, often background |
| Mobile (iOS + Android) | **No** first-class support | **Yes** — iOS + Android are first-class targets in v2 | One runtime for desktop **and** mobile is the whole point of UniversalAuth |
| Backend language | Node.js / JS | Rust core (frontend stays web tech) | Keychain/secure-storage and deep-link handling live in vetted Rust plugins |
| Attack surface | Full Node runtime exposed to renderer unless locked down | Capability/permission-scoped IPC by default | Smaller surface for an auth-handling process |
| WebView | Bundled Chromium (consistent, heavy) | System WebView (WKWebView / WebView2 / WebKitGTK) | Lighter, but introduces per-OS WebView variance — see risks |

The decisive factor is **mobile + desktop from one codebase**. Electron does not target iOS/Android; choosing it would force a separate native (or React Native / Flutter) auth path for mobile, which directly violates the Globe-user "no per-runtime carveout" constraint (§6). Tauri 2.x covers all five target platforms with one shell.

The main cost of Tauri — using the **system WebView** instead of a bundled Chromium — is a known, bounded risk (rendering variance, older Linux WebKitGTK), not a blocker for an auth shell whose UI is a small set of login screens.

---

## 2. Decision

**Adopt Tauri 2.x as the runtime for the EClaw UniversalAuth shell**, across desktop (macOS / Windows / Linux), iOS, and Android.

- Frontend: web tech (the existing EClaw web auth UI can be reused), rendered in the OS WebView.
- Native glue: Rust, using official Tauri plugins for deep-linking and secure storage.
- The shell's only job is to acquire and securely persist tokens, then call the existing EClaw `/api` auth endpoints. It is **not** a re-implementation of the EClaw app.

---

## 3. OAuth Deep-Link Redirect Flow

The core problem: an OAuth provider redirects to a `redirect_uri` after login in the system browser, and that redirect must land **back inside the Tauri app** with the authorization code. The mechanism differs by platform, and not every provider accepts every mechanism.

### 3.1 Desktop — two supported patterns

**A. Loopback / localhost redirect (recommended for desktop, broadest provider support).**
The app spins up a short-lived local HTTP listener (e.g. `http://127.0.0.1:<port>/callback`), opens the provider's authorize URL in the system browser, and captures the `code` when the browser hits the loopback URL. This is the IETF-recommended native-app pattern (RFC 8252) and is what the community **`tauri-plugin-oauth`** does — it spawns a temporary localhost server to capture the redirect. Critically, many providers (Google, GitHub) **reject custom URI schemes** as redirect URIs but **do** accept loopback, so loopback is the safe default on desktop. **[RE-VERIFY]** exact plugin version/API at Phase-1 time.

**B. Custom URI scheme (deep link).**
Register a scheme such as `eclaw://auth/callback` via the official **deep-link plugin** (`@tauri-apps/plugin-deep-link` / `tauri-plugin-deep-link`). On macOS/iOS the Tauri core also surfaces `tauri::RunEvent::Opened` for scheme/URL opens. Use this when the provider allows custom schemes, or for app-to-app handoff. Note: custom schemes on desktop have edge cases (app-already-running vs cold-start, single-instance handling).

### 3.2 Mobile — deep link / app link / universal link

- **Custom URI scheme** (`eclaw://...`): declared via the deep-link plugin's `scheme` field in the mobile config; no hosted file required. Simplest, but spoofable by other apps and not accepted by all providers.
- **iOS Universal Links** (`https://auth.eclaw…/callback`): requires hosting an **`apple-app-site-association`** JSON at `/.well-known/`, served over HTTPS with `Content-Type: application/json`. Most secure on iOS; provider accepts a normal `https` redirect_uri.
- **Android App Links** (verified `https` links): requires hosting **`/.well-known/assetlinks.json`** and `autoVerify` intent filters. Android equivalent of universal links.
- The deep-link plugin also handles **app re-launch** (deep link opened while app is backgrounded/closed) across mobile platforms.

### 3.3 Recommendation

Use a **per-platform adapter behind one auth interface** (see §6):
- **Desktop** → loopback (`tauri-plugin-oauth` style) as primary; custom scheme as fallback.
- **iOS** → Universal Link (`https`) primary; custom scheme fallback.
- **Android** → App Link (verified `https`) primary; custom scheme fallback.
Always use **PKCE** (Authorization Code + PKCE), since native/mobile apps are public clients with no safe client secret.

---

## 4. Secure Local Token Storage

We must persist refresh/access tokens (and any PKCE/session material) securely on each platform. Three candidate approaches, in increasing security:

| Option | What it is | Security | Verdict |
|---|---|---|---|
| **`tauri-plugin-store`** | Simple key-value JSON persisted to disk | **Plaintext on disk** — no encryption | **Reject for tokens.** Fine for non-secret prefs only. |
| **`tauri-plugin-stronghold`** | IOTA Stronghold encrypted vault | Strong encryption, but requires a password / an encryption key that must itself be stored somewhere | Good, but pushes the "where does the master key live" problem onto us |
| **OS keychain** (macOS Keychain, Windows Credential Manager/DPAPI, Linux Secret Service/libsecret; iOS Keychain, Android Keystore) | Native OS-backed secret store | OS-protected, hardware-backed where available (Secure Enclave / StrongBox) | **Recommended** for tokens |

### Recommendation

**Store tokens in the OS keychain.** Use a keyring-backed plugin (e.g. the community **`tauri-plugin-keyring`**, which wraps the Rust `keyring` crate) **[RE-VERIFY]** its mobile (iOS Keychain / Android Keystore) coverage and maturity. If a keyring plugin's mobile support is insufficient at Phase-1 time, the fallback is **Stronghold for the encrypted vault + OS keychain for the Stronghold master key** (the documented Tauri pattern: keyring is "a good place to store" the Stronghold encryption key). Never store tokens via `tauri-plugin-store`.

Defense in depth: short-lived access tokens, rotating refresh tokens, store only what's necessary, and bind the storage entry to the EClaw service identifier.

---

## 5. Cross-Platform Matrix

| Capability | macOS | Windows | Linux | iOS | Android |
|---|---|---|---|---|---|
| Tauri 2.x runtime | ✅ Mature | ✅ Mature | ✅ Mature (WebKitGTK variance) | ✅ Supported (newer) | ✅ Supported (newer) |
| WebView | WKWebView | WebView2 (Edge) | WebKitGTK | WKWebView | Android System WebView |
| Deep-link plugin (custom scheme) | ✅ (+ `RunEvent::Opened`) | ✅ (single-instance handling needed) | ✅ (varies by DE) | ✅ | ✅ |
| HTTPS universal/app links | n/a | n/a | n/a | ✅ (AASA file) | ✅ (assetlinks.json) |
| Loopback OAuth | ✅ | ✅ | ✅ | ⚠️ Discouraged on mobile — use links | ⚠️ Discouraged on mobile — use links |
| OS keychain token store | ✅ Keychain | ✅ Cred Mgr / DPAPI | ⚠️ Secret Service (libsecret may be absent on headless/minimal) | ✅ Keychain | ✅ Keystore |
| Maturity / risk | Low | Low | **Medium** (WebKitGTK + libsecret) | **Medium** (mobile newer; signing/provisioning friction) | **Medium** (App Links verification, Keystore variance) |

**What's solid:** desktop trio + the deep-link plugin + loopback OAuth on desktop.
**What's less mature / risk areas:** mobile targets are newer than desktop; Linux depends on WebKitGTK version and `libsecret` availability; mobile signing/provisioning (Apple provisioning profiles, Android keystores) adds CI/build friction; custom-scheme single-instance handling on Windows/Linux needs care.

---

## 6. Globe-User Constraint: One Auth Interface, Runtime Adapters

Per the platform-rule + Globe-user requirements, the auth design must work for **all** users on **all** runtimes with **no per-runtime carveout** in the abstraction. Concretely:

- Define **one auth interface** (conceptually):
  - `login() -> Session`
  - `getToken() -> Token | null`
  - `refresh() -> Token`
  - `logout()`
  - `storeToken(token)` / `loadToken()` / `clearToken()`
- Implement **runtime adapters** behind it:
  - **Redirect adapter**: `loopback` (desktop) | `universal-link` (iOS) | `app-link` (Android) | `custom-scheme` (fallback any).
  - **Storage adapter**: `keychain` (all, preferred) | `stronghold+keychain-key` (fallback).
- Callers (EClaw UI, EClaw `/api` integration) depend **only on the interface**, never on `if platform == …`. Platform branching is confined to adapter selection at the edge.
- **`?` icon / empty-state UX** (Globe-user clarity): each auth surface must expose a `?` affordance explaining *what* is needed (e.g. "Sign in with your EClaw account"), *what conditions* are required (e.g. on Linux: "requires a Secret Service provider such as GNOME Keyring/KWallet"), and the *concrete next step* (the sign-in button or the setup link). Disabled/empty auth states must say why and how to enable.

This is the line in the sand that justified Tauri over Electron: Electron forces a **separate mobile auth path**, i.e. a per-runtime carveout, which this constraint forbids.

---

## 7. Phase-1 Breakdown Recommendation

Concrete, ordered next steps (each a small card; do **not** boil the ocean):

1. **Scaffold** a minimal Tauri 2.x app via `create-tauri-app` (web frontend = existing EClaw auth UI shell), desktop targets only first. Wire `@tauri-apps/plugin-deep-link`.
2. **Deep-link PoC** — register `eclaw://auth/callback`, prove cold-start + already-running capture on macOS/Windows/Linux; add `tauri-plugin-oauth`-style **loopback** capture and prove a real OAuth round-trip with PKCE against a test provider.
3. **Token-store PoC** — integrate a keyring/keychain plugin; prove write→read→clear of a token on macOS/Windows/Linux; document the Linux Secret Service prerequisite. **[RE-VERIFY]** mobile keychain coverage.
4. **EClaw `/api` integration** — define the one auth interface (§6), implement the desktop redirect + keychain adapters, and exchange the captured code/token with the existing EClaw `/api` auth endpoints; confirm an authenticated EClaw session.
5. **Mobile spike (separate, after desktop green)** — bring up iOS Universal Links (AASA) + Android App Links (assetlinks.json); validate the deep-link plugin re-launch path and Keychain/Keystore storage on device.

One-line summary: **scaffold Tauri 2.x desktop shell → deep-link + loopback OAuth PoC (PKCE) → keychain token-store PoC → wire to EClaw /api auth → then mobile (universal/app links + Keychain/Keystore) spike.**

---

## 8. Risks & Open Questions

- **[RE-VERIFY]** Exact current versions/APIs of `tauri-plugin-deep-link`, `tauri-plugin-oauth` (community, Fabian Lars), and the keyring/keychain plugin — confirm against the live plugins-workspace before coding.
- **Mobile maturity**: iOS/Android in Tauri 2 are newer than desktop; budget for build/signing/provisioning friction and possible plugin gaps on mobile.
- **Keychain on mobile**: confirm a single keyring plugin actually covers iOS Keychain **and** Android Keystore; otherwise fall back to Stronghold + keychain-stored master key.
- **Linux variance**: WebKitGTK rendering differences and `libsecret`/Secret Service availability (headless, minimal, or non-GNOME/KDE environments).
- **Custom-scheme single-instance**: on Windows/Linux a deep link must be routed to the already-running instance, not a second one — needs single-instance handling.
- **Provider redirect policy**: confirm which providers EClaw will support and which redirect mechanisms each accepts (loopback vs custom scheme vs https link).
- **Universal/App Link hosting**: requires controlling an HTTPS domain to host AASA / assetlinks.json — confirm the EClaw domain can serve these from `/.well-known/`.
- **Open question for #6/Hank**: which identity providers must UniversalAuth support at launch (EClaw native account only, or Google/GitHub/etc.)? This decides whether loopback (broad provider support) is mandatory on desktop.

---

## References (verified 2026-06-17)

- Tauri 2.0 Stable Release — https://v2.tauri.app/blog/tauri-20/
- Deep Linking | Tauri — https://v2.tauri.app/plugin/deep-linking/
- `@tauri-apps/plugin-deep-link` (npm) — https://www.npmjs.com/package/@tauri-apps/plugin-deep-link
- `tauri-plugin-deep-link` (FabianLars) — https://github.com/FabianLars/tauri-plugin-deep-link
- `tauri-plugin-oauth` (FabianLars) — https://github.com/FabianLars/tauri-plugin-oauth
- Stronghold | Tauri — https://v2.tauri.app/plugin/stronghold/
- `tauri-plugin-keyring` (HuakunShen) — https://github.com/HuakunShen/tauri-plugin-keyring
- Mobile Plugin Development | Tauri — https://v2.tauri.app/develop/plugins/develop-mobile/
- Supabase + Google OAuth in a Tauri 2.0 macOS app (deep links) — https://medium.com/@nathancovey/supabase-google-oauth-in-a-tauri-2-0-macos-app-with-deep-links-f8876375cb0a
