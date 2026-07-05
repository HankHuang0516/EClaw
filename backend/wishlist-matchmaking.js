/**
 * wishlist-matchmaking — the pure-EClaw public-code b2b matchmaking handshake
 * (card_e44c2ea87013225b94769ae5, P2). Builds on the P1 wishlist-bridge proxy.
 *
 * WHAT THIS IS
 *   A buyer entity expresses a free-text intent ("想買 Sony 降噪耳機"). The module
 *   searches the external Wishlist catalogue (via P1's SSRF-safe bridge), reranks,
 *   and — for a matched listing owned by a SELLER entity — runs a bot-to-bot
 *   handshake keyed ENTIRELY by EClaw public codes:
 *
 *     invite  → seller   {type:'wishlist_trade_invite', matchId, fromPublicCode, toPublicCode, itemId, itemName, note}
 *     accept  → buyer    {type:'wishlist_trade_accept',  matchId, fromPublicCode, toPublicCode}
 *     decline → buyer    {type:'wishlist_trade_decline', matchId, reason}
 *     contact → both     {type:'wishlist_trade_contact', matchId, nameCard:{publicCode,displayName,caps}}
 *
 *   matchId = sha256(buyerPublicCode | itemId | sellerPublicCode) so a replayed
 *   invite/accept is idempotent (same match, no double-fire).
 *
 * HARD RULES (owner spec)
 *   1. ALL buyer↔seller messages go through the EClaw public-code b2b protocol —
 *      NO side channels. The `sendB2bMessage` injectable is the ONLY egress and it
 *      is wired to the existing cross-speak delivery in index.js.
 *   2. Governance — matchmaking is OFF unless BOTH owners opted in
 *      (`wishlist_matchmaking_enabled`, default OFF), a global kill-switch
 *      (`wishlist_matchmaking_killswitch`) disables ALL sends, and a per-entity
 *      quota (separate counter from CROSS_SPEAK_MAX_MESSAGES) caps invites.
 *   3. Reachability — an invite is only sent to a target whose owner OPTED IN.
 *      Reachability is opt-in ONLY: it does NOT depend on the roster's current
 *      liveness (invites are async/durable, so an opted-in but momentarily idle or
 *      SLEEPING party still receives them). The kill-switch is the "stop reaching
 *      me" control; heartbeat freshness is not.
 *   4. Dual lightweight consent (D5) — the agent name-card (publicCode/displayName/
 *      caps) may auto-exchange, but ANY real contact info (email/phone/…) is
 *      released ONLY after BOTH owners approve it in their 需要你 inbox. A contact
 *      envelope always carries the safety disclaimer
 *      「EClaw 只牽線不背書 / EClaw only introduces, does not endorse」.
 *   5. Untrusted listing text (name/notes coming from the external catalogue or a
 *      counterparty) is SANITISED before it can enter an envelope or an LLM prompt
 *      (prompt-injection / control-char defence). proxy_end_user_id PII is never
 *      leaked into an envelope.
 *
 * All EClaw dependencies are INJECTED via createRouter({...}) so the whole flow is
 * unit-testable with no network and no DB (mirrors wishlist-route.js / petdex-route.js).
 */

const express = require('express');
const crypto = require('crypto');

// Separate quota from the global CROSS_SPEAK_MAX_MESSAGES (index.js). Matchmaking
// invites get their OWN budget so a burst of trade invites can't be masked by, or
// starve, ordinary bot-to-bot chat. Default 5 invites / entity / rolling window.
const MATCHMAKING_INVITE_QUOTA_DEFAULT = 5;
const MATCHMAKING_QUOTA_WINDOW_MS_DEFAULT = 60 * 60 * 1000; // 1h rolling window

// The b2b envelope type tokens (P0 protocol). Frozen so a typo can't silently
// mint a new type.
const ENVELOPE_TYPES = Object.freeze({
    INVITE: 'wishlist_trade_invite',
    ACCEPT: 'wishlist_trade_accept',
    DECLINE: 'wishlist_trade_decline',
    CONTACT: 'wishlist_trade_contact',
});

// Bilingual safety disclaimer stamped on every contact exchange.
const SAFETY_DISCLAIMER = 'EClaw 只牽線不背書 / EClaw only introduces, does not endorse.';

// Contact-info key names that are treated as REAL contact PII and therefore gated
// behind dual consent. Anything matching is never auto-exchanged.
const CONTACT_PII_KEYS = Object.freeze([
    'email', 'phone', 'tel', 'mobile', 'line', 'wechat', 'whatsapp', 'telegram',
    'address', 'contact', 'signal', 'im', 'social',
]);

const PUBLIC_CODE_RE = /^[a-z0-9]{6}$/;

// ── Pure helpers (exported for direct unit tests) ───────────────────────────

/**
 * Deterministic, order-fixed match id. buyer + item + seller ⇒ one stable id, so
 * a replayed invite/accept dedups to the same match (idempotency key).
 */
