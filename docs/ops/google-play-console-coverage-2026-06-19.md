# Google Play Console Coverage Runbook - 2026-06-19

This runbook captures the live Google Play Console gaps for `EClawbot (OpenClaw)`
package `com.hank.clawlive` and the exact completion path. Do not paste secrets
into this file, PR comments, logs, or issue comments.

## Live State

Observed in Google Play Console on 2026-06-19 10:12 CST:

| Surface | Current state | Remaining blocker |
| --- | --- | --- |
| Deep links, version `100 (1.0.92)` | `/r/` on `eclawbot.com` shows `未通過網域檢查` | Production `/.well-known/assetlinks.json` still publishes only the upload certificate. PR #3545 must be reviewed, merged, and deployed so the Play App Signing certificate is served. |
| Protect with Play: Auto protection | `1/1` enabled | None. |
| Protect with Play: Play Integrity API | `0/7` enabled, `尚未整合 Play Integrity API` | The Play Integrity bridge PR must be reviewed, merged, deployed, configured with Google credentials, and shipped in a new Android release. |
| Protect with Play: Play Store safeguards | `6/7` enabled | `商店資訊檢查功能` is off for `禁止在高風險裝置上安裝應用程式`; this is a Play Console setting reached via `管理商店顯示設定`. |
| Protect with Play: Play Billing safeguards | `4/4` enabled | None. |

## Required PR Order

1. Review and merge PR #3545: Android App Links domain verification.
2. Let Railway production deploy `main`.
3. Verify production serves both Android App Links fingerprints:
   - Play App Signing certificate fingerprint.
   - Upload certificate fingerprint.
4. Re-check Play Console deep links for version `100 (1.0.92)` and confirm `/r/`
   on `eclawbot.com` no longer reports `未通過網域檢查`.
5. Review and merge the Play Integrity standard bridge PR.
6. Let Railway production deploy `main`.
7. Configure Play Integrity server verification in Railway and Google Play
   Console.
8. Build and upload a new Android release containing the Play Integrity client
   integration.

Do not merge to `main` or trigger production deploy from an automation thread
unless the user explicitly asks for that exact action.

## Deep Link Verification

Before PR #3545 deploys, production currently returns only the upload
certificate:

```sh
curl -fsSL https://eclawbot.com/.well-known/assetlinks.json \
  | jq -r '.[0].target.sha256_cert_fingerprints[]'
```

After PR #3545 deploys, this command must include both the Play App Signing
certificate and the upload certificate. If Play Console still shows the domain
as failed after production is correct, wait for Play revalidation and then
reopen:

`Google Play Console -> EClawbot (OpenClaw) -> 開發更多使用者 -> 深層連結`

Expected state:

- Version selector: `100 (1.0.92)` or the latest shipped Android version.
- Domain: `eclawbot.com`.
- Path prefix: `/r/`.
- Status no longer says `未通過網域檢查`.

Read-only verifier:

```sh
node scripts/check-google-play-coverage.js
```

This verifier checks both remote production state and the local release branch:

- Production `/.well-known/assetlinks.json` includes the Play App Signing and
  upload fingerprints.
- `app/build.gradle.kts` keeps `applicationId = "com.hank.clawlive"` and still
  includes Google Play Billing plus Play Integrity dependencies.
- `gradle/libs.versions.toml` keeps Google Play Billing Library at `8.0.0` or
  newer; this branch uses `9.1.0` so future Play updates do not hit the
  2026-08-31 Billing Library 8+ requirement.
- `BillingManager.kt` enables Billing Library automatic service reconnection.
- `AndroidManifest.xml` exposes `com.hank.clawlive.MainActivity` as an
  `android:autoVerify="true"` HTTPS App Link for `eclawbot.com` `/r/`.
- `ClawApplication.kt` sends a non-debug startup Play Integrity report from
  release builds so Play Console can observe baseline install/session traffic.
- `BillingManager.kt` sends Play Integrity reports on successful top-up,
  subscription, and borrow-subscription purchase paths.
- `PlayIntegrityReporter.kt` refreshes the Standard Integrity token provider
  and retries once when Google returns `INTEGRITY_TOKEN_PROVIDER_INVALID`, so
  the release does not silently fall back to Classic-only signals after the
  provider expires or Play Store data is cleared.
- `backend/index.js` mounts the Play Integrity router at `/api/play-integrity`.
- `backend/play-integrity.js` posts Google decode requests with the official
  camelCase `integrityToken` request field from the Play Integrity v1 discovery
  contract.
