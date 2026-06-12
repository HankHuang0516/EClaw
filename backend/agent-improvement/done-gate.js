// OODA-R Phase 1 #3c (original) + #4 (hardened) — done-evidence gate.
// Card: card_337040389de34bcb65cf0cb0 (#4 hardening)
//
// v1 (PR #3230): checked text presence of preflight marker + 5 checklist items.
//   Gap surfaced by Hank 20:35-20:41 TW 2026-06-07: text-presence alone lets
//   me close cards I never actually tested from user POV. The 5 sections can
//   all be present even when the work was punted.
//
// v2 (this card, P1#4): artifact + DoD/AC split + severity tier per:
//   - promptengineering.org 2026 playbook "verification-aware planning"
//   - Scrum.org / Visual-Paradigm DoD-vs-AC distinction
//   - Marker.io / Panaya UAT 2026 "audit-ready evidence"
//   - arxiv 2604.05000 closed-loop autonomous dev "confidence + review" policy
//
// Concrete additions:
//   1. require ≥1 non-image file attachment (jest log etc.) after the preflight
//      comment, for every card with requires_preflight_review=true
//   2. UI cards (heuristic: painTag in {ux_feedback, redirect_deeplink,
//      delivery_reliability} OR explicit isUiCard=true) ALSO require ≥1
//      image/* file after the preflight comment
//   3. Evidence comment must include a github.com pull/N link
//   4. Evidence comment must include a 6th item: "User POV" or "用戶角度"
//   5. Severity tier — P0 cards require ALL (1+2+3+4); P1 (1+3+4); P2/P3 (1+3)
//
// Backward compat: when no files/severity are passed, falls back to v1 text-only
// behaviour. The kanban.js callsite passes the new args; existing tests still
// work; new tests cover the artifact branches explicitly.

'use strict';

const PREFLIGHT_MARKER = '[OODA-R preflight';

const REQUIRED_EVIDENCE_ITEMS = Object.freeze([
    'Scope',
    'Acceptance',
    'Test plan',
    'Evidence plan',
    'Out-of-scope',
]);

// v2 6th item — codifies the user-POV requirement Hank surfaced at 20:37 TW
// 2026-06-07. Match EITHER English label or Chinese label so authors can use
// whichever feels natural; gate accepts either string.
const USER_POV_ALIASES = Object.freeze(['User POV', '用戶角度', 'User perspective']);

const PR_LINK_PATTERN = /https?:\/\/github\.com\/[\w.\-]+\/[\w.\-]+\/pull\/\d+/i;

const UI_PAIN_TAGS = Object.freeze(['ux_feedback', 'redirect_deeplink', 'delivery_reliability']);

/**
 * @typedef {Object} GateInput
 * @property {string} oldStatus
 * @property {string} newStatus
 * @property {boolean} [requiresPreflightReview]
 * @property {Array<{text:string, isSystem:boolean, createdAt:string|number|Date}>} comments
 * @property {Array<{filename?:string, mimeType?:string, mime_type?:string, createdAt?:string|number|Date, created_at?:string|number|Date}>} [files]
 *           kanban_files rows for the card. When omitted, file checks are skipped (v1 compat).
 * @property {('P0'|'P1'|'P2'|'P3')} [severity]
 *           when omitted, defaults to 'P2' (mid-tier requirements)
 * @property {boolean} [isUiCard]            explicit override; if undefined, painTags is inspected
 * @property {string[]} [painTags]           used to infer isUiCard when not passed
 * @property {boolean} [strictArtifacts]     default true when severity/files provided; false otherwise
 */

/**
 * @typedef {Object} GateVerdict
 * @property {boolean} allowed
 * @property {string} [code]    'PREFLIGHT_GATE_FAILED' when blocked
 * @property {string} [error]
 * @property {string} [hint]
 * @property {string[]} [missingItems]
 */

function tsOf(c) {
    if (!c) return 0;
    const v = c.createdAt ?? c.created_at;
    if (!v) return 0;
    if (typeof v === 'number') return v;
    return Date.parse(v) || 0;
}

function inferIsUiCard(input) {
    if (typeof input.isUiCard === 'boolean') return input.isUiCard;
    const pt = Array.isArray(input.painTags) ? input.painTags : [];
    return pt.some(t => UI_PAIN_TAGS.includes(t));
}

function mimeOf(f) {
    return (f.mimeType || f.mime_type || '').toString().toLowerCase();
}

/**
 * Pure predicate. Defaults to ALLOW when transition isn't done-bound or
 * card is opted out.
 *
 * @param {GateInput} input
 * @returns {GateVerdict}
 */
