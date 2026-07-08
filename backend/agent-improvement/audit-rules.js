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
 * @property {('compliance'|'multi_tenant'|'operability')} dimension
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
    'test_',          // root-level legacy test scripts (test_multi_tenant.js etc.)
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

// ─────────────────────────────────────────────────────────────────────────
// Dimension C: human_operability (人類操作便利性) — card_3c6fb87efc650c6903e22e53
// (Hank-direct 2026-06-23; SPEC v1 + SPEC v2 #6-refinements). Static Tier-1
// checks on portal HTML/JS for keyboard/a11y/feedback friction. HTML regex is
// FALSE-POSITIVE-PRONE: every operability rule is scoped to portal files via
// `filePathFilter` and tuned with context windows / falseHits so the weekly
// cron files real subcards, not a flood. Tier-2 runtime/vision (touch targets,
// focus-trap, contrast) and Tier-3 LLM heuristics stay out of scope (P2/P3).
//
// PORTAL_FILE: scope predicate shared by R1–R7. The runner emits repo-relative
// paths from backend/ (e.g. `public/portal/community.html`).
function isPortalFile(p) {
    return /public\/portal\//.test(p) && !/\.(min|bundle)\.(js|css)$/.test(p);
}
const PORTAL_HTML = (p) => isPortalFile(p) && /\.(html|js)$/.test(p);
const PORTAL_CSS = (p) => isPortalFile(p) && /\.(html|css)$/.test(p);

// An accessible name is provided when the element carries aria-label /
// aria-labelledby / a non-empty title (i18n-driven variants count too).
const HAS_ACCESSIBLE_NAME = /\b(aria-label|aria-labelledby|data-i18n-aria-label|data-i18n-title|title)\s*=/;

/**
 * R1 icon-only-button: the matched `<button …>` opening tag has NO accessible
 * name on the tag itself, AND its content (this line + a small forward window
 * until `</button>`) is icon-only — an inline <svg>, an <i …icon…>, an emoji,
 * an HTML entity (&#x2715;) / unicode escape (✕), or a lone glyph like
 * `?`/`×` — with NO word-shaped text (which would itself be the label).
 * KEEP only when icon-only AND unlabeled.
 */