- `backend/play-integrity.js` verifies both `requestDetails.requestPackageName`
  and `appIntegrity.packageName` against `com.hank.clawlive`, and preserves the
  safe `certificateSha256Digest` value in the debug summary for release
  evidence.
- `backend/play-integrity.js` verifies `appIntegrity.certificateSha256Digest`
  against the known Play App Signing and upload certificate digests. Override
  only through `PLAY_INTEGRITY_EXPECTED_CERT_SHA256_DIGESTS` if Google rotates
  app signing keys.

Before PR #3545 deploys this command is expected to fail
`assetlinks.fingerprints` because production is still missing the Play App
Signing fingerprint. After deploy, it must pass that check along with the local
Android/backend coverage checks.

## Play Integrity Activation

The Play Integrity bridge PR adds:

- Android dependency on Google Play Integrity.
- Release-build startup reporting through `PlayIntegrityReporter`.
- Server nonce and verdict endpoints under `/api/play-integrity/*`.
- Standard API `requestHash` support when `PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER`
  is configured.
- Classic nonce fallback when standard requests are not configured.
- Release-build purchase-success reporting for `billing_topup`,
  `subscription_purchase`, and `borrow_subscription`.
- Device-auth debug endpoint at `GET /api/play-integrity/debug`.

Set configuration through the production secret manager only:

| Variable | Purpose |
| --- | --- |
| `PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER` | Enables Standard Integrity API requests from Android. |
| `PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON` | Enables backend decode through the Play Integrity API. |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` or `GOOGLE_APPLICATION_CREDENTIALS` | Alternate credential sources for backend decode. |
| `PLAY_INTEGRITY_NONCE_SECRET` | Optional dedicated nonce signing secret; defaults to `JWT_SECRET` if unset. |
| `PLAY_INTEGRITY_EXPECTED_CERT_SHA256_DIGESTS` | Optional comma/space-separated override for expected app certificate digests; accepts Play Integrity base64url digests or colon-style SHA-256 fingerprints. Leave unset unless Play signing keys rotate. |

Never print or commit the values. Only report whether each variable is present.

After deploy, verify configuration with a device-authenticated request:

```sh
curl -fsS 'https://eclawbot.com/api/play-integrity/debug?deviceId=...&deviceSecret=...'
```

The response should show:

- `verificationConfigured: true`
- `standardRequestConfigured: true`
- `cloudProjectNumberConfigured: true`
- `lastVerdict` remains `null` until a Play-distributed Android build submits
  a verdict. After the first release-build report, `lastVerdict` must show the
  latest action/status/checks and `consoleSignals` without echoing a token,
  nonce, request hash, device secret, or service-account value.

Then upload a new Android release so Play Console can observe real integrity
traffic from the Play-distributed build.

## Android Release Build Requirements

The Play Integrity bridge is only observable by Google Play Console after it is
included in a Play-distributed Android build. The current production baseline is
`versionName "1.0.92"` / `versionCode 100`, so the follow-up Android release
must use a new, unused version code.

For the first release after this bridge merges, unless another Android release
lands first, use:

- `app/build.gradle.kts`: `versionCode = 101`
- `app/build.gradle.kts`: `versionName = "1.0.93"`
- `backend/index.js`: `LATEST_APP_VERSION = "1.0.93"`
- `RELEASE_HISTORY.md`: add the v1.0.93 row with the Play Integrity bridge,
  Android App Links verification fix, and Play Console coverage purpose.

Release checklist:

1. Branch from `main` after PR #3545 and the Play Integrity bridge PR are both
   merged and production deploys are healthy.
2. Bump `versionCode` and `versionName`; never reuse `100`.
3. Sync `LATEST_APP_VERSION` so Android clients and backend update prompts agree.
4. Build the signed release bundle with `./gradlew :app:bundleRelease`.
5. Upload to internal testing first with `node scripts/upload_to_play.js`.
6. Install or launch the Play-distributed build and verify
   `GET /api/play-integrity/debug` records `lastVerdict.status: "verified"` for
   the test device and that `lastVerdict.consoleSignals.appIntegrity.versionCode`
   matches the newly uploaded Play version code.
7. Exercise at least one Google Play Billing success path from the
   Play-distributed build when release testing allows it. Top-ups should report
   `billing_topup`, normal subscriptions should report `subscription_purchase`,
   and borrow subscriptions should report `borrow_subscription`.
8. Promote to production only after the debug endpoint and Play Console signals
   prove the release is reporting integrity verdicts.

Release verifier after the Play-distributed build reports at least one verdict:

```sh
DEVICE_ID=... DEVICE_SECRET=... \
node scripts/check-google-play-coverage.js \
  --min-version-code=101 \
  --expected-version-name=1.0.93 \
  --expected-verdict-action=startup \
  --expected-verdict-version-code=101 \
  --require-play-integrity \
  --require-verified-verdict
