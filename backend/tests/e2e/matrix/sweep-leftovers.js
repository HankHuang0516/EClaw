/**
 * Pre-run sweep for leftover E2E matrix marker cards (#3985).
 *
 * kanban_lifecycle self-cleans in `finally`, but when the archive DELETE hits a
 * transient 503/429 that survives its retry window the driver defers cleanup
 * ("leaving for next-run/sweep cleanup") — and until this module existed, no
 * sweep ever ran, so deferred marker cards piled up on the BROADCAST_TEST
 * device and the stale-card sweeper spammed P0 escalation warns about them.
 *
 * This sweep runs BEFORE the matrix (see run-matrix.js): it lists the test
 * device's cards and archives every card from a PREVIOUS run whose title
 * carries both marker fragments. Best-effort by design — a sweep failure must
 * never red the gate (the current run's own cleanup still applies), so errors
 * are logged and swallowed.
 */
'use strict';

const MARKER_PREFIX = 'E2E-MATRIX';
const MARKER_SUFFIX = '(auto, safe to delete)';

function isLeftoverMarkerCard(card, runId) {
    const title = (card && card.title) || '';
    if (!title.includes(MARKER_PREFIX) || !title.includes(MARKER_SUFFIX)) return false;
    // Never touch the current run's own marker cards — their driver owns cleanup.
    if (runId && title.includes(` ${runId} `)) return false;
    return true;
}

/**
 * @param {object} opts
 * @param {string} opts.base       target origin (e.g. https://eclawbot.com)
 * @param {string} opts.deviceId   BROADCAST_TEST device id
 * @param {string} opts.deviceSecret BROADCAST_TEST device secret
 * @param {string} [opts.runId]    current run id (its cards are skipped)
 * @param {Function} [opts.fetchImpl] injectable fetch for tests (default global fetch)
 * @param {Function} [opts.log]    injectable logger (default console.warn)
 * @returns {Promise<{swept: number, matched: number, skipped: boolean}>}
 */
async function sweepLeftoverMarkerCards({ base, deviceId, deviceSecret, runId, fetchImpl, log } = {}) {
    const doFetch = fetchImpl || global.fetch;
    const warn = log || ((...a) => console.warn(...a)); // eslint-disable-line no-console
    if (!deviceId || !deviceSecret) {
        return { swept: 0, matched: 0, skipped: true };
    }
    let swept = 0;
    let matched = 0;
    try {
        const qs = `deviceId=${encodeURIComponent(deviceId)}&deviceSecret=${encodeURIComponent(deviceSecret)}`;
        const listResp = await doFetch(`${base}/api/mission/cards?${qs}&q=${encodeURIComponent(MARKER_PREFIX)}`);
        const listJson = await listResp.json().catch(() => null);
        const cards = (listJson && listJson.cards) || [];
        const leftovers = cards.filter((c) => isLeftoverMarkerCard(c, runId));
        matched = leftovers.length;
        for (const card of leftovers) {
            try {
                const delResp = await doFetch(`${base}/api/mission/card/${encodeURIComponent(card.id)}?${qs}`, { method: 'DELETE' });
                const delJson = await delResp.json().catch(() => null);
                if (delResp.status < 400 && (!delJson || delJson.success !== false)) {
                    swept++;
                } else {
                    warn(`[matrix-sweep] could not archive leftover marker card ${card.id} (status ${delResp.status})`);
                }
            } catch (e) {
                warn(`[matrix-sweep] archive threw for ${card.id}: ${e && e.message}`);
            }
        }
        if (matched) warn(`[matrix-sweep] archived ${swept}/${matched} leftover marker card(s) from previous runs`);
    } catch (e) {
        // Best-effort: never red the gate on sweep failure.
        warn(`[matrix-sweep] sweep skipped on error: ${e && e.message}`);
    }
    return { swept, matched, skipped: false };
}

module.exports = { sweepLeftoverMarkerCards, isLeftoverMarkerCard, MARKER_PREFIX, MARKER_SUFFIX };
