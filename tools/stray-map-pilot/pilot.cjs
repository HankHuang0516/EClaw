'use strict';
// Independent pending text candidate. Its complete non-builtin dependency closure is store.cjs + pure contract.js.
// No fixtures, rebuild service, identities, credentials, timer, source polling or native table writes.
const { validateTip, canonicalSourceURL, reportSemantics } = require('../stray-map-intake/contract');
const { createStore, PilotError } = require('./store.cjs');
const PROFILE = 'TEXT_COARSE_PENDING_V1';
const PREFIX = '/external-intake/v1';
const DEFAULT_LIMITS = Object.freeze({ maxCases: 1000, maxPending: 100, maxRequests: 4000, perSourceHour: 10, publicLimit: 100 });
const HARD_LIMITS = { maxCases: 2000, maxPending: 1000, maxRequests: 8000, perSourceHour: 100, publicLimit: 100 };
const CHECKS = ['contentReviewed','localLanguageReviewed','privacyReviewed','sourceVerified','locationSafe'];
const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const exact = (v, keys) => plain(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const subset = (v, keys) => plain(v) && Object.keys(v).every(k => keys.includes(k));
const identifier = v => typeof v === 'string' && /^[a-z][a-z0-9-]{2,63}$/.test(v);
const tipID = v => typeof v === 'string' && /^tip_[a-f0-9]{32}$/.test(v);
const keyOK = v => typeof v === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(v);
// Conservative rejection only, not proof of semantic privacy. An authorized reviewer must create a separate public artifact.
const unsafeText = text => /(?:https?:\/\/|www\.|[\w.+-]+@[\w.-]+\.[a-z]{2,}|@[a-z\d_]{2,}|\+?\d[\d ()-]{7,}\d|\d{1,3}\.\d{3,}|\b[A-Z]{2,3}-\d{3,4}\b|\d+\s*號|[\u200b-\u200f\u202a-\u202e\u2066-\u2069])/i
    .test(text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ''));
