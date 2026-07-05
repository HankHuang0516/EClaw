/**
 * wishlist-matchmaking-p3 — photo-recognition path + seller-initiated matchmaking
 * + periodic rescan/dedup (card_496f752a622b722f82843d4e, P3).
 *
 * Builds STRICTLY on top of P2 (backend/wishlist-matchmaking.js) — it does NOT
 * fork it. Every buyer↔seller send still goes through P2's ONE egress
 * (`sendB2bMessage`) via P2's own invite path; P3 only adds three new front doors
 * that feed into that same governed handshake:
 *
 *   1. PHOTO PATH  (POST /photo-search)
 *      A buyer OR a seller uploads a photo. EClaw's OWN Claude vision
 *      (self-hosted, billed on the entity-2 ANTHROPIC budget — NOT the counterparty's
 *      user-auth, so it is never blocked by their session) extracts an item
 *      name + tags. That extracted text is fed into P2's /search (the P1 SSRF-safe
 *      bridge). A per-window VISION COST CAP (D4b) bounds spend; over the cap →
 *      fail-closed 429, no vision call, no charge.
 *
 *   2. SELLER-INITIATED MATCHMAKING  (POST /seller-listing-scan)
 *      A seller has listed an item (written through the P1/write-auth
 *      authenticated path — P3 never writes the listing itself). P3 reverse-searches
 *      the buyer wishlist catalogue for that item and, for each matched buyer,
 *      fires P2's fully-governed invite (opt-in/kill-switch/quota/reachability all
 *      enforced) FROM the seller TO the buyer. matchId dedups repeat scans.
 *
 *   3. PERIODIC RESCAN / DEDUP  (POST /rescan  — cron-callable)
 *      The authenticated caller (a buyer/agent) re-checks its OWN still-unmatched
 *      wishes; for each new (buyer,item,seller) triple, send EXACTLY ONE invite
 *      ever. Idempotency key is matchId = P2.computeMatchId(buyer,item,seller); a
 *      triple whose matchId is already in the shared match store is skipped, so
 *      re-running is a no-op. The invite is always sent FROM the authenticated
 *      caller — a rescan CANNOT invite on behalf of a code the caller doesn't
 *      control (see OPEN PRODUCT QUESTION: a central multi-buyer scheduler would
 *      need a privileged impersonation capability we deliberately do NOT grant here).
 *
 * SECURITY (the class that bit P1 & P2):
 *   - Every new send binds `from` to the caller's VERIFIED publicCode (P2's
 *     authenticateCaller → resolved publicCode). A body-supplied `fromPublicCode`
 *     is REJECTED unless it equals the caller's own code — the invite is ALWAYS
 *     sent FROM the authenticated caller. No impersonation, in any flow.
 *   - Auth/verify happens BEFORE any privileged read (vision key, catalogue search).
 *   - Vision provider key is read SERVER-SIDE by NAME from the vault, never taken
 *     from the request, never logged, never returned. If the key is absent or the
 *     upstream is down → fail-closed (503/429), never a silent fallback that leaks.
 *   - Untrusted photo-derived text is sanitised with P2.sanitizeUntrusted before it
 *     can enter an envelope or a downstream prompt (prompt-injection defence).
 *   - No cross-owner PII: P3 only reaches P2's INVITE stage. Contact exchange stays
 *     behind P2's dual human-marked consent gate — P3 has no contact path at all.
 *
 * Everything is INJECTED via createRouter({...}) so the module is unit-testable
 * with no network, no DB, and no real LLM — mirrors P2 / wishlist-route.js.
 */

const express = require('express');
const mm = require('./wishlist-matchmaking'); // P2 — reuse, do not fork

// ── Vision cost cap (D4b) ────────────────────────────────────────────────────
// Photo recognition calls EClaw's own Claude vision. Each call costs tokens on
// the entity-2 ANTHROPIC budget, so a SEPARATE rolling-window cap bounds how many
// recognitions can run per caller-device before we fail closed. Deliberately small.
const VISION_CALL_CAP_DEFAULT = 20;              // recognitions / device / window
const VISION_WINDOW_MS_DEFAULT = 60 * 60 * 1000; // 1h rolling window

