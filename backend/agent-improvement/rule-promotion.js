// OODA-R Phase 4 #9 — rule promotion engine.
// Card: card_5ac74610cbf1f89440427809
// Parent: card_be59aa034883fe36d3645a27
//
// This is the "Reinforce" step of the OODA-R loop (see roadmap.html
// #ai-agent-self-improvement). When the SAME pain taxonomy keeps re-firing
// across episodes, a one-off lesson on a single card is not enough — the
// learning must be *promoted* into an enforced rule (a new SOP entry, a CI
// check, a lint rule, or a required checklist item) so the next agent cannot
// re-ship the same class of failure.
//
// Design seam (mirrors preflight.js / done-gate.js): this module is PURE.
// It takes an already-loaded list of episodes (validateEpisode-compatible
// shape) and returns deterministic suggestion objects + a meta-PR draft body.
// It NEVER touches the DB, the network, or the GitHub API — the route/cron
// layer is responsible for fetching episodes and actually opening the PR.
// That keeps the promotion logic unit-testable with fixed input → fixed
// output, which is exactly what the acceptance criteria asks for.
//
// "N consecutive warnings" semantics: episodes are sorted by occurredAt ASC;
// for each painTag we find the longest *trailing* run of episodes carrying
// that tag (most recent N in a row). A run of length >= threshold for a tag
// triggers a promotion suggestion. "Consecutive" is evaluated per-tag over
// the chronologically-ordered episode stream so an unrelated episode in the
// middle breaks the run (the same failure must keep recurring, not merely
// have happened N times ever).

'use strict';

const { PAIN_TAXONOMY_SET } = require('./episode-schema');

/**
 * Default promotion threshold. Hank's done-retro slot on this card asks
 * "rule 提升閾值 N=? 是否需要按 pain axis 分級?" — answered here: the base
 * threshold is 3 (three consecutive same-axis warnings = systemic, not noise),
 * but severity-bearing axes promote faster via SEVERITY_THRESHOLD_OVERRIDE so
 * a P0 class doesn't have to re-hurt the user three times before it is gated.
 * @type {number}
 */
const DEFAULT_THRESHOLD = 3;

/**
 * Per-severity threshold override. The MINIMUM (most aggressive) threshold
 * among the episodes in a run wins — a single P0 in the run pulls the whole
 * run's bar down to 2. Tunable so the engine can re-tune itself later (this
 * card is self-recursive: if N is miscalibrated, a later episode promotes a
 * change to these numbers).
 * @type {Readonly<Record<string, number>>}
 */
const SEVERITY_THRESHOLD_OVERRIDE = Object.freeze({
    P0: 2,
    P1: 3,
    P2: 3,
    P3: 4,
});

/**
 * The four enforcement vehicles a lesson can be promoted into. The engine
 * picks one per pain axis via PAIN_AXIS_TO_VEHICLE so the meta-PR has a
 * concrete, actionable target instead of a vague "add a rule".
 * @type {readonly string[]}
 */
const RULE_VEHICLES = Object.freeze(['sop', 'ci_check', 'lint', 'checklist']);

/**
 * Map each pain axis to the enforcement vehicle that best fits its failure
 * mode. Code-shaped pains (test coverage, redirect) get machine-enforced
 * vehicles (CI / lint); process-shaped pains (ownership, task context) get
 * human-enforced vehicles (SOP / checklist). Deterministic — same axis always
 * yields the same vehicle, which keeps the suggestion shape stable for tests.
 * @type {Readonly<Record<string, {vehicle:string, target:string}>>}
 */
const PAIN_AXIS_TO_VEHICLE = Object.freeze({
    delivery_reliability: { vehicle: 'ci_check', target: 'CI: offline-queue replay + delivery-state E2E must pass before merge' },
    auth_session:         { vehicle: 'ci_check', target: 'CI: session-persistence + refresh-mutex E2E must pass before merge' },
    redirect_deeplink:    { vehicle: 'lint',     target: 'Lint: deep-link / redirect changes must carry a traceId + canonical-route assertion' },
    ux_feedback:          { vehicle: 'checklist', target: 'Required checklist: every UI card cites a before/after screenshot showing the visible delta' },
    agent_ownership:      { vehicle: 'sop',      target: 'SOP: explicit owner + heartbeat cadence declared on card before in_progress' },
    task_context:         { vehicle: 'sop',      target: 'SOP: Task Contract (scope/acceptance/test/evidence) published at preflight' },
    test_coverage:        { vehicle: 'ci_check', target: 'CI: cross-surface E2E matrix gate blocks merge on failure' },
    scope_completeness:   { vehicle: 'checklist', target: 'Required checklist: done-gate evidence comment with all 6 items + artifacts' },
});