function validPolicies(policies) {
    if (!Array.isArray(policies) || !policies.length || policies.length > 20) return false;
    const seen = new Set();
    return policies.every(p => {
        if (!exact(p, ['verified','publisherId','datasetId','origin','pathPrefix','allowedRegions']) || p.verified !== true
            || !identifier(p.publisherId) || !identifier(p.datasetId) || typeof p.origin !== 'string'
            || canonicalSourceURL(`${p.origin}/`) !== `${p.origin}/` || typeof p.pathPrefix !== 'string' || !/^\/[A-Za-z0-9/_~-]+\/$/.test(p.pathPrefix)
            || !Array.isArray(p.allowedRegions) || !p.allowedRegions.length || p.allowedRegions.length > 50
            || !p.allowedRegions.every(r => typeof r === 'string' && /^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(r))) return false;
        const key = `${p.publisherId}:${p.datasetId}`; if (seen.has(key)) return false; seen.add(key); return true;
    });
}
function settings(configuration, bindings) {
    try {
        const c = typeof configuration === 'function' ? configuration() : {};
        if (!subset(c, ['profile','intake','review','publicRead','limits']) || (c.profile !== undefined && c.profile !== PROFILE)
            || ['intake','review','publicRead'].some(k => c[k] !== undefined && typeof c[k] !== 'boolean')
            || (['intake','review','publicRead'].some(k => c[k] === true) && c.profile !== PROFILE)
            || !bindings || typeof bindings.verifySource !== 'function' || typeof bindings.verifyReviewer !== 'function'
            || (bindings.allowPayload !== undefined && typeof bindings.allowPayload !== 'function')
            || !validPolicies(bindings.sourcePolicies)) return null;
        if (c.limits !== undefined && !subset(c.limits, Object.keys(DEFAULT_LIMITS))) return null;
        const limits = { ...DEFAULT_LIMITS, ...c.limits };
        if (!Object.keys(limits).every(k => Number.isSafeInteger(limits[k]) && limits[k] > 0 && limits[k] <= HARD_LIMITS[k])) return null;
        const policies = JSON.parse(JSON.stringify(bindings.sourcePolicies));
        const result = { profile: PROFILE, intake: c.intake === true, review: c.review === true, publicRead: c.publicRead === true, limits, policies,
            verifySource: bindings.verifySource, verifyReviewer: bindings.verifyReviewer, allowPayload: bindings.allowPayload };
        result.signature = JSON.stringify({ intake: result.intake, review: result.review, publicRead: result.publicRead, limits, policies }); return result;
    } catch { return null; }
}
function rawJSON(body) {
    if (!Buffer.isBuffer(body) || body.length > 16384) throw new PilotError('INVALID_JSON_BODY', body?.length > 16384 ? 413 : 400);
    const text = body.toString('utf8'); if (!Buffer.from(text).equals(body)) throw new PilotError('INVALID_JSON_BODY', 400);
    try {
        const value = JSON.parse(text), stack = [];
        // JSON.parse discards duplicate keys. Reject them, including escaped key spellings, before any review mutation.
        for (let i = 0; i < text.length; i++) {
            if (text[i] === '{') stack.push(new Set());
            else if (text[i] === '[') stack.push(null);
            else if (text[i] === '}' || text[i] === ']') stack.pop();
            else if (text[i] === '"') {
                const start = i++;
                for (; i < text.length; i++) { if (text[i] === '\\') i++; else if (text[i] === '"') break; }
                let next = i + 1; while (next < text.length && /\s/.test(text[next])) next++;
                if (text[next] === ':') { const key = JSON.parse(text.slice(start, i + 1)), keys = stack.at(-1);
                    if (keys.has(key)) throw new Error('duplicate'); keys.add(key); }
            }
        }
        return value;
    } catch { throw new PilotError('INVALID_JSON_BODY', 400); }
}
function clock(now) {
    const value = now();
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new PilotError('PILOT_CLOCK_UNAVAILABLE');
    return value;
}
function policyFor(cfg, source) { return cfg.policies.find(p => p.publisherId === source?.publisherId && p.datasetId === source?.datasetId); }
function validateText(raw, policy, at, contentType, encoding) {
    const v = validateTip(raw, { submittedAt: at, sourcePolicy: policy, verifiedUploads: [], contentType, contentEncoding: encoding });
    if (!v.success) throw new PilotError('INVALID_TEXT_COARSE_TIP', v.status || 400);
    const p = v.canonicalPayload;
    if (p.schemaVersion !== 3 || p.source.url !== null || p.photos.length !== 0 || p.animal.kind === 'WILDLIFE'
        || p.location.sensitivity !== 'NONE' || p.location.regionCode === null
        || [p.display.title,p.display.description].some(unsafeText)) throw new PilotError('INVALID_TEXT_COARSE_TIP', 400);
    return v;
}
function validateDisplay(display, payload, policy, at) {
    if (!exact(display, ['locale','title','description']) || display.locale !== payload.display.locale
        || [display.title,display.description].some(v => typeof v !== 'string' || unsafeText(v))) throw new PilotError('PUBLIC_REVIEW_REQUIRED', 403);
    try { validateText(Buffer.from(JSON.stringify({ ...payload, display })), policy, at, 'application/json', 'identity'); }
    catch { throw new PilotError('PUBLIC_REVIEW_REQUIRED', 403); }
    return JSON.parse(JSON.stringify(display));
}
async function install(app, { pool, configuration, bindings, now = () => new Date().toISOString() } = {}) {
    const store = createStore({ pool }); // Deliberately no init/DDL here, including fully disabled bootstrap.
    function context(mode) {
        const cfg = settings(configuration, bindings);
        if (!cfg || !cfg[mode]) throw new PilotError('PILOT_CLOSED');
        const assertOpen = () => {
            const current = settings(configuration, bindings);
            if (!current || !current[mode] || current.signature !== cfg.signature || current.verifySource !== cfg.verifySource
                || current.verifyReviewer !== cfg.verifyReviewer || current.allowPayload !== cfg.allowPayload) throw new PilotError('PILOT_CLOSED');
        };
        return { cfg, assertOpen };
    }
    async function source(req, cfg) {
        let actor; try { actor = await cfg.verifySource(req); } catch { throw new PilotError('SOURCE_NOT_AUTHORIZED', 403); }
        if (!plain(actor) || !identifier(actor.publisherId) || !identifier(actor.datasetId) || !policyFor(cfg, actor)) throw new PilotError('SOURCE_NOT_AUTHORIZED', 403);
        return { publisherId: actor.publisherId, datasetId: actor.datasetId };
    }
    async function reviewer(req, cfg) {
        let actor; try { actor = await cfg.verifyReviewer(req); } catch { throw new PilotError('REVIEWER_NOT_AUTHORIZED', 403); }
        if (!plain(actor) || typeof actor.reviewerId !== 'string' || actor.reviewerId.length < 1 || actor.reviewerId.length > 128 || actor.canReview !== true) throw new PilotError('REVIEWER_NOT_AUTHORIZED', 403);
        return { reviewerId: actor.reviewerId };
    }
    const respond = handler => async (req, reply) => {
        reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff');
        try { return await handler(req, reply); }
        catch (error) { const known = error instanceof PilotError; return reply.code(known ? error.status : 503).send({ success: false, error: known ? error.code : 'PILOT_STORE_UNAVAILABLE' }); }
    };
    const requireJSON = req => {
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '') || (req.headers['content-encoding'] || 'identity') !== 'identity') throw new PilotError('JSON_REQUIRED', 415);
    };
    await app.register(async scope => {
        scope.setErrorHandler((error, _req, reply) => {
            const status = [400,413,415].includes(error.statusCode) ? error.statusCode : 503;
            return reply.code(status).header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff')
                .send({ success: false, error: { 400: 'INVALID_REQUEST', 413: 'PAYLOAD_TOO_LARGE', 415: 'JSON_REQUIRED', 503: 'PILOT_UNAVAILABLE' }[status] });
        });
        scope.removeContentTypeParser('application/json');
        scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
        const route = (method, url, mode, handler) => scope.route({ method, url, bodyLimit: 16384,
            onRequest: respond(async (req, _reply) => {
                context(mode);
                if (req.query && Object.keys(req.query).length) throw new PilotError('INVALID_QUERY', 400);
                if (method === 'POST') requireJSON(req);
            }), handler: respond(handler) });
        route('POST', `${PREFIX}/tips`, 'intake', async (req, reply) => {
            const { cfg, assertOpen } = context('intake'); requireJSON(req);
            const actor = await source(req, cfg); assertOpen();
            if (!keyOK(req.headers['idempotency-key'])) throw new PilotError('INVALID_IDEMPOTENCY_KEY', 400);
            const parsed = rawJSON(req.body);
            if (parsed?.source?.publisherId !== actor.publisherId || parsed?.source?.datasetId !== actor.datasetId) throw new PilotError('SOURCE_NOT_AUTHORIZED', 403);
            const at = clock(now), valid = validateText(req.body, policyFor(cfg, actor), at, req.headers['content-type'], req.headers['content-encoding'] || 'identity');
            if (cfg.allowPayload && !cfg.allowPayload(valid.canonicalPayload)) throw new PilotError('SOURCE_PAYLOAD_NOT_AUTHORIZED', 403);
            const result = await store.accept({ payload: valid.canonicalPayload, payloadHash: valid.payloadHash, key: req.headers['idempotency-key'], source: actor, submittedAt: at, limits: cfg.limits, assertOpen });
            assertOpen(); return reply.code(202).send(result);
        });
        route('GET', `${PREFIX}/receipts/:id`, 'intake', async (req, reply) => {
            const { cfg, assertOpen } = context('intake'), actor = await source(req, cfg); assertOpen();
            if (!tipID(req.params.id)) throw new PilotError('NOT_FOUND', 404);
            return reply.send(await store.receipt({ id: req.params.id, source: actor, assertOpen }));
        });
        route('POST', `${PREFIX}/review/:id`, 'review', async (req, reply) => {
            const { cfg, assertOpen } = context('review'); requireJSON(req); const actor = await reviewer(req, cfg); assertOpen();
            if (!tipID(req.params.id)) throw new PilotError('NOT_FOUND', 404);
            const body = rawJSON(req.body);
            if (!subset(body, ['decision','checks','display']) || !['APPROVE','REJECT','WITHDRAW'].includes(body.decision)) throw new PilotError('INVALID_REVIEW', 400);
            if (body.decision === 'APPROVE' && (!exact(body.checks, CHECKS) || !CHECKS.every(k => body.checks[k] === true))) throw new PilotError('PUBLIC_REVIEW_REQUIRED', 403);
            if (body.decision !== 'APPROVE' && (body.display !== undefined || body.checks !== undefined)) throw new PilotError('INVALID_REVIEW', 400);
            const at = clock(now);
            const result = await store.review({ id: req.params.id, decision: body.decision, reviewer: actor, at, assertOpen, validate: row => {
                const p = policyFor(cfg, { publisherId: row.publisher, datasetId: row.dataset });
                const valid = validateText(Buffer.from(JSON.stringify(row.payload)), p, at, 'application/json', 'identity');
                if (valid.payloadHash !== row.payload_hash) throw new PilotError('PUBLIC_REVIEW_REQUIRED', 403);
                return validateDisplay(body.display, row.payload, p, at);
            } });
            assertOpen(); return reply.send({ ...result, publicVisible: result.status === 'APPROVED' && cfg.publicRead });
        });
        route('GET', `${PREFIX}/cards`, 'publicRead', async (_req, reply) => {
            const { cfg, assertOpen } = context('publicRead'), at = clock(now);
            const rows = await store.cards({ scopes: cfg.policies.map(p => `${p.publisherId}:${p.datasetId}`), limit: cfg.limits.publicLimit, assertOpen });
            const cards = rows.slice(0, cfg.limits.publicLimit).map(row => {
                const policy = policyFor(cfg, { publisherId: row.publisher, datasetId: row.dataset });
                const valid = validateText(Buffer.from(JSON.stringify(row.payload)), policy, at, 'application/json', 'identity');
                if (valid.payloadHash !== row.payload_hash) throw new PilotError('PILOT_STORE_UNAVAILABLE');
                const display = validateDisplay(row.public_content, row.payload, policy, at), p = valid.canonicalPayload;
                return { id: row.id, origin: 'EXTERNAL_PUBLIC_LEAD', thirdParty: true, selfWitness: false, display, animal: p.animal,
                    report: reportSemantics(p), observation: p.observation,
                    location: { countryCode: p.location.countryCode, regionCode: p.location.regionCode, precision: 'REGION', coordinates: null },
                    photos: [], coordinates: null, mapMarkerEligible: false, careLocationInferred: false };
            });
            assertOpen(); return reply.send({ success: true, profile: PROFILE, cards, limit: cfg.limits.publicLimit, truncated: rows.length > cfg.limits.publicLimit });
        });
    });
    return { profile: PROFILE };
}
module.exports = { install, PROFILE, DEFAULT_LIMITS };