// Reasonable bounds on an uploaded image we will forward to vision (defence in
// depth against a huge / hostile payload; the real byte transfer already happened
// via /api/files/upload, we only receive a reference + small metadata here).
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MiB
const ACCEPTED_MIME = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// How many recognised tags we keep, and their max length (sanitised).
const MAX_TAGS = 12;
const MAX_TAG_LEN = 40;
const MAX_ITEMNAME_LEN = 120;

// ── Pure helpers (exported for direct unit tests) ────────────────────────────

/**
 * Normalise + sanitise the structured result coming back from the (untrusted)
 * vision model. The model output is treated as HOSTILE text — a crafted photo
 * could carry an adversarial "itemName" trying to inject downstream. We reuse
 * P2.sanitizeUntrusted (control-char / injection-lead-in strip + length cap) on
 * every string before it leaves this function.
 *
 * Returns { itemName, tags:[...] } — both sanitised, tags deduped + bounded.
 */
function normalizeVisionResult(raw) {
    const obj = raw && typeof raw === 'object' ? raw : {};
    const itemName = mm.sanitizeUntrusted(obj.itemName || obj.name || '', MAX_ITEMNAME_LEN);
    const rawTags = Array.isArray(obj.tags) ? obj.tags : [];
    const seen = new Set();
    const tags = [];
    for (const t of rawTags) {
        const clean = mm.sanitizeUntrusted(t, MAX_TAG_LEN);
        const key = clean.toLowerCase();
        if (clean && !seen.has(key)) {
            seen.add(key);
            tags.push(clean);
            if (tags.length >= MAX_TAGS) break;
        }
    }
    return { itemName, tags };
}

/**
 * Build the free-text search intent fed into P2's catalogue search from a
 * recognised photo. itemName leads; a bounded set of tags follows. Everything is
 * already sanitised by normalizeVisionResult; we just join + cap.
 */
function buildIntentFromVision({ itemName, tags }) {
    const parts = [];
    if (itemName) parts.push(itemName);
    if (Array.isArray(tags) && tags.length) parts.push(tags.join(' '));
    return mm.sanitizeUntrusted(parts.join(' ').trim(), 200);
}

/** True iff an uploaded-image descriptor is acceptable to forward to vision. */
function isAcceptableImage({ mimeType, size } = {}) {
    if (!mimeType || typeof mimeType !== 'string') return false;
    if (!ACCEPTED_MIME.includes(mimeType.toLowerCase())) return false;
    const n = Number(size);
    if (!Number.isFinite(n) || n <= 0 || n > MAX_IMAGE_BYTES) return false;
    return true;
}

/**
 * Separate rolling-window cost cap for vision recognitions. Same shape as P2's
 * quota tracker but a DISTINCT counter (photo cost must not be masked by, or
 * starve, ordinary invite quota). Returns { remaining, consume, cap, windowMs }.
 */
function createVisionCostGuard({ max, windowMs, now } = {}) {
    const cap = Number.isFinite(Number(max)) ? Number(max) : VISION_CALL_CAP_DEFAULT;
    const win = Number.isFinite(Number(windowMs)) ? Number(windowMs) : VISION_WINDOW_MS_DEFAULT;
    const clock = typeof now === 'function' ? now : () => Date.now();
    const hits = new Map(); // deviceId -> [timestamps]

    function remaining(deviceId) {
        const t = clock();
        const start = t - win;
        const arr = (hits.get(deviceId) || []).filter((ts) => ts > start);
        return Math.max(0, cap - arr.length);
    }
    // Returns true if a recognition is ALLOWED (and records it); false if over cap.
    function consume(deviceId) {
        const t = clock();
        const start = t - win;
        const arr = (hits.get(deviceId) || []).filter((ts) => ts > start);
        if (arr.length >= cap) {
            hits.set(deviceId, arr);
            return false;
        }
        arr.push(t);
        hits.set(deviceId, arr);
        return true;
    }
    return { remaining, consume, cap, windowMs: win };
}

/**
 * Deterministic rescan-attempt key so a rescan sends EXACTLY ONE invite per
 * (buyer,item,seller) ever. This is the SAME identity P2 uses for a match
 * (P2.computeMatchId) — so a rescan-triggered invite dedups against a manually
 * triggered one and vice-versa. Kept as a thin re-export for callers/tests.
 */
function rescanMatchId(buyerPublicCode, itemId, sellerPublicCode) {
    return mm.computeMatchId(buyerPublicCode, itemId, sellerPublicCode);
}

