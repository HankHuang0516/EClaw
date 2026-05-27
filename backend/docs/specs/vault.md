# vault — device_vars encrypted secret store

**Source:** `backend/index.js` (encryptVars / decryptVars + 5 endpoints), `backend/mission.js` (decryptVarsLocal), `backend/rental_schema.sql` (allowed_vars dead column)
**Mounted at:** `/api/device-vars` (5 endpoints — see §6)
**Db tables:** `device_vars` (one row per device), `device_vars_audit` (append-only mutation log)

The vault is the per-device secret store: env-style key/value pairs (X_API_KEY,
ANTHROPIC_API_KEY, DEVTO_API_KEY, …) that an entity needs at runtime
but the platform must not see in plaintext. This spec captures the encryption
boundary, the dual-auth read model, the no-whitelist rule for rental, and the
mutation safeguards. Constants are cited **by name + value** so a grep against
this doc and a grep against the code lead to the same line.

---

## 1. Constants

| Name | Value | Defined at | Meaning |
|------|-------|------------|---------|
| `SEAL_KEY_HEX` | env `SEAL_KEY`, 64 hex chars = 32 bytes | `index.js:4847-4851` | AES-256 key. Process exits at boot if length is wrong. |
| AES mode | `aes-256-gcm` | `index.js:4857`, `index.js:4873` | authenticated encryption |
| IV length | `12` bytes (random per encrypt) | `index.js:4856` | `crypto.randomBytes(12)` |
| Auth-tag length | 16 bytes (GCM default) | `index.js:4860` | hex-encoded for storage |
| Ciphertext encoding | `base64` | `index.js:4858-4859` | column `encrypted_vars` |
| IV / authTag encoding | `hex` | `index.js:4863-4864` | columns `iv`, `auth_tag` |
| Wipe-confirm token | `"YES_DELETE_ALL_VAULT"` | `index.js:16317` | required body param to wipe a non-empty vault |
| Merge-empty token | `"REPLACE_ALL_EMPTY"` | `index.js:16071`, `index.js:16153` | required to replace a non-empty vault with `{}` (legacy or merge-mode) |

`mission.js` carries an independent `SEAL_KEY_HEX` reference + `decryptVarsLocal`
helper (`mission.js:52-64`). Two decryption surfaces, one key — keep both
in sync if the cipher ever changes.

---

## 2. Encryption boundary — what is and is NOT encrypted

| Data | Stored where | Encrypted? |
|------|--------------|------------|
| device_vars (key/value secrets) | `device_vars.encrypted_vars` | **YES** (AES-256-GCM) |
| `device_vars.var_keys[]` (key NAMES only) | column on same table | NO — names are plaintext for hint-rendering (`index.js:13950`, `:14033`) |
| `device_vars.var_sources` | JSONB column | NO — only the strings `"web"` / `"app"` / `null`, no value content |
| `device_vars_audit.*` | audit table | NO — but **values are never inserted**, only action / key-name / counts (§5) |
| chat_messages.text | `chat_messages` | NO (`project_chat_plaintext_vault_encrypted.md`) |
| kanban / mission tables | `mission_*` | NO |

**Invariant:** the vault is the **only** at-rest encryption surface in the
backend. Auth-gated does not mean encrypted.

---

## 3. The no-whitelist / no-rental-leak rule

This rule is the load-bearing reason this spec exists. Lifted verbatim from
`feedback_no_whitelist_vault.md`:

> **Vault keys are NEVER accessible to rental bots. There is no `allowed_vars`
> whitelist that could opt some keys in.**

Concretely:

- `rental_snapshots.allowed_vars JSONB DEFAULT '[]'` exists in the schema
  (`rental_schema.sql:146`) and `rental.js:722` writes the literal `'[]'`
  hardcoded on every reservation. **Nothing reads this column.** The column
  is a dead artifact left from an earlier design; do not start honoring it
  without explicit policy review.
- `backend/rental-proxy.js` does not import, call, or grep-match
  `decryptVars` / `device_vars` / `vault` / `allowed_vars`. Renter ↔ bot
  traffic is metered (`rental_usage_events`) but never carries vault values.
- The three server-side `{{KEY}}` interpolation sites
  (`index.js:8243` /api/client/speak, `index.js:10666` cross-device speak,
  `index.js:15778` BYO embedding key resolver) all read `device_vars` for
  the **owning device**, not for any rental contract. A rented bot speaking
  through the rental proxy follows a different code path that never enters
  these blocks.
- The `[Local Variables available: …]` enrichment hint (`index.js:13952`,
  `:14035`) is appended to messages addressed to **the device's own
  entities**, not to rental traffic. The hint also auto-redacts when
  `varsMeta.is_locked` is true.

If you ever add an `allowed_vars`-honoring code path, it must ship behind a
policy doc that supersedes this section in the same PR — not a quiet
"feature add."

---

## 4. Auth model — dual-secret, lock-aware

`/api/device-vars` accepts **either** of two secrets, with different
capabilities (`index.js:16203-16252`):

| Auth | Caller | Read | Write | Bypasses `is_locked`? |
|------|--------|------|-------|------------------------|
| `deviceSecret` | device owner | ✅ | ✅ | YES (owner can toggle the flag, so honoring it would be theatre) |
| `botSecret` | a bound entity on this device | ✅ | ❌ (read-only) | NO — locked vault returns `403 {error:'locked'}` |

