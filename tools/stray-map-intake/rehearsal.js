'use strict';

// SYNTHETIC REHEARSAL ONLY. Not imported by the server, collector, automation or production API.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID, createHash } = require('node:crypto');
const { validateTip, decideIdempotency, LIMITS, definitelyAfter, temporal } = require('./contract');
const cases = require('./case-semantics');
const digest = value => createHash('sha256').update(value).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const fail = (error, status = 400) => ({ success: false, error, status });
const activeOrigins = new Set();
const SOURCE_EVENT_LIMIT = 2000;
const CHECKS = ['contentReviewed', 'localLanguageReviewed', 'privacyReviewed', 'sourceVerified', 'rightsReviewed', 'locationSafe'];

function loopbackURL(value) {
    const u = new URL(value);
    if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port || u.username || u.password || u.hash || !activeOrigins.has(u.origin)) {
        throw new Error('SYNTHETIC_LOOPBACK_ONLY');
    }
    return u;
}

class RehearsalStore {
    constructor(directory, { sourcePolicy, sourcePolicies = [sourcePolicy], uploads = [], now = () => new Date().toISOString() } = {}) {
        if (!sourcePolicy || !sourcePolicies.length || !sourcePolicies.every(policy => policy
            && policy.publisherId.startsWith('synthetic-') && new URL(policy.origin).hostname.endsWith('.example.invalid'))) throw new Error('SYNTHETIC_SOURCE_ONLY');
        this.policies = copy(sourcePolicies);
        this.policy = copy(sourcePolicy); this.uploads = copy(uploads); this.now = now;
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('SYMLINK_STORE_FORBIDDEN');
        this.directory = fs.realpathSync(directory);
        this.file = path.join(this.directory, 'synthetic-intake-state.json');
        this.lock = path.join(this.directory, 'synthetic-intake.lock');
        this.lockFd = fs.openSync(this.lock, 'wx', 0o600); // One writer; stale locks fail closed.
        this.lockInode = fs.fstatSync(this.lockFd).ino;
        try {
            fs.writeFileSync(this.lockFd, JSON.stringify({ kind: 'STRAY_INTAKE_REHEARSAL', pid: process.pid }));
            fs.fsyncSync(this.lockFd);
            if (fs.existsSync(this.file)) {
                const stat = fs.lstatSync(this.file);
                if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('INVALID_REHEARSAL_STATE_FILE');
            }
            this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8'))
                : { kind: 'STRAY_INTAKE_REHEARSAL', version: 1, publisherId: this.policy.publisherId,
                    datasetId: this.policy.datasetId, receipts: {}, idempotency: {}, records: {}, acceptedTimes: [], jobs: {} };
            if (this.state.kind !== 'STRAY_INTAKE_REHEARSAL' || this.state.version !== 1
                || this.state.publisherId !== this.policy.publisherId || this.state.datasetId !== this.policy.datasetId) throw new Error('WRONG_REHEARSAL_STORE');
        } catch (error) { this.close(); throw error; }
    }
    commit(next) {
        if (this.lockFd === null || this.poisoned) throw new Error('REHEARSAL_STORE_CLOSED');
        const bytes = JSON.stringify(next);
        if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) throw new Error('REHEARSAL_STORE_FULL');
        const temporary = path.join(this.directory, `.synthetic-${randomUUID()}.tmp`);
        const fd = fs.openSync(temporary, 'wx', 0o600);
        try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        try {
            fs.renameSync(temporary, this.file);
            const dir = fs.openSync(this.directory, 'r');
            try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
        } catch (error) { this.poisoned = true; throw error; }
        this.state = next; // Receipt returned only after durable snapshot and directory sync.
    }
    close() {
        if (this.lockFd === null || this.lockFd === undefined) return;
        fs.closeSync(this.lockFd); this.lockFd = null;
        if (fs.existsSync(this.lock) && fs.lstatSync(this.lock).ino === this.lockInode) fs.unlinkSync(this.lock);
    }
    accept(raw, key, contentType = 'application/json', contentEncoding = 'identity') {
        if (this.lockFd === null || this.poisoned) return fail('REHEARSAL_STORE_CLOSED', 503);
        const submittedAt = this.now();
        let policy;
        if ((typeof raw === 'string' || Buffer.isBuffer(raw)) && Buffer.byteLength(raw) <= LIMITS.jsonBytes) {
            try { const source = JSON.parse(raw.toString()).source;
                policy = this.policies.find(item => item.publisherId === source?.publisherId && item.datasetId === source?.datasetId);
            } catch { /* The contract returns the bounded parse error. */ }
        }
        const valid = validateTip(raw, { submittedAt, sourcePolicy: policy, verifiedUploads: this.uploads,
            contentType, contentEncoding });
        if (!valid.success) return valid;
        const input = valid.canonicalPayload;
        const existing = this.state.idempotency[`${input.source.publisherId}:${key}`] || null;
        const decision = decideIdempotency({ publisherId: input.source.publisherId, key, payloadHash: valid.payloadHash, existing });
        if (!decision.success) return decision;
        if (decision.action === 'REPLAY') return { success: true, receipt: decision.receipt, replay: true, status: 202 };
        const recordScope = digest(JSON.stringify([input.source.publisherId, input.source.datasetId, input.source.recordKey]));
        const priorId = this.state.records[recordScope];
        const prior = priorId ? this.state.receipts[priorId] : null;
        if (prior && prior.payloadHash !== valid.payloadHash) return fail('SOURCE_RECORD_CONFLICT', 409);
        const next = copy(this.state);
        if (Object.keys(next.idempotency).length >= 2000) return fail('REHEARSAL_STORE_FULL', 503);
        if (prior) {
            next.idempotency[decision.scopeKey] = { scopeKey: decision.scopeKey, payloadHash: valid.payloadHash, receipt: prior.receipt };
            this.commit(next);
            return { success: true, receipt: copy(prior.receipt), replay: true, status: 202 };
        }
        next.acceptedTimes = next.acceptedTimes.filter(t => Date.parse(t.at) > Date.parse(submittedAt) - 3600000);
        if (next.acceptedTimes.filter(t => t.publisherId === input.source.publisherId).length >= 10) return fail('SOURCE_RATE_LIMIT', 429);
        if (Object.keys(next.receipts).length >= 1000 || Object.keys(next.idempotency).length >= 2000) return fail('REHEARSAL_STORE_FULL', 503);
        const tipId = `tip_${randomUUID().replace(/-/g, '')}`;
        const receipt = { success: true, tipId, status: 'PENDING', publicVisible: false, submittedAt };
        const candidates = valid.candidateFingerprint === null ? [] : Object.entries(next.receipts)
            .filter(([, row]) => row.candidateFingerprint === valid.candidateFingerprint).map(([id]) => id);
        next.receipts[tipId] = { receipt, payload: input, payloadHash: valid.payloadHash,
            candidateFingerprint: valid.candidateFingerprint, candidates, mapPolicy: valid.review.mapPolicy,
            review: { status: 'PENDING', publicVisible: false }, audit: [{ action: 'ACCEPT', at: submittedAt }] };
        next.records[recordScope] = tipId;
        next.idempotency[decision.scopeKey] = { scopeKey: decision.scopeKey, payloadHash: valid.payloadHash, receipt };
        next.acceptedTimes.push({ publisherId: input.source.publisherId, at: submittedAt });
        this.commit(next);
        return { success: true, receipt, replay: false, status: 202 };
    }
    publicationBlockReason() {
        if (this.poisoned) return 'STORE_UNAVAILABLE';
        return Object.keys(this.state.sourceEvents || {}).length >= SOURCE_EVENT_LIMIT ? 'SOURCE_EVENT_CAPACITY' : null;
    }
    receipt(tipId) {
        const row = this.state.receipts[tipId];
        return row ? { success: true, receipt: copy(row.receipt), review: copy(row.review), sourceState: copy(cases.sourceState(row)), effectivePublicVisible: this.publicationBlockReason() === null && cases.publiclyVisible(row), publicationBlockedReason: this.publicationBlockReason() } : fail('NOT_FOUND', 404);
    }
    // No HTTP review mutation. Called only by the synthetic supervisor, never source input.
    review(tipId, action, checks = {}, duplicateOf = null) {
        if (this.lockFd === null || this.poisoned) return fail('REHEARSAL_STORE_CLOSED', 503);
        const row = this.state.receipts[tipId];
        if (!row) return fail('NOT_FOUND', 404);
        if (!['APPROVE', 'REJECT', 'WITHDRAW', 'DUPLICATE'].includes(action)) return fail('INVALID_DECISION');
        if (action !== 'WITHDRAW' && row.review.status !== 'PENDING') return fail('REVIEW_TERMINAL', 409);
        const next = copy(this.state); const changed = next.receipts[tipId];
        if (action === 'APPROVE') {
            if (!CHECKS.every(key => checks[key] === true)) return fail('REVIEW_CHECKS_REQUIRED', 403);
            const recheck = validateTip(JSON.stringify(row.payload), { submittedAt: row.receipt.submittedAt,
                sourcePolicy: this.policies.find(item => item.publisherId === row.payload.source.publisherId
                    && item.datasetId === row.payload.source.datasetId), verifiedUploads: this.uploads });
            if (!recheck.success) return fail('REVIEW_EVIDENCE_INVALID', 403);
            changed.review = { status: row.mapPolicy === 'NEVER' ? 'APPROVED_PRIVATE' : 'APPROVED', publicVisible: row.mapPolicy !== 'NEVER' };
        } else if (action === 'DUPLICATE') {
            if (duplicateOf === tipId || !next.receipts[duplicateOf]) return fail('INVALID_DUPLICATE_TARGET');
            if (cases.reportSemantics(row.payload).type !== cases.reportSemantics(next.receipts[duplicateOf].payload).type) return fail('DISTINCT_REPORT_TYPES');
            changed.review = { status: 'DUPLICATE', publicVisible: false, duplicateOf };
        } else changed.review = { status: action === 'REJECT' ? 'REJECTED' : 'WITHDRAWN', publicVisible: false };
        changed.audit.push({ action, at: this.now() }); this.commit(next);
        return { success: true, review: copy(changed.review), effectivePublicVisible: this.publicationBlockReason() === null && cases.publiclyVisible(changed), publicationBlockedReason: this.publicationBlockReason() };
    }
    publicList() {
        if (this.publicationBlockReason()) return fail('REHEARSAL_PUBLICATION_BLOCKED', 503);
        return { success: true, simulation: true, items: Object.entries(this.state.receipts)
            .filter(([, row]) => cases.publiclyVisible(row))
            .map(([id, row]) => ({ id, thirdParty: true, selfWitness: false, provenanceLabel: 'THIRD_PARTY_PUBLIC_LEAD',
                ...copy(cases.publicSemantics(row.payload)), animal: copy(row.payload.animal), location: copy(row.payload.location), observation: copy(row.payload.observation),
                display: copy(row.payload.display), photos: row.payload.photos.map(photo => ({ caption: photo.caption, simulatedMedia: true })) })) };
    }
    matchingSuggestions() { return copy(cases.matchingSuggestions(this.state.receipts)); }
    sourceEvent(event, { completeSnapshot = false } = {}) {
        if (this.lockFd === null || this.poisoned) return fail('REHEARSAL_STORE_CLOSED', 503);
        const now = this.now();
        if (!temporal({ precision: 'INSTANT', value: now, timeZone: 'UTC' })) return fail('SERVER_CONTEXT_REQUIRED', 500);
        const policy = this.policies.find(item => item.publisherId === event?.publisherId && item.datasetId === event?.datasetId);
        if (!cases.validateSourceEvent(event, policy, now)) return fail('INVALID_SOURCE_EVENT');
        const recordScope = digest(JSON.stringify([event.publisherId, event.datasetId, event.recordKey]));
        const id = this.state.records[recordScope];
        if (!id) return fail('NOT_FOUND', 404);
        const scope = digest(JSON.stringify([event.publisherId, event.datasetId, event.eventKey]));
        const canonical = Object.fromEntries(Object.keys(event).sort().map(key => [key, event[key]]));
        canonical.sourceChangedAt = Object.fromEntries(Object.keys(event.sourceChangedAt).sort().map(key => [key, event.sourceChangedAt[key]]));
        const payloadHash = digest(JSON.stringify(canonical));
        const existing = this.state.sourceEvents?.[scope];
        if (existing) return existing.payloadHash === payloadHash ? { success: true, replay: true, eventReceipt: copy(existing.receipt) }
            : fail('SOURCE_EVENT_CONFLICT', 409);
        if (event.type === 'ABSENT' && completeSnapshot !== true) return fail('INCOMPLETE_SNAPSHOT', 409);
        if (Object.keys(this.state.sourceEvents || {}).length >= SOURCE_EVENT_LIMIT) return fail('REHEARSAL_STORE_FULL', 503);
        const row = this.state.receipts[id], state = cases.sourceState(row);
        if (definitelyAfter(state.sourceChangedAt, event.sourceChangedAt)) return fail('STALE_SOURCE_EVENT', 409);
        const next = copy(this.state); next.sourceEvents ||= {};
        const changed = next.receipts[id];
        changed.sourceState = { ...state, lastCheckedAt: now };
        if (event.sourceChangedAt.precision !== 'UNKNOWN') changed.sourceState.sourceChangedAt = copy(event.sourceChangedAt);
        if (event.type === 'EXPLICIT_CLOSED') {
            changed.sourceState.caseStatus = 'CLOSED_BY_SOURCE'; changed.sourceState.availability = 'PRESENT';
            changed.sourceState.closureEvidence ||= { sourceChangedAt: copy(event.sourceChangedAt), receivedAt: now, reunionVerified: false };
        } else changed.sourceState.availability = { PRESENT: 'PRESENT', ABSENT: 'ABSENT', TEMPORARY_FAILURE: 'UNAVAILABLE' }[event.type];
        const receipt = { eventId: `sourceevt_${randomUUID().replace(/-/g, '')}`, receivedAt: now,
            tipId: id, type: event.type, reunionVerified: false };
        next.sourceEvents[scope] = { payloadHash, receipt };
        changed.audit.push({ action: `SOURCE_${event.type}`, at: now }); this.commit(next);
        return { success: true, replay: false, eventReceipt: copy(receipt) };
    }
    sourceAvailability(scope, { seenKeys = [], acceptedKeys = [], completeSnapshot = false, unavailable = false, jobId }) {
        const policy = this.policies.find(item => item.publisherId === scope?.publisherId && item.datasetId === scope?.datasetId && item.verified);
        if (!policy) return fail('INVALID_SOURCE_SCOPE');
        const seen = new Set(seenKeys), accepted = new Set(acceptedKeys), at = this.now(), results = [];
        for (const row of Object.values(this.state.receipts)) {
            const source = row.payload.source;
            if (source.publisherId !== scope.publisherId || source.datasetId !== scope.datasetId) continue;
            const type = unavailable || (seen.has(source.recordKey) && !accepted.has(source.recordKey)) ? 'TEMPORARY_FAILURE'
                : accepted.has(source.recordKey) ? 'PRESENT' : completeSnapshot ? 'ABSENT' : null;
            if (type === null) continue;
            const event = { publisherId: source.publisherId, datasetId: source.datasetId, recordKey: source.recordKey,
                eventKey: digest(JSON.stringify(['source-check-v1', jobId, at, source.recordKey, type])), type,
                sourceChangedAt: { precision: 'UNKNOWN', value: null, timeZone: null } };
            results.push(this.sourceEvent(event, { completeSnapshot }));
        }
        return { success: results.every(item => item.success), results };
    }
    reservePoll(jobId, minimumIntervalMs) {
        if (!/^[a-z0-9-]{3,64}$/.test(jobId) || !Number.isSafeInteger(minimumIntervalMs) || minimumIntervalMs < 60000) throw new Error('INVALID_REHEARSAL_SCHEDULE');
        const now = this.now(); const previous = this.state.jobs[jobId];
        if (previous && Date.parse(now) < Date.parse(previous.nextPollAt)) return false;
        const next = copy(this.state);
        next.jobs[jobId] = { lastPollAt: now, nextPollAt: new Date(Date.parse(now) + minimumIntervalMs).toISOString() };
        this.commit(next); return true;
    }
}

