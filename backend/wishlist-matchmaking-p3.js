/**
 * wishlist-matchmaking-p3 — caller-recognised photo path + seller-initiated
 * matchmaking + periodic rescan/dedup (card_496f752a622b722f82843d4e, P3).
 *
 * ARCHITECTURE PRINCIPLE — 官方不介入 (the platform stays out of the loop).
 * (Hank, 2026-07-05, card_e61aa62a). The platform does NOT run compute for agents,
 * does NOT act on their behalf, and does NOT subsidise. EClaw = MATCHING + standard
 * STORAGE only. Each party's OWN Agent brings its own vision and calls this API with
 * its own identity. Concretely for P3:
 *   - There is NO server-side vision / LLM call in matchmaking. Photo recognition is
 *     the CALLER's job: the buyer's / seller's own Agent runs its own vision and
 *     submits the ALREADY-RECOGNISED item (name/tags). The platform never reads a
 *     vision provider key and never bills a recognition.
 *   - A listing PHOTO uses EClaw's EXISTING standard storage (`/api/files` → R2 →
 *     fileId), referenced by fileId, device-scoped ownership. P3 never intakes raw
 *     image bytes and never fetches a cross-device file.
 *
 * Builds STRICTLY on top of P2 (backend/wishlist-matchmaking.js) — it does NOT
 * fork it. Every buyer↔seller send still goes through P2's ONE egress
 * (`sendB2bMessage`) via P2's own invite path; P3 only adds three front doors that
 * feed into that same governed handshake:
 *
 *   1. PHOTO PATH  (POST /photo-search)
 *      A buyer OR a seller has ALREADY recognised an item with THEIR OWN Agent's
 *      vision and submits the result ({itemName, tags}). Optionally they reference a
 *      listing photo they already uploaded to EClaw's standard storage by `fileId`
 *      (device-scoped; owner only). P3 sanitises the caller-supplied recognised text
 *      and feeds it into P2's /search (the P1 SSRF-safe bridge). READ/PLAN only —
 *      NO b2b send here, NO vision here.
 *
 *   2. SELLER-INITIATED MATCHMAKING  (POST /seller-listing-scan)
 *      A seller has listed an item (written through the P1/write-auth authenticated
 *      path — P3 never writes the listing itself). P3 reverse-searches the buyer
 *      wishlist catalogue for that item and, for each matched buyer, fires P2's
 *      fully-governed invite (opt-in/kill-switch/quota/reachability all enforced)
 *      FROM the seller TO the buyer. matchId dedups repeat scans.
 *
 *   3. PERIODIC RESCAN / DEDUP  (POST /rescan  — cron-callable)
 *      The AUTHENTICATED caller (a buyer/agent) re-checks its OWN still-unmatched
 *      wishes; for each new (buyer,item,seller) triple, send EXACTLY ONE invite ever.
 *      Idempotency key is matchId = P2.computeMatchId(buyer,item,seller); a triple
 *      whose matchId is already in the shared match store is skipped, so re-running
 *      is a no-op. The invite is ALWAYS sent FROM the authenticated caller — a rescan
 *      CANNOT invite on behalf of a code the caller doesn't control. There is NO
 *      central/privileged multi-buyer scheduler (「官方不介入」): each buyer's own
 *      Agent calls /rescan itself with its own identity.
 *
 * SECURITY (the class that bit P1 & P2):
 *   - Every new send binds `from` to the caller's VERIFIED publicCode (P2's
 *     authenticateCaller → resolved publicCode). A body-supplied `fromPublicCode` is
 *     REJECTED unless it equals the caller's own code — the invite is ALWAYS sent
 *     FROM the authenticated caller. No impersonation, in any flow.
 *   - Auth/verify happens BEFORE any privileged read (catalogue search, file lookup).
 *   - Untrusted caller-supplied recognised text is sanitised with P2.sanitizeUntrusted
 *     before it can enter an envelope or a search intent (prompt-injection defence).
 *   - A referenced listing `fileId` is resolved ONLY as the OWNER device's file
 *     (device-scoped); a caller can never reference another device's file (no IDOR).
 *   - No cross-owner PII: P3 only reaches P2's INVITE stage. Contact exchange stays
 *     behind P2's dual human-marked consent gate — P3 has no contact path at all.
 *
 * Everything is INJECTED via createRouter({...}) so the module is unit-testable
 * with no network, no DB, and no real LLM — mirrors P2 / wishlist-route.js.
 */

