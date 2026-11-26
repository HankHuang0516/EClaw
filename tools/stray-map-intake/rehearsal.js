'use strict';

// SYNTHETIC REHEARSAL ONLY. Not imported by the server, collector, automation or production API.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID, createHash } = require('node:crypto');
const { validateTip, decideIdempotency, LIMITS } = require('./contract');
const digest = value => createHash('sha256').update(value).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const fail = (error, status = 400) => ({ success: false, error, status });
const activeOrigins = new Set();
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
    receipt(tipId) {
        const row = this.state.receipts[tipId];
        return row ? { success: true, receipt: copy(row.receipt), review: copy(row.review) } : fail('NOT_FOUND', 404);
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
            changed.review = { status: 'DUPLICATE', publicVisible: false, duplicateOf };
        } else changed.review = { status: action === 'REJECT' ? 'REJECTED' : 'WITHDRAWN', publicVisible: false };
        changed.audit.push({ action, at: this.now() }); this.commit(next);
        return { success: true, review: copy(changed.review) };
    }
    publicList() {
        if (this.poisoned) return fail('REHEARSAL_STORE_UNAVAILABLE', 503);
        return { success: true, simulation: true, items: Object.entries(this.state.receipts)
            .filter(([, row]) => row.review.status === 'APPROVED' && row.review.publicVisible === true && row.mapPolicy !== 'NEVER')
            .map(([id, row]) => ({ id, thirdParty: true, selfWitness: false, provenanceLabel: 'THIRD_PARTY_PUBLIC_LEAD',
                animal: copy(row.payload.animal), location: copy(row.payload.location), observation: copy(row.payload.observation),
                display: copy(row.payload.display), photos: row.payload.photos.map(photo => ({ caption: photo.caption, simulatedMedia: true })) })) };
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
            if (req.method === 'GET' && u.pathname === '/public/tips') return send(200, store.publicList());
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
async function scheduledPass({ store, sourceURL, receiverURL, jobId = 'synthetic-patrol', minimumIntervalMs = 900000 }) {
    loopbackURL(sourceURL); loopbackURL(receiverURL);
    if (!store.reservePoll(jobId, minimumIntervalMs)) return { success: true, skipped: true, requests: 0, results: [] };
    const source = await readJSON(sourceURL); // Anonymous JSON fixture API only; no web page or real patrol access.
    if (source.status !== 200 || source.body.synthetic !== true || !Array.isArray(source.body.records) || source.body.records.length > 20) throw new Error('INVALID_SYNTHETIC_DATASET');
    const results = [];
    for (const record of source.body.records) {
        const key = digest(JSON.stringify([record.source?.publisherId, record.source?.datasetId, record.source?.recordKey]));
        const options = { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(record) };
        try { results.push(await readJSON(`${receiverURL}/synthetic/tips`, options)); }
        catch (error) {
            if (!error.rehearsalTransportFailure && !error.rehearsalAcknowledgementFailure) throw error;
            // The first response may have been lost after commit. One bounded retry uses exactly the same key/body.
            results.push(await readJSON(`${receiverURL}/synthetic/tips`, options));
        }
    }
    return { success: true, skipped: false, requests: 1, results };
}
module.exports = { RehearsalStore, startReceiver, startLoopback, scheduledPass, readJSON, CHECKS };