/**
 * Stable ISO timestamp parse → epoch ms, with a deterministic tiebreaker so
 * episodes that share an occurredAt keep a stable order (by cardId) instead of
 * relying on input order. NaN dates sort to the front (treated as oldest).
 * @param {object} ep
 * @returns {number}
 */
function epMs(ep) {
    const t = Date.parse(ep && ep.occurredAt);
    return Number.isNaN(t) ? 0 : t;
}

/**
 * Sort episodes chronologically ASC, deterministically. Pure — returns a new
 * array, does not mutate the input.
 * @param {object[]} episodes
 * @returns {object[]}
 */
function sortChronological(episodes) {
    return episodes
        .slice()
        .sort((a, b) => (epMs(a) - epMs(b)) || String(a.cardId || '').localeCompare(String(b.cardId || '')));
}

/**
 * For one pain axis, find the longest TRAILING consecutive run of episodes
 * carrying that tag in the chronologically-sorted stream. "Trailing" = the run
 * must include the most recent episode that has the tag, AND not be interrupted
 * by a later episode that lacks it. We walk the sorted stream and reset the run
 * whenever an episode without the tag appears, so the returned run is the
 * current unbroken streak ending at the latest tagged episode.
 *
 * @param {string} tag
 * @param {object[]} sorted   chronological ASC
 * @returns {object[]}        the trailing run (may be empty)
 */
function trailingRunForTag(tag, sorted) {
    let run = [];
    for (const ep of sorted) {
        const tags = Array.isArray(ep.painTags) ? ep.painTags : [];
        if (tags.includes(tag)) {
            run.push(ep);
        } else {
            run = [];
        }
    }
    return run;
}

/**
 * The most aggressive (lowest) threshold implied by a run's severities.
 * @param {object[]} run
 * @returns {number}
 */
function effectiveThreshold(run) {
    let best = DEFAULT_THRESHOLD;
    for (const ep of run) {
        const sev = ep && ep.severity;
        const override = SEVERITY_THRESHOLD_OVERRIDE[sev];
        if (typeof override === 'number' && override < best) best = override;
    }
    return best;
}

/**
 * @typedef {Object} PromotionSuggestion
 * @property {string} painTag            the axis that keeps re-firing
 * @property {string} vehicle            one of RULE_VEHICLES
 * @property {string} ruleTarget         concrete rule text to enforce
 * @property {number} consecutiveCount   length of the trailing run
 * @property {number} threshold          the threshold this run cleared
 * @property {('P0'|'P1'|'P2'|'P3')} highestSeverity   most severe in the run
 * @property {string[]} supportingCardIds episodes (cardIds) backing the suggestion
 * @property {object[]} supportingEpisodes the actual episode objects (chrono ASC)
 * @property {string} suggestionId       deterministic id: `promote:<tag>:<lastCardId>`
 */

const SEVERITY_RANK = Object.freeze({ P0: 0, P1: 1, P2: 2, P3: 3 });

function highestSeverity(run) {
    let best = 'P3';
    for (const ep of run) {
        const sev = ep && ep.severity;
        if (sev in SEVERITY_RANK && SEVERITY_RANK[sev] < SEVERITY_RANK[best]) best = sev;
    }
    return best;
}

/**
 * Evaluate a set of episodes and return one promotion suggestion per pain axis
 * whose trailing consecutive run meets its threshold. Deterministic: same input
 * episodes → identical suggestions array (sorted by severity then painTag).
 *
 * @param {object[]} episodes               validateEpisode-compatible objects
 * @param {object} [opts]
 * @param {number} [opts.threshold]         override DEFAULT_THRESHOLD globally
 * @param {Record<string,number>} [opts.severityOverride]  override per-severity bars
 * @returns {PromotionSuggestion[]}
 */