function computeMatchId(buyerPublicCode, itemId, sellerPublicCode) {
    const buyer = normalizeCode(buyerPublicCode);
    const seller = normalizeCode(sellerPublicCode);
    const item = String(itemId == null ? '' : itemId);
    const h = crypto.createHash('sha256');
    h.update(`${buyer}|${item}|${seller}`);
    return h.digest('hex').slice(0, 32);
}

function normalizeCode(raw) {
    if (typeof raw !== 'string') return '';
    let v = raw.trim().toLowerCase();
    if (v.startsWith('eclaw:')) v = v.slice('eclaw:'.length).trim();
    if (v.startsWith('@')) v = v.slice(1);
    return v;
}

function isValidPublicCode(raw) {
    return PUBLIC_CODE_RE.test(normalizeCode(raw));
}

/**
 * Sanitise untrusted text (a listing name/notes from the external catalogue or a
 * counterparty) BEFORE it enters an envelope OR an LLM rerank prompt. This is the
 * prompt-injection / control-char defence:
 *   - strip control chars (incl. the NUL used as the matchId field separator),
 *   - collapse newlines/tabs to a single space (kills "\n\nIGNORE ABOVE" tricks),
 *   - neutralise the common instruction-override lead-ins so a malicious listing
 *     name cannot pose as a system/developer directive,
 *   - hard length cap.
 * Returns a single-line, bounded, injection-inert string.
 */
function sanitizeUntrusted(raw, maxLen = 200) {
    if (raw == null) return '';
    let s = String(raw);
    // Drop ALL C0/C1 control chars (incl. NUL, and the newlines/tabs an
    // injection uses to fake a new turn or a new field).
    s = s.replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ');
    // Strip zero-width / bidi-override chars sometimes used to smuggle text.
    s = s.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '');
    // Neutralise classic instruction-override lead-ins (case-insensitive), and
    // role labels a payload uses to impersonate the system prompt.
    s = s.replace(
        /\b(ignore|disregard|forget)\b[\s\S]{0,40}?\b(previous|above|prior|earlier|all)\b[\s\S]{0,20}?\b(instructions?|prompts?|context|rules?)\b/gi,
        '[filtered]'
    );
    s = s.replace(/^\s*(system|assistant|developer|user)\s*[:\uFF1A]/gi, '$1 ');
    // Collapse whitespace runs, trim, cap.
    s = s.replace(/\s+/g, ' ').trim();
    if (s.length > maxLen) s = s.slice(0, maxLen);
    return s;
}

/**
 * Cheap keyword rerank (LLM optional / off by default — keep it cheap). Scores
 * each item by overlap of query tokens against the item name+notes, with a small
 * exact-substring bonus. Stable sort, highest score first; ties keep input order.
 * Input item text is sanitised first so a hostile listing name can't skew or
 * inject anything downstream.
 */
function rerank(query, items) {
    const qTokens = tokenize(query);
    const scored = (Array.isArray(items) ? items : []).map((it, idx) => {
        const name = sanitizeUntrusted(it && it.name, 200);
        const notes = sanitizeUntrusted(it && it.notes, 200);
        const hay = `${name} ${notes}`.toLowerCase();
        const hayTokens = new Set(tokenize(hay));
        let score = 0;
        for (const t of qTokens) {
            if (hayTokens.has(t)) score += 2;
            else if (t.length >= 3 && hay.includes(t)) score += 1;
        }
        // Whole-query substring bonus.
        const qLower = query ? String(query).toLowerCase().trim() : '';
        if (qLower && hay.includes(qLower)) score += 3;
        return { item: it, score, idx, cleanName: name };
    });
    scored.sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
    return scored;
}

function tokenize(s) {
    if (!s) return [];
    return String(s)
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length >= 2);
}

// ── Envelope builders (P0 protocol; all public-code keyed) ──────────────────

function buildInviteEnvelope({ matchId, fromPublicCode, toPublicCode, itemId, itemName, note }) {
    return {
        type: ENVELOPE_TYPES.INVITE,
        matchId,
        fromPublicCode: normalizeCode(fromPublicCode),
        toPublicCode: normalizeCode(toPublicCode),
        itemId: itemId == null ? null : itemId,
        // itemName/note come from the catalogue / caller → SANITISE.
        itemName: sanitizeUntrusted(itemName, 120),
        note: sanitizeUntrusted(note, 200),
    };
}

function buildAcceptEnvelope({ matchId, fromPublicCode, toPublicCode }) {
    return {
        type: ENVELOPE_TYPES.ACCEPT,
        matchId,
        fromPublicCode: normalizeCode(fromPublicCode),
        toPublicCode: normalizeCode(toPublicCode),
    };
}

function buildDeclineEnvelope({ matchId, reason }) {
    return {
        type: ENVELOPE_TYPES.DECLINE,
        matchId,
        reason: sanitizeUntrusted(reason, 120),
    };
}