```

After exercising a Google Play Billing success path from the Play-distributed
build, run the verifier again with the expected action from that path:

```sh
DEVICE_ID=... DEVICE_SECRET=... \
node scripts/check-google-play-coverage.js \
  --min-version-code=101 \
  --expected-version-name=1.0.93 \
  --expected-verdict-action=billing_topup \
  --expected-verdict-version-code=101 \
  --require-play-integrity \
  --require-verified-verdict
```

Use `subscription_purchase` or `borrow_subscription` instead of
`billing_topup` when the exercised purchase path is a subscription path.

The script prints only check names, booleans, missing fingerprints, and safe
verdict status/version metadata. It must not print `DEVICE_SECRET`, integrity
tokens, nonces, request hashes, or service-account values.

If any local branch check fails before upload, stop the release and fix the
branch first. Play Console cannot mark the related feature covered if the
artifact no longer declares the App Link, Billing dependency, Play Integrity
dependency, modern Billing Library version, auto-reconnecting Billing client,
Standard Integrity provider refresh path, or backend verifier route that the
Console signal depends on. Also stop if the backend Google decode request body
uses `integrity_token`; the Play Integrity v1 API expects `integrityToken`.
Stop as well if backend verification no longer checks `appIntegrity.packageName`
because `requestDetails.requestPackageName` alone is not enough app-integrity
evidence, or if it no longer checks `certificateSha256Digest` against the
expected app signing digest set.

## Play Integrity Signals

The Protect with Play page currently lists these seven disabled Play Integrity
services:

| Console label | Signal surfaced by the Play Integrity bridge |
| --- | --- |
| `Play 授權檢查功能` | `accountDetails.appLicensingVerdict` |
| `應用程式完整性檢查功能` | `appIntegrity.appRecognitionVerdict`, `packageName`, `versionCode` |
| `裝置完整性檢查功能` | `deviceIntegrity.deviceRecognitionVerdict` |
| `虛擬完整性檢查功能` | `deviceIntegrity.deviceRecognitionVerdict` values returned by Google |
| `近期裝置活動功能` | `recentDeviceActivity` |
| `Play 安全防護狀態` | `environmentDetails.playProtectVerdict` |
| `應用程式存取風險功能` | `environmentDetails.appAccessRiskVerdict` |

Expected backend behavior after server credentials are configured:

- Valid package, binding, freshness, app recognition, and device integrity
  return `status: "verified"`.
- Failed checks return `status: "verification_failed"` and include the failed
  check booleans.
- `GET /api/play-integrity/debug` returns the latest safe `lastVerdict`
  summary for that device so release verification does not depend only on
  external Play Console refresh timing.
- Tokens are never echoed in responses or logs.

## Store Safeguard Manual Setting

The remaining `Play 商店防護措施` item is not a repository change.

Manual path:

1. Open `Google Play Console -> EClawbot (OpenClaw) -> 由 Google Play 保護`.
2. Expand `Play 商店防護措施`.
3. On `禁止在高風險裝置上安裝應用程式`, click `管理商店顯示設定`.
4. Enable `商店資訊檢查功能` if the business decision is to block high-risk
   device installs through the store listing check.
5. Return to `由 Google Play 保護` and verify `Play 商店防護措施` is `7/7`.

This setting changes Google Play distribution behavior, so do it only after the
user explicitly approves that Console-side change.

## Completion Evidence

Do not call the Android/Play Console coverage work complete until all of the
following are true:

- Play Console deep links show no `未通過網域檢查` issue for `eclawbot.com` `/r/`.
- `Protect with Play -> Auto protection` is `1/1`.
- `Protect with Play -> Play Integrity API` is `7/7`.
- `Protect with Play -> Play Store safeguards` is `7/7`.
- `Protect with Play -> Play Billing safeguards` is `4/4`.
- Production `/api/play-integrity/debug` reports verifier and standard request
  configuration present without exposing any secret values.
- The Android release containing the bridge uses a new Play version code
  greater than `100`, and `backend/index.js` `LATEST_APP_VERSION` matches the
  shipped `versionName`.
- A Play-distributed Android build containing the Play Integrity bridge has sent at least one
  Play Integrity verdict to production, and `/api/play-integrity/debug`
  reports a `lastVerdict.status` of `verified` for that device.
