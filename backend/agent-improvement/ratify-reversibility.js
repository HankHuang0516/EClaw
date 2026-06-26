// 計畫E ratify-loop — reversibility/low-risk GREEN-LIGHT predicate (card_e9d01b6e).
//
// Decides whether an agent-consensus decision may be armed for *passive
// default-agree* (silence ⇒ the decided option ships) versus must HOLD for an
// explicit owner tap.
//
// 🔑 DESIGN INVARIANT (the whole point — see the card's design comment): the
// owner-decision classifier is a VETO ONLY, never the green light. It DEFAULTS
// ownerOnly=false (tuned to keep the 需要你 inbox short → its failure mode is a
// false-NEGATIVE). For *surfacing* a false-negative is benign; for *default-
// agree* the polarity flips and a false-negative would auto-ship an irreversible
// change = fail-OPEN. So the green light is this SEPARATE, fail-CLOSED predicate:
// a small reversible-class allowlist AND a branch-first prove (prUrl) AND a
// diff/path scanner for irreversible-once-merged changes the lexicon can't see
// (migrations, DROP/TRUNCATE, billing/auth/secret/deploy paths, fs.unlink) AND
// the classifier not vetoing. ANY missing/unknown/oversized input ⇒ 'hold'.
//
// Pure, no DB/network. Imports classifyOwnerDecision for the veto only.

'use strict';

const { classifyOwnerDecision } = require('./owner-decision-classifier');

// Only these change-classes are ever eligible for passive default-agree. Anything
// else (or an unrecognised value) is NOT reversible-by-construction → hold.
const ALLOWED_CLASSES = Object.freeze(new Set([
    'config_toggle',        // a reversible feature-flag / pref flip
    'copy_text',            // user-facing copy / i18n string
    'reversible_code_branch', // ordinary code on an UNMERGED branch (revert = drop branch)
    'doc',                  // docs / comments only
]));

// Cap on the text we will scan — an oversized/binary diff is un-auditable → hold.
const MAX_DIFF_CHARS = 200000;

// Changed-file paths that make a change irreversible-once-merged or high-blast —
// these the keyword classifier cannot see (it only reads prose). Case-insensitive.
const DENY_PATH_RES = Object.freeze([
    /(^|\/)migrations?\//i,           // DB migrations
    /_schema\.sql$/i,                 // schema DDL
    /\.sql$/i,                        // any raw SQL file
    /(^|\/)(billing|payments?|wallet|stripe)\b/i, // money paths
    /(^|\/)(auth|oauth|session|login|password|credential)/i, // authn/z paths
    /(secret|vault|\.env|private[_-]?key)/i,      // secrets
    /(^|\/)(Dockerfile|Procfile|nixpacks\.toml|railway\.(json|toml)|fly\.toml)$/i, // deploy/infra
    /\.github\/workflows\//i,         // CI definitions
]);

// Diff-content patterns that are destructive/irreversible regardless of path.
const DENY_DIFF_RES = Object.freeze([
    /\bDROP\s+(TABLE|COLUMN|DATABASE|SCHEMA|INDEX)\b/i,
    /\bTRUNCATE\b/i,
    /\bALTER\s+TABLE\b[\s\S]{0,80}?\bDROP\b/i,
    /\bDELETE\s+FROM\b(?![\s\S]{0,200}?\bWHERE\b)/i, // DELETE without a WHERE in the next ~200 chars
    /\bfs\.(unlink|rm|rmdir)\b/i,
    /\brm\s+-rf\b/i,
    /\bdropDatabase\b/i,
]);

/**
 * @typedef {Object} RatifyInput
 * @property {string}   proposalText        the action-request prompt / what the agents decided about
 * @property {string}   decidedOptionLabel  the chosen option's STRING (load-bearing — feed it to the veto)
 * @property {string}   reversibilityClass  one of ALLOWED_CLASSES (anything else ⇒ hold)
 * @property {string[]} [changedFiles]      paths the PR touches (for the path scanner)
 * @property {string}   [diffSummary]       unified diff or summary text (for the content scanner)
 * @property {string}   [prUrl]             branch-first prove; absent ⇒ hold
 * @property {string}   [relatedCardText]   optional extra context (title/desc/comment) for the veto
 */