/**
 * Contact envelope. `nameCard` (publicCode/displayName/caps) auto-exchanges. Any
 * REAL contact PII is carried ONLY when `contactInfo` is provided (i.e. dual
 * consent already granted by the caller) and is stripped of anything that isn't a
 * recognised contact key. The disclaimer is always present. proxy_end_user_id and
 * other opaque ids are never included.
 */
function buildContactEnvelope({ matchId, nameCard, contactInfo }) {
    const card = sanitizeNameCard(nameCard);
    const env = {
        type: ENVELOPE_TYPES.CONTACT,
        matchId,
        nameCard: card,
        disclaimer: SAFETY_DISCLAIMER,
    };
    const cleanContact = sanitizeContactInfo(contactInfo);
    if (cleanContact && Object.keys(cleanContact).length > 0) {
        env.contactInfo = cleanContact;
    }
    return env;
}

/** Keep only publicCode/displayName/caps; sanitise the human strings. */
function sanitizeNameCard(nameCard) {
    const nc = nameCard && typeof nameCard === 'object' ? nameCard : {};
    const caps = Array.isArray(nc.caps)
        ? nc.caps.slice(0, 10).map((c) => sanitizeUntrusted(c, 40)).filter(Boolean)
        : [];
    return {
        publicCode: normalizeCode(nc.publicCode),
        displayName: sanitizeUntrusted(nc.displayName, 60),
        caps,
    };
}

/**
 * Keep only recognised contact keys, sanitise their values, and NEVER pass an
 * opaque proxy id through. Anything not in CONTACT_PII_KEYS is dropped.
 */
function sanitizeContactInfo(contactInfo) {
    if (!contactInfo || typeof contactInfo !== 'object' || Array.isArray(contactInfo)) return null;
    const out = {};
    for (const [k, v] of Object.entries(contactInfo)) {
        const key = String(k).toLowerCase();
        if (key === 'proxy_end_user_id' || key === 'proxyenduserid') continue; // never leak PII id
        if (!CONTACT_PII_KEYS.includes(key)) continue;
        const val = sanitizeUntrusted(v, 120);
        if (val) out[key] = val;
    }
    return out;
}

// ── Reachability (opt-in ONLY — NOT liveness) ───────────────────────────────

/**
 * True iff the target's owner device has opted into matchmaking. Reachability is
 * OPT-IN ONLY — it does NOT depend on the roster's current liveness (owner spec,
 * 2026-07: 「不建議使用心跳新鮮度來阻擋撮合，opt-in 阻擋合理」).
 *
 * Matchmaking invites are asynchronous, durable action-requests: an opted-in
 * seller/buyer that is momentarily idle (heartbeat stale) or SLEEPING (idle-20min-
 * no-work) is STILL reachable — it receives the invite and responds whenever next
 * active. Blocking on current liveness only produced false-negatives (a real
 * opted-in party idle for a few minutes got silently skipped). SLEEPING/FAILED/
 * stale-heartbeat none mean "opted out", so none may gate matchmaking.
 *
 * The kill-switch (checked separately by the caller) is the intentional per-owner
 * "stop reaching me" control — liveness is not.
 */
function isReachableTarget({ rosterEntry, prefs }) {
    return isOptedIn(prefs);
}

function isOptedIn(prefs) {
    return !!(prefs && prefs.wishlist_matchmaking_enabled === true);
}

function isKillSwitchOn(prefs) {
    return !!(prefs && prefs.wishlist_matchmaking_killswitch === true);
}

// ── Per-entity invite quota (separate counter) ──────────────────────────────

function createQuotaTracker({ max, windowMs, now } = {}) {
    const cap = Number.isFinite(Number(max)) ? Number(max) : MATCHMAKING_INVITE_QUOTA_DEFAULT;
    const win = Number.isFinite(Number(windowMs)) ? Number(windowMs) : MATCHMAKING_QUOTA_WINDOW_MS_DEFAULT;
    const clock = typeof now === 'function' ? now : () => Date.now();
    const hits = new Map(); // key -> [timestamps]

    function key(deviceId, entityId) {
        return `${deviceId}:${entityId}`;
    }
    function remaining(deviceId, entityId) {
        const t = clock();
        const start = t - win;
        const arr = (hits.get(key(deviceId, entityId)) || []).filter((ts) => ts > start);
        return Math.max(0, cap - arr.length);
    }
    // Returns true if the invite is ALLOWED (and records it); false if over quota.
    function consume(deviceId, entityId) {
        const k = key(deviceId, entityId);
        const t = clock();
        const start = t - win;
        const arr = (hits.get(k) || []).filter((ts) => ts > start);
        if (arr.length >= cap) {
            hits.set(k, arr);
            return false;
        }
        arr.push(t);
        hits.set(k, arr);
        return true;
    }
    return { remaining, consume, cap, windowMs: win };
}

// ── Match-state store (in-memory dedup + dual-consent tracking) ─────────────

