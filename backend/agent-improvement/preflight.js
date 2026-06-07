// OODA-R Phase 1 #3a — preflight composer.
// Card: card_50dccd356888b22d6654e85a
// Parent: card_be59aa034883fe36d3645a27
//
// Given a card (title + description), produce the markdown text of the
// preflight comment that should appear when the card transitions to
// in_progress:
//   1. "本任務如何避免過往同類錯誤" — bullets mined from prior episodes
//      that share painTags with the card's classified taxonomy
//   2. Required scope / acceptance / test / evidence-plan checklist
//
// Pure-data: takes a card + already-loaded episodes (+ optional recent
// PR risks). The route layer is responsible for fetching the episodes;
// this module never touches the DB or the network. That's the seam
// that keeps the composer unit-testable and lets #3b wire it into the
// kanban move hook without reshape.

'use strict';

const { classifyPainTags } = require('./classifier');

/**
 * Rank prior episodes by how many of their painTags overlap the card's
 * classified taxonomy. Ties broken by occurredAt DESC.
 *
 * @param {string[]} cardTaxonomy   painTags emitted from the card text
 * @param {object[]} allEpisodes    candidates (shape: validateEpisode-compatible)
 * @param {number} [limit=5]
 * @returns {object[]}
 */
function selectSimilarEpisodes(cardTaxonomy, allEpisodes, limit = 5) {
    if (!Array.isArray(cardTaxonomy) || cardTaxonomy.length === 0) return [];
    if (!Array.isArray(allEpisodes)) return [];
    const cardSet = new Set(cardTaxonomy);
    const scored = [];
    for (const ep of allEpisodes) {
        const tags = Array.isArray(ep.painTags) ? ep.painTags : [];
        let overlap = 0;
        for (const t of tags) if (cardSet.has(t)) overlap++;
        if (overlap === 0) continue;
        scored.push({ ep, overlap, ts: Date.parse(ep.occurredAt) || 0 });
    }
    scored.sort((a, b) => (b.overlap - a.overlap) || (b.ts - a.ts));
    return scored.slice(0, limit).map(s => s.ep);
}

/**
 * Mine the one-line "lesson learned" from an episode. Prefers a missedCheck
 * (it says what would have caught the bug) over the userFeedback (which
 * says what hurt). Returns empty string when nothing useful is on the record.
 *
 * @param {object} ep
 * @returns {string}
 */
function extractLessons(ep) {
    if (!ep || typeof ep !== 'object') return '';
    if (Array.isArray(ep.missedChecks) && ep.missedChecks.length > 0) {
        return ep.missedChecks[0];
    }
    if (typeof ep.userFeedback === 'string' && ep.userFeedback.trim()) {
        return ep.userFeedback.trim();
    }
    if (typeof ep.userVisibleResult === 'string' && ep.userVisibleResult.trim()) {
        return ep.userVisibleResult.trim();
    }
    return '';
}

function formatEpisodeCite(ep) {
    const parts = [];
    if (ep.cardId) parts.push(ep.cardId);
    if (ep.severity) parts.push(ep.severity);
    return parts.length ? `[${parts.join(' · ')}]` : '';
}

/**
 * Compose the preflight comment markdown for a card.
 *
 * @param {object} params
 * @param {string} params.cardTitle
 * @param {string} [params.cardDescription]
 * @param {object[]} [params.similarEpisodes]   already-ranked, top-K
 * @param {object[]} [params.recentRisks]       shape: { ref, summary }; populated by #3b's git scanner
 * @param {string} [params.taskType]            optional taskType hint for classifier
 * @returns {string}
 */
function composePreflightComment({
    cardTitle = '',
    cardDescription = '',
    similarEpisodes = [],
    recentRisks = [],
    taskType,
} = {}) {
    const text = `${cardTitle}\n\n${cardDescription}`;
    const taxonomy = classifyPainTags(text, taskType);

    const lines = [];
    lines.push('[OODA-R preflight — auto-composed]');
    lines.push('');
    lines.push(`Classified painTags: \`${taxonomy.join('`, `')}\``);
    lines.push('');

    lines.push('## 本任務如何避免過往同類錯誤');
    if (similarEpisodes.length === 0) {
        lines.push('No prior episodes match this taxonomy yet. This is the first task in its category — fill the missedChecks field thoroughly when closing.');
    } else {
        for (const ep of similarEpisodes) {
            const lesson = extractLessons(ep);
            if (!lesson) continue;
            const cite = formatEpisodeCite(ep);
            lines.push(`- ${cite ? cite + ' ' : ''}${lesson}`);
        }
    }
    lines.push('');

    if (recentRisks.length > 0) {
        lines.push('## Recent same-area PR risks');
        for (const r of recentRisks) {
            lines.push(`- ${r.ref}: ${r.summary}`);
        }
        lines.push('');
    }

    lines.push('## Required checklist (fill before moving to done)');
    lines.push('- [ ] **Scope** — what files / endpoints / surfaces will change; what stays untouched');
    lines.push('- [ ] **Acceptance** — concrete, verifiable conditions; no "should work" language');
    lines.push('- [ ] **Test plan** — specific commands; jest test names if unit; URL if E2E');
    lines.push('- [ ] **Evidence plan** — where the post-run proof will live (PR link, screenshot, jest output file)');
    lines.push('- [ ] **Out-of-scope** — explicit deferral list so the close-out can be audited');
    lines.push('');
    lines.push('Move to done ONLY after evidence comment cites all five items.');

    return lines.join('\n');
}

module.exports = {
    composePreflightComment,
    selectSimilarEpisodes,
    extractLessons,
};
