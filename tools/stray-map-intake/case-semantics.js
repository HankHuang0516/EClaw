'use strict';
// Pure/private case semantics for the synthetic rehearsal. No matching/publication side effects.
const { temporal, definitelyAfter, reportSemantics, temporalBounds } = require('./contract');
const UNKNOWN = () => ({ precision: 'UNKNOWN', value: null, timeZone: null });
const EVENTS = ['EXPLICIT_CLOSED', 'PRESENT', 'ABSENT', 'TEMPORARY_FAILURE'];
function sourceState(row) {
    return row.sourceState || { caseStatus: 'NOT_CONFIRMED_CLOSED', availability: 'PRESENT',
        sourceChangedAt: UNKNOWN(), lastCheckedAt: row.receipt.submittedAt, reunionStatus: 'UNVERIFIED' };
}
function visibleSource(row) {
    const state = sourceState(row);
    return state.caseStatus !== 'CLOSED_BY_SOURCE' && state.availability === 'PRESENT';
}
function publiclyVisible(row) {
    return row.review.status === 'APPROVED' && row.review.publicVisible === true && row.mapPolicy !== 'NEVER' && visibleSource(row);
}
function validateSourceEvent(event, policy, now) {
    const keys = ['eventKey', 'publisherId', 'datasetId', 'recordKey', 'type', 'sourceChangedAt'];
    if (!event || typeof event !== 'object' || Array.isArray(event) || Object.getPrototypeOf(event) !== Object.prototype
        || Object.keys(event).length !== keys.length || !keys.every(key => Object.hasOwn(event, key))
        || !EVENTS.includes(event.type) || typeof event.eventKey !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(event.eventKey)
        || typeof event.recordKey !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(event.recordKey)) return false;
    if (!policy || policy.verified !== true || event.publisherId !== policy.publisherId || event.datasetId !== policy.datasetId) return false;
    const changed = temporal(event.sourceChangedAt);
    return changed !== null && !definitelyAfter(changed, { precision: 'INSTANT', value: now, timeZone: 'UTC' });
}
function matchingSuggestions(receipts) {
    const eligible = Object.entries(receipts).filter(([, row]) => visibleSource(row) && row.mapPolicy !== 'NEVER'
        && ['PENDING', 'APPROVED'].includes(row.review.status) && row.payload.schemaVersion === 3);
    const lost = eligible.filter(([, row]) => row.payload.report.type === 'LOST');
    const found = eligible.filter(([, row]) => row.payload.report.type === 'FOUND');
    const items = [], ranges = new Map(); let comparisons = 0;
    const range = (id, row) => {
        if (!ranges.has(id)) ranges.set(id, temporalBounds(row.payload.observation));
        return ranges.get(id);
    };
    const result = truncated => ({ items, manualOnly: true, suggestionLimit: 100, comparisonLimit: 2000, truncated });
    for (const [lostTipId, a] of lost) for (const [foundTipId, b] of found) {
        if (++comparisons > 2000) return result(true);
        if (a.payload.animal.kind !== b.payload.animal.kind || a.payload.location.countryCode !== b.payload.location.countryCode
            || a.payload.location.regionCode !== b.payload.location.regionCode) continue;
        const left = range(lostTipId, a), right = range(foundTipId, b);
        if (left && right && left[0] > right[1]) continue;
        if (items.length === 100) return result(true);
        items.push({ lostTipId, foundTipId, manualOnly: true, confidence: 'UNSCORED', reunionVerified: false,
            reasons: ['SAME_KIND', 'SAME_COARSE_REGION', 'TIME_NOT_CONTRADICTED'] });
    }
    return result(false);
}
function publicSemantics(tip) {
    const report = reportSemantics(tip);
    return { report, mapMarkerEligible: tip.schemaVersion === 3 && report.type === 'SIGHTING', careLocationInferred: false };
}
module.exports = { sourceState, visibleSource, publiclyVisible, validateSourceEvent, matchingSuggestions, publicSemantics, reportSemantics };
