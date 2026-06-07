// OODA-R Phase 1 #3c — done-evidence gate predicate.
// Pure function: given a card + its comments + the transition shape, decide
// whether the move-to-done is allowed and (when blocked) what feedback to
// surface. Lives outside kanban.js so the predicate is unit-testable without
// the kanban router closure.

'use strict';

const PREFLIGHT_MARKER = '[OODA-R preflight';

// Five required evidence checklist items. The composer template uses these
// exact substrings; the gate just checks presence (text-only). Future
// upgrade: LLM sufficiency check.
const REQUIRED_EVIDENCE_ITEMS = Object.freeze([
    'Scope',
    'Acceptance',
    'Test plan',
    'Evidence plan',
    'Out-of-scope',
]);

/**
 * @typedef {Object} GateInput
 * @property {string} oldStatus
 * @property {string} newStatus
 * @property {boolean} [requiresPreflightReview]  default true
 * @property {Array<{text:string, isSystem:boolean, createdAt:string|number|Date}>} comments
 *           ordered oldest→newest
 */

/**
 * @typedef {Object} GateVerdict
 * @property {boolean} allowed
 * @property {string} [code]    'PREFLIGHT_GATE_FAILED' when blocked
 * @property {string} [error]
 * @property {string} [hint]
 * @property {string[]} [missingItems]  when blocked on evidence
 */

/**
 * Pure predicate. Defaults to ALLOW when the transition is not done-bound
 * or when the card has explicitly opted out.
 * @param {GateInput} input
 * @returns {GateVerdict}
 */
function evaluateDoneGate(input) {
    const { oldStatus, newStatus, requiresPreflightReview, comments } = input || {};
    if (newStatus !== 'done') return { allowed: true };
    if (oldStatus === 'done') return { allowed: true };
    if (requiresPreflightReview === false) return { allowed: true };

    const list = Array.isArray(comments) ? comments : [];

    let preflightIdx = -1;
    for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (typeof c?.text === 'string' && c.text.includes(PREFLIGHT_MARKER)) {
            preflightIdx = i;
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

    // Evidence must be in a non-system comment AFTER the preflight, and must
    // cite all five required items.
    let bestMissing = REQUIRED_EVIDENCE_ITEMS.slice();
    for (let i = preflightIdx + 1; i < list.length; i++) {
        const c = list[i];
        if (!c || typeof c.text !== 'string') continue;
        if (c.isSystem) continue;
        const missing = REQUIRED_EVIDENCE_ITEMS.filter(item => !c.text.includes(item));
        if (missing.length === 0) {
            return { allowed: true };
        }
        if (missing.length < bestMissing.length) bestMissing = missing;
    }

    return {
        allowed: false,
        code: 'PREFLIGHT_GATE_FAILED',
        error: 'Evidence comment must cite all 5 checklist items',
        hint: `缺少: ${bestMissing.join(', ')}. 在 evidence comment 內逐項補上 (照 composer template 的 5 點 checklist 順序). 若此卡為 trivial dep-bump / doc-only, PUT /card/:id 把 requiresPreflightReview 設 false.`,
        missingItems: bestMissing,
    };
}

module.exports = {
    PREFLIGHT_MARKER,
    REQUIRED_EVIDENCE_ITEMS,
    evaluateDoneGate,
};
