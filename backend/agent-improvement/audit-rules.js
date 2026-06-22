// Weekly platform-compliance + multi-tenant audit rules.
// Card: card_923709f59ecb0c1cd66bc786
//
// Two dimensions, per Hank 2026-06-07 20:32 TW:
//   A. 用戶平台規範遵循 — feedback_platform_user_rule_compliance: every
//      repo/feature/script/template/doc must work for ALL worldwide users;
//      no single-tenant designs, no carveouts.
//   B. 多用戶 / 多實體角度 — features must reason about N>1 users per
//      device and N>1 entities per user (the test device has 2 entities but
//      production accounts vary; UI / API / DB queries that assume N=1 leak).
//
// Each rule is a pure JSON object so the auditor walks them deterministically.
// New rules: add to the array; bump `id` (kebab-case slug, unique).

'use strict';

/**
 * @typedef {Object} AuditRule
 * @property {string} id                kebab-case unique slug
 * @property {('compliance'|'multi_tenant')} dimension
 * @property {('P0'|'P1'|'P2'|'P3')} severity
 * @property {string} title             one-liner
 * @property {string} rationale         why this is a violation
 * @property {RegExp} pattern           matches the offending text
 * @property {(filePath: string, match: string) => boolean} [filePathFilter]
 *           optional: skip files that don't match. Returns true to KEEP.
 * @property {string[]} [allowFiles]    substrings — file paths containing any
 *                                       of these are ALWAYS exempt (tests, etc.)
 * @property {string[]} [falseHits]     lowercased literals that match `pattern`
 *                                       by shape but are known non-violations
 *                                       (e.g. 'base64' for the publicCode rule);
 *                                       a line whose match equals one of these
 *                                       is suppressed.
 */

const TEST_PATH_HINTS = Object.freeze([
    '/tests/', '/test/', '__tests__', '.test.js', '.spec.js',
    '/fixtures/', '/migrations/', // migrations may legitimately reference example IDs
]);
const HANK_HEX_DEVICE = '480def4c-2183-4d8e-afd0-b131ae89adcc';
const HANK_HEX_REGEX = new RegExp(HANK_HEX_DEVICE, 'g');

// ─────────────────────────────────────────────────────────────────────────
// Schema-derived table classification (card_f9... weekly-audit precision pass,
// 2026-06-22). Regenerate with a balanced-paren CREATE TABLE / ALTER TABLE ADD
// COLUMN scan over the whole backend tree:
//   node -e '<walk *.js/*.sql, mark a table entity-scoped iff its column block
//            contains `entity_id`>'
// (721 files / 126 tables at time of writing → 27 entity-scoped, 99 device-grain.)
//
// USED AS A *SUPPRESS-LIST* (not an allow-list) so the classification fails
// SAFE: a table absent here is treated as entity-scoped and STILL fires. So a
// newly-added entity_id table is caught even before this list is regenerated;
// only a newly-added device-grain table produces (harmless) noise until added.
// A device-grain table has no entity_id column → a `WHERE device_id = $1` read
// on it cannot leak one entity's rows into another's view.
const DEVICE_GRAIN_TABLES = new Set([
    'agent_card_holder', 'ai_chat_queries', 'ai_chat_requests', 'arena_comments',
    'arena_exams', 'arena_feedback', 'arena_leaderboard', 'arena_sessions',
    'blogger_tokens', 'bot_interviews', 'bot_listings', 'bot_reviews',
    'channel_accounts', 'channel_registrations', 'channel_repair_log',
    'channel_repair_log_meta', 'chat_integrity_reports', 'chat_uploads',
    'community_messages', 'community_ratings', 'companions', 'cross_device_contacts',
    'custom_domains', 'device_preferences', 'device_telemetry', 'device_vars',
    'device_vars_audit', 'devices', 'disputes', 'feedback', 'feedback_photos',
    'form_submissions', 'fraud_detection_log', 'free_bot_tos_agreements',
    'friend_requests', 'gatekeeper_blocks', 'gatekeeper_violations',
    'idempotency_keys', 'invite_clicks', 'invite_codes', 'invite_redemptions',
    'invite_rewards', 'kanban_card_dependencies', 'kanban_card_links',
    'kanban_card_tags', 'kanban_cards', 'kanban_comments', 'kanban_files',
    'kanban_notes', 'kanban_pending_notify', 'kanban_tags', 'lifecycle_event_log',
    'message_reactions', 'mindmap_edges', 'mindmap_node_anchors', 'mission_dashboard',
    'mission_items', 'mission_note_card_links', 'mission_notes', 'mission_rules',
    'mission_sync_log', 'note_pages', 'notification_preferences', 'notifications',
    'oauth_authorization_codes', 'oauth_clients', 'oauth_tokens', 'official_bots',
    'outbound_msg_pending', 'page_views', 'pending_ack', 'pending_cross_messages',
    'portal_beacons', 'pricing_market_snapshots', 'push_ack_log', 'push_health_run',
    'push_subscriptions', 'redirect_events', 'rental_contracts', 'rental_cooldowns',
    'rental_rebind_audit_log', 'rental_snapshots', 'rental_usage_events', 'roles',
    'rule_contributions', 'scheduled_messages', 'site_page_views', 'skill_contributions',
    'soul_contributions', 'tappay_transactions', 'topup_orders', 'usage_tracking',
    'user_accounts', 'user_blacklist', 'user_credit_scores', 'user_roles',
    'wallet_ledger', 'wallets', 'wordpress_tokens',
]);

