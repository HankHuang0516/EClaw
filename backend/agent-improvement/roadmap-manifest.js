// OODA-R Phase 4 #9 — public roadmap manifest.
// Card: card_5ac74610cbf1f89440427809
//
// Maps the 9 self-improvement roadmap items to their kanban card IDs so the
// public /portal/roadmap.html tracker can pull LIVE status (todo / in_progress
// / shipped) instead of the hard-coded badges that were there before.
//
// Why a manifest module rather than reading the roadmap from the DB directly:
//   - The roadmap is a curated narrative (9 items, 4 phases) that does NOT map
//     1:1 to every kanban card; the manifest is the editorial source of truth
//     for WHICH cards are public and in WHAT order.
//   - It carries no secrets — only public card IDs + display labels + PR links
//     that already appear on the public roadmap page today.
//   - The route layer joins this manifest against kanban_cards.status so the
//     public page never needs a botSecret (the old /cards endpoint requires one).
//
// Each item's `cardId` is looked up in kanban_cards at request time; the live
// `status` overrides the manifest's `fallbackStatus` when the card is found.
// fallbackStatus exists so the page degrades gracefully if a card was archived
// or the device board is unavailable.

'use strict';

/**
 * Kanban status → public tracker status. The public page only speaks three
 * words; internal statuses collapse into them. Single source of truth so the
 * endpoint and any test agree.
 * @type {Readonly<Record<string,string>>}
 */
const KANBAN_TO_PUBLIC = Object.freeze({
    backlog: 'todo',
    todo: 'todo',
    in_progress: 'in_progress',
    review: 'in_progress',
    done: 'shipped',
    blocked: 'todo', // blocked is still "not shipped" from a user's POV
});

/** @type {readonly string[]} */
const PUBLIC_STATUSES = Object.freeze(['todo', 'in_progress', 'shipped']);

/**
 * @param {string} kanbanStatus
 * @returns {string} one of PUBLIC_STATUSES
 */
function toPublicStatus(kanbanStatus) {
    return KANBAN_TO_PUBLIC[kanbanStatus] || 'todo';
}

/**
 * @typedef {Object} RoadmapItem
 * @property {string} id            stable slug used as the i18n / DOM anchor
 * @property {number} phase         0..4
 * @property {number} num           1..9 (the roadmap's item number)
 * @property {string} cardId        kanban card backing this item
 * @property {string} title         English display title (i18n key = `rm_oodar_${id}`)
 * @property {string} fallbackStatus  public status used when the card is missing
 * @property {string} [pr]          PR URL to surface as the "ship proof" link
 */

/**
 * The 9-item OODA-R roadmap. cardIds are the real Phase 0–4 subcards under
 * parent card_be59aa034883fe36d3645a27 (see fixtures/episodes.js + roadmap.html
 * narrative). PRs are the ones already cited on the public page.
 * @type {readonly RoadmapItem[]}
 */
const ROADMAP_ITEMS = Object.freeze([
    { id: 'p0-1-taxonomy', phase: 0, num: 1, cardId: 'card_e9de7607cd9a838462148328', title: 'Pain taxonomy + episode schema', fallbackStatus: 'shipped', pr: 'https://github.com/HankHuang0516/EClaw/pull/3226' },
    { id: 'p0-2-ingest',   phase: 0, num: 2, cardId: 'card_af7d8bb1c7c74',            title: 'Feedback ingestion bridge',       fallbackStatus: 'shipped', pr: 'https://github.com/HankHuang0516/EClaw/pull/3227' },
    { id: 'p1-3-preflight', phase: 1, num: 3, cardId: 'card_50dccd356888b22d6654e85a', title: 'Task-start preflight lint',       fallbackStatus: 'shipped', pr: 'https://github.com/HankHuang0516/EClaw/pull/3228' },
    { id: 'p1-4-done-gate', phase: 1, num: 4, cardId: 'card_337040389de34bcb65cf0cb0', title: 'Done-evidence gate + anti-laziness guard', fallbackStatus: 'shipped', pr: 'https://github.com/HankHuang0516/EClaw/pull/3230' },
    { id: 'p2-5-offline',  phase: 2, num: 5, cardId: 'card_47ed9a0c21dd507d3b726136', title: 'Offline delivery queue + reconnect replay', fallbackStatus: 'todo' },
    { id: 'p2-6-auth',     phase: 2, num: 6, cardId: 'card_214d48e395e812b3e909e5ca', title: 'Auth/session persistence + refresh diagnostics', fallbackStatus: 'todo' },
    { id: 'p2-7-redirect', phase: 2, num: 7, cardId: 'card_14571f26914b9c1eae148362', title: 'Unified App/Web redirect state machine', fallbackStatus: 'todo' },
    { id: 'p3-8-e2e',      phase: 3, num: 8, cardId: 'card_42ffca0d29ce22b369d55ca4', title: 'Cross-surface E2E matrix for top workflows', fallbackStatus: 'todo' },
    { id: 'p4-9-promote',  phase: 4, num: 9, cardId: 'card_5ac74610cbf1f89440427809', title: 'Rule promotion engine + public roadmap tracker', fallbackStatus: 'in_progress' },
]);

/**
 * Build the public tracker payload by joining the manifest against a map of
 * cardId → { status, updatedAt }. Pure — the route layer supplies the map from
 * a single SQL query. Items whose card is absent fall back to fallbackStatus.
 *
 * @param {Record<string,{status?:string, updatedAt?:string|Date}>} cardStatusById
 * @returns {{items:Array, generatedAt:string}}
 */
function buildTrackerPayload(cardStatusById = {}) {
    const items = ROADMAP_ITEMS.map((it) => {
        const row = cardStatusById[it.cardId];
        const live = row && row.status ? toPublicStatus(row.status) : null;
        const updatedAt = row && row.updatedAt
            ? (row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt))
            : null;
        return {
            id: it.id,
            phase: it.phase,
            num: it.num,
            cardId: it.cardId,
            title: it.title,
            status: live || it.fallbackStatus,
            live: !!live,
            updatedAt,
            pr: it.pr || null,
        };
    });
    return { items, generatedAt: new Date().toISOString() };
}

module.exports = {
    KANBAN_TO_PUBLIC,
    PUBLIC_STATUSES,
    toPublicStatus,
    ROADMAP_ITEMS,
    buildTrackerPayload,
};
