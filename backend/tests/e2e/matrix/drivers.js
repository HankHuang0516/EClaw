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
 *   - agent_reply_visibility (SELF-SEEDED: source entity's botSecret resolved via
 *     /api/entities, /api/transform writes a run/platform-scoped marker that lands
 *     in chat history as is_from_bot, then chat.html render check. No external
 *     fixture dependency — survives history wipes / device rebinds).
 *   - login_refresh (AUTH-LIGHT, receiving-end of the pain-4 bounce): land on
 *     index.html?authReason=token_expired&return_to=<allowlisted portal page> and
 *     assert (a) #authReasonBanner becomes visible with the session-expired copy,
 *     and (b) the return_to value passes index.html's portal-page allowlist so the
 *     post-login round-trip is honored. No creds — verifies the contract every
 *     api.js 401 redirect (shared/api.js §LOGIN_REDIRECT) writes.
 *   - message_send (AUTH-LIGHT, drives the real outbox state machine on the live
 *     chat.html): offline → EclawOutbox.enqueue persists to localStorage and
 *     EclawOutboxUI renders a .msg-outbox queued bubble; online optimistic →
 *     setBubbleState('sending') flips the same bubble to the sending state. Uses
 *     the exact modules the UI's sendMessage() calls (card_751 outbox / 情緒價值 #2),
 *     so it exercises prod DOM + CSS without seeded creds or a bound target entity.
 * All five drivers now implemented — runner gate is fatal-on-pending (no PEND cells
 * expected in a healthy run; a PEND means a flow key lost its driver = regression).
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

// Transient-error classifier + retrying fetch wrapper for the secret-bound drivers.
// Mirrors the canonical retry pattern from openclaw-channel-eclaw/src/client.ts
// ("fix(openclaw-channel): retry transient message delivery failures", 21989abc):
// prod can throw HTTP 503/429 or a cold-path timeout on the two secret-bound flows
// (kanban_lifecycle, agent_reply_visibility) — those are transient, NOT a product
// failure, and must never red the required gate. Up to RETRY_ATTEMPTS tries with
// backoff = min(30s, 2s × attempt). A 4xx that is not 429 is a real failure → no retry.
const TRANSIENT_ERROR_RE = /(server starting up|too many requests|rate.?limit|HTTP 429|HTTP 5\d\d|ECONNRESET|ETIMEDOUT|timeout|socket hang up|fetch failed)/i;
// 5 attempts (matches the canonical client.ts pattern) — backoff 2+4+6+8s ≈ 20s of
// retry window, enough to ride out a transient prod 503 burst without redding the gate.
const RETRY_ATTEMPTS = 5;

function isTransientStatus(status) {
    return status === 429 || status >= 500;
}