/**
 * @typedef {Object} RatifyVerdict
 * @property {('default_agree'|'hold')} mode
 * @property {string[]} holdReasons   why it is HOLD (empty when default_agree)
 * @property {string}   summary
 */

function isHttpUrl(u) {
    return typeof u === 'string' && /^https?:\/\/[^\s]+$/i.test(u.trim());
}

/**
 * Fail-closed green-light predicate. Returns mode='default_agree' ONLY when every
 * condition holds; otherwise 'hold' with the specific reasons.
 * @param {RatifyInput} input
 * @returns {RatifyVerdict}
 */
function classifyRatifyMode(input) {
    const holdReasons = [];
    const inp = (input && typeof input === 'object') ? input : {};

    const proposalText = typeof inp.proposalText === 'string' ? inp.proposalText : '';
    const decidedOptionLabel = typeof inp.decidedOptionLabel === 'string' ? inp.decidedOptionLabel : '';
    const cls = typeof inp.reversibilityClass === 'string' ? inp.reversibilityClass.trim() : '';
    const changedFiles = Array.isArray(inp.changedFiles) ? inp.changedFiles.filter(f => typeof f === 'string') : null;
    const diffSummary = typeof inp.diffSummary === 'string' ? inp.diffSummary : '';
    const prUrl = inp.prUrl;
    const relatedCardText = typeof inp.relatedCardText === 'string' ? inp.relatedCardText : '';

    // 1. Reversibility class must be in the allowlist (unknown/missing ⇒ hold).
    if (!ALLOWED_CLASSES.has(cls)) {
        holdReasons.push(`reversibility_class_not_allowed:${cls || 'missing'}`);
    }

    // 2. Branch-first prove: a real PR URL must be present (revert = drop the
    //    unmerged branch; without a PR there is nothing cheap to revert).
    if (!isHttpUrl(prUrl)) {
        holdReasons.push('missing_or_invalid_pr_url');
    }

    // 3. We must actually have something to scan. A claim with neither changed
    //    files nor a diff is un-auditable → hold (fail-closed).
    if ((!changedFiles || changedFiles.length === 0) && !diffSummary.trim()) {
        holdReasons.push('no_changed_files_or_diff_to_audit');
    }
    // Oversized/binary diff can't be audited → hold.
    if (diffSummary.length > MAX_DIFF_CHARS) {
        holdReasons.push('diff_too_large_to_audit');
    }

    // 4. Path scanner — any dangerous/irreversible-once-merged path ⇒ hold.
    if (changedFiles) {
        for (const f of changedFiles) {
            const hit = DENY_PATH_RES.find(re => re.test(f));
            if (hit) { holdReasons.push(`danger_path:${f}`); break; }
        }
    }

    // 5. Diff-content scanner — destructive SQL / fs ops ⇒ hold.
    if (diffSummary) {
        const hit = DENY_DIFF_RES.find(re => re.test(diffSummary));
        if (hit) { holdReasons.push(`destructive_diff:${hit.source.slice(0, 24)}`); }
    }

    // 6. Owner-decision VETO (necessary, NOT sufficient): if the proposal/decided
    //    option reads as owner-only, force hold. (Never used as the green light.)
    const vetoText = [proposalText, decidedOptionLabel, relatedCardText].filter(Boolean).join('\n');
    let veto = { ownerOnly: true, categories: ['veto_eval_failed'] };
    try {
        veto = classifyOwnerDecision(vetoText);
    } catch (_) {
        holdReasons.push('classifier_veto_threw'); // fail-closed
    }
    if (veto && veto.ownerOnly) {
        holdReasons.push(`owner_decision_veto:${(veto.categories || []).join(',') || 'ownerOnly'}`);
    }

    const mode = holdReasons.length === 0 ? 'default_agree' : 'hold';
    return {
        mode,
        holdReasons,
        summary: mode === 'default_agree'
            ? `reversible/low-risk (${cls}) with PR + clean diff/path + no owner veto → eligible for passive default-agree`
            : `HOLD — ${holdReasons.join('; ')}`,
    };
}

module.exports = {
    classifyRatifyMode,
    ALLOWED_CLASSES,
    MAX_DIFF_CHARS,
    DENY_PATH_RES,
    DENY_DIFF_RES,
};