async function startLoopback(handler) {
    const server = http.createServer(handler);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const url = `http://127.0.0.1:${server.address().port}`; activeOrigins.add(url);
    return { url, close: () => new Promise(resolve => { activeOrigins.delete(url); server.close(resolve); }) };
}
async function startReceiver(store) {
    return startLoopback(async (req, res) => {
        const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
        try {
            const u = new URL(req.url, 'http://127.0.0.1');
            if (req.method === 'GET' && u.pathname === '/public/tips') {
                const result = store.publicList(); return send(result.status || 200, result);
            }
            if (req.method === 'GET' && /^\/receipts\/tip_[a-f0-9]{32}$/.test(u.pathname)) {
                const result = store.receipt(u.pathname.split('/').pop()); return send(result.status || 200, result);
            }
            if (req.method !== 'POST' || u.pathname !== '/synthetic/tips') return send(404, fail('NOT_FOUND', 404));
            const chunks = []; let size = 0;
            for await (const chunk of req) {
                size += chunk.length;
                if (size > LIMITS.jsonBytes) return send(413, fail('PAYLOAD_TOO_LARGE', 413));
                chunks.push(chunk);
            }
            const result = store.accept(Buffer.concat(chunks), req.headers['idempotency-key'], req.headers['content-type'], req.headers['content-encoding'] || 'identity');
            return send(result.status || 202, result);
        } catch { return send(500, fail('REHEARSAL_FAILURE', 500)); }
    });
}
async function readJSON(url, options = {}) {
    loopbackURL(url);
    let response;
    try { response = await fetch(url, { ...options, headers: { ...options.headers, Connection: 'close' },
        redirect: 'error', signal: AbortSignal.timeout(3000) }); }
    catch (error) { error.rehearsalTransportFailure = true; throw error; }
    if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) throw new Error('SOURCE_NOT_JSON');
    const chunks = []; let bytes = 0;
    try {
        for await (const chunk of response.body) {
            bytes += chunk.length;
            if (bytes > 262144) throw new Error('SOURCE_TOO_LARGE');
            chunks.push(Buffer.from(chunk));
        }
    } catch (error) {
        if (error.message !== 'SOURCE_TOO_LARGE') error.rehearsalTransportFailure = true;
        throw error;
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    try { return { status: response.status, body: JSON.parse(text) }; }
    catch (error) {
        // A truncated successful acknowledgement leaves commit status unknown; retry the same POST once.
        if (response.status >= 200 && response.status < 300) error.rehearsalAcknowledgementFailure = true;
        throw error;
    }
}
async function scheduledPass({ store, sourceURL, receiverURL, jobId = 'synthetic-patrol', minimumIntervalMs = 900000, sourceScope = null,
    receiverPath = '/synthetic/tips', receiverRegistration = null }) {
    if (!['/synthetic/tips', '/external-rebuild/v1/tips'].includes(receiverPath)) throw new Error('INVALID_RECEIVER_PATH');
    // An out-of-band isolated runner may attest its own native child server. Never read this from fixture JSON.
    if (receiverRegistration !== null) {
        const target = new URL(receiverURL);
        if (receiverPath !== '/external-rebuild/v1/tips' || !receiverRegistration || receiverRegistration.synthetic !== true
            || receiverRegistration.purpose !== 'STRAY_MAP_ISOLATED_NATIVE' || receiverRegistration.origin !== target.origin
            || Object.keys(receiverRegistration).length !== 3 || target.protocol !== 'http:' || target.hostname !== '127.0.0.1'
            || !target.port || target.username || target.password || target.search || target.hash || target.pathname !== '/') throw new Error('INVALID_RECEIVER_REGISTRATION');
        receiverURL = target.origin;
    }
    const receiverCall = callback => {
        if (receiverRegistration === null) return callback();
        const origin = receiverRegistration.origin, alreadyRegistered = activeOrigins.has(origin);
        activeOrigins.add(origin);
        // readJSON checks the origin synchronously before its first await. Do not retain a global registration while fetching.
        try { return callback(); } finally { if (!alreadyRegistered) activeOrigins.delete(origin); }
    };
    loopbackURL(sourceURL); receiverCall(() => loopbackURL(receiverURL));
    if (sourceScope && !store.policies.some(policy => policy.verified && policy.publisherId === sourceScope.publisherId
        && policy.datasetId === sourceScope.datasetId)) throw new Error('INVALID_SOURCE_SCOPE');
    if (!await store.reservePoll(jobId, minimumIntervalMs)) return { success: true, skipped: true, requests: 0, results: [] };
    let source;
    try {
        source = await readJSON(sourceURL); // Anonymous fixture JSON only; no web page or real patrol.
        if (source.status !== 200 || source.body.synthetic !== true || !Array.isArray(source.body.records) || source.body.records.length > 20
            || (source.body.events !== undefined && (!Array.isArray(source.body.events) || source.body.events.length > 20))
            || (store.supportsSourceEvents === false && source.body.events?.length > 0)
            || (sourceScope && [...source.body.records.map(item => item.source), ...(source.body.events || [])]
                .some(item => item?.publisherId !== sourceScope.publisherId || item?.datasetId !== sourceScope.datasetId))) throw new Error('INVALID_SYNTHETIC_DATASET');
    } catch (error) {
        if (sourceScope) await store.sourceAvailability(sourceScope, { unavailable: true, jobId });
        throw error;
    }
    const results = [];
    for (const record of source.body.records) {
        const key = digest(JSON.stringify([record.source?.publisherId, record.source?.datasetId, record.source?.recordKey]));
        const options = { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(record) };
        try { results.push(await receiverCall(() => readJSON(`${receiverURL}${receiverPath}`, options))); }
        catch (error) {
            if (!error.rehearsalTransportFailure && !error.rehearsalAcknowledgementFailure) throw error;
            // The first response may have been lost after commit. One bounded retry uses exactly the same key/body.
            results.push(await receiverCall(() => readJSON(`${receiverURL}${receiverPath}`, options)));
        }
    }
    const availability = sourceScope ? await store.sourceAvailability(sourceScope, { jobId, completeSnapshot: source.body.completeSnapshot === true,
        seenKeys: source.body.records.map(record => record.source?.recordKey),
        acceptedKeys: source.body.records.filter((_record, index) => results[index].status === 202 && results[index].body.success === true)
            .map(record => record.source.recordKey) }) : null;
    const events = [];
    for (const event of source.body.events || []) events.push(await store.sourceEvent(event, { completeSnapshot: source.body.completeSnapshot === true }));
    return { success: results.every(item => item.status === 202 && item.body.success === true) && events.every(item => item.success) && (availability === null || availability.success), skipped: false, requests: 1, results, events, availability };
}
module.exports = { RehearsalStore, startReceiver, startLoopback, scheduledPass, readJSON, CHECKS, SOURCE_EVENT_LIMIT };
