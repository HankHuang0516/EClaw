# ADR 001: Desktop app framework for one-click agent binding

- **Status:** Proposed for D0 review
- **Date:** 2026-05-25
- **Owner:** Codex #6
- **Reviewer:** LOBSTER #2
- **Parent card:** `card_b0568b17e0380ad25effe79b` - `[Roadmap/Desktop] D0 - spike / architecture gate`
- **Blocks:** D1 desktop core infrastructure (`card_1434b0534bfb8a9871276c7f`)

## Context

The desktop roadmap targets a one-click EClaw Desktop app that can complete
agent binding configuration in under 30 seconds. D1 must not start until the
desktop framework, update path, token handling, rollback behavior, and smoke E2E
scope are settled enough to avoid re-cutting the foundation.

The first implementation target is macOS plus Windows. This ADR is written from
the repo as-is on macOS. Windows VM evidence remains a follow-up gate for the
PoC scope card, not a blocker for documenting the architecture decision.

## Decision

Use **Tauri 2** for the first EClaw Desktop implementation.

The app should be a local Tauri shell around an EClaw-owned frontend bundle,
with privileged operations implemented as narrow Rust commands. It must not load
remote privileged UI with broad desktop permissions. OAuth should run through
the system browser with PKCE and a loopback redirect listener; the WebView is
for EClaw UI, not for collecting third-party credentials.

## Comparison

| Area | Electron | Tauri 2 | Decision impact |
| --- | --- | --- | --- |
| Packaging | Mature ecosystem through Electron Forge/electron-builder. Common outputs include DMG/ZIP on macOS and NSIS/Squirrel/MSIX on Windows. | Built-in bundler supports native app bundles/installers such as macOS app/DMG and Windows MSI/NSIS. | Both are viable. Tauri gives native installer coverage without shipping Chromium and Node in every build. |
| Auto-update | Electron `autoUpdater` uses Squirrel on macOS and Squirrel/MSIX paths on Windows. electron-builder adds a mature cross-platform update layer. | Tauri updater creates signed update artifacts and supports static JSON or dynamic update servers. Update signatures are mandatory. | Tauri meets the D0 update requirement with a smaller trust surface. Use static JSON on GitHub Releases for PoC, then a dynamic endpoint for rollback control. |
| Code signing | macOS auto-update requires signed apps. Windows signing depends on installer target and SmartScreen reputation. | macOS signing/notarization and Windows signing are first-class documented distribution steps. | Neither framework removes signing work. Tauri keeps signing tied to the native bundler pipeline. |
| Native API integration | JavaScript/Node main process is fast for web teams and broad npm usage. Requires careful preload/IPC boundaries. | Rust command layer and plugin permissions are more explicit. JS calls only exposed commands. | EClaw's risk is privileged local mutation of auth and agent config, so the extra Rust boundary is useful. |
| Security model | Secure when hardened, but mistakes around Node integration, context isolation, sandboxing, IPC sender validation, or remote content can turn XSS into host compromise. | WebView code only reaches system resources through Tauri IPC, capabilities, permissions, and command scopes. Tauri does not bundle a WebView. | Prefer the model that makes least-privilege the default shape of the app. |
| Artifact size and patching | Bundles Chromium and Node, increasing installer and update size. Electron must be updated to ship Chromium/Node security patches. | Uses the OS WebView, so app artifacts are smaller and WebView security patches usually arrive through the OS. | Smaller update payloads help the one-click install target and support bandwidth-sensitive users. |
| Team cost | More existing desktop examples and JS-only implementation. | Requires Rust comfort and Windows CI validation. | Accept the Rust/CI cost because D1 includes local system integration and token storage. |

## Consequences

- D1 starts with a Tauri 2 scaffold, not an Electron scaffold.
- The frontend may reuse EClaw portal UI code, but must be built and shipped as
  local assets with a restrictive CSP.
- Privileged commands live in Rust and are schema-validated. No command should
  expose generic shell, arbitrary filesystem, broad process execution, or token
  readback to the WebView.
- OAuth uses Authorization Code + PKCE with `state` and `nonce`. The app opens
  the system browser and listens on `127.0.0.1:<random-port>` for a short-lived
  callback. A custom URL scheme can be added later only after signed app
  identity is stable on both macOS and Windows.