function evaluatePromotions(episodes, opts = {}) {
    if (!Array.isArray(episodes) || episodes.length === 0) return [];
    const sorted = sortChronological(episodes);

    // Collect every painTag actually present in the stream (closed-set guarded).
    const tagsPresent = new Set();
    for (const ep of sorted) {
        const tags = Array.isArray(ep.painTags) ? ep.painTags : [];
        for (const t of tags) if (PAIN_TAXONOMY_SET.has(t)) tagsPresent.add(t);
    }

    const suggestions = [];
    for (const tag of tagsPresent) {
        const run = trailingRunForTag(tag, sorted);
        if (run.length === 0) continue;

        let bar = typeof opts.threshold === 'number' ? opts.threshold : effectiveThreshold(run);
        if (opts.severityOverride) {
            // Recompute bar against caller-supplied overrides.
            let best = typeof opts.threshold === 'number' ? opts.threshold : DEFAULT_THRESHOLD;
            for (const ep of run) {
                const o = opts.severityOverride[ep && ep.severity];
                if (typeof o === 'number' && o < best) best = o;
            }
            bar = best;
        }

        if (run.length < bar) continue;

        const veh = PAIN_AXIS_TO_VEHICLE[tag] || { vehicle: 'sop', target: `SOP: codify a guard for repeated ${tag} failures` };
        const lastCardId = run[run.length - 1].cardId || 'unknown';
        suggestions.push({
            painTag: tag,
            vehicle: veh.vehicle,
            ruleTarget: veh.target,
            consecutiveCount: run.length,
            threshold: bar,
            highestSeverity: highestSeverity(run),
            supportingCardIds: run.map(e => e.cardId).filter(Boolean),
            supportingEpisodes: run,
            suggestionId: `promote:${tag}:${lastCardId}`,
        });
    }

    suggestions.sort((a, b) =>
        (SEVERITY_RANK[a.highestSeverity] - SEVERITY_RANK[b.highestSeverity]) ||
        a.painTag.localeCompare(b.painTag));
    return suggestions;
}

/**
 * Render the markdown body for the meta-PR that proposes a single rule
 * promotion. Includes the N supporting episodes (cardId · severity · the
 * lesson / missedCheck) so a reviewer can audit the basis. Deterministic
 * string output — secrets never appear because we only echo cardId / severity /
 * missedChecks (the episode schema already forbids secret-shaped substrings,
 * and assertNoSecrets is the upstream guard at ingest time).
 *
 * @param {PromotionSuggestion} s
 * @returns {string}
 */
function renderMetaPrBody(s) {
    if (!s || typeof s !== 'object') return '';
    const lines = [];
    lines.push('## OODA-R rule promotion (auto-suggested)');
    lines.push('');
    lines.push(`The \`${s.painTag}\` pain axis fired **${s.consecutiveCount} consecutive** warnings ` +
        `(threshold ${s.threshold}, highest severity ${s.highestSeverity}). Promoting the lesson into an enforced rule.`);
    lines.push('');
    lines.push('### Proposed rule');
    lines.push(`- **Vehicle**: \`${s.vehicle}\``);
    lines.push(`- **Enforce**: ${s.ruleTarget}`);
    lines.push('');
    lines.push(`### Supporting episodes (${s.supportingEpisodes.length})`);
    for (const ep of s.supportingEpisodes) {
        const lesson = (Array.isArray(ep.missedChecks) && ep.missedChecks[0])
            || ep.userFeedback
            || ep.userVisibleResult
            || ep.deliverable
            || '(no lesson recorded)';
        lines.push(`- [${ep.cardId || 'unknown'} · ${ep.severity || '?'}] ${lesson}`);
    }
    lines.push('');
    lines.push('### Reinforce checklist');
    lines.push(`- [ ] Implement the ${s.vehicle} above`);
    lines.push('- [ ] Add/extend a test that fails when the rule is violated');
    lines.push('- [ ] Cross-link this PR back to the supporting episode cards');
    lines.push('- [ ] Write a promotion episode (regressed-axis / supporting count / proposed rule)');
    lines.push('');
    lines.push(`<!-- suggestionId: ${s.suggestionId} -->`);
    return lines.join('\n');
}

/**
 * Convenience: produce a "draft" object the route/cron layer can hand to the
 * GitHub API (it constructs title + body + a stable branch name). Still pure —
 * does not call GitHub.
 * @param {PromotionSuggestion} s
 * @returns {{title:string, body:string, branch:string, suggestionId:string}}
 */
function buildMetaPrDraft(s) {
    return {
        title: `chore(oodar): promote ${s.painTag} lesson to ${s.vehicle} rule`,
        body: renderMetaPrBody(s),
        branch: `oodar/promote-${s.painTag.replace(/_/g, '-')}`,
        suggestionId: s.suggestionId,
    };
}

module.exports = {
    DEFAULT_THRESHOLD,
    SEVERITY_THRESHOLD_OVERRIDE,
    RULE_VEHICLES,
    PAIN_AXIS_TO_VEHICLE,
    sortChronological,
    trailingRunForTag,
    effectiveThreshold,
    highestSeverity,
    evaluatePromotions,
    renderMetaPrBody,
    buildMetaPrDraft,
};