const ICON_ONLY_CONTENT = /<svg|<i\s[^>]*class=["'][^"']*icon|&#x?[0-9a-f]+;|\\u\{?[0-9a-f]{4,6}\}?|[←-⯿\u{1f000}-\u{1faff}⌀-➿]/iu;
const WORD_TEXT = /[A-Za-z0-9一-鿿]{2,}/; // a real text label (>=2 word chars)
function ctxIconOnlyButtonUnlabeled(idx, lines) {
    const line = lines[idx];
    // Dynamically-rendered buttons (innerHTML / template strings) frequently
    // carry an i18n label via `${i18n.t('key') || 'Fallback'}` shapes the static
    // text-extractor can't fully resolve; one component fix covers all instances.
    // Scope R1 to STATIC authored buttons (Tier-2 runtime judges rendered DOM).
    if (isDynamicHtmlLine(line)) return false;
    // Anchor at THIS button's opening tag (the line may contain several elements;
    // we must parse from the <button, not from the line's first `>`). Take the
    // LAST <button on the line whose tag closes here — the matcher's lastIndex
    // already advanced past earlier ones, and a single line rarely nests buttons.
    const btnStart = line.lastIndexOf('<button');
    if (btnStart < 0) return false;
    const tagClose = line.indexOf('>', btnStart);
    if (tagClose < 0) return false;
    const openTag = line.slice(btnStart, tagClose + 1);
    if (HAS_ACCESSIBLE_NAME.test(openTag)) return false; // labeled on the tag → fine
    // Gather inner content from just after this button's `>` to its `</button>`
    // (this line + a small forward window for wrapped buttons).
    const rest = line.slice(tagClose + 1);
    let inner;
    const closeHere = rest.indexOf('</button>');
    if (closeHere >= 0) {
        inner = rest.slice(0, closeHere);
    } else {
        inner = rest;
        for (let i = idx + 1; i < Math.min(lines.length, idx + 4); i++) {
            if (HAS_ACCESSIBLE_NAME.test(lines[i])) return false; // label on a wrapped attr line
            const end = lines[i].indexOf('</button>');
            inner += '\n' + (end >= 0 ? lines[i].slice(0, end) : lines[i]);
            if (end >= 0) break;
        }
    }
    // A button built as `✏️ ${t('key','Edit')}` / `${ttt('key','Resume')}` IS
    // labeled by the i18n fallback text, not icon-only. Pull literal text from
    // any `…t('key','FALLBACK')`-shaped helper BEFORE stripping ${…}.
    let labelText = '';
    const i18nText = /\b\w*t\s*\(\s*['"`][^'"`]+['"`]\s*,\s*['"`]([^'"`]+)['"`]/g;
    let mm; while ((mm = i18nText.exec(inner))) labelText += ' ' + mm[1];
    if (WORD_TEXT.test(labelText)) return false;    // i18n fallback supplies a label
    // Strip template placeholders (${…}), HTML entities (&#x2715; / &times;), and
    // unicode escapes (✕), then tags — so a glyph button built as `>${icon}<`
    // or `>&#x2715;<` reads as icon-only, while a static text button does not.
    const stripped = inner
        .replace(/\$\{[^}]*\}/g, '')
        .replace(/&#x?[0-9a-f]+;|&[a-z]+;/gi, '')   // numeric + named HTML entities
        .replace(/\\u\{?[0-9a-f]{4,6}\}?/gi, '')    // ✕ / \u{1f4cc}
        .replace(/<[^>]*>/g, ' ')
        .trim();
    if (WORD_TEXT.test(stripped)) return false;     // has real static text → labeled
    if (!ICON_ONLY_CONTENT.test(inner)) return false; // not recognizably an icon → skip
    return true;
}

/**
 * R2 div/span onclick not keyboard-operable: a <div>/<span> with onclick that
 * has neither role= nor tabindex=. Tuned hard: backdrop-dismiss overlays
 * (`event.target===this`) and pure `event.stopPropagation()` wrappers are not
 * primary controls; and we only fire when the handler looks like an ACTION
 * (calls a named function / a window-open / clipboard write) so we don't flag
 * every clickable container. KEEP only genuine action handlers w/o keyboard.
 */
// A line that is part of a JS-built template string (innerHTML / `html +=` /
// backtick/concat HTML) renders a LIST item dynamically: one keyboard fix on
// the template covers every rendered instance, and the placeholder/label may be
// supplied at render time. We scope R2/R3 to STATIC authored markup so each hit
// is a distinct, hand-fixable element (and we don't N-count one template).
function isDynamicHtmlLine(line) {
    return /`/.test(line)                       // template literal HTML
        || /['"]\s*\+|\+\s*['"]/.test(line)     // string concatenation HTML
        || /\$\{/.test(line)                    // interpolation
        || /\binnerHTML\b|\bhtml\s*\+?=|\.insertAdjacentHTML/.test(line);
}
// Repeated design-pattern GROUPS — filter/time chips, tabs, FAQ-accordion rows,
// category cards, code-copy rows. These appear as N siblings of one widget; a
// single keyboard fix on the shared component covers the whole set, so emitting
// one static finding per sibling is a flood, not N distinct bugs. The Tier-2
// runtime audit reports these as one grouped widget finding. Suppress them here
// so the STATIC R2 surfaces only standalone div/span action controls.
const R2_GROUP_PATTERN = /\b(?:filter-chip|time-chip|cap-filter-chip|plaza-chip|auth-tab|faq-question|cat-card|feedback-cat-card|channel-step-code)\b/;
function ctxDivOnclickNoKeyboard(idx, lines) {
    const line = lines[idx];
    if (isDynamicHtmlLine(line)) return false;                     // dynamic list render
    if (/\b(role|tabindex)\s*=/.test(line)) return false;          // keyboard-operable
    if (R2_GROUP_PATTERN.test(line)) return false;                 // repeated widget group → Tier-2
    const m = /onclick\s*=\s*(["'])([\s\S]*?)\1/.exec(line);
    const handler = m ? m[2] : '';
    if (/event\.target\s*===?\s*this/.test(handler)) return false; // modal backdrop dismiss
    if (/^\s*event\.stopPropagation\(\)\s*;?\s*$/.test(handler)) return false; // bubble guard only
    // Modal/lightbox BACKDROP dismiss — a full-bleed overlay (class/id with
    // overlay|backdrop|lightbox|modal-bg, or a fixed inset:0 layer) whose onclick
    // just closes the dialog is a convenience tap, not the primary control (the
    // labeled close button lives inside the dialog). Esc/close-button cover the
    // keyboard path → not a standalone keyboard-operability gap.
    if (/\b(overlay|backdrop|lightbox|modal-bg|modal-overlay|scrim)\b/i.test(line)
        || /inset\s*:\s*0/.test(line)) {
        if (/\bclose|dismiss|hide/i.test(handler)) return false;
    }
    // Require an actual action verb: a function call, window.open, clipboard, or
    // navigation — a bare attribute with no call is usually decorative.
    if (!/[A-Za-z_$][\w$]*\s*\(|window\.open|clipboard|location\s*=/.test(handler)) return false;
    return true;
}

/**
 * R3 input-no-label: an <input> (not hidden/submit/button/checkbox/radio) with
 * a placeholder but no accessible name ON the tag, AND no <label for="<id>">
 * anywhere in the file. The label scan over the whole file is what stops the
 * placeholder-as-label rule from false-firing on properly-labeled fields.
 */
function ctxInputPlaceholderNoLabel(idx, lines) {
    const line = lines[idx];
    if (isDynamicHtmlLine(line)) return false; // dynamic input: label may render at runtime
    if (/type\s*=\s*["'](hidden|submit|button|checkbox|radio|reset|image)["']/i.test(line)) return false;
    if (HAS_ACCESSIBLE_NAME.test(line)) return false;
    const idm = /\bid\s*=\s*["']([^"']+)["']/.exec(line);
    if (idm) {
        const id = idm[1];
        // A literal `<label for="<id>">` anywhere in the file labels this input.
        // (Skip template-interpolated ids — `${…}` — which we can't resolve.)
        if (!/\$\{|['"`]\s*\+/.test(id)) {
            const labelRe = new RegExp('<label[^>]*\\bfor\\s*=\\s*["\\\']' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\\\']');
            for (const l of lines) if (labelRe.test(l)) return false;
        }
    }
    return true;
}

const CONFIRM_REF = /showConfirm|confirm\s*\(|window\.confirm|data-confirm|confirm-overlay|confirmDialog|confirmCheck|\.checked\b/i; // +checkbox-gate (delete-account confirmCheck)
// A SERVER mutation only — an HTTP write. Deliberately NOT `.delete(`/`.destroy(`
// which match JS Set/Map.delete() and teardown helpers (false positives like
// `mySet.delete(id)` / `widget.destroy()`), not data loss on the backend.
const SERVER_MUTATION = /method\s*:\s*["'](POST|PUT|DELETE|PATCH)["']|apiCall\s*\(\s*["'](POST|PUT|DELETE|PATCH)["']/i;
/**
 * R4 destructive-no-confirm: a handler whose NAME contains delete/remove/clear/
 * reset/wipe that performs a SERVER MUTATION (a POST/PUT/DELETE/PATCH or
 * apiCall) within its body and does NOT reference any confirm primitive in the
 * same body. Requiring the server mutation is the key FP cut: it drops local
 * `clearSearch()` / `resetView()` UI-only resets, leaving real data-loss paths.
 */
function ctxDestructiveNoConfirm(idx, lines) {
    // Scan the function body forward to a balanced close (cap the window).
    let depth = 0, started = false, mutates = false, confirms = false;
    for (let i = idx; i < Math.min(lines.length, idx + 60); i++) {
        const l = lines[i];
        if (CONFIRM_REF.test(l)) confirms = true;
        if (SERVER_MUTATION.test(l)) mutates = true;
        for (const ch of l) {
            if (ch === '{') { depth++; started = true; }
            else if (ch === '}') { depth--; }
        }
        if (started && depth <= 0) break;
    }
    return mutates && !confirms;
}

const FEEDBACK_REF = /showToast|toast\s*\(|notify|aria-live|showMsg|showStatus|showError|showSuccess|alert\s*\(/i;
/**
 * R6 mutation-no-feedback: a FIRE-AND-FORGET mutating call — a fetch(…method:
 * POST/PUT/DELETE/PATCH…) or apiCall('POST'…) statement that is NOT awaited,
 * NOT assigned, and has NO .then/.catch chained across its (multi-line) call
 * expression — so there is structurally no success path to surface feedback —
 * AND no feedback primitive appears in the surrounding window. This narrow
 * shape is the only low-FP static form of "mutated state, told the user
 * nothing"; awaited calls with toast-on-success live in Tier-2 runtime audit.
 */
function ctxMutationNoFeedback(idx, lines) {
    const line = lines[idx];
    if (/\bawait\b|\breturn\b|=\s*(await\s*)?(fetch|apiCall)|\b(const|let|var)\b/.test(line)) return false;
    // Read the full call expression forward until its statement terminator; if a
    // .then/.catch/.finally handler is chained (possibly on a following line),
    // feedback can live there → not fire-and-forget. Don't stop at a `})` line
    // whose NEXT non-blank line begins with a chained `.` method.
    let expr = '';
    for (let i = idx; i < Math.min(lines.length, idx + 12); i++) {
        expr += lines[i] + '\n';
        const endsStmt = /;\s*$/.test(lines[i]);
        const endsCallParen = /\}?\s*\)\s*;?\s*$/.test(lines[i]);
        if (endsStmt || endsCallParen) {
            // Peek: a leading-dot continuation means the chain (and its handler)
            // continues on the next line — keep reading.
            let next = '';
            for (let j = i + 1; j < Math.min(lines.length, i + 3); j++) {
                if (lines[j].trim() === '') continue;
                next = lines[j].trim();
                break;
            }
            if (/^\./.test(next)) continue;
            break;
        }
    }
    if (/\.then\s*\(|\.catch\s*\(|\.finally\s*\(/.test(expr)) return false;
    if (FEEDBACK_REF.test(expr)) return false;
    return true;
}

/**
 * R7 focus-style-removed: a CSS rule whose selector targets :focus / :focus-
 * visible / :focus-within and sets `outline: none|0` (or `box-shadow: none`)
 * with NO replacement focus affordance in the SAME rule block — i.e. no
 * border / box-shadow / outline / background / color override that restores a
 * visible focus ring. The match line carries the removal; we scan forward to
 * the rule's `}` for a replacement so the common, CORRECT pattern
 * (`outline:none; border-color: …`) is NOT flagged.
 */
const FOCUS_REMOVAL = /:focus(-visible|-within)?\b/;
// A replacement focus affordance: any border/box-shadow/background/outline/
// outline-offset/color declaration whose VALUE is not itself a removal. We strip
// the removal declarations (`outline:none`, `box-shadow:none`, `outline:0`)
// FIRST, then look for a surviving affordance property — this avoids the regex
// backtracking trap where `(?!none)` slid past the space and matched `: none`.
const REMOVAL_DECL = /\b(?:outline|box-shadow)\s*:\s*(?:none|0)\b\s*;?/gi;
const REPLACEMENT_DECL = /\b(?:border|border-color|box-shadow|background|background-color|outline|outline-offset|outline-color|color)\s*:/i;
function ctxFocusStyleRemoved(idx, lines) {
    const start = lines[idx];
    // The match anchors on the property line (outline:none / box-shadow:none).
    // Find the selector: this line if it has :focus, else a short backward scan
    // to the opening selector of the current rule block.
    let hasFocusSelector = FOCUS_REMOVAL.test(start);
    let blockText = start;
    if (!hasFocusSelector) {
        for (let i = idx - 1; i >= Math.max(0, idx - 6); i--) {
            blockText = lines[i] + '\n' + blockText;
            if (FOCUS_REMOVAL.test(lines[i])) { hasFocusSelector = true; }
            if (/\{/.test(lines[i])) break; // reached the rule open
        }
    }
    if (!hasFocusSelector) return false;
    // Collect the rest of the rule block forward to `}` and look for a
    // replacement focus affordance anywhere in the block.
    if (!/\}/.test(start)) {
        for (let i = idx + 1; i < Math.min(lines.length, idx + 8); i++) {
            blockText += '\n' + lines[i];
            if (/\}/.test(lines[i])) break;
        }
    }
    // Strip the removal declarations, then see if any focus affordance survives.
    const residual = blockText.replace(REMOVAL_DECL, '');
    if (REPLACEMENT_DECL.test(residual)) return false; // replacement present → fine
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
        allowFiles: TEST_PATH_HINTS.concat(['compliance-scan']), // scripts/compliance-scan.js DEFINES the literal to detect it (self-ref)
    },
    {
        id: 'hardcoded-users-hank-path',
        dimension: 'compliance',
        severity: 'P1',
        title: 'Absolute path under /Users/hank/ in shipped code',
        rationale: 'Paths under one developer\'s home directory will not resolve on production or another contributor\'s laptop.',
        pattern: /\/Users\/hank\//,
        allowFiles: TEST_PATH_HINTS.concat(['/scripts/dev', '/.local/', '/docs/', 'compliance-scan']), // + tests + scanner self-ref (rule descriptions / fixtures)
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
        pattern: /['"`](?!0x)(?=[a-z0-9]{6}['"`])(?=[a-z0-9]*[a-z])(?=[a-z0-9]*\d)[a-z0-9]{6}['"`]/, // (?!0x) drops hex literals like '0xf3a4'
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

    // ── Dimension C: human_operability (人類操作便利性) ──────────────────
    // Tier-1 static a11y / keyboard / feedback friction on portal HTML/JS.
    // Every rule is portal-scoped + context-tuned (see helpers above) so the
    // weekly cron does not flood the board. Severity per SPEC v2: R4 (data
    // loss) = P1; the rest P2.
    {
        id: 'operability-icon-button-no-aria',
        dimension: 'operability',
        severity: 'P2',
        title: 'Icon-only <button> with no aria-label/title',
        rationale: 'A button whose only content is an icon/emoji/glyph and that carries no aria-label, aria-labelledby or title is unnamed to screen readers and ambiguous to anyone — keyboard and AT users cannot tell what it does. Add an accessible name.',
        // Anchor on the opening <button …> tag; the context filter inspects the
        // button content + label attrs (handles wrapped tags + ${…} icons).
        pattern: /<button\b[^>]*>/i,
        filePathFilter: PORTAL_HTML,
        contextFilter: ctxIconOnlyButtonUnlabeled,
        allowFiles: TEST_PATH_HINTS.slice(),
    },
    {
        id: 'operability-div-onclick-no-keyboard',
        dimension: 'operability',
        severity: 'P2',
        title: '<div>/<span> with onclick but no role + tabindex (not keyboard-operable)',
        rationale: 'A clickable <div>/<span> with an action onclick but neither role nor tabindex is invisible to the keyboard and to assistive tech — Tab skips it and Enter/Space do nothing. Use a <button>, or add role + tabindex + a keydown handler.',
        pattern: /<(?:div|span)\b[^>]*\bonclick\s*=/i,
        filePathFilter: PORTAL_HTML,
        contextFilter: ctxDivOnclickNoKeyboard,
        allowFiles: TEST_PATH_HINTS.slice(),
    },
    {
        id: 'operability-input-no-label',
        dimension: 'operability',
        severity: 'P2',
        title: 'Text <input> labelled only by placeholder (no <label>/aria-label)',
        rationale: 'A placeholder is not a label: it disappears on input, fails contrast, and is not reliably announced. An <input> with a placeholder but no <label for>, aria-label or aria-labelledby leaves screen-reader and low-vision users without a field name.',
        pattern: /<input\b[^>]*\bplaceholder\s*=/i,
        filePathFilter: PORTAL_HTML,
        contextFilter: ctxInputPlaceholderNoLabel,
        allowFiles: TEST_PATH_HINTS.slice(),
    },
    {
        id: 'operability-destructive-no-confirm',
        dimension: 'operability',
        severity: 'P1',
        title: 'Destructive handler mutates server state with no confirm',
        rationale: 'A delete/remove/clear/reset/wipe handler that issues a POST/PUT/DELETE/PATCH (real data loss) without any confirm step (showConfirm / confirm() / data-confirm) lets a single mis-click destroy data irreversibly. Gate destructive mutations behind a confirmation.',
        // Anchor on the handler declaration; the context filter requires a server
        // mutation in the body AND the absence of any confirm primitive.
        pattern: /(?:function|const|let|var)\s+(?:\w*\.)?(?:delete|remove|clear|reset|wipe)\w*\s*[=(]/i,
        filePathFilter: PORTAL_HTML,
        contextFilter: ctxDestructiveNoConfirm,
        allowFiles: TEST_PATH_HINTS.slice(),
    },
    {
        id: 'operability-emptystate-no-next-step',
        dimension: 'operability',
        severity: 'P2',
        title: 'Empty-state block with no actionable next step',
        rationale: 'An empty / no-results / no-data state that shows only "nothing here" — with no button, link, CTA, href or error-reason within the block — strands the user with no way forward. Give every empty state a next step (per feedback_spec_globe_user_setup_clarity; the ? help icon is a bonus, not required).',
        // Match the CONTAINER open only (class/id has empty|no-results|no-data but
        // not a child element like -icon/-text/-title/-detail/-msg); the context
        // filter requires the block to lack any CTA. Conservative: prefers FNs.
        pattern: /<[a-z][a-z0-9]*\b[^>]*\b(?:class|id)\s*=\s*["'][^"']*\b(?:empty(?:-state)?|no-results|no-data)\b(?![\w-]*-(?:icon|text|title|detail|msg|sub|hint|desc|emoji))[^"']*["'][^>]*>/i,
        filePathFilter: PORTAL_HTML,
        contextFilter: function ctxEmptyStateNoNextStep(idx, lines) {
            const line = lines[idx];
            // CONSERVATIVE (prefer false-negatives, per SPEC v2 — highest FP risk):
            // Dynamically-rendered empties (innerHTML / template strings) often get
            // their CTA appended at render time and one template fix covers all
            // instances → out of scope for the STATIC pass (Tier-2 runtime audit
            // judges the rendered DOM). Only hand-authored static empty blocks fire.
            if (isDynamicHtmlLine(line)) return false;
            // A loading state is transient, not a dead-end → not in scope.
            if (/\b(load|loading|spinner|skeleton|fetching|載入|加載|讀取)/i.test(line)) return false;
            // Look across the empty-state block (this line + a forward window).
            let block = line;
            for (let i = idx + 1; i < Math.min(lines.length, idx + 8); i++) {
                block += '\n' + lines[i];
                // Stop the window at the next element open so we don't borrow a
                // CTA from an unrelated following block (tightens precision both ways,
                // but we still err toward NOT firing).
            }
            // Loading/error copy inside the block: a loading placeholder is transient;
            // an error state already carries a reason (which IS the next-step context),
            // so neither is the "stranded with nothing" anti-pattern this rule targets.
            if (/\b(load|loading|spinner|skeleton|fetching|載入|加載|讀取|err|error|failed|錯誤|失敗)\b/i.test(block)) return false;
            // POSITIVE / success empty states ("No issues detected", "All clear",
            // "All caught up") are a GOOD outcome with no action needed — not a
            // dead-end. Suppress so we don't nag users to act on a clean state.
            if (/\b(no\s+issues|all\s+clear|all\s+caught\s+up|nothing\s+to\s+(?:do|review)|up\s+to\s+date|沒有問題|一切正常|無待辦)\b/i.test(block)) return false;
            // Any actionable affordance OR instructional next-step copy anywhere in
            // the block → has a next step. Includes hint/guidance text ("try …",
            // "add your first …", "send a message …") which IS a next step even
            // without a button — conservative: we'd rather miss than nag.
            const CTA = /<a\b|<button\b|href\s*=|onclick\s*=|role\s*=\s*["']button["']|class\s*=\s*["'][^"']*\b(?:btn|cta|action|link|hint|desc)\b|retry|reload|try\b|click\b|tap\b|press\b|add\s+your|send\s+a|get\s+started|create|重試|重新|前往|去\b|試試|新增|開始|點擊|點選|按一?下|switchChTab|setFilter|resetFilters|openDetail|navigate/i;
            if (CTA.test(block)) return false;
            return true;
        },
        allowFiles: TEST_PATH_HINTS.slice(),
    },
    {
        id: 'operability-mutation-no-feedback',
        dimension: 'operability',
        severity: 'P2',
        title: 'Fire-and-forget mutating call with no user feedback',
        rationale: 'A mutating fetch/apiCall (POST/PUT/DELETE/PATCH) that is not awaited, not assigned, and has no .then/.catch handler gives the user no success/failure signal and silently swallows errors. Await it and surface a toast / aria-live update on success and on failure.',
        // Anchor on the call; the context filter proves it is fire-and-forget and
        // that no feedback primitive lives in the call expression / nearby window.
        pattern: /(?:^|[^.\w])(?:fetch\s*\([^;]*method\s*:\s*["'](?:POST|PUT|DELETE|PATCH)["']|apiCall\s*\(\s*["'](?:POST|PUT|DELETE|PATCH)["'])/i,
        filePathFilter: PORTAL_HTML,
        contextFilter: ctxMutationNoFeedback,
        allowFiles: TEST_PATH_HINTS.slice(),
    },
    {
        id: 'operability-focus-style-removed',
        dimension: 'operability',
        severity: 'P2',
        title: ':focus removes outline/box-shadow with no replacement focus ring',
        rationale: 'Removing outline:none (or box-shadow:none) on a :focus/:focus-visible/:focus-within selector with no replacement focus affordance in the same rule makes keyboard focus invisible — Tab users cannot see where they are. Always pair outline removal with a visible custom focus style.',
        pattern: /outline\s*:\s*(?:none|0)\b|box-shadow\s*:\s*none\b/i,
        filePathFilter: PORTAL_CSS,
        contextFilter: ctxFocusStyleRemoved,
        allowFiles: TEST_PATH_HINTS.slice(),
    },
];

const DIMENSIONS = Object.freeze(['compliance', 'multi_tenant', 'operability']);
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