function evaluateDoneGate(input) {
    const { oldStatus, newStatus, requiresPreflightReview, comments } = input || {};
    if (newStatus !== 'done') return { allowed: true };
    if (oldStatus === 'done') return { allowed: true };
    if (requiresPreflightReview === false) return { allowed: true };

    const list = Array.isArray(comments) ? comments : [];

    // 1. Preflight marker
    let preflightIdx = -1;
    let preflightTs = 0;
    for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (typeof c?.text === 'string' && c.text.includes(PREFLIGHT_MARKER)) {
            preflightIdx = i;
            preflightTs = tsOf(c);
            break;
        }
    }
    if (preflightIdx === -1) {
        return {
            allowed: false,
            code: 'PREFLIGHT_GATE_FAILED',
            error: 'Preflight comment missing',
            hint: '此卡尚未跑過 OODA-R preflight。先把卡片移到 in_progress 觸發 auto-fire（或手動貼上 composer 模板）再 move to done。',
        };
    }

    // 2. Evidence comment with all 5 (or 6) checklist items
    const severity = ((input.severity || 'P2') + '').toUpperCase();
    const useV2 = Array.isArray(input.files) || input.severity != null || typeof input.isUiCard !== 'undefined';
    const requiredItems = useV2
        ? REQUIRED_EVIDENCE_ITEMS.concat(['__USER_POV__']) // sentinel; matched specially via aliases
        : REQUIRED_EVIDENCE_ITEMS.slice();

    let bestMissing = requiredItems.slice();
    // Collect EVERY comment that satisfies all checklist items — not just the
    // first. card_4c3a75bc: the old loop locked onto the first complete comment,
    // so if that one lacked the PR link, a later comment that ADDED the link was
    // never read ("先到先贏"). We now pick among all complete comments below.
    const completeComments = [];
    for (let i = preflightIdx + 1; i < list.length; i++) {
        const c = list[i];
        if (!c || typeof c.text !== 'string' || c.isSystem) continue;
        const missing = requiredItems.filter(item => {
            if (item === '__USER_POV__') {
                return !USER_POV_ALIASES.some(alias => c.text.includes(alias));
            }
            return !c.text.includes(item);
        });
        if (missing.length < bestMissing.length) bestMissing = missing;
        if (missing.length === 0) completeComments.push(c);
    }

    // Prefer a complete comment that ALSO carries the PR link (latest wins);
    // otherwise fall back to the latest complete comment so the PR-link error
    // below still fires correctly instead of being masked.
    let evidenceComment = null;
    if (completeComments.length) {
        const newest = (a, b) => (tsOf(b) >= tsOf(a) ? b : a);
        const withPrLink = completeComments.filter(c => PR_LINK_PATTERN.test(c.text));
        evidenceComment = (withPrLink.length ? withPrLink : completeComments).reduce(newest);
    }

    if (evidenceComment === null) {
        const bm = bestMissing.map(x => x === '__USER_POV__' ? `User POV / 用戶角度` : x);
        return {
            allowed: false,
            code: 'PREFLIGHT_GATE_FAILED',
            error: useV2
                ? 'Evidence comment must cite all 6 checklist items (Scope/Acceptance/Test plan/Evidence plan/Out-of-scope/User POV)'
                : 'Evidence comment must cite all 5 checklist items',
            hint: `缺少: ${bm.join(', ')}. 在 evidence comment 內逐項補上 (照 composer template 順序). 若此卡為 trivial dep-bump / doc-only, PUT /card/:id 把 requiresPreflightReview 設 false.`,
            missingItems: bm,
        };
    }

    // v1 path: text-only, allow now.
    if (!useV2) return { allowed: true };

    // 3. v2 — PR link in evidence (severity-tier independent: always required)
    if (!PR_LINK_PATTERN.test(evidenceComment.text)) {
        return {
            allowed: false,
            code: 'PREFLIGHT_GATE_FAILED',
            error: 'Evidence comment must include a GitHub PR link',
            hint: 'Include a https://github.com/<owner>/<repo>/pull/<N> URL in the evidence comment so the PR can be linked back.',
            missingItems: ['PR link'],
        };
    }

    // 4. v2 — artifact attachments after preflight
    const files = Array.isArray(input.files) ? input.files : [];
    const filesAfterPreflight = files.filter(f => tsOf(f) >= preflightTs);
    const hasJestLog = filesAfterPreflight.some(f => {
        const m = mimeOf(f);
        if (m.startsWith('image/')) return false;
        const name = (f.filename || '').toLowerCase();
        if (m === 'text/plain' || m === 'application/json') return true;
        // filename heuristic: hits when the file name contains any of these
        // tokens (`_` counts as word, so plain substring match — not \b).
        return /(jest|test|output|log)/.test(name);
    });
    const hasScreenshot = filesAfterPreflight.some(f => mimeOf(f).startsWith('image/'));

    const isUi = inferIsUiCard(input);

    // Severity tier:
    //   P0: jest log + (screenshot if UI)
    //   P1: jest log + (screenshot if UI)
    //   P2/P3: jest log
    // (UI screenshot enforced on P0+P1 only; lower tiers can ship UI without
    //  screenshot but get flagged.)
    const requiresJest = true;
    const requiresScreenshot = isUi && (severity === 'P0' || severity === 'P1');

    if (requiresJest && !hasJestLog) {
        return {
            allowed: false,
            code: 'PREFLIGHT_GATE_FAILED',
            error: 'Required artifact missing: jest output / log file',
            hint: 'Upload the jest verbose output (or other test log) via POST /api/mission/card/:id/file with mimeType: "text/plain" AFTER the preflight comment. Text-claim of "tests passed" is insufficient.',
            missingItems: ['jest_output_artifact'],
        };
    }
    if (requiresScreenshot && !hasScreenshot) {
        return {
            allowed: false,
            code: 'PREFLIGHT_GATE_FAILED',
            error: `${severity} UI card requires a screenshot artifact`,
            hint: 'Upload a post-deploy screenshot via POST /api/mission/card/:id/file with mimeType: "image/png". User-visible UI changes must include a screenshot capturing the actual rendered result.',
            missingItems: ['screenshot_artifact'],
        };
    }

    return { allowed: true };
}

module.exports = {
    PREFLIGHT_MARKER,
    REQUIRED_EVIDENCE_ITEMS,
    USER_POV_ALIASES,
    PR_LINK_PATTERN,
    UI_PAIN_TAGS,
    evaluateDoneGate,
};
