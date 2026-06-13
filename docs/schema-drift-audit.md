# Schema-drift audit — `id`-column DEFAULTs across modules

**Origin**: card_7fc8e7abc3cb546e89721a26 (SI stream B), spawned from P0 card_68242d88.

**Context**: For 2 months, `POST /api/rental/listing` 500'd on every entity except a legacy April-era listing because `bot_listings.id` had lost its DEFAULT on prod. The schema definition said `DEFAULT ('listing_' || encode(gen_random_bytes(12), 'hex'))`, but `CREATE TABLE IF NOT EXISTS` is a no-op on existing tables, so a prior schema change never reached prod. INSERT then wrote NULL → 23502 → 500.

**Scope of this audit**: every `id` column with a `DEFAULT` clause across every `backend/*_schema.sql`, cross-checked against the corresponding module's `INSERT INTO <t>` to see whether the JS code supplies `id` explicitly (safe — schema-drift on DEFAULT can't break INSERT) or relies on the DB-side DEFAULT (exposed).

## Findings

| Schema file | Table | DEFAULT expression | JS module | INSERT pattern | Exposed? |
|---|---|---|---|---|---|
| rental_schema.sql | `bot_listings` | `'listing_' \|\| encode(gen_random_bytes(12), 'hex')` | rental.js | Was rely-on-DEFAULT; **fixed in PR #3352** to pass `crypto.randomBytes` id as $1 | NO (now) |
| rental_schema.sql | `rental_contracts` | `'contract_' \|\| encode(gen_random_bytes(12), 'hex')` | rental.js | rely-on-DEFAULT; **startup ALTER asserts DEFAULT** | LOW |
| rental_schema.sql | `bot_interviews` | `gen_random_uuid()` | rental.js | rely-on-DEFAULT | MEDIUM (built-in fn, but extension drift possible) |
| interview_arena_schema.sql | `arena_exams` | `'exam_' \|\| encode(gen_random_bytes(12), 'hex')` | interview-arena.js | **explicit id** passed as $1 | NO |
| interview_arena_schema.sql | `arena_sessions` | `gen_random_uuid()` | interview-arena.js | rely-on-DEFAULT | MEDIUM |
| kanban_schema.sql | `kanban_cards` | `'card_' \|\| encode(gen_random_bytes(12), 'hex')` | kanban.js | **explicit id** via `newCardId()` | NO |
| kanban_schema.sql | `kanban_comments` / `_files` / etc. | `gen_random_uuid()` | kanban.js | rely-on-DEFAULT | MEDIUM |
| mission_schema.sql | `mission_notes` | `'note_' \|\| encode(gen_random_bytes(12), 'hex')` | mission.js | **explicit id** via `crypto.randomUUID()` | NO |
| mission_schema.sql | `mission_rules` | `'rule_' \|\| encode(gen_random_bytes(12), 'hex')` | mission.js | **explicit id** | NO |
| mission_schema.sql | `mission_items` | `gen_random_uuid()` | mission.js | **explicit id** via `crypto.randomUUID()` | NO |
| auth_schema.sql | `user_accounts` / `device_*` | `gen_random_uuid()` | auth.js | rely-on-DEFAULT | MEDIUM |
| wallet_schema.sql | `wallet_*` | `gen_random_uuid()` | wallet.js | rely-on-DEFAULT | MEDIUM |
| trust_schema.sql | `trust_*` | `gen_random_uuid()` | trust.js | rely-on-DEFAULT | MEDIUM |
| invite_schema.sql | `invite_*` | `gen_random_uuid()` | invite.js | rely-on-DEFAULT | MEDIUM |
| scheduled_messages_schema.sql | `scheduled_messages` | `gen_random_uuid()` | scheduled-messages.js | rely-on-DEFAULT | MEDIUM |

## Risk tiers

**HIGH (custom-prefix id depending on DEFAULT)**: NONE remaining. All five custom-prefix tables (`bot_listings`, `rental_contracts`, `arena_exams`, `kanban_cards`, `mission_notes`/`mission_rules`) now either pass `id` explicitly in JS or have a startup-time `ALTER COLUMN id SET DEFAULT` re-assert.

**MEDIUM (`gen_random_uuid()` rely-on-DEFAULT)**: Many tables. These work on modern Postgres (pgcrypto built-in or core extension), but if a prod DB ever loses the function or the DEFAULT, every INSERT silently 500s.

**LOW**: Tables whose JS layer passes id explicitly.

## Code-review checklist for new `CREATE TABLE` PRs

When adding a `CREATE TABLE IF NOT EXISTS` with `id ... DEFAULT (...)`:

1. **Mandatory**: Does the corresponding `INSERT INTO <table>` in the JS module pass `id` explicitly as `$1`? If yes → safe regardless of DB DEFAULT state.
2. **If relying on DB DEFAULT**: Add an idempotent startup-time `ALTER TABLE <table> ALTER COLUMN id SET DEFAULT (<expr>)` in the module's `init*Database()` function, mirroring the rental_contracts pattern at `backend/rental.js:316`.
3. **Sentinel coverage**: `backend/tests/jest/rental-schema-drift-sentinel.test.js` parses `rental_schema.sql` and asserts the ALTER exists in rental.js. Extend the sentinel — or duplicate for the new schema file — when adding similar patterns to other modules.

## Recommended follow-up (not in this PR)

- Extend the schema-drift sentinel to scan ALL `*_schema.sql` files and check the corresponding module's startup init. Today it's rental-only; expanding it auto-grows future coverage.
- Add a CI integration job that runs the `DATABASE_URL`-gated sentinel against a snapshot of prod's `information_schema`, to catch silent DEFAULT loss in prod that's not visible in dev.
- Lint rule that flags any `INSERT INTO <table>` query string that excludes the `id` column when the schema declares an `id` DEFAULT — forces the explicit-id pattern.

## Why this hid for 2 months

1. **Hank's device had only one rental listing** (Mac_F from April). BUG-M2 duplicate-listing check short-circuited every subsequent attempt with 400 `duplicate_listing` — never reached the broken INSERT path.
2. **Other entities (4/5/6/10) never tried** until the day Hank clicked 執行面試 on Mac_E.
3. **Unit-test fake-pg mock synthesizes `id`** via `genId()`, so the JS test never exercised the real-DB DEFAULT path. The entire class of "DB DEFAULT lost in migration" bugs is invisible to Jest as written.
4. **No prod schema diff in CI** — there was no test comparing live `information_schema.columns` to the schema file.