- Refresh tokens are stored only through OS-backed credential storage:
  macOS Keychain, Windows Credential Manager/DPAPI, and Linux Secret
  Service/libsecret if Linux enters scope. The renderer never receives refresh
  tokens.
- Access tokens are held in memory and refreshed by the Rust layer. Persisted
  config files contain non-secret metadata only.
- Updates are signed, served over HTTPS, and verified before install. The update
  signing private key lives only in release CI secrets.
- Windows VM install/update/uninstall proof remains required before D1 is marked
  unblocked.

## Threat Model

### Assets

- OAuth authorization codes, access tokens, refresh tokens, and session cookies.
- EClaw `deviceId`, entity binding state, bot secrets, and generated agent
  configuration.
- Local agent endpoint inventory and configuration backups.
- Update signing keys, code signing identities, installer manifests, and
  rollback caches.
- Smoke E2E logs, videos, GIFs, and crash reports.

### Trust boundaries

1. WebView frontend to Rust command layer.
2. Rust command layer to OS credential store.
3. Desktop app to EClaw backend APIs.
4. Desktop app to local agent endpoints and local files.
5. Installer/updater to release artifacts and update metadata.
6. Browser OAuth redirect to the local loopback listener.

### Threats and controls

| Threat | Risk | Required controls |
| --- | --- | --- |
| OAuth code interception | A local process or malicious page captures the authorization code. | Use PKCE S256, high-entropy `state` and `nonce`, exact redirect URI validation, random loopback port, listener timeout, single-use code exchange, and immediate listener shutdown after success/failure. |
| Token theft at rest | Malware or another app reads refresh tokens from disk. | Store refresh tokens in OS credential storage only. Never put tokens in WebView localStorage, IndexedDB, config JSON, logs, crash reports, screenshots, videos, or update metadata. |
| Renderer compromise | XSS or dependency compromise uses desktop privileges. | Ship local assets, enforce CSP, disable remote privileged content, expose only allowlisted Tauri commands, validate all command inputs, deny dangerous plugin permissions by default, and never return secrets to the renderer. |
| Malicious update | Attacker serves or replays a compromised installer. | Require HTTPS, signed update bundles, pinned updater public key, platform code signing, monotonic release metadata by default, and explicit dynamic-server downgrade allowlist for rollback only. |
| Local agent spoofing | A fake local service pretends to be a supported agent. | Detect agents with protocol-specific handshakes, verify expected process/config fingerprints where available, show a human-readable target summary before mutation, and never read another app's secrets. |
| Config corruption | One-click binding edits agent config incorrectly. | Write transactional config backups before mutation, validate after each write, restore on failure, and record a local rollback manifest. |
| Device binding replay | Stolen device metadata is reused elsewhere. | Bind after authenticated OAuth only, include app installation identity and OS credential-store presence in risk checks, rotate server-side binding on suspicious reuse, and support explicit device revoke. |
| Installer privilege abuse | Installer writes more than needed or leaves privileged hooks. | Prefer user-level install. Admin elevation is opt-in and only for explicit system-wide paths. Maintain a manifest of files, registry keys, launch agents, shortcuts, firewall rules, and credential entries. |
| E2E artifact leakage | Smoke videos or logs expose tokens or private agent names. | Redact tokens and secret paths, use test accounts, scrub logs before upload, and keep raw artifacts out of public release assets unless reviewed. |
| Supply-chain compromise | npm/Cargo dependency compromise affects desktop app. | Commit lockfiles, pin release tooling, run dependency audit in CI, keep release signing isolated, and require review for new Tauri plugins or Rust crates that add filesystem, shell, process, or network authority. |

## Rollback And Uninstall Spec

### Installer rollback

Installation is a staged transaction:

1. **Preflight:** verify OS version, WebView2 availability on Windows, writable
   install path, network reachability, and sufficient disk space.
2. **Prepare:** create an install transaction directory and write an install
   manifest with every file, shortcut, registry key, launch item, credential
   entry, and firewall rule the installer intends to touch.