function createMatchStore() {
    const matches = new Map(); // matchId -> record
    return {
        get(matchId) {
            return matches.get(matchId) || null;
        },
        has(matchId) {
            return matches.has(matchId);
        },
        upsert(matchId, patch) {
            const cur = matches.get(matchId) || { matchId };
            const next = { ...cur, ...patch };
            matches.set(matchId, next);
            return next;
        },
        all() {
            return Array.from(matches.values());
        },
    };
}

// ── The router ──────────────────────────────────────────────────────────────

/**
 * createRouter injectables (all wired in index.js; faked in tests):
 *   searchItems(query) -> Promise<{items:[...]}> | Promise<[...]>   (P1 bridge)
 *   resolvePublicCode(code) -> { deviceId, entityId, entity } | null
 *   getRosterEntry(code) -> /api/entities record | null
 *   getDevicePrefs(deviceId) -> Promise<prefs>
 *   sendB2bMessage({fromDeviceId,fromEntityId,fromPublicCode,toPublicCode,envelope}) -> Promise<{success}>
 *   createOwnerActionRequest({deviceId,fromEntityId,prompt,options,decisionContext}) -> Promise<{id}>
 *   getActionRequestStatus(requestId, deviceId) -> Promise<{status, approved}>
 *       (approved is TRUE only when the HUMAN owner resolved a crossOwnerPii consent)
 *   getPartyContact({deviceId,entityId,publicCode}) -> Promise<{nameCard, contactInfo}>
 *       (resolved SERVER-SIDE from the owner's trusted records; never the request body)
 *   authenticateCaller({deviceId,entityId,botSecret}) -> { ok, publicCode } | { ok:false }
 *   log(level,cat,msg) ; now() ; quota:{max,windowMs}
 */