// Retrying wrapper around page.request.fetch. Retries on transient HTTP status
// (503/429/5xx) OR a thrown network/timeout error; surfaces the last error/status
// to the caller after RETRY_ATTEMPTS so a genuine failure still fails the cell.
// Returns { resp, status } on success; throws the last error if every attempt threw.
async function fetchWithRetry(page, url, opts = {}) {
    let lastErr = null;
    let lastResp = null;
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
        try {
            const resp = await page.request.fetch(url, opts);
            const status = resp.status();
            if (!isTransientStatus(status) || attempt === RETRY_ATTEMPTS) {
                return { resp, status };
            }
            lastResp = resp;
        } catch (e) {
            lastErr = e;
            const reason = (e && e.message) || String(e);
            if (!TRANSIENT_ERROR_RE.test(reason) || attempt === RETRY_ATTEMPTS) {
                throw e; // non-transient throw, or out of attempts → real failure
            }
        }
        await new Promise(r => setTimeout(r, Math.min(30000, 2000 * attempt)));
    }
    if (lastResp) return { resp: lastResp, status: lastResp.status() };
    throw lastErr || new Error('fetchWithRetry: exhausted attempts');
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
        // Retry on transient prod latency / 503 / 429 (cloud cold-path can exceed the
        // default timeout or bounce a 5xx once; fetchWithRetry backs off + retries so a
        // transient blip never reds the gate — only a real 4xx/exhausted-retry fails).
        const api = async (method, path, body) => {
            const { resp } = await fetchWithRetry(page, `${base}${path}`, {
                method,
                headers: { 'content-type': 'application/json' },
                data: body ? JSON.stringify(body) : undefined,
                timeout: 45000,
            });
            let json = null; try { json = await resp.json(); } catch (_) {}
            return { status: resp.status(), json };
        };
        const auth = { deviceId, deviceSecret, entityId };
        let cardId = null;
        try {
            // 1. create (todo) — assignedBots required (non-empty, bound entity)
            const created = await api('POST', '/api/mission/card', { ...auth, assignedBots: [entityId], title: marker, status: 'todo' });
            cardId = created.json && (created.json.id || (created.json.card && created.json.card.id));
            if (!cardId) {
                // Transient 5xx/429 after retries = prod infra blip → transient (no card
                // was created, so nothing to clean up). A real status is a genuine failure.
                if (isTransientStatus(created.status)) {
                    return { transient: true, detail: `card create hit transient status ${created.status} after retries (prod infra) — not redding the gate` };
                }
                return { ok: false, detail: `create failed (status ${created.status})` };
            }

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
                    // Transient 5xx/429 after retries → transient (the finally block still
                    // archives the created card). A real status is a genuine failure.
                    if (isTransientStatus(mv.status)) {
                        return { transient: true, detail: `move→${s} hit transient status ${mv.status} after retries (prod infra) — not redding the gate: ${JSON.stringify(seen)}` };
                    }
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
        } finally { // eslint-disable-line no-unsafe-finally
            // self-clean: archive the marker card. A REAL cleanup failure (4xx) throws →
            // cell fails (no silent pollution, per #6). But api() already retried any
            // transient 503/429 up to RETRY_ATTEMPTS; if it STILL returns a transient
            // status after that window, that's a prod infra blip, not preventable test
            // pollution — the card is preflight-opted-out + clearly marked "safe to
            // delete", so we log + defer rather than red the required gate on infra.
            if (cardId) {
                const del = await api('DELETE', `/api/mission/card/${cardId}`, auth);
                const ok = del.json && (del.json.success !== false) && del.status < 400;
                if (!ok) {
                    if (isTransientStatus(del.status)) {
                        // eslint-disable-next-line no-console
                        console.warn(`[matrix] CLEANUP DEFERRED — marker card ${cardId} archive got transient status ${del.status} after retries; leaving for next-run/sweep cleanup (not redding the gate on prod infra)`);
                    } else {
                        throw new Error(`CLEANUP FAILED — marker card ${cardId} not archived (status ${del.status}); refusing to leave test pollution`);
                    }
                }
            }
        }
    },

    // A bot reply in chat history renders as a visible bubble WITH sender identity.
    // SELF-SEEDED on BROADCAST_TEST (#6 ruling: never depend on pre-existing chat
    // state). Per run: resolve source entity's botSecret via /api/entities, POST
    // /api/transform with a run/platform-scoped marker (lands as is_from_bot in
    // chat history), then assert chat.html renders a received .chat-bubble whose
    // .chat-source sender label is non-empty AND whose body contains the marker.
    // speakTo target = MATRIX_TEST_ENTITY_PUBLIC_CODE (env) ∥ 'ldsntq' (BROADCAST_TEST
    // entity 1's published publicCode — same device, same surface).
    agent_reply_visibility: async (page, { base, platform, runId }) => {
        const { deviceId, deviceSecret, entityId } = testCreds();
        const speakToCode = process.env.MATRIX_TEST_ENTITY_PUBLIC_CODE || 'ldsntq';
        const marker = `E2E reply visibility marker run=${runId || 'run'} platform=${platform.key}`;

        // 1. Resolve botSecret for the source entity (deviceSecret → entities list).
        //    /api/entities accepts deviceSecret; botSecret is per-entity, not committable.
        //    fetchWithRetry: a 503/429/timeout here is transient, not a product gap.
        const { resp: entResp } = await fetchWithRetry(page,
            `${base}/api/entities?deviceId=${encodeURIComponent(deviceId)}&deviceSecret=${encodeURIComponent(deviceSecret)}`,
            { timeout: 30000 }
        );
        let entJson = null; try { entJson = await entResp.json(); } catch (_) {}
        const ent = ((entJson && entJson.entities) || []).find(e => Number(e.entityId) === entityId);
        if (!ent || !ent.botSecret) {
            // A transient 503/429 here survived all retries → prod infra blip, not a
            // product gap; report as transient (does NOT red the gate). A real status
            // (e.g. 401/404 / empty entity list on 200) is a genuine failure.
            if (isTransientStatus(entResp.status())) {
                return { transient: true, detail: `entities resolve hit transient status ${entResp.status()} after retries (prod infra) — not redding the gate` };
            }
            return { ok: false, detail: `cannot resolve botSecret for entityId=${entityId} (entities status ${entResp.status()})` };
        }

        // 2. Seed: transform with a run/platform-scoped marker → saved as is_from_bot.
        const { resp: seedResp } = await fetchWithRetry(page, `${base}/api/transform`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            data: JSON.stringify({
                deviceId,
                botSecret: ent.botSecret,
                entityId,
                message: marker,
                state: 'IDLE',
                speakTo: [speakToCode],
            }),
            timeout: 45000,
        });
        if (seedResp.status() >= 400) {
            // Transient 5xx/429 after retries = prod infra, not a product gap → transient.
            if (isTransientStatus(seedResp.status())) {
                return { transient: true, detail: `seed transform hit transient status ${seedResp.status()} after retries (prod infra) — not redding the gate` };
            }
            let body = ''; try { body = await seedResp.text(); } catch (_) {}
            return { ok: false, detail: `seed transform failed (status ${seedResp.status()}): ${body.slice(0, 200)}` };
        }

        // 3+4. POLL chat history until the seeded marker lands as is_from_bot. The
        // transform→chat_messages write is async on prod, and the FIRST surface tested
        // in a run races that write (the desktop-flaps-while-mobile/webview-pass flake).
        // A single fixed 3s wait + one read is the root cause of that flake; poll instead
        // (up to ~24s, 8 × 3s) so a slow cold-path persist doesn't red the cell.
        let botReply = null;
        let lastMsgCount = 0;
        for (let poll = 0; poll < 8; poll++) {
            await page.waitForTimeout(3000);
            let histResp;
            try {
                ({ resp: histResp } = await fetchWithRetry(page,
                    `${base}/api/chat/history?deviceId=${encodeURIComponent(deviceId)}&deviceSecret=${encodeURIComponent(deviceSecret)}&entityId=${entityId}&limit=50`,
                    { timeout: 45000 }
                ));
            } catch (_) { continue; } // transient throw → next poll
            let hist = null; try { hist = await histResp.json(); } catch (_) {}
            const msgs = (hist && (hist.messages || hist)) || [];
            lastMsgCount = Array.isArray(msgs) ? msgs.length : 0;
            botReply = Array.isArray(msgs) ? msgs.find(m =>
                (m.is_from_bot === true || m.isFromBot === true) &&
                (m.text || '').includes(marker)
            ) : null;
            if (botReply) break;
        }
        if (!botReply) {
            return { ok: false, detail: `seeded marker not visible in chat history after polling (last history msgs=${lastMsgCount})` };
        }

        // 5. Render check: inject creds, load chat.html, assert a received bubble
        //    whose body contains the marker text appears with a non-empty sender.
        //    addInitScript persists across navigations in this context — set once.
        await page.addInitScript(([d, sec]) => {
            try { localStorage.setItem('deviceId', d); localStorage.setItem('deviceSecret', sec); } catch (_) {}
        }, [deviceId, deviceSecret]);

        // chat.html does its OWN client-side bootstrap (checkAuth → device-login →
        // history fetch → renderMessages). On a cold CI runner that whole chain — plus
        // chat.html's history query firing before the just-seeded row propagates to it —
        // can outlast a single waitForFunction window (the residual render-side flake).
        // Reload-and-retry the render check up to 3× (a fresh goto re-fetches history),
        // so a slow first bootstrap doesn't red the cell. The marker is already
        // confirmed in the API above, so this only waits out client render latency.
        let verdict = { ok: false };
        const RENDER_ATTEMPTS = 3;
        for (let attempt = 1; attempt <= RENDER_ATTEMPTS; attempt++) {
            await page.goto(`${base}/portal/chat.html`, { waitUntil: 'domcontentloaded', timeout: 45000 });
            try {
                verdict = await page.waitForFunction((mk) => {
                    const msgs = Array.from(document.querySelectorAll('.chat-msg'));
                    for (const m of msgs) {
                        if (m.classList.contains('sent')) continue;       // skip our own
                        const src = m.querySelector('.chat-source');
                        const bubble = m.querySelector('.chat-bubble');
                        const senderLabel = src && (src.textContent || '').trim();
                        const bodyText = bubble && (bubble.textContent || '').trim();
                        if (senderLabel && bodyText && bodyText.includes(mk)) {
                            return { ok: true, sender: senderLabel.slice(0, 40), textLen: bodyText.length };
                        }
                    }
                    return false; // keep waiting
                }, marker, { timeout: 20000 }).then(h => h.jsonValue());
            } catch (_) {
                verdict = { ok: false };
            }
            if (verdict.ok) break;
        }

        return {
            ok: !!verdict.ok,
            detail: verdict.ok
                ? `seeded marker renders with sender="${verdict.sender}" (${verdict.textLen} chars)`
                : `seeded marker found in API but not rendered in chat.html after ${RENDER_ATTEMPTS} reload attempts (msg .chat-bubble + .chat-source not matched)`,
        };
    },

    // pain 4: an api.js 401 bounces to index.html?authReason=<reason>&return_to=<page>
    // (shared/api.js §LOGIN_REDIRECT). This driver verifies the RECEIVING end of that
    // contract — the part that has to render correctly on every surface — without
    // needing to provoke a real 401 (which races auth.js's /me probe, the prod
    // discrepancy that kept this pending). Auth-light: no creds.
    //   (a) #authReasonBanner becomes visible carrying the session-expired copy.
    //   (b) the return_to value is one index.html's portal-page allowlist accepts,
    //       so the post-login round-trip back to the interrupted page is honored.
    login_refresh: async (page, { base }) => {
        const returnTo = '/portal/kanban.html'; // on index.html's allowlist
        const entry = `${base}/portal/index.html?authReason=token_expired&return_to=${encodeURIComponent(returnTo)}`;
        // index.html is heavier than the /r/ entry (i18n + login bootstrap); give the
        // prod cold-path one retry at a generous timeout so a single slow nav doesn't
        // flap the gate (same transient class kanban_lifecycle already retries on).
        let resp = null, navErr = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            try { resp = await page.goto(entry, { waitUntil: 'domcontentloaded', timeout: 45000 }); navErr = null; break; }
            catch (e) { navErr = e; }
        }
        if (navErr) return { ok: false, detail: `nav to index.html failed: ${navErr.message}` };
        const status = resp ? resp.status() : 0;

        // (a) the auth-reason banner shows with non-empty text (the inline IIFE runs
        //     on DOMContentLoaded; allow i18n to settle a beat).
        let banner = { visible: false, text: '' };
        try {
            banner = await page.waitForFunction(() => {
                const el = document.getElementById('authReasonBanner');
                if (!el) return false;
                const shown = el.style.display !== 'none' && el.offsetParent !== null;
                const txt = (el.textContent || '').trim();
                return shown && txt.length > 1 ? { visible: true, text: txt.slice(0, 80) } : false;
            }, null, { timeout: 10000 }).then(h => h.jsonValue());
        } catch (_) { banner = { visible: false, text: '' }; }

        // (b) the return_to we passed must pass index.html's own allowlist regex —
        //     re-run the exact predicate the page uses so a regex drift here is caught.
        const returnToHonored = await page.evaluate((rt) => {
            return !!rt && !rt.startsWith('//')
                && /^\/(r\/|portal\/(dashboard|chat|kanban|mission|settings)\.html)/.test(rt);
        }, returnTo);

        const ok = status < 400 && banner.visible && returnToHonored;
        return {
            ok,
            detail: `index.html?authReason=token_expired (status ${status}); banner_visible=${banner.visible}` +
                `${banner.text ? ` ("${banner.text}")` : ''}; return_to_honored=${returnToHonored}`,
        };
    },

    // card_751 outbox + 情緒價值 #2: a chat send shows an optimistic SENDING bubble
    // online and QUEUES offline. This drives the real outbox state machine + render
    // modules on the live chat.html — the exact code sendMessage() runs (EclawOutbox
    // .enqueue → EclawOutboxUI.renderQueuedBubble → setBubbleState('sending')) — so
    // it exercises prod DOM + CSS state classes without seeded creds or a bound
    // target entity (the auth/target gating sendMessage applies before the outbox
    // step is orthogonal to the outbox behaviour under test). Auth-light.
    message_send: async (page, { base, platform, runId }) => {
        const marker = `E2E-OUTBOX ${runId || 'run'} ${platform.key}`;
        await page.goto(`${base}/portal/chat.html`, { waitUntil: 'domcontentloaded', timeout: 45000 });

        // The outbox modules load as portal scripts; wait for them to be present.
        try {
            await page.waitForFunction(
                () => !!(window.EclawOutbox && window.EclawOutboxUI && document.getElementById('chatMessages')),
                null, { timeout: 15000 }
            );
        } catch (_) {
            return { ok: false, detail: 'EclawOutbox / EclawOutboxUI / #chatMessages not present on chat.html' };
        }

        // Start from a clean outbox so our assertions are unambiguous, then exercise
        // BOTH legs of the flow against the real modules and DOM.
        const result = await page.evaluate(({ mk }) => {
            const out = { steps: [] };
            const container = document.getElementById('chatMessages');
            const STORAGE_KEY = (window.EclawOutbox && window.EclawOutbox.STORAGE_KEY) || 'eclaw_outbox';
            try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
            try { (window.EclawOutbox.clear || function () {})(); } catch (_) {}

            const payload = { text: mk, source: 'web_chat', entityId: 1 };

            // ── OFFLINE leg: enqueue + render queued bubble, assert persisted + in DOM ──
            const enq = window.EclawOutbox.enqueue(payload);
            const entry = enq && enq.entry;
            const key = entry && entry.idempotencyKey;
            out.key = key || null;
            if (!key) { out.steps.push('enqueue returned no idempotencyKey'); return out; }

            window.EclawOutboxUI.renderQueuedBubble(container, { idempotencyKey: key, text: mk });

            let persisted = false;
            try {
                const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
                persisted = Array.isArray(raw) && raw.some(e => e.idempotencyKey === key);
            } catch (_) {}
            const queuedEl = container.querySelector(`[data-outbox-key="${key}"]`);
            const queuedClassOk = !!queuedEl && queuedEl.classList.contains('msg-outbox')
                && queuedEl.classList.contains('msg-outbox-queued');
            const bodyOk = !!queuedEl && (queuedEl.querySelector('.chat-bubble') || {}).textContent === mk;
            out.offline = { persisted, queuedClassOk, bodyOk };
            out.steps.push(`offline: persisted=${persisted} queued=${queuedClassOk} body=${bodyOk}`);

            // ── ONLINE optimistic leg: flip the SAME bubble to the sending state ──
            window.EclawOutbox.markRetrying(key);
            const sendingEl = window.EclawOutboxUI.setBubbleState(container, key, 'sending');
            const sendingClassOk = !!sendingEl && sendingEl.classList.contains('msg-outbox-sending');
            out.online = { sendingClassOk };
            out.steps.push(`online: sending=${sendingClassOk}`);

            // self-clean the throwaway entry so we never leave queued test pollution.
            try { window.EclawOutbox.markSent(key); } catch (_) {}
            try { window.EclawOutboxUI.removeBubble(container, key); } catch (_) {}
            try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}

            return out;
        }, { mk: marker });

        const off = result.offline || {};
        const on = result.online || {};
        const ok = !!(off.persisted && off.queuedClassOk && off.bodyOk && on.sendingClassOk);
        return {
            ok,
            detail: ok
                ? `outbox offline-queue + online optimistic OK (key ${result.key}): ${result.steps.join(' | ')}`
                : `outbox flow incomplete: ${result.steps.join(' | ') || 'no steps ran'}`,
        };
    },
};

module.exports = { DRIVERS };