3. **Stage:** copy the app into a versioned staging path and verify code
   signature/notarization before registering it as active.
4. **Commit:** atomically promote the staged app to active, then register
   shortcuts, launch items, protocol handlers, and updater metadata.
5. **Rollback on failure:** remove staged files, undo only manifest-recorded
   registrations, leave the previous active version untouched, and emit a
   redacted failure report.

### Update rollback

- Keep the last-known-good installer/app bundle until the new version passes the
  first-launch health gate.
- Health gate checks:
  - app launches and renders local UI;
  - credential store can decrypt the session envelope;
  - EClaw `/whoami` or equivalent session validation succeeds;
  - local agent detection runs without mutating config;
  - updater metadata is readable.
- If the health gate fails, restore the previous active version and mark the
  failed version as blocked in local updater state.
- Normal updater metadata is monotonic. Rollback/downgrade requires the dynamic
  update endpoint to explicitly allow a lower version for the affected platform
  and version cohort.

### Config rollback

- Every agent config mutation writes a timestamped backup before the first
  write.
- The binding flow records an ordered local operation log:
  `detect -> backup -> write -> validate -> bind -> verify`.
- Failure before `bind` restores local config only.
- Failure after `bind` restores local config and calls the EClaw backend to
  cancel or mark the partial binding as failed.
- Backup retention defaults to the latest 5 successful mutations per agent,
  with user-visible cleanup.

### Uninstall cleanup

Uninstall must remove:

- App bundle/install directory and update cache.
- Launch agents/login items/startup tasks.
- Shortcuts, protocol handlers, and registry entries.
- OS credential-store entries created by EClaw Desktop.
- Local app config, operation logs, rollback manifests, and temporary backups.
- Firewall/proxy entries if the app created any.

User choice:

- Default uninstall removes secrets and local app data.
- Optional "keep diagnostics" preserves redacted logs only.
- Optional "keep config backups" preserves agent config backups without tokens.

### Verification matrix

| Platform | Required checks |
| --- | --- |
| macOS | Fresh install from signed DMG or app bundle, OAuth loopback, bind one test agent, uninstall, then verify no EClaw Keychain item, LaunchAgent/login item, app support directory, update cache, or protocol handler remains. |
| Windows | Fresh install from signed MSI/NSIS, OAuth loopback, bind one test agent, uninstall, then verify no Credential Manager item, HKCU/HKLM uninstall/app path key, startup task, AppData directory, update cache, firewall rule, or protocol handler remains. |

## PoC Scope Plan

The proof-of-concept should be a separate scope card and, if needed, a separate
`eclaw-desktop-spike` repository so this ADR PR stays documentation-only.

Required PoC acceptance:

1. Scaffold a Tauri 2 app with a minimal local EClaw UI bundle.
2. Implement OAuth Authorization Code + PKCE using system browser plus loopback
   redirect.
3. Store a test refresh token through the OS credential store and prove the
   renderer cannot read it directly.
4. Implement one real or staging "bind one agent" path with config backup,
   write, validation, and rollback.
5. Package on macOS and run install -> OAuth -> bind one agent -> uninstall in
   under 5 minutes on a clean macOS account.
6. Add a forced installer/update failure test proving rollback to the previous
   active version or clean no-install state.
7. Add uninstall verification output for all files, launch items, protocol
   handlers, update cache, and credential entries.
8. Record a redacted smoke E2E video or GIF.
9. Repeat the same smoke and uninstall verification on a clean Windows VM as a
   follow-up before D1 is unblocked.

## Source Notes

Checked on 2026-05-25:

- Tauri security model: https://v2.tauri.app/security/
- Tauri updater: https://v2.tauri.app/plugin/updater/
- Tauri macOS signing: https://v2.tauri.app/distribute/sign/macos/
- Tauri Windows signing: https://v2.tauri.app/distribute/sign/windows/
- Electron autoUpdater: https://www.electronjs.org/docs/latest/api/auto-updater
- Electron security checklist: https://www.electronjs.org/docs/latest/tutorial/security/
- Electron process model: https://www.electronjs.org/docs/latest/tutorial/process-model
- Electron safeStorage: https://www.electronjs.org/docs/latest/api/safe-storage