function createRouter(opts = {}) {
    const {
        searchItems,
        resolvePublicCode,
        getRosterEntry,
        getDevicePrefs,
        sendB2bMessage,
        createOwnerActionRequest,
        getActionRequestStatus,
        // (MED #4) resolves { nameCard, contactInfo } for a party SERVER-SIDE from
        // that owner's own trusted record — never from the caller's request body.
        getPartyContact,
        authenticateCaller,
        log,
        now,
        quota,
        matchStore,
        // (P4 GA hardening) OPTIONAL metrics sink. If injected it receives
        // observability signals on the REAL control path: inc(name) on a sent /
        // deduped / accepted / declined / contact-released invite, and
        // recordBlock(reason) on every governance rejection. It is a pure
        // side-observer — a throwing or absent metrics object never changes an
        // outcome (calls are guarded + swallowed). Backwards-compatible: P0-P3
        // tests that pass no `metrics` see identical behaviour.
        metrics,
    } = opts;

    const router = express.Router();
    const logger = typeof log === 'function' ? log : () => {};
    const clock = typeof now === 'function' ? now : () => Date.now();
    // Guarded metric helpers — never let observability change a control outcome.
    const metricInc = (name) => {
        try { if (metrics && typeof metrics.inc === 'function') metrics.inc(name); } catch (_e) { /* non-critical */ }
    };
    const metricBlock = (reason) => {
        try { if (metrics && typeof metrics.recordBlock === 'function') metrics.recordBlock(reason); } catch (_e) { /* non-critical */ }
    };
    const store = matchStore || createMatchStore();
    const quotaTracker = createQuotaTracker({
        max: quota && quota.max,
        windowMs: quota && quota.windowMs,
        now: clock,
    });
    const authCaller =
        typeof authenticateCaller === 'function'
            ? authenticateCaller
            : async () => ({ ok: false, reason: 'no_auth_configured' });

    async function prefsFor(deviceId) {
        if (typeof getDevicePrefs !== 'function') return {};
        try {
            return (await getDevicePrefs(deviceId)) || {};
        } catch (_e) {
            return {};
        }
    }

    // Authenticate the caller as a real bound EClaw entity, returning their own
    // resolved publicCode + deviceId/entityId. Fail closed.
    async function requireCaller(body) {
        const { deviceId, entityId, botSecret } = body || {};
        if (!deviceId || entityId === undefined || entityId === null || !botSecret) {
            return { ok: false, status: 401, reason: 'caller authentication required (deviceId, entityId, botSecret)' };
        }
        let caller;
        try {
            caller = await authCaller({ deviceId, entityId, botSecret });
        } catch (err) {
            logger('warn', 'wishlist-matchmaking', `caller auth error: ${err.message}`);
            return { ok: false, status: 502, reason: 'caller auth unavailable' };
        }
        if (!caller || !caller.ok || !caller.publicCode) {
            return { ok: false, status: 403, reason: 'caller is not a verified EClaw entity' };
        }
        return {
            ok: true,
            deviceId,
            entityId,
            publicCode: normalizeCode(caller.publicCode),
        };
    }

    // POST /search — buyer free-text intent → search (P1 bridge) → rerank.
    // Returns ranked candidates + whether an "add my own" fallback is offered
    // (no match). No b2b send here; this is the read/plan step.
    router.post('/search', async (req, res) => {
        const caller = await requireCaller(req.body);
        if (!caller.ok) return res.status(caller.status).json({ error: caller.reason });

        const intent = typeof req.body.intent === 'string' ? req.body.intent.trim() : '';
        if (!intent) return res.status(400).json({ error: 'intent (free-text) is required' });

        let items = [];
        try {
            const raw = await searchItems(intent);
            items = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.items) ? raw.items : []);
        } catch (err) {
            logger('warn', 'wishlist-matchmaking', `search failed: ${err.message}`);
            return res.status(502).json({ error: 'catalogue search failed' });
        }

        const ranked = rerank(intent, items);
        const candidates = ranked
            .filter((r) => r.score > 0)
            .slice(0, 10)
            .map((r) => ({
                itemId: r.item && r.item.id,
                itemName: r.cleanName,
                sellerPublicCode: normalizeCode((r.item && (r.item.publicCode || r.item.ownerPublicCode)) || ''),
                score: r.score,
            }));

        return res.status(200).json({
            intent: sanitizeUntrusted(intent, 200),
            candidates,
            matchFound: candidates.length > 0,
            // No match → the caller MAY add their own listing. This module only
            // SIGNALS that (canAddOwnListing); it does NOT perform the write and has
            // ZERO dependency on the merchant-key path (x-merchant-api-key /
            // WISHLIST_MERCHANT_KEY). The actual "add" is a follow-up: the write path
            // will authenticate the EClaw agent's identity (wishlist backend calls
            // back to EClaw to verify a real entity) — implemented separately under
            // card_e30cf03d2d7b16cbab5cbb6b to avoid two agents editing the wishlist
            // write code at once. Until then this flag is advisory only.
            canAddOwnListing: candidates.length === 0,
        });
    });

    // Core invite logic, shared by POST /invite and POST /connect. `bypassFriendsOnly`
    // is threaded to the injected sender: /connect passes true so the sender skips
    // the target's friends_only rule — but ONLY because the target is verified
    // opted-in here, and ALL the matchmaking governance (opt-in/kill-switch/quota/
    // reachability) still runs. It never bypasses matchmaking's own gates.
    async function handleInvite(req, res, { bypassFriendsOnly } = {}) {
        const caller = await requireCaller(req.body);
        if (!caller.ok) return res.status(caller.status).json({ error: caller.reason });

        const sellerCode = normalizeCode(req.body.sellerPublicCode);
        const itemId = req.body.itemId;
        if (!isValidPublicCode(sellerCode)) {
            return res.status(400).json({ error: 'valid sellerPublicCode is required' });
        }
        if (sellerCode === caller.publicCode) {
            return res.status(400).json({ error: 'cannot invite yourself' });
        }

        // (a) Buyer's OWN kill-switch / opt-in. Matchmaking must not fire unless
        // the buyer's owner opted in.
        const buyerPrefs = await prefsFor(caller.deviceId);
        if (isKillSwitchOn(buyerPrefs)) {
            metricBlock('killswitch');
            return res.status(403).json({ error: 'matchmaking disabled by kill-switch', reason: 'killswitch' });
        }
        if (!isOptedIn(buyerPrefs)) {
            metricBlock('opt_in_off');
            return res.status(403).json({ error: 'matchmaking not enabled for this owner', reason: 'opt_in_off' });
        }

        // (b) Resolve the seller + its owner device, then enforce reachability:
        // the seller must be opted-in. Reachability is OPT-IN ONLY — NOT current
        // liveness. Invites are durable/async, so an opted-in seller that is idle
        // or SLEEPING still receives the invite (blocking on liveness only caused
        // false-negatives).
        const sellerResolved = typeof resolvePublicCode === 'function' ? resolvePublicCode(sellerCode) : null;
        if (!sellerResolved || !sellerResolved.deviceId) {
            return res.status(404).json({ error: 'seller public code not found' });
        }
        const sellerRoster = typeof getRosterEntry === 'function' ? getRosterEntry(sellerCode) : null;
        const sellerPrefs = await prefsFor(sellerResolved.deviceId);
        if (isKillSwitchOn(sellerPrefs)) {
            metricBlock('target_killswitch');
            return res.status(403).json({ error: 'target has matchmaking disabled', reason: 'target_killswitch' });
        }
        if (!isReachableTarget({ rosterEntry: sellerRoster, prefs: sellerPrefs })) {
            metricBlock('unreachable');
            return res.status(409).json({
                error: 'seller has not opted into matchmaking',
                reason: 'unreachable',
            });
        }

        const matchId = computeMatchId(caller.publicCode, itemId, sellerCode);

        // (c) Idempotency: a replayed invite for the same match does NOT re-send.
        const existing = store.get(matchId);
        if (existing && existing.inviteSent) {
            metricInc('invites_deduped');
            return res.status(200).json({ matchId, deduped: true, status: existing.status || 'invited' });
        }

        // (d) Quota — separate counter from CROSS_SPEAK_MAX_MESSAGES.
        if (!quotaTracker.consume(caller.deviceId, caller.entityId)) {
            metricBlock('quota');
            return res.status(429).json({ error: 'matchmaking invite quota exceeded', reason: 'quota' });
        }

        const envelope = buildInviteEnvelope({
            matchId,
            fromPublicCode: caller.publicCode,
            toPublicCode: sellerCode,
            itemId,
            itemName: req.body.itemName,
            note: req.body.note,
        });

        try {
            await sendB2bMessage({
                fromDeviceId: caller.deviceId,
                fromEntityId: caller.entityId,
                fromPublicCode: caller.publicCode,
                toPublicCode: sellerCode,
                envelope,
                // /connect ⇒ skip the target's friends_only rule (opted-in target only).
                bypassFriendsOnly: !!bypassFriendsOnly,
            });
        } catch (err) {
            logger('warn', 'wishlist-matchmaking', `invite send failed: ${err.message}`);
            return res.status(502).json({ error: 'invite delivery failed' });
        }

        store.upsert(matchId, {
            matchId,
            buyerPublicCode: caller.publicCode,
            buyerDeviceId: caller.deviceId,
            buyerEntityId: caller.entityId,
            sellerPublicCode: sellerCode,
            sellerDeviceId: sellerResolved.deviceId,
            sellerEntityId: sellerResolved.entityId,
            itemId: itemId == null ? null : itemId,
            inviteSent: true,
            status: 'invited',
        });
        metricInc('invites_sent');
        logger('info', 'wishlist-matchmaking', `invite sent match=${matchId} ${caller.publicCode}->${sellerCode}`);
        return res.status(200).json({ matchId, status: 'invited', deduped: false });
    }

    // POST /invite — the normal (friends-respecting) trade invite.
    router.post('/invite', (req, res) => handleInvite(req, res, { bypassFriendsOnly: false }));

    // POST /accept — seller accepts an invite; the accept envelope goes back to
    // the buyer. Idempotent on matchId.
    router.post('/accept', async (req, res) => {
        const caller = await requireCaller(req.body);
        if (!caller.ok) return res.status(caller.status).json({ error: caller.reason });

        const matchId = typeof req.body.matchId === 'string' ? req.body.matchId : '';
        const match = store.get(matchId);
        if (!match) return res.status(404).json({ error: 'unknown matchId' });
        // Only the seller side of this match may accept.
        if (normalizeCode(caller.publicCode) !== match.sellerPublicCode) {
            return res.status(403).json({ error: 'only the invited seller may accept this match' });
        }
        // Seller's own governance still applies to the outbound accept.
        const sellerPrefs = await prefsFor(caller.deviceId);
        if (isKillSwitchOn(sellerPrefs)) {
            return res.status(403).json({ error: 'matchmaking disabled by kill-switch', reason: 'killswitch' });
        }
        if (match.accepted) {
            return res.status(200).json({ matchId, deduped: true, status: match.status });
        }

        const envelope = buildAcceptEnvelope({
            matchId,
            fromPublicCode: match.sellerPublicCode,
            toPublicCode: match.buyerPublicCode,
        });
        try {
            await sendB2bMessage({
                fromDeviceId: caller.deviceId,
                fromEntityId: caller.entityId,
                fromPublicCode: match.sellerPublicCode,
                toPublicCode: match.buyerPublicCode,
                envelope,
            });
        } catch (err) {
            logger('warn', 'wishlist-matchmaking', `accept send failed: ${err.message}`);
            return res.status(502).json({ error: 'accept delivery failed' });
        }
        store.upsert(matchId, { accepted: true, status: 'accepted' });
        metricInc('accepts');
        return res.status(200).json({ matchId, status: 'accepted', deduped: false });
    });

    // POST /decline — either side declines; decline envelope to the buyer.
    router.post('/decline', async (req, res) => {
        const caller = await requireCaller(req.body);
        if (!caller.ok) return res.status(caller.status).json({ error: caller.reason });
        const matchId = typeof req.body.matchId === 'string' ? req.body.matchId : '';
        const match = store.get(matchId);
        if (!match) return res.status(404).json({ error: 'unknown matchId' });
        if (
            normalizeCode(caller.publicCode) !== match.sellerPublicCode &&
            normalizeCode(caller.publicCode) !== match.buyerPublicCode
        ) {
            return res.status(403).json({ error: 'not a party to this match' });
        }
        const envelope = buildDeclineEnvelope({ matchId, reason: req.body.reason });
        // Deliver to the OTHER party.
        const toCode = normalizeCode(caller.publicCode) === match.sellerPublicCode
            ? match.buyerPublicCode
            : match.sellerPublicCode;
        try {
            await sendB2bMessage({
                fromDeviceId: caller.deviceId,
                fromEntityId: caller.entityId,
                fromPublicCode: normalizeCode(caller.publicCode),
                toPublicCode: toCode,
                envelope,
            });
        } catch (err) {
            logger('warn', 'wishlist-matchmaking', `decline send failed: ${err.message}`);
            return res.status(502).json({ error: 'decline delivery failed' });
        }
        store.upsert(matchId, { status: 'declined' });
        metricInc('declines');
        return res.status(200).json({ matchId, status: 'declined' });
    });

    // POST /contact/request — begin the DUAL consent flow. Creates a 需要你
    // action-request for EACH owner (buyer + seller). Contact PII is NOT sent
    // here; it is only released once BOTH owners approve (via /contact/release).
    router.post('/contact/request', async (req, res) => {
        const caller = await requireCaller(req.body);
        if (!caller.ok) return res.status(caller.status).json({ error: caller.reason });
        const matchId = typeof req.body.matchId === 'string' ? req.body.matchId : '';
        const match = store.get(matchId);
        if (!match) return res.status(404).json({ error: 'unknown matchId' });
        if (!match.accepted) {
            return res.status(409).json({ error: 'contact exchange requires an accepted match first' });
        }
        if (
            normalizeCode(caller.publicCode) !== match.sellerPublicCode &&
            normalizeCode(caller.publicCode) !== match.buyerPublicCode
        ) {
            return res.status(403).json({ error: 'not a party to this match' });
        }
        if (match.buyerConsentReqId && match.sellerConsentReqId) {
            return res.status(200).json({
                matchId,
                deduped: true,
                status: 'contact_pending',
                buyerConsentReqId: match.buyerConsentReqId,
                sellerConsentReqId: match.sellerConsentReqId,
            });
        }
        if (typeof createOwnerActionRequest !== 'function') {
            return res.status(502).json({ error: 'consent inbox unavailable' });
        }

        const prompt = `撮合聯絡資訊交換：對方想交換聯絡方式完成交易。是否同意釋出你的聯絡資訊？（${SAFETY_DISCLAIMER}）`;
        const options = ['同意釋出 / Approve', '拒絕 / Decline'];
        const decisionContext = {
            ownerOnly: true,
            source: 'wishlist_matchmaking',
            matchId,
            disclaimer: SAFETY_DISCLAIMER,
            // HUMAN-ONLY markers (security review HIGH #1 + #2): this consent releases
            // real contact PII across two owners. crossOwnerPii makes isNegotiable
            // EXCLUDE it (no bot /vote can synthesize+resolve it), and the release gate
            // requires resolved_by_user — so only the HUMAN owner can approve. Neither
            // may be dropped or a bot could self-approve a cross-owner PII release.
            crossOwnerPii: true,
            humanOnly: true,
            whatWasDone: 'Two entities matched on a wishlist trade and both accepted; contact exchange needs owner approval.',
        };

        try {
            const buyerReq = await createOwnerActionRequest({
                deviceId: match.buyerDeviceId,
                fromEntityId: match.buyerEntityId,
                prompt,
                options,
                decisionContext,
            });
            const sellerReq = await createOwnerActionRequest({
                deviceId: match.sellerDeviceId,
                fromEntityId: match.sellerEntityId,
                prompt,
                options,
                decisionContext,
            });
            store.upsert(matchId, {
                status: 'contact_pending',
                buyerConsentReqId: buyerReq && buyerReq.id,
                sellerConsentReqId: sellerReq && sellerReq.id,
            });
            return res.status(200).json({
                matchId,
                status: 'contact_pending',
                buyerConsentReqId: buyerReq && buyerReq.id,
                sellerConsentReqId: sellerReq && sellerReq.id,
            });
        } catch (err) {
            logger('warn', 'wishlist-matchmaking', `contact consent create failed: ${err.message}`);
            return res.status(502).json({ error: 'could not open consent requests' });
        }
    });

    // POST /contact/release — release contact info ONLY when BOTH owners have
    // approved their 需要你 item. One approve + one pending → still gated (409).
    router.post('/contact/release', async (req, res) => {
        const caller = await requireCaller(req.body);
        if (!caller.ok) return res.status(caller.status).json({ error: caller.reason });
        const matchId = typeof req.body.matchId === 'string' ? req.body.matchId : '';
        const match = store.get(matchId);
        if (!match) return res.status(404).json({ error: 'unknown matchId' });
        // (MED #3) party-membership auth — same as /accept, /decline, /contact/request:
        // only the buyer or the seller of THIS match may trigger a release. Without
        // this any bound bot could fire a release (and, pre-MED#4, inject its own PII).
        if (
            normalizeCode(caller.publicCode) !== match.sellerPublicCode &&
            normalizeCode(caller.publicCode) !== match.buyerPublicCode
        ) {
            return res.status(403).json({ error: 'not a party to this match' });
        }
        if (!match.buyerConsentReqId || !match.sellerConsentReqId) {
            return res.status(409).json({ error: 'contact consent has not been requested for this match' });
        }
        if (typeof getActionRequestStatus !== 'function') {
            return res.status(502).json({ error: 'consent status unavailable' });
        }

        let buyerApproved = false;
        let sellerApproved = false;
        try {
            const b = await getActionRequestStatus(match.buyerConsentReqId, match.buyerDeviceId);
            const s = await getActionRequestStatus(match.sellerConsentReqId, match.sellerDeviceId);
            // approved requires BOTH resolved AND resolved by the HUMAN owner — the
            // injected getActionRequestStatus enforces resolved_by_user (HIGH #1).
            buyerApproved = !!(b && b.approved);
            sellerApproved = !!(s && s.approved);
        } catch (err) {
            logger('warn', 'wishlist-matchmaking', `consent status read failed: ${err.message}`);
            return res.status(502).json({ error: 'could not read consent status' });
        }

        if (!(buyerApproved && sellerApproved)) {
            // DUAL gate: one approve + one pending → still gated.
            return res.status(409).json({
                error: 'contact release requires BOTH owners to approve',
                reason: 'dual_consent_pending',
                buyerApproved,
                sellerApproved,
            });
        }

        // (MED #4) Both approved → resolve each party's contact + name-card
        // SERVER-SIDE from that owner's own trusted record. The caller does NOT get
        // to choose the bytes (a caller-supplied contact/nameCard could inject a
        // phishing payload decoupled from what the owner approved). getPartyContact
        // is injected + bound to the owner's device; req.body contact fields are
        // IGNORED entirely.
        if (typeof getPartyContact !== 'function') {
            return res.status(502).json({ error: 'contact source unavailable' });
        }
        let buyerParty;
        let sellerParty;
        try {
            buyerParty = await getPartyContact({
                deviceId: match.buyerDeviceId, entityId: match.buyerEntityId, publicCode: match.buyerPublicCode,
            });
            sellerParty = await getPartyContact({
                deviceId: match.sellerDeviceId, entityId: match.sellerEntityId, publicCode: match.sellerPublicCode,
            });
        } catch (err) {
            logger('warn', 'wishlist-matchmaking', `party contact resolve failed: ${err.message}`);
            return res.status(502).json({ error: 'could not resolve party contact' });
        }

        try {
            // seller's OWN card+contact → buyer
            await sendB2bMessage({
                fromDeviceId: match.sellerDeviceId,
                fromEntityId: match.sellerEntityId,
                fromPublicCode: match.sellerPublicCode,
                toPublicCode: match.buyerPublicCode,
                envelope: buildContactEnvelope({
                    matchId,
                    nameCard: sellerParty && sellerParty.nameCard,
                    contactInfo: sellerParty && sellerParty.contactInfo,
                }),
            });
            // buyer's OWN card+contact → seller
            await sendB2bMessage({
                fromDeviceId: match.buyerDeviceId,
                fromEntityId: match.buyerEntityId,
                fromPublicCode: match.buyerPublicCode,
                toPublicCode: match.sellerPublicCode,
                envelope: buildContactEnvelope({
                    matchId,
                    nameCard: buyerParty && buyerParty.nameCard,
                    contactInfo: buyerParty && buyerParty.contactInfo,
                }),
            });
        } catch (err) {
            logger('warn', 'wishlist-matchmaking', `contact release send failed: ${err.message}`);
            return res.status(502).json({ error: 'contact delivery failed' });
        }

        store.upsert(matchId, { status: 'contact_released', contactReleased: true });
        metricInc('contacts_released');
        return res.status(200).json({ matchId, status: 'contact_released' });
    });

    // POST /connect — bot-callable matchmaking connect request that bypasses
    // friends_only (and the ordinary cross-speak quota) ONLY for opted-in targets.
    // It runs the SAME fully-governed invite path (opt-in/kill-switch/matchmaking-
    // quota/reachability all enforced); its only extra power is threading
    // bypassFriendsOnly:true to the sender, which the sender honours ONLY because
    // reachability already proved the target is opted-in.
    router.post('/connect', (req, res) => handleInvite(req, res, { bypassFriendsOnly: true }));

    // Expose the store + quota for the mount + tests.
    router._store = store;
    router._quota = quotaTracker;
    return router;
}

module.exports = {
    createRouter,
    // pure helpers
    computeMatchId,
    normalizeCode,
    isValidPublicCode,
    sanitizeUntrusted,
    sanitizeContactInfo,
    sanitizeNameCard,
    rerank,
    tokenize,
    buildInviteEnvelope,
    buildAcceptEnvelope,
    buildDeclineEnvelope,
    buildContactEnvelope,
    isReachableTarget,
    isOptedIn,
    isKillSwitchOn,
    createQuotaTracker,
    createMatchStore,
    // constants
    ENVELOPE_TYPES,
    SAFETY_DISCLAIMER,
    CONTACT_PII_KEYS,
    MATCHMAKING_INVITE_QUOTA_DEFAULT,
    MATCHMAKING_QUOTA_WINDOW_MS_DEFAULT,
};