// ── The router ────────────────────────────────────────────────────────────────

/**
 * createRouter injectables (wired in index.js; faked in tests). P3 reuses the P2
 * primitives directly and adds only vision + reverse-search:
 *
 *   authenticateCaller({deviceId,entityId,botSecret}) -> {ok, publicCode} | {ok:false}
 *        SAME verifier as P2 / write-auth. The ONLY identity source. Fail closed.
 *   recognizeItem({imageData?, fileId?, mimeType, size, deviceId}) -> Promise<{itemName,tags}>
 *        SERVER-SIDE vision. Wired in index.js to EClaw's OWN Claude vision with the
 *        provider key read by NAME from the vault. It MUST NOT accept a key from the
 *        caller. Throws on upstream failure so the route can fail closed.
 *        Supported photo input in this release is caller-supplied base64
 *        (`imageData`); a server-side fetch-by-`fileId` (device-scoped R2 fetch) is
 *        a documented follow-up — a fileId-only request currently throws here and the
 *        route fails closed (502), it does NOT silently succeed.
 *   searchItems(intent) -> Promise<{items:[...]}> | Promise<[...]>   (P1 bridge, same as P2)
 *   governedInvite({caller, fromPublicCode, toPublicCode, itemId, itemName, note, bypassFriendsOnly})
 *        -> Promise<{status, matchId, deduped, reason?}>
 *        Runs P2's FULL governed invite path (opt-in/kill-switch/quota/reachability).
 *        Wired in index.js to call the P2 invite logic so P3 never re-implements
 *        governance. `caller` is the AUTHENTICATED request principal; `fromPublicCode`
 *        is who the invite is sent AS (must be a code the caller is entitled to drive
 *        — the wired impl verifies this) and `toPublicCode` is whom to invite. The
 *        matchId is always P2.computeMatchId(buyer,item,seller) regardless of who
 *        initiated, so dedup is symmetric.
 *   matchStore  — the SHARED P2 match store (dedup across P2 + P3). REQUIRED for
 *        rescan idempotency; if absent P3 makes its own (still correct within P3).
 *   visionCost:{max,windowMs} ; log ; now
 */
