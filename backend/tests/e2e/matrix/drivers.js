/**
 * Flow drivers for the cross-surface E2E matrix (card_42ffca0d29ce22b369d55ca4).
 *
 * Each driver: async (page, { base, platform }) => { ok: boolean, detail: string }.
 * A driver verifies ONE canonical flow on the live target. Keep them auth-light
 * where possible (public surfaces) so the baseline runs without seeded secrets;
 * auth-bound flows document what they need.
 *
 * Implemented:
 *   - redirect (self-contained, public /r/ entry — auth-light).
 *   - kanban_lifecycle (WRITE flow → BROADCAST_TEST device only, creds from env,
 *     run/platform-scoped marker, finally self-clean; cleanup failure fails the
 *     cell). #6 ruling 2026-06-12: never commit creds; missing secrets fail fast.
 * Pending (intentionally absent → runner reports `pending`, never silent-pass):
 *   login_refresh (prod-behavior discrepancy under investigation — auth.js /me
 *   probe pre-empts the api.js authReason path), message_send, agent_reply_visibility.
 * Flip run-matrix.js's gate to fatal-on-pending once all five exist.
 */
'use strict';

// BROADCAST_TEST throwaway creds — injected via CI env / GitHub Secrets, NEVER
// committed (#6 ruling; feedback_no_whitelist_vault). Missing → fail fast.
function testCreds() {
    const deviceId = process.env.MATRIX_TEST_DEVICE_ID;
    const deviceSecret = process.env.MATRIX_TEST_DEVICE_SECRET;
    if (!deviceId || !deviceSecret) {
        throw new Error('missing MATRIX_TEST_DEVICE_ID / MATRIX_TEST_DEVICE_SECRET (BROADCAST_TEST creds required for write-flow drivers)');
    }
    // BROADCAST_TEST slot 0 is a rental-bind slot (often unbound); the persistent
    // assignable entity is 1 ("E2E Bot B"). Overridable via env for other fixtures.
    const entityId = Number(process.env.MATRIX_TEST_ENTITY_ID || 1);
    return { deviceId, deviceSecret, entityId };
}

const DRIVERS = {
    // pain 1+5: /r/:target universal entry 302s to the registry web URL with traceId.
    // profile is a non-sensitive target (/p/{publicCode}), so no HMAC sig needed.
    redirect: async (page, { base }) => {
        const publicCode = process.env.MATRIX_REDIRECT_CODE || 'tbwb9e'; // #1 Mac_F public profile
        const entry = `${base}/r/profile?publicCode=${publicCode}`;
        const resp = await page.goto(entry, { waitUntil: 'domcontentloaded', timeout: 20000 });
        const finalUrl = page.url();
        const landed = finalUrl.includes(`/p/${publicCode}`);
        const status = resp ? resp.status() : 0;
        return {
            ok: landed && status < 400,
            detail: `entry=/r/profile?publicCode=${publicCode} → ${finalUrl} (status ${status})`,
        };
    },

    // 情緒價值 #2: kanban card moves todo→in_progress→done. WRITE flow — runs ONLY
    // against the BROADCAST_TEST device, with a run/platform-scoped marker card
    // that is archived in `finally`. Cleanup failure fails the cell (no silent
    // pollution, per #6). Verifies the lifecycle through the same API the
    // optimistic UI calls, then confirms the card renders in kanban.html.
    kanban_lifecycle: async (page, { base, platform, runId }) => {
        const { deviceId, deviceSecret, entityId } = testCreds();
        const marker = `E2E-MATRIX ${runId || 'run'} ${platform.key} — kanban_lifecycle (auto, safe to delete)`;
        // One retry on transient prod latency (cloud cold-path can exceed the
        // default 30s once; a second attempt almost always lands).
        const api = async (method, path, body) => {
            let lastErr;
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    const resp = await page.request.fetch(`${base}${path}`, {
                        method,
                        headers: { 'content-type': 'application/json' },
                        data: body ? JSON.stringify(body) : undefined,
                        timeout: 45000,
                    });
                    let json = null; try { json = await resp.json(); } catch (_) {}
                    return { status: resp.status(), json };
                } catch (e) { lastErr = e; }
            }
            throw lastErr;
        };
        const auth = { deviceId, deviceSecret, entityId };
        let cardId = null;
        try {
            // 1. create (todo) — assignedBots required (non-empty, bound entity)
            const created = await api('POST', '/api/mission/card', { ...auth, assignedBots: [entityId], title: marker, status: 'todo' });
            cardId = created.json && (created.json.id || (created.json.card && created.json.card.id));
            if (!cardId) return { ok: false, detail: `create failed (status ${created.status})` };

            // This test exercises the LIFECYCLE state machine, not the OODA-R done
            // gate — opt the throwaway card out so todo→done isn't gated on evidence.
            await api('PUT', `/api/mission/card/${cardId}`, { ...auth, requiresPreflightReview: false });

            // 2. move todo→in_progress→done
            const states = ['in_progress', 'done'];
            const seen = [];
            for (const s of states) {
                const mv = await api('POST', `/api/mission/card/${cardId}/move`, { ...auth, newStatus: s });
                const got = mv.json && mv.json.card && mv.json.card.status;
                seen.push(`${s}:${got || mv.json && mv.json.error || mv.status}`);
                if (got !== s) {
                    return { ok: false, detail: `move→${s} failed: ${JSON.stringify(seen)}` };
                }
            }

            // 3. render check: inject creds, load kanban.html, confirm the marker card shows
            await page.addInitScript(([d, sec]) => {
                try { localStorage.setItem('deviceId', d); localStorage.setItem('deviceSecret', sec); } catch (_) {}
            }, [deviceId, deviceSecret]);
            await page.goto(`${base}/portal/kanban.html`, { waitUntil: 'domcontentloaded', timeout: 45000 });
            // Use textContent (not innerText) so cards in a collapsed/hidden column
            // — e.g. the mobile single-column kanban layout — still count as rendered.
            let rendered = false;
            try {
                await page.waitForFunction(
                    (mk) => document.body && (document.body.textContent || '').includes(mk),
                    marker, { timeout: 15000 }
                );
                rendered = true;
            } catch (_) { rendered = false; }

            return {
                ok: rendered,
                detail: `card ${cardId} lifecycle ${seen.join('→')}; rendered_in_kanban=${rendered}`,
            };
        } finally {
            // self-clean: archive the marker card. Cleanup failure throws → cell fails.
            if (cardId) {
                const del = await api('DELETE', `/api/mission/card/${cardId}`, auth);
                const ok = del.json && (del.json.success !== false) && del.status < 400;
                if (!ok) {
                    throw new Error(`CLEANUP FAILED — marker card ${cardId} not archived (status ${del.status}); refusing to leave test pollution`);
                }
            }
        }
    },
};

module.exports = { DRIVERS };