/** Lines that are pure comments / JSDoc continuations (no executable code). */
function isCommentLine(line) {
    const t = line.trim();
    return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('*/');
}

/** Nearest SQL table a matched line belongs to (backward scan, same statement). */
function nearestSqlTable(lines, idx) {
    for (let i = idx; i >= Math.max(0, idx - 12); i--) {
        const m = /\b(?:FROM|UPDATE|JOIN|INTO)\s+([a-z_][a-z0-9_]*)/i.exec(lines[i]);
        if (m) return m[1].toLowerCase();
    }
    return null;
}

// contextFilter(idx, lines) → return TRUE to KEEP the finding, FALSE to suppress
// (same true=keep convention as filePathFilter). These read a small window of
// surrounding lines so a single-line regex can be made statement-aware.

/**
 * db-query-missing-entity-id-filter precision: a bare `WHERE device_id = $1` is
 * only a multi-tenant leak when (a) the table actually has an entity_id column
 * AND (b) entity_id is not filtered anywhere in the statement.
 */
function ctxEntityScopedLeak(idx, lines) {
    // (a) entity_id IS filtered (this line or a continuation) → correctly scoped.
    const ENTITY_FILTER = /(?:WHERE|AND|,|\(|\bON)\s*[a-z_.]*\bentity_id\b\s*(?:=|<>|!=|\bIS\b|\bIN\b)/i;
    for (let i = idx; i <= Math.min(lines.length - 1, idx + 3); i++) {
        if (ENTITY_FILTER.test(lines[i])) return false;
    }
    // (b) device-grain table → no entity_id column to leak.
    const tbl = nearestSqlTable(lines, idx);
    if (tbl && DEVICE_GRAIN_TABLES.has(tbl)) return false;
    return true; // entity-scoped table, unfiltered → keep for review
}

/** RMW race: atomic upserts (ON CONFLICT/DO UPDATE) and row-locked
 *  (SELECT … FOR UPDATE) writes are not lost-update races. */
function ctxNonAtomicWrite(idx, lines) {
    if (/\b(?:ON\s+CONFLICT|DO\s+UPDATE)\b/i.test(lines[idx])) return false;
    for (let i = idx; i >= Math.max(0, idx - 25); i--) {
        if (/\bFOR\s+UPDATE\b/i.test(lines[i])) return false;
    }
    return true;
}

/** owner-only-user-query: user_accounts is UNIQUE(device_id) (auth_schema.sql)
 *  → exactly one row per device, so LIMIT 1 is correct, not a multi-user bug. */
function ctxNotSingleRowPerDeviceTable(idx, lines) {
    if (/\bFROM\s+user_accounts\b/i.test(lines[idx])) return false;
    return true;
}

/**
 * entity-id-from-body-unverified: the read `const entityId = req.body.entityId`
 * is a near-universal pattern; it is only an IDOR when the handler trusts it
 * WITHOUT validating the caller. Suppress when a caller-auth check appears near
 * the read. Fail-safe: no recognized auth token in window → KEEP the finding.
 */
function ctxBodyEntityIdHasAuth(idx, lines) {
    const AUTH = /\b(?:safeEqual|authenticate|checkAdminAuth|isValidEntityId|requireAuth|verifyBotSecret|botAuth|effectiveEntityId)\b/;
    for (let i = Math.max(0, idx - 15); i <= Math.min(lines.length - 1, idx + 45); i++) {
        if (AUTH.test(lines[i])) return false;
    }
    return true;
}

/** @type {AuditRule[]} */
const RULES = [
    // ── Dimension A: platform compliance ───────────────────────────────
    {
        id: 'hardcoded-hank-device-id',
        dimension: 'compliance',
        severity: 'P0',
        title: 'Hank\'s deviceId UUID hardcoded in source',
        rationale: 'EClawbot must work for any user. Hardcoding the test device UUID into shipped code makes the feature single-tenant.',
        pattern: HANK_HEX_REGEX,
        allowFiles: TEST_PATH_HINTS.slice(),
    },
    {
        id: 'hardcoded-users-hank-path',
        dimension: 'compliance',
        severity: 'P1',
        title: 'Absolute path under /Users/hank/ in shipped code',
        rationale: 'Paths under one developer\'s home directory will not resolve on production or another contributor\'s laptop.',
        pattern: /\/Users\/hank\//,
        allowFiles: ['/scripts/dev', '/.local/', '/docs/'],
    },
    {
        id: 'hardcoded-entity-id-comparison',
        dimension: 'compliance',
        severity: 'P1',
        title: 'Equality check against hardcoded entityId 1-5',
        rationale: 'EClawbot entity slots are user-configurable. `entityId === 2` (etc.) outside a routing seam single-tenants the feature.',
        pattern: /\bentityId\s*===\s*[1-5]\b/,
        allowFiles: TEST_PATH_HINTS.concat(['/agent-improvement/', '/eclaw-bridge/']),
    },
    {
        id: 'hardcoded-public-code-literal',
        dimension: 'compliance',
        severity: 'P2',
        title: '6-char publicCode literal hardcoded',
        rationale: 'publicCodes are assigned per user; literals like `tbwb9e` or `3xa3h4` in shipped code identify specific user bots.',
        // EXACTLY 6 lowercase a-z/0-9 between quote delimiters, requiring BOTH a
        // letter and a digit — that is the publicCode shape (e.g. tbwb9e, 3xa3h4).
        // Lookaheads keep us from false-firing on '401', '256kb', plain words, or
        // long hashes (the earlier `[a-z0-9]*\d[a-z0-9]*` matched all of those).
        pattern: /['"`](?=[a-z0-9]{6}['"`])(?=[a-z0-9]*[a-z])(?=[a-z0-9]*\d)[a-z0-9]{6}['"`]/,
        filePathFilter: (p) => /\.(js|ts)$/.test(p) && !/\.test\./.test(p),
        // Words with the publicCode shape (6 alnum, letter+digit) that are NOT
        // publicCodes — encodings, hash algos, mime fragments. Without this
        // blocklist, `base64`/`sha256` flooded the report with 42 false hits and
        // ~0 true positives on the live tree (see PR scope notes). `oauth2`/
        // `latin1` are protocol/encoding constants; `a1b1c1` is a run-length
        // test fixture ("abc"→"a1b1c1") — added 2026-06-22 audit triage.
        falseHits: Object.freeze(['base64', 'sha256', 'sha224', 'sha384', 'sha512', 'md5sum', 'ripemd', 'crc32c', 'oauth2', 'latin1', 'a1b1c1']),
        // JSDoc / inline-comment examples (e.g. `* - "abc123" 6-char publicCode`,
        // `// legit user 'alice1'`, `* ProductTour.register('track1', …)`) are
        // documentation, not shipped identifiers — skip pure comment lines.
        skipComments: true,
        allowFiles: TEST_PATH_HINTS.concat(['/migrations/', '/api-docs', 'api_refs']),
    },
    {
        id: 'hank-specific-conditional',
        dimension: 'compliance',
        severity: 'P0',
        title: 'Conditional gated on Hank\'s specific deviceId or email',
        rationale: 'Features that fork on `if (deviceId === HANK_*)` are explicitly single-tenant.',
        pattern: /if\s*\(\s*deviceId\s*===?\s*['"`][a-f0-9-]{8,}/,
        allowFiles: TEST_PATH_HINTS.slice(),
    },
    {
        id: 'migration-without-if-not-exists',
        dimension: 'compliance',
        severity: 'P2',
        title: 'Migration ADD COLUMN without IF NOT EXISTS',
        rationale: 'Re-running a migration on a fresh prod database should be safe. ADD COLUMN without IF NOT EXISTS crashes on replay.',
        pattern: /ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/i,
        filePathFilter: (p) => p.endsWith('.up.sql'),
    },
    {
        id: 'zh-only-string-no-i18n-key',
        dimension: 'compliance',
        severity: 'P3',
        title: 'Chinese-only literal in alert() / confirm() / throw',
        rationale: 'Worldwide-user platform: every user-visible string must be either i18n-keyed or English. zh-only strings in alerts strand non-CJK users.',
        pattern: /(alert|confirm|throw\s+new\s+Error)\s*\(\s*['"`][一-鿿]/,
        filePathFilter: (p) => /\.(js|html)$/.test(p),
        allowFiles: TEST_PATH_HINTS.concat(['/i18n', '/docs/', 'memory/']),
    },
    {
        id: 'owner-only-user-query-assumption',
        dimension: 'compliance',
        severity: 'P1',
        title: 'API query assumes the owner is the only user (LIMIT 1 / first row)',
        rationale: 'An endpoint that fetches "the device row" with no user/entity key and then `rows[0]` / `LIMIT 1` assumes a single account per device. On a multi-user device it silently serves the wrong user. Scope the query by the caller, not "the first row".',
        // SELECT ... FROM <table> WHERE device_id = $n   LIMIT 1   (no entity/user key)
        pattern: /FROM\s+\w+\s+WHERE\s+device_id\s*=\s*\$\d+\s+LIMIT\s+1\b/i,
        filePathFilter: (p) => /\.(js|sql)$/.test(p) && !/\.test\./.test(p),
        contextFilter: ctxNotSingleRowPerDeviceTable,
        allowFiles: TEST_PATH_HINTS.concat(['/devices', '/auth', '/migrations/']),
    },

    // ── Dimension B: multi-tenant perspective ──────────────────────────
    {
        id: 'db-query-missing-entity-id-filter',
        dimension: 'multi_tenant',
        severity: 'P2',
        title: 'DB SELECT/UPDATE on entity-scoped table missing entity_id filter',
        rationale: 'Tables with entity_id columns (counters, episodes, drawer state) need WHERE filters on both device_id AND entity_id; otherwise rows from one entity leak into another\'s view.',
        pattern: /WHERE\s+device_id\s*=\s*\$\d+\s*$/im,
        filePathFilter: (p) => /\.(js|sql)$/.test(p),
        contextFilter: ctxEntityScopedLeak,
        allowFiles: TEST_PATH_HINTS.concat(['/devices', '/auth', '/migrations/']),
    },
    {
        id: 'broadcast-without-recipient-list',
        dimension: 'multi_tenant',
        severity: 'P1',
        title: 'speakTo:[] without senderHint or explicit broadcast flag',
        rationale: 'Empty speakTo arrays + missing broadcast flag silently fan out to all entities on the device. PR #2960 / U64 incident.',
        pattern: /speakTo:\s*\[\s*\]/,
        filePathFilter: (p) => /\.(js)$/.test(p) && !/\.test\./.test(p),
        allowFiles: TEST_PATH_HINTS.slice(),
    },
    {
        id: 'cron-once-per-device-assumption',
        dimension: 'multi_tenant',
        severity: 'P2',
        title: 'Cron job iterates devices via SELECT DISTINCT but does not iterate entities',
        rationale: 'A cron that runs once per device but skips per-entity work treats N=2 entities as a single agent. Counter/episode/drawer crons must iterate entities.',
        pattern: /SELECT\s+DISTINCT\s+device_id\s+FROM/i,
        filePathFilter: (p) => /(cron|sweeper|background)/.test(p),
    },
    {
        id: 'ui-assumes-two-bot-slots',
        dimension: 'multi_tenant',
        severity: 'P2',
        title: 'UI hardcodes 2 / 5 bot slots',
        rationale: 'Test device has 2 slots, prod accounts have up to 5. Loops with `i < 2` / array literals `[#1, #2]` strand bot 3-5.',
        pattern: /for\s*\(\s*(?:let|const|var)?\s*\w+\s*=\s*[01]\s*;\s*\w+\s*<\s*[25]\s*;.*botSlots?/,
        filePathFilter: (p) => /\.(js|html)$/.test(p),
        allowFiles: TEST_PATH_HINTS.slice(),
    },
    {
        id: 'counter-increment-not-per-entity',
        dimension: 'multi_tenant',
        severity: 'P1',
        title: 'incrementCounter / addCounter call without entityId argument',
        rationale: 'Per-entity counters (no_reply axes, error counters) need entityId; calls without it bucket into entity_id=0 and the dashboard collapses entities into one row.',
        pattern: /incrementCounter\s*\(\s*[a-zA-Z_$][^,)]*\)/,
        filePathFilter: (p) => /\.(js)$/.test(p) && !/\.test\./.test(p),
        allowFiles: TEST_PATH_HINTS.slice(),
    },
    {
        id: 'entity-id-from-body-unverified',
        dimension: 'multi_tenant',
        severity: 'P0',
        title: 'entityId read from request body without a caller check',
        rationale: 'Trusting `req.body.entityId` to scope a query lets any caller act AS another entity on the same device (IDOR). The handler must validate it against the authenticated caller (callerEntityId / session) before using it in a WHERE.',
        // `const entityId = req.body.entityId`  /  `req.body.entityId`  /  `body.entityId`
        // The matcher line-context heuristic below would over-fire; keep the pattern
        // tight to the body-read assignment shape.
        pattern: /\b(?:const|let|var)\s+entityId\s*=\s*(?:req\.)?body\.entityId\b/,
        filePathFilter: (p) => /\.(js)$/.test(p) && !/\.test\./.test(p),
        contextFilter: ctxBodyEntityIdHasAuth,
        allowFiles: TEST_PATH_HINTS.slice(),
    },
    {
        id: 'cross-entity-read-modify-write-race',
        dimension: 'multi_tenant',
        severity: 'P1',
        title: 'Non-atomic read-modify-write on a shared counter/column',
        rationale: 'Two entities acting on the same card/message/counter in parallel can lost-update when the code does `SELECT ... ; <compute> ; UPDATE ... SET col = <newValue>`. Use an atomic `SET col = col + 1` / `ON CONFLICT` / row lock instead of a JS round-trip.',
        // SET <col> = $n on a counter-shaped column name — the tell of "I computed
        // the new value in JS (a bound param) and wrote it back" rather than an
        // in-place `col = col + N`. Require the `$` param: a bare literal (`= 0`,
        // `= 1`) is a constant reset / version stamp, not a read-modify-write.
        pattern: /\bSET\s+(?:\w+_)?(?:count|counter|total|seq|version|balance)\s*=\s*\$\d/i,
        filePathFilter: (p) => /\.(js|sql)$/.test(p) && !/\.test\./.test(p),
        // Atomic upserts (ON CONFLICT … DO UPDATE) and row-locked writes
        // (SELECT … FOR UPDATE earlier in the statement) are not lost-update races.
        contextFilter: ctxNonAtomicWrite,
        allowFiles: TEST_PATH_HINTS.concat(['/migrations/']),
    },
    {
        id: 'push-fanout-without-dedupe',
        dimension: 'multi_tenant',
        severity: 'P2',
        title: 'Push fan-out loops tokens without a per-recipient dedupe set',
        rationale: 'When multiple entities share a device, the same push token can appear more than once in the recipient list; sending in a bare `for (token of tokens)` loop double-notifies. Dedupe tokens (new Set(...)) before fan-out.',
        // for (... of tokens) / forEach over a *tokens variable, used as the send loop.
        pattern: /for\s*\(\s*(?:const|let|var)\s+\w+\s+of\s+\w*[Tt]okens\s*\)/,
        filePathFilter: (p) => /\.(js)$/.test(p) && !/\.test\./.test(p),
        allowFiles: TEST_PATH_HINTS.slice(),
    },
    {
        id: 'upload-path-collides-across-users',
        dimension: 'multi_tenant',
        severity: 'P1',
        title: 'R2 / file upload key built from filename without a per-user namespace',
        rationale: 'An object key like `uploads/${filename}` or `${req.file.originalname}` collides when two users upload the same filename — one overwrites the other. Namespace the key by deviceId/entityId/uuid.',
        // putObject/upload Key built directly from a *name var with no id segment.
        pattern: /[Kk]ey:\s*[`'"](?:uploads?\/|files?\/)?\$\{(?:filename|originalname|req\.file\.originalname|name)\}/,
        filePathFilter: (p) => /\.(js)$/.test(p) && !/\.test\./.test(p),
        allowFiles: TEST_PATH_HINTS.slice(),
    },
];

const DIMENSIONS = Object.freeze(['compliance', 'multi_tenant']);
const SEVERITIES = Object.freeze(['P0', 'P1', 'P2', 'P3']);

function isFileExempt(filePath, rule) {
    if (!filePath) return false;
    // Normalize a leading slash so `/tests/` style hints match repo-relative
    // paths that START with `tests/` (the runner emits paths without a leading
    // slash). Without this, `tests/foo.js` slips past every `/tests/` hint.
    const norm = filePath.startsWith('/') ? filePath : '/' + filePath;
    const allow = rule.allowFiles || [];
    for (const hint of allow) {
        if (norm.includes(hint)) return true;
    }
    if (typeof rule.filePathFilter === 'function') {
        if (!rule.filePathFilter(filePath, '')) return true;
    }
    return false;
}

/**
 * Scan one chunk of text against all rules; returns flat findings list.
 * @param {string} filePath
 * @param {string} text
 * @returns {{ruleId:string, dimension:string, severity:string, title:string, rationale:string, lineNo:number, excerpt:string}[]}
 */
function scanText(filePath, text) {
    if (typeof text !== 'string' || text.length === 0) return [];
    const lines = text.split('\n');
    const findings = [];
    for (const rule of RULES) {
        if (isFileExempt(filePath, rule)) continue;
        const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g');
        for (let lineNo = 0; lineNo < lines.length; lineNo++) {
            const line = lines[lineNo];
            // Pure comment / JSDoc lines are documentation, not shipped code —
            // skip them for rules that opt in (e.g. publicCode examples).
            if (rule.skipComments && isCommentLine(line)) continue;
            re.lastIndex = 0;
            const m = re.exec(line);
            if (m) {
                // Suppress known false positives that match by shape (e.g. the
                // publicCode rule firing on 'base64'). Compare the matched text
                // stripped of surrounding quotes, case-insensitively.
                if (rule.falseHits && rule.falseHits.length) {
                    const matched = m[0].replace(/^['"`]|['"`]$/g, '').toLowerCase();
                    if (rule.falseHits.includes(matched)) continue;
                }
                // Statement-aware suppression: a rule may inspect a small window
                // of surrounding lines. Returns true to KEEP, false to suppress.
                if (typeof rule.contextFilter === 'function'
                    && !rule.contextFilter(lineNo, lines)) {
                    continue;
                }
                findings.push({
                    ruleId: rule.id,
                    dimension: rule.dimension,
                    severity: rule.severity,
                    title: rule.title,
                    rationale: rule.rationale,
                    filePath,
                    lineNo: lineNo + 1,
                    excerpt: line.trim().slice(0, 160),
                });
            }
        }
    }
    return findings;
}

module.exports = {
    RULES,
    DIMENSIONS,
    SEVERITIES,
    isFileExempt,
    scanText,
};