function createRouter(opts = {}) {
    const {
        authenticateCaller,
        recognizeItem,
        searchItems,
        governedInvite,
        matchStore,
        visionCost,
        log,
        now,
    } = opts;

    const router = express.Router();
    const logger = typeof log === 'function' ? log : () => {};
    const clock = typeof now === 'function' ? now : () => Date.now();
    const store = matchStore || mm.createMatchStore();
    const visionGuard = createVisionCostGuard({
        max: visionCost && visionCost.max,
        windowMs: visionCost && visionCost.windowMs,
        now: clock,
    });
    const authCaller =
        typeof authenticateCaller === 'function'
            ? authenticateCaller
            // Fail CLOSED if not wired.
            : async () => ({ ok: false, reason: 'no_auth_configured' });

    // Authenticate the caller as a real bound EClaw entity → their OWN publicCode.
    // Identical contract to P2.requireCaller. Fail closed on missing/bad creds.
    async function requireCaller(body) {
        const { deviceId, entityId, botSecret } = body || {};
        if (!deviceId || entityId === undefined || entityId === null || !botSecret) {
            return { ok: false, status: 401, reason: 'caller authentication required (deviceId, entityId, botSecret)' };
        }
        let caller;
        try {
            caller = await authCaller({ deviceId, entityId, botSecret });
        } catch (err) {
            logger('warn', 'wishlist-matchmaking-p3', `caller auth error: ${err.message}`);
            return { ok: false, status: 502, reason: 'caller auth unavailable' };
        }
        if (!caller || !caller.ok || !caller.publicCode) {
            return { ok: false, status: 403, reason: 'caller is not a verified EClaw entity' };
        }
        return {
            ok: true,
            deviceId,
            entityId,
            // The caller's OWN verified credentials, threaded to the governed invite
            // so the invite is driven with the caller as the P2 principal — NEVER by
            // looking up another entity's secret. This is the fix for the P1/P2
            // "verified ≠ wired principal" defect: the identity we verified here IS
            // the identity that drives the on-wire send.
            botSecret,
            publicCode: mm.normalizeCode(caller.publicCode),
        };
    }

    // Send a governed invite with a HARD principal-binding: the invite is ALWAYS
    // driven with the AUTHENTICATED CALLER as the P2 principal (its own verified
    // creds), so the on-wire envelope's `from` is the caller and P2 checks the
    // CALLER's opt-in + consumes the CALLER's quota + checks the TARGET's
    // reachability. A `fromPublicCode` that is NOT the caller's own code is REJECTED
    // — this closes the P1/P2 "verified ≠ wired principal" defect (never look up or
    // use another entity's botSecret to act on its behalf).
    //
    // Canonical dedup: `buyerPublicCode`/`sellerPublicCode` fix the matchId order
    // (buyer,item,seller) SYMMETRICALLY regardless of who initiated. P3 owns this
    // dedup at the shared store (P2's internal matchId is keyed on ITS caller, which
    // differs by direction), checking BEFORE the send and stamping AFTER a real send.
    async function sendGovernedInvite(caller, { fromPublicCode, toPublicCode, buyerPublicCode, sellerPublicCode, itemId, itemName, note, bypassFriendsOnly, rescan }) {
        const from = mm.normalizeCode(fromPublicCode);
        const to = mm.normalizeCode(toPublicCode);
        const buyer = mm.normalizeCode(buyerPublicCode);
        const seller = mm.normalizeCode(sellerPublicCode);
        // Principal-binding guard — fail closed. `from` MUST be the verified caller.
        if (from !== caller.publicCode) {
            return { ok: false, reason: 'from_not_caller' };
        }
        if (!mm.isValidPublicCode(to) || to === from) {
            return { ok: false, reason: 'invalid_or_self_target' };
        }

        // Canonical dedup pre-check on the SHARED store (symmetric across directions).
        const canonicalMatchId = mm.computeMatchId(buyer, itemId, seller);
        const existing = store.get(canonicalMatchId);
        if (existing && existing.inviteSent) {
            return { ok: true, result: { status: 'invited', matchId: canonicalMatchId, deduped: true } };
        }

        const result = await governedInvite({
            caller,
            // The caller's OWN verified credentials drive the P2 principal. The wired
            // impl uses THESE — it never resolves another entity's secret.
            callerCreds: { deviceId: caller.deviceId, entityId: caller.entityId, botSecret: caller.botSecret },
            fromPublicCode: caller.publicCode, // force the verified identity
            toPublicCode: to,
            buyerPublicCode: buyer,
            sellerPublicCode: seller,
            canonicalMatchId,
            itemId,
            itemName,
            note,
            bypassFriendsOnly: !!bypassFriendsOnly,
            rescan: !!rescan,
        });

        // Stamp the canonical key after a REAL send so a cross-direction replay dedups.
        if (result && (result.status === 'invited') && !result.deduped) {
            store.upsert(canonicalMatchId, {
                matchId: canonicalMatchId,
                buyerPublicCode: buyer,
                sellerPublicCode: seller,
                itemId: itemId == null ? null : itemId,
                inviteSent: true,
                status: 'invited',
            });
        }
        return { ok: true, result };
    }

    // ── (1) PHOTO PATH ────────────────────────────────────────────────────────
    // POST /photo-search — a buyer OR seller uploads a photo; EClaw's own vision
    // extracts item name/tags; that intent is fed into the P1-backed catalogue
    // search. This is the READ/PLAN step (mirrors P2 /search) — NO b2b send here.
    // Vision cost is capped (D4b): over the cap → 429, and the vision call never
    // runs (so no spend, no upstream hit).
    router.post('/photo-search', async (req, res) => {
        const caller = await requireCaller(req.body);
        if (!caller.ok) return res.status(caller.status).json({ error: caller.reason });

        // Validate the image descriptor BEFORE spending the cost budget or calling
        // vision. A caller cannot smuggle a non-image or an oversize payload.
        const image = {
            fileId: typeof req.body.fileId === 'string' ? req.body.fileId : undefined,
            imageData: typeof req.body.imageData === 'string' ? req.body.imageData : undefined,
            mimeType: req.body.mimeType,
            size: req.body.size,
        };
        if (!image.fileId && !image.imageData) {
            return res.status(400).json({ error: 'fileId or imageData is required' });
        }
        if (!isAcceptableImage(image)) {
            return res.status(400).json({
                error: 'image must be jpeg/png/webp/gif and <= 8MiB',
                reason: 'bad_image',
            });
        }
        if (typeof recognizeItem !== 'function') {
            // Fail CLOSED — no vision wired means no recognition.
            return res.status(503).json({ error: 'photo recognition unavailable', reason: 'no_vision' });
        }

        // (D4b) Cost cap — consume BEFORE the vision call. Over cap → fail closed,
        // vision never runs, nothing is billed.
        if (!visionGuard.consume(caller.deviceId)) {
            return res.status(429).json({
                error: 'photo recognition cost cap reached; try again later',
                reason: 'vision_cost_cap',
            });
        }

        // SERVER-SIDE vision. The provider key is resolved inside recognizeItem
        // (index.js), never taken from the request. Any failure → fail closed.
        let recognised;
        try {
            const rawVision = await recognizeItem({
                fileId: image.fileId,
                imageData: image.imageData,
                mimeType: String(image.mimeType).toLowerCase(),
                size: Number(image.size),
                deviceId: caller.deviceId,
            });
            recognised = normalizeVisionResult(rawVision);
        } catch (err) {
            logger('warn', 'wishlist-matchmaking-p3', `vision recognition failed: ${err.message}`);
            return res.status(502).json({ error: 'photo recognition failed', reason: 'vision_error' });
        }
        if (!recognised.itemName && recognised.tags.length === 0) {
            return res.status(200).json({
                recognised: { itemName: '', tags: [] },
                intent: '',
                candidates: [],
                matchFound: false,
                reason: 'no_recognition',
            });
        }

        // Feed the recognised, sanitised intent into the P1-backed catalogue search.
        const intent = buildIntentFromVision(recognised);
        let items = [];
        try {
            const rawSearch = await searchItems(intent);
            items = Array.isArray(rawSearch)
                ? rawSearch
                : (rawSearch && Array.isArray(rawSearch.items) ? rawSearch.items : []);
        } catch (err) {
            logger('warn', 'wishlist-matchmaking-p3', `photo search failed: ${err.message}`);
            return res.status(502).json({ error: 'catalogue search failed', reason: 'search_error' });
        }

        // Reuse P2's exact rerank so photo-path ranking == text-path ranking, and
        // any hostile listing text is sanitised by P2 the same way.
        const ranked = mm.rerank(intent, items);
        const candidates = ranked
            .filter((r) => r.score > 0)
            .slice(0, 10)
            .map((r) => ({
                itemId: r.item && r.item.id,
                itemName: r.cleanName,
                sellerPublicCode: mm.normalizeCode((r.item && (r.item.publicCode || r.item.ownerPublicCode)) || ''),
                score: r.score,
            }));

        return res.status(200).json({
            recognised,
            intent,
            candidates,
            matchFound: candidates.length > 0,
            visionRemaining: visionGuard.remaining(caller.deviceId),
        });
    });

    // ── (2) SELLER-INITIATED MATCHMAKING ───────────────────────────────────────
    // POST /seller-listing-scan — the authenticated SELLER has a listing (already
    // written via the authenticated write path — NOT here). P3 reverse-searches the
    // buyer wishlist catalogue and, for each matched buyer, fires P2's fully-governed
    // invite FROM the seller TO the buyer. matchId dedups repeat scans.
    //
    // The invite's `from` is ALWAYS the authenticated caller's publicCode — a seller
    // can never make P3 invite on behalf of a code they don't control.
    router.post('/seller-listing-scan', async (req, res) => {
        const caller = await requireCaller(req.body);
        if (!caller.ok) return res.status(caller.status).json({ error: caller.reason });

        // The seller describes their own listing. itemId identifies the listing;
        // itemName/note are sanitised inside P2's invite builder. The listing text
        // used to reverse-search is sanitised here too (it is caller-supplied).
        const itemId = req.body.itemId;
        const listingText = mm.sanitizeUntrusted(
            req.body.itemName || req.body.listingText || '',
            200
        );
        if (!listingText) {
            return res.status(400).json({ error: 'itemName / listingText is required to reverse-search buyers' });
        }
        if (typeof governedInvite !== 'function') {
            return res.status(503).json({ error: 'seller matchmaking unavailable', reason: 'no_invite_path' });
        }

        // Reverse-search the buyer wishlist catalogue for this listing.
        let items = [];
        try {
            const rawSearch = await searchItems(listingText);
            items = Array.isArray(rawSearch)
                ? rawSearch
                : (rawSearch && Array.isArray(rawSearch.items) ? rawSearch.items : []);
        } catch (err) {
            logger('warn', 'wishlist-matchmaking-p3', `reverse buyer search failed: ${err.message}`);
            return res.status(502).json({ error: 'buyer search failed', reason: 'search_error' });
        }

        // Rank buyer wishes against the listing (reuse P2 rerank). Each candidate is
        // a buyer entity whose wish matches. We invite the BUYER, from the SELLER.
        const ranked = mm.rerank(listingText, items).filter((r) => r.score > 0).slice(0, 10);

        const invited = [];
        const skipped = [];
        for (const r of ranked) {
            const buyerCode = mm.normalizeCode(
                (r.item && (r.item.publicCode || r.item.ownerPublicCode)) || ''
            );
            // A buyer wish must carry a valid, DIFFERENT public code (never self).
            if (!mm.isValidPublicCode(buyerCode) || buyerCode === caller.publicCode) {
                skipped.push({ buyerPublicCode: buyerCode || null, reason: 'invalid_or_self' });
                continue;
            }

            // Canonical matchId (buyer,item,seller) for reporting; sendGovernedInvite
            // owns the authoritative dedup on the SHARED store using this same key, so
            // a SELLER-initiated invite dedups symmetrically against a BUYER-initiated
            // one for the same triple. Exactly-once.
            const matchId = mm.computeMatchId(buyerCode, itemId, caller.publicCode);

            // Fire P2's FULL governed invite with the SELLER (caller) as the P2
            // principal — so P2 checks the SELLER's opt-in, consumes the SELLER's
            // quota, and checks the TARGET (buyer)'s reachability (online AND
            // opted-in). Delivery: from = authenticated seller (caller), to = buyer.
            // Canonical roles for matchId: buyer = matched buyer, seller = caller.
            // bypassFriendsOnly is false — a cold seller invite respects friends_only.
            try {
                const sent = await sendGovernedInvite(caller, {
                    fromPublicCode: caller.publicCode,  // send AS the authenticated seller
                    toPublicCode: buyerCode,            // invite the matched buyer
                    buyerPublicCode: buyerCode,         // canonical buyer (for matchId)
                    sellerPublicCode: caller.publicCode, // canonical seller (for matchId)
                    itemId,
                    itemName: r.cleanName,
                    note: mm.sanitizeUntrusted(req.body.note, 200),
                    bypassFriendsOnly: false,
                });
                if (!sent.ok) {
                    skipped.push({ buyerPublicCode: buyerCode, matchId, reason: sent.reason });
                    continue;
                }
                const result = sent.result;
                if (result && (result.status === 'invited' || result.deduped)) {
                    invited.push({ buyerPublicCode: buyerCode, matchId: result.matchId || matchId, deduped: !!result.deduped });
                } else {
                    skipped.push({ buyerPublicCode: buyerCode, matchId, reason: (result && result.reason) || 'not_sent' });
                }
            } catch (err) {
                // A single buyer being unreachable / over quota must not abort the
                // whole scan; record and continue.
                skipped.push({ buyerPublicCode: buyerCode, matchId, reason: 'invite_blocked', detail: err.message });
            }
        }

        return res.status(200).json({
            sellerPublicCode: caller.publicCode,
            invited,
            skipped,
            invitedCount: invited.length,
        });
    });

    // ── (3) PERIODIC RESCAN / DEDUP ─────────────────────────────────────────────
    // POST /rescan — cron-callable. The authenticated caller re-checks its OWN
    // still-unmatched wishes (each wish: {itemId, sellerPublicCode, itemName?}) and
    // sends EXACTLY ONE invite per (caller-as-buyer, item, seller) triple ever.
    // Idempotent: re-running is a no-op because matchId (buyer,item,seller) is
    // already in the shared store.
    //
    // Auth + impersonation guard: the invite is sent FROM the authenticated caller
    // (the buyer / wish owner). A wish that names a different buyer is REJECTED —
    // a rescan can NEVER invite on behalf of a code the caller doesn't control.
    // (OPEN PRODUCT QUESTION: a central multi-buyer scheduler would need a
    // privileged impersonation capability, which we deliberately do not grant here.)
    router.post('/rescan', async (req, res) => {
        const caller = await requireCaller(req.body);
        if (!caller.ok) return res.status(caller.status).json({ error: caller.reason });

        const wishes = Array.isArray(req.body.wishes) ? req.body.wishes : null;
        if (!wishes) {
            return res.status(400).json({ error: 'wishes[] is required (each: {itemId, sellerPublicCode, itemName?}; buyer = the authenticated caller)' });
        }
        if (typeof governedInvite !== 'function') {
            return res.status(503).json({ error: 'rescan invite path unavailable', reason: 'no_invite_path' });
        }

        // The buyer is ALWAYS the authenticated caller. A wish may echo buyerPublicCode
        // but it must equal the caller — anything else is rejected (impersonation guard).
        const buyerCode = caller.publicCode;

        const sentNow = [];
        const dedupedAlready = [];
        const invalid = [];
        for (const w of wishes) {
            const sellerCode = mm.normalizeCode(w && w.sellerPublicCode);
            const itemId = w && w.itemId;
            const claimedBuyer = w && w.buyerPublicCode != null ? mm.normalizeCode(w.buyerPublicCode) : buyerCode;
            if (claimedBuyer !== buyerCode) {
                // Impersonation attempt — the wish names a buyer that isn't the caller.
                invalid.push({ sellerPublicCode: sellerCode || null, reason: 'buyer_not_caller' });
                continue;
            }
            if (!mm.isValidPublicCode(sellerCode) || sellerCode === buyerCode) {
                invalid.push({ sellerPublicCode: sellerCode || null, reason: 'invalid_seller' });
                continue;
            }

            const matchId = rescanMatchId(buyerCode, itemId, sellerCode);
            const existing = store.get(matchId);
            if (existing && existing.inviteSent) {
                // EXACTLY ONCE — already invited for this triple. No re-send.
                dedupedAlready.push({ buyerPublicCode: buyerCode, sellerPublicCode: sellerCode, matchId });
                continue;
            }

            // Send the ONE invite: buyer (caller) -> seller (the wish owner reaches out
            // to the seller who now stocks it). Fully governed via P2's path.
            // from = to caller, canonical roles: buyer = caller, seller = the target.
            try {
                const sent = await sendGovernedInvite(caller, {
                    fromPublicCode: buyerCode,     // send AS the wish owner (the caller)
                    toPublicCode: sellerCode,      // invite the seller who now stocks it
                    buyerPublicCode: buyerCode,    // canonical buyer (for matchId)
                    sellerPublicCode: sellerCode,  // canonical seller (for matchId)
                    itemId,
                    itemName: mm.sanitizeUntrusted(w.itemName, 120),
                    note: mm.sanitizeUntrusted(w.note, 200),
                    bypassFriendsOnly: false,
                    rescan: true,
                });
                if (!sent.ok) {
                    invalid.push({ buyerPublicCode: buyerCode, sellerPublicCode: sellerCode, matchId, reason: sent.reason });
                    continue;
                }
                const result = sent.result;
                if (result && (result.status === 'invited' || result.deduped)) {
                    if (result.deduped) {
                        dedupedAlready.push({ buyerPublicCode: buyerCode, sellerPublicCode: sellerCode, matchId: result.matchId || matchId });
                    } else {
                        sentNow.push({ buyerPublicCode: buyerCode, sellerPublicCode: sellerCode, matchId: result.matchId || matchId });
                    }
                } else {
                    invalid.push({ buyerPublicCode: buyerCode, sellerPublicCode: sellerCode, matchId, reason: (result && result.reason) || 'not_sent' });
                }
            } catch (err) {
                invalid.push({ buyerPublicCode: buyerCode, sellerPublicCode: sellerCode, matchId, reason: 'invite_blocked', detail: err.message });
            }
        }

        return res.status(200).json({
            sentNow,
            dedupedAlready,
            invalid,
            sentCount: sentNow.length,
            dedupedCount: dedupedAlready.length,
        });
    });

    // Expose the store + guard for the mount + tests.
    router._store = store;
    router._visionGuard = visionGuard;
    return router;
}

module.exports = {
    createRouter,
    // pure helpers
    normalizeVisionResult,
    buildIntentFromVision,
    isAcceptableImage,
    createVisionCostGuard,
    rescanMatchId,
    // constants
    VISION_CALL_CAP_DEFAULT,
    VISION_WINDOW_MS_DEFAULT,
    MAX_IMAGE_BYTES,
    ACCEPTED_MIME,
    MAX_TAGS,
};