`safeEqual` is used for both comparisons (`index.js:16215`, `:16221`) — never
`===` on a user-supplied secret. A bound bot's botSecret is matched by
iterating `device.entities` and checking `e.isBound && safeEqual(...)`
(`index.js:16220-16221`); unbound entities cannot read vault even if their
secret leaks.

The `is_locked` flag lives on `device_vars.is_locked` and is set by the owner
via `POST /api/device-vars` (`locked: true`). When set, every bot read
returns 403. The owner's `deviceSecret` always wins.

---

## 5. Mutation safeguards (incidents → guards)

The vault has been wiped twice in production by misfired clients
(2026-04-23, 2026-04-24). Both incidents added a guard. Current state:

### 5.1 Wipe via `DELETE /api/device-vars`
Requires `confirm: "YES_DELETE_ALL_VAULT"` if any keys exist
(`index.js:16317`). Without it: `400 {error:'refuse_delete_without_confirm'}`,
audit row `action='refuse_delete'`, plus a `serverLog('warn', 'device_vars',…)`
line capturing IP + UA. An empty vault wipes silently (no harm).

### 5.2 Empty merge / empty legacy replace via `POST /api/device-vars`
A POST with `vars:{}` to a non-empty vault is refused unless `confirm:
"REPLACE_ALL_EMPTY"` is set (`index.js:16071-16080` for merge-mode,
`index.js:16150-16162` for legacy mode). Without confirm: `400` + audit row
`action='refuse_wipe'`. This is the 2026-04-24 Android-WebView guard:
fresh WebView opened `env-vars.html` with empty localStorage and POSTed
`{vars:{},source:'web'}`, which would have wiped 17 keys.

### 5.3 Audit trail — `device_vars_audit`
Every successful AND every refused mutation writes an audit row
(`db.logDeviceVarsAudit`). Schema:

| Field | Notes |
|-------|-------|
| `action` | `replace` / `merge` / `delete_one` / `wipe` / `refuse_delete` / `refuse_wipe` |
| `key_name` | only set for `delete_one` |
| `source` | `web` / `app` / `legacy` |
| `caller_ip`, `caller_ua` | recorded for forensics |
| `before_count`, `after_count` | the delta — values are NEVER stored |

**Invariant:** vault VALUES are never in audit rows, never in `serverLog`,
never in error responses. Only key NAMES (which are also plaintext in
`var_keys`) and counts.

Owner reads the trail via `GET /api/device-vars/audit?deviceId=…&deviceSecret=…`
(`index.js:16339-16358`). Optional `since` (ISO-8601) and `limit` query
params.

---

## 6. Endpoint surface

| Method | Path | Auth | Defined at | Purpose |
|--------|------|------|------------|---------|
| POST | `/api/device-vars` | deviceSecret | `index.js:16012` | replace OR merge (when `source:"web"\|"app"`); also flips `is_locked` |
| GET | `/api/device-vars` | deviceSecret OR botSecret | `index.js:16203` | read decrypted vars; bot blocked when `is_locked` |
| DELETE | `/api/device-vars/:key` | deviceSecret | `index.js:16256` | delete a single key |
| DELETE | `/api/device-vars` | deviceSecret + `confirm` | `index.js:16304` | wipe all keys |
| GET | `/api/device-vars/audit` | deviceSecret | `index.js:16339` | mutation history |

The legacy `POST /api/device-vars/approve` and `/deny` JIT-approval routes
were removed in commit `fed3abf` (`backend/CHANGELOG.md:1005`). The
`info.html` setup guide still mentions them; treat that as stale doc, not
live behaviour.

---

## 7. Variable interpolation — three server-side sites

`{{KEY_NAME}}` placeholders in messages are resolved at push time, not
stored expanded. The three callsites:

| Site | Path | Audience |
|------|------|----------|
| `index.js:8243` | `/api/client/speak` | owner-driven message → bot push |
| `index.js:10666` | cross-device speak | entity ↔ entity push |
| `index.js:15778` | `getDeviceVarForEmbedding` | BYO embedding API key (Voyage / OpenAI) |

`mission.js:83` (`applyVarSubstitution`) interpolates inside dashboard
fields — `skills.steps`, `rules.description`, `souls.content` — for the
**local** dashboard render only.

Every site checks `is_locked` before decrypting. `chat_messages.text` keeps
the raw `{{KEY}}` form (privacy + replay safety); only the bot push gets
the expanded value.

---

## 8. What this doc deliberately does NOT cover

- **Front-end env-vars editor flow** (`public/portal/env-vars.html`) — UI
  state machine and merge-suffix UX live in that file.
- **JIT approval flow** — removed; see §6.
- **BYO embedding fallback chain** — see `embedding-client.js` (priority:
  vault → env → fail). This spec only documents the vault-read step.
- **Publisher-key bootstrap** — see `article-publisher.js:604-660`. Same
  pattern: vault first, env fallback, atomic 4-key check.
- **SEAL_KEY rotation** — no rotation tooling exists. Rotating
  `SEAL_KEY` invalidates every existing row. File a card before doing it.

---

## 9. Update discipline

- `SEAL_KEY` length / cipher mode change → update §1 in the same PR.
- New endpoint under `/api/device-vars` → update §6.
- New audit `action` value → update §5.3.
- New server-side `{{KEY}}` interpolation site → update §7.
- **If anyone proposes honoring `rental_snapshots.allowed_vars`** → that PR
  must include a policy-doc change here in §3, signed off by Hank, before
  the code change lands. The dead column is a Chesterton's fence.