const express = require('express');
const mm = require('./wishlist-matchmaking'); // P2 — reuse, do not fork

// How many recognised tags we keep, and their max length (sanitised). The caller's
// own Agent produced these; we treat them as UNTRUSTED text regardless.
const MAX_TAGS = 12;
const MAX_TAG_LEN = 40;
const MAX_ITEMNAME_LEN = 120;

// ── Pure helpers (exported for direct unit tests) ────────────────────────────

/**
 * Normalise + sanitise the structured recognised item the CALLER submitted. The
 * caller's Agent ran its own vision; we still treat the result as HOSTILE text — a
 * crafted photo (or a crafted caller) could carry an adversarial "itemName" trying
 * to inject downstream. We reuse P2.sanitizeUntrusted (control-char / injection-
 * lead-in strip + length cap) on every string before it leaves this function.
 *
 * Returns { itemName, tags:[...] } — both sanitised, tags deduped + bounded.
 */
function normalizeRecognizedItem(raw) {
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
 * caller-recognised item. itemName leads; a bounded set of tags follows. Everything
 * is already sanitised by normalizeRecognizedItem; we just join + cap.
 */
function buildIntentFromRecognized({ itemName, tags }) {
    const parts = [];
    if (itemName) parts.push(itemName);
    if (Array.isArray(tags) && tags.length) parts.push(tags.join(' '));
    return mm.sanitizeUntrusted(parts.join(' ').trim(), 200);
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
 * primitives directly and adds only caller-recognised intake + reverse-search:
 *
 *   authenticateCaller({deviceId,entityId,botSecret}) -> {ok, publicCode} | {ok:false}
 *        SAME verifier as P2 / write-auth. The ONLY identity source. Fail closed.
 *   searchItems(intent) -> Promise<{items:[...]}> | Promise<[...]>   (P1 bridge, same as P2)
 *   resolveOwnedFile({fileId, deviceId}) -> Promise<{fileId, mimeType?, ...} | null>   (optional)
 *        DEVICE-SCOPED file metadata lookup for a referenced listing photo. Wired in
 *        index.js to EClaw's standard /api/files store (r2_files WHERE file_id=? AND
 *        device_id=?). MUST return null for a file the caller's device does not own
 *        (no cross-device read / IDOR). Optional: photo-search works without a fileId
 *        (the recognised item alone drives the search). There is NO server-side
 *        vision — the platform never reads image bytes for recognition.
 *   governedInvite({callerCreds, fromPublicCode, toPublicCode, itemId, itemName, note, bypassFriendsOnly})
 *        -> Promise<{status, matchId, deduped, reason?}>
 *        Runs P2's FULL governed invite path (opt-in/kill-switch/quota/reachability).
 *        Wired in index.js to call the P2 invite logic so P3 never re-implements
 *        governance. `callerCreds` is the AUTHENTICATED request principal's OWN creds;
 *        `fromPublicCode` is who the invite is sent AS (forced to the caller) and
 *        `toPublicCode` is whom to invite. The matchId is always
 *        P2.computeMatchId(buyer,item,seller) regardless of who initiated, so dedup
 *        is symmetric.
 *   matchStore  — the SHARED P2 match store (dedup across P2 + P3). REQUIRED for
 *        rescan idempotency; if absent P3 makes its own (still correct within P3).
 *   log ; now
 */
function createRouter(opts = {}) {
    const {
        authenticateCaller,
        searchItems,
        resolveOwnedFile,
        governedInvite,
        matchStore,
        log,
        now,
    } = opts;

    const router = express.Router();
    const logger = typeof log === 'function' ? log : () => {};
    const clock = typeof now === 'function' ? now : () => Date.now();
    const store = matchStore || mm.createMatchStore();
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
    // POST /photo-search — a buyer OR seller submits an item ALREADY RECOGNISED by
    // THEIR OWN Agent's vision ({itemName, tags}) — 官方不介入, the platform runs no
    // vision. Optionally the caller references a listing photo they already uploaded
    // to EClaw's standard storage by `fileId` (device-scoped; owner only). The
    // recognised text is sanitised and fed into the P1-backed catalogue search. This
    // is the READ/PLAN step (mirrors P2 /search) — NO b2b send here.
    router.post('/photo-search', async (req, res) => {
        const caller = await requireCaller(req.body);
        if (!caller.ok) return res.status(caller.status).json({ error: caller.reason });

        // The caller's own Agent already recognised the item. We accept the result
        // (name/tags) and treat it as UNTRUSTED — sanitise before any use.
        const recognised = normalizeRecognizedItem(
            (req.body && typeof req.body.recognizedItem === 'object' && req.body.recognizedItem)
            || { itemName: req.body && (req.body.itemName || req.body.name), tags: req.body && req.body.tags }
        );
        if (!recognised.itemName && recognised.tags.length === 0) {
            return res.status(400).json({
                error: 'recognizedItem is required — the caller Agent must submit its own recognised {itemName, tags} (the platform runs no vision)',
                reason: 'no_recognized_item',
            });
        }

        // OPTIONAL listing-photo reference. If the caller references a fileId it must
        // be a file OWNED by the caller's device (device-scoped; no cross-device read
        // / IDOR). We only VERIFY ownership + surface the reference — the image bytes
        // are never fetched for recognition (the caller already recognised it).
        let listingPhoto = null;
        const fileId = req.body && typeof req.body.fileId === 'string' ? req.body.fileId : null;
        if (fileId) {
            if (typeof resolveOwnedFile !== 'function') {
                return res.status(503).json({ error: 'file storage unavailable', reason: 'no_file_store' });
            }
            let meta;
            try {
                meta = await resolveOwnedFile({ fileId, deviceId: caller.deviceId });
            } catch (err) {
                logger('warn', 'wishlist-matchmaking-p3', `owned-file lookup failed: ${err.message}`);
                return res.status(502).json({ error: 'file lookup failed', reason: 'file_error' });
            }
            if (!meta) {
                // Not found OR not owned by this device — same fail-closed response so
                // a caller cannot probe another device's files (no IDOR oracle).
                return res.status(404).json({ error: 'file not found for this device', reason: 'file_not_owned' });
            }
            listingPhoto = { fileId: meta.fileId || fileId, mimeType: meta.mimeType || meta.mime_type || undefined };
        }

        // Feed the recognised, sanitised intent into the P1-backed catalogue search.
        const intent = buildIntentFromRecognized(recognised);
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
            listingPhoto,
            intent,
            candidates,
            matchFound: candidates.length > 0,
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
    // POST /rescan — cron-callable. The AUTHENTICATED caller re-checks its OWN
    // still-unmatched wishes (each wish: {itemId, sellerPublicCode, itemName?}) and
    // sends EXACTLY ONE invite per (caller-as-buyer, item, seller) triple ever.
    // Idempotent: re-running is a no-op because matchId (buyer,item,seller) is
    // already in the shared store.
    //
    // 官方不介入: this acts ONLY as the authenticated caller. There is NO central /
    // privileged multi-buyer scheduler — each buyer's own Agent calls /rescan itself.
    // The invite is sent FROM the authenticated caller (the buyer / wish owner). A
    // wish that names a different buyer is REJECTED — a rescan can NEVER invite on
    // behalf of a code the caller doesn't control.
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

    // Expose the store for the mount + tests.
    router._store = store;
    return router;
}

module.exports = {
    createRouter,
    // pure helpers
    normalizeRecognizedItem,
    buildIntentFromRecognized,
    rescanMatchId,
    // constants
    MAX_TAGS,
};
