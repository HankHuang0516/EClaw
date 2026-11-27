'use strict';

const { randomUUID } = require('node:crypto');
const { LIMITS, parseBody } = require('../stray-map-intake/contract');
const { SOURCE } = require('./dot-identity.cjs');
const { BODY_LIMIT, IDENTIFYING_FEATURES, OFFICIAL_CLAIM_METHOD, validPublicDetails, validatePhotoSubmission, sha } = require('./photo-contract.cjs');
const { PilotError } = require('./store.cjs');
const { HANDOFF_ID, SECRET, proofMatches, contentMatches, matchesWorker, createHandoffs } = require('./photo-handoff.cjs');

const PREFIX = '/external-intake/v1';
const ID = /^photo_[a-f0-9]{32}$/;
const LICENSE_URLS = {
    CC_BY_4_0: 'https://creativecommons.org/licenses/by/4.0/',
    CC0_1_0: 'https://creativecommons.org/publicdomain/zero/1.0/',
};
const PUBLIC_CASE_CREDIT = 'data provided by permission of King County';
const CLAIM_URL = 'https://kingcounty.gov/LostAPet';

function createPhotos(pool) {
    let initialization;
    const ready = () => initialization ||= pool.query(`CREATE SCHEMA IF NOT EXISTS stray_dot_photo_v1;
        CREATE TABLE IF NOT EXISTS stray_dot_photo_v1.tips (
            id text PRIMARY KEY, publisher text NOT NULL, dataset text NOT NULL, record_key text NOT NULL,
            fingerprint text NOT NULL, payload jsonb NOT NULL, evidence jsonb NOT NULL, image bytea NOT NULL,
            image_hash text NOT NULL, submitted_at timestamptz NOT NULL, visible_until timestamptz NOT NULL,
            withdrawn_at timestamptz, UNIQUE (publisher, dataset, record_key)
        );
        CREATE TABLE IF NOT EXISTS stray_dot_photo_v1.handoffs (
            id text PRIMARY KEY, run_id text NOT NULL, secret_hash text NOT NULL, content_hash text NOT NULL,
            expires_at timestamptz NOT NULL, candidate jsonb, image bytea, result jsonb
        )`).catch(error => { initialization = null; throw error; });

    async function admit(candidate, image, at, assertWritable) {
        await ready();
        const client = await pool.connect();
        let broken;
        try {
            await client.query('BEGIN');
            await client.query("SET LOCAL lock_timeout='1000ms'; SET LOCAL statement_timeout='3000ms'");
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['stray-dot-photo-v1']);
            const scope = [SOURCE.publisherId, SOURCE.datasetId, candidate.tip.source.recordKey];
            const prior = (await client.query(`SELECT id, fingerprint, submitted_at, withdrawn_at FROM stray_dot_photo_v1.tips
                WHERE publisher=$1 AND dataset=$2 AND record_key=$3`, scope)).rows[0];
            if (prior && prior.fingerprint !== candidate.fingerprint) throw new PilotError('PHOTO_RECORD_CONFLICT', 409);
            if (prior?.withdrawn_at) throw new PilotError('PHOTO_RECORD_WITHDRAWN', 409);
            assertWritable(candidate.visibleUntil);
            let row;
            if (prior) {
                row = (await client.query(`UPDATE stray_dot_photo_v1.tips
                    SET visible_until=GREATEST(visible_until,$2), evidence=CASE WHEN visible_until<$2 THEN $3 ELSE evidence END
                    WHERE id=$1 RETURNING id, submitted_at, visible_until, withdrawn_at`,
                [prior.id, candidate.visibleUntil, candidate.picture])).rows[0];
            } else {
                const counts = (await client.query(`SELECT count(*)::int total,
                    count(*) FILTER (WHERE submitted_at > $3::timestamptz - INTERVAL '1 hour')::int recent
                    FROM stray_dot_photo_v1.tips WHERE publisher=$1 AND dataset=$2`, [...scope.slice(0, 2), at])).rows[0];
                if (counts.total >= 10) throw new PilotError('PHOTO_PILOT_CAPACITY', 503);
                if (counts.recent >= 1) throw new PilotError('SOURCE_RATE_LIMIT', 429);
                row = (await client.query(`INSERT INTO stray_dot_photo_v1.tips
                    (id,publisher,dataset,record_key,fingerprint,payload,evidence,image,image_hash,submitted_at,visible_until)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, submitted_at, visible_until, withdrawn_at`,
                [`photo_${randomUUID().replaceAll('-', '')}`, ...scope, candidate.fingerprint, candidate.tip, candidate.picture,
                    image, sha(image), at, candidate.visibleUntil])).rows[0];
            }
            assertWritable(candidate.visibleUntil);
            await client.query('COMMIT');
            return { row, replay: !!prior };
        } catch (error) {
            try { await client.query('ROLLBACK'); } catch (_) { broken = error; }
            throw error;
        } finally { client.release(broken); }
    }

    async function receipt(id) {
        await ready();
        return (await pool.query(`SELECT id,submitted_at,visible_until,withdrawn_at FROM stray_dot_photo_v1.tips
            WHERE id=$1 AND publisher=$2 AND dataset=$3`, [id, SOURCE.publisherId, SOURCE.datasetId])).rows[0];
    }
    async function withdraw(id, at) {
        await ready();
        return (await pool.query(`UPDATE stray_dot_photo_v1.tips SET withdrawn_at=COALESCE(withdrawn_at,$2)
            WHERE id=$1 AND publisher=$3 AND dataset=$4 RETURNING id,submitted_at,visible_until,withdrawn_at`,
        [id, at, SOURCE.publisherId, SOURCE.datasetId])).rows[0];
    }
    async function cards(at) {
        await ready();
        return (await pool.query(`SELECT id, payload, evidence->'rights' AS rights,
            evidence->'publicDetails' AS public_details, evidence#>>'{sourceEvidence,caseUrl}' AS case_url,
            evidence#>>'{sourceEvidence,status}' AS case_status, evidence#>>'{sourceEvidence,checkedAt}' AS case_checked_at,
            visible_until FROM stray_dot_photo_v1.tips
            WHERE withdrawn_at IS NULL AND visible_until>$1 ORDER BY submitted_at DESC LIMIT 10`, [at])).rows;
    }
    async function media(id, at) {
        await ready();
        return (await pool.query(`SELECT image, image_hash, visible_until FROM stray_dot_photo_v1.tips
            WHERE id=$1 AND withdrawn_at IS NULL AND visible_until>$2`, [id, at])).rows[0];
    }
    return { ready, admit, receipt, withdraw, cards, media };
}

function formatReceipt(row, at) {
    const visible = !row.withdrawn_at && Date.parse(row.visible_until) > Date.parse(at);
    return {
        id: row.id, submittedAt: new Date(row.submitted_at).toISOString(),
        status: row.withdrawn_at ? 'WITHDRAWN' : visible ? 'PUBLISHED' : 'EXPIRED',
        publicVisible: visible, visibleUntil: new Date(row.visible_until).toISOString(),
    };
}

function publicCard(row) {
    const { payload, rights } = row;
    const details = validPublicDetails(row.public_details, row.case_url) ? row.public_details : null;
    const checkedAt = Date.parse(row.case_checked_at);
    const active = row.case_status === 'ACTIVE' && Number.isFinite(checkedAt);
    return { id: row.id, origin: 'EXTERNAL_PUBLIC_LEAD', type: 'FOUND', animalKind: payload.animal.kind,
        title: payload.display.title, description: 'A public King County record reports this animal found in Washington.',
        observation: payload.observation, location: { countryCode: 'US', regionCode: 'US-WA', coordinates: null },
        identifyingFeatures: details?.features.map(code => ({ code, label: IDENTIFYING_FEATURES[code] })) ?? [],
        caseStatus: active ? { status: 'ACTIVE', checkedAt: new Date(checkedAt).toISOString() } : null,
        source: { label: 'Regional Animal Services of King County', credit: PUBLIC_CASE_CREDIT,
            url: details?.publishCaseLink ? row.case_url : null },
        claim: details?.claimMethod === OFFICIAL_CLAIM_METHOD ? { label: 'How to reclaim a lost pet', url: CLAIM_URL } : null,
        mapMarkerEligible: false, photo: { url: `${PREFIX}/photo-media/${row.id}`, credit: rights.credit,
            creditUrl: rights.creditUrl, license: rights.license, licenseUrl: LICENSE_URLS[rights.license] || null, changes: 'Metadata removed' },
        visibleUntil: new Date(row.visible_until).toISOString() };
}

async function install(app, { pool, verifyRead, verifyWrite, sharp, inspectImage, inspectSafety, enabled = () => false,
    now = () => new Date().toISOString() }) {
    if (typeof verifyRead !== 'function' || typeof verifyWrite !== 'function' || verifyRead === verifyWrite) {
        throw Error('SEPARATE_PHOTO_IDENTITIES_REQUIRED');
    }
    const persistence = createPhotos(pool);
    const handoffs = createHandoffs(pool, persistence.ready);
    const cleanup = setInterval(() => {
        if (enabled()) void handoffs.purge(now()).catch(() => {});
    }, 60000);
    cleanup.unref();
    app.addHook('onClose', async () => clearInterval(cleanup));
    let processing = false;
    await app.register(async scope => {
        const authorized = new WeakMap();
        function assertOpen() { if (!enabled()) throw new PilotError('PHOTO_INTAKE_CLOSED'); }
        function assertWritable(until) {
            assertOpen();
            if (Date.parse(until) <= Date.parse(now())) throw new PilotError('SOURCE_ACTIVE_PROOF_EXPIRED', 403);
        }
        async function auth(request, role) {
            if (role === 'proof') {
                const proof = request.headers['x-photo-handoff-proof'], id = request.params.id;
                if (!HANDOFF_ID.test(id) || typeof proof !== 'string' || !SECRET.test(proof)) throw new PilotError('NOT_FOUND', 404);
                const row = await handoffs.find(id, now());
                if (!row || !proofMatches(row, proof)) throw new PilotError('NOT_FOUND', 404);
                return { row, proof };
            }
            const actor = await (role === 'read' ? verifyRead : verifyWrite)(request);
            if (actor?.publisherId !== SOURCE.publisherId || actor?.datasetId !== SOURCE.datasetId || actor.photoRole !== role
                || (role === 'write' && (!actor.handoff || (request.params?.id && actor.handoff.id !== request.params.id)))) {
                throw new PilotError('SOURCE_NOT_AUTHORIZED', 403);
            }
            return actor;
        }
        function respond(fn) {
            return async (request, reply) => {
                reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
                try { return await fn(request, reply); }
                catch (error) {
                    const known = error instanceof PilotError;
                    return reply.code(known ? error.status : 503).send({ success: false, error: known ? error.code : 'PHOTO_INTAKE_UNAVAILABLE' });
                }
            };
        }
        scope.setErrorHandler((error, _request, reply) => reply.header('Cache-Control', 'no-store')
            .code(error.statusCode === 413 ? 413 : 415).send({ success: false, error: 'PHOTO_REQUEST_REJECTED' }));
        scope.removeContentTypeParser('application/json');
        scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, value, done) => done(null, value));
        function route(method, path, role, handler, bodyLimit = 256) {
            scope.route({ method, url: PREFIX + path, bodyLimit,
                onRequest: respond(async request => {
                    assertOpen();
                    if (Object.keys(request.query || {}).length) throw new PilotError('INVALID_QUERY', 400);
                    if (role) authorized.set(request, await auth(request, role));
                }), handler: respond(handler) });
        }
        route('GET', '/photo-status', 'read', async () => ({ success: true, profile: 'DOT_PHOTO_V1',
            publication: 'AUTOMATIC_IF_VERIFIED', handoff: 'PRIVATE_UPLOAD_V1',
            scope: { publisherId: SOURCE.publisherId, datasetId: SOURCE.datasetId, region: 'US-WA' }, maxOriginalBytes: LIMITS.imageBytes }));
        route('POST', '/photo-tips', 'write', async () => { throw new PilotError('PHOTO_HANDOFF_REQUIRED', 409); });
        route('POST', '/photo-handoffs/:id/open', 'write', async (request, reply) => {
            if (request.body !== undefined) throw new PilotError('INVALID_HANDOFF_REQUEST', 400);
            if (request.params.id === '0'.repeat(32)) throw new PilotError('RESERVED_HANDOFF_ID', 400);
            const expiresAt = await handoffs.open(authorized.get(request).handoff, now());
            return reply.code(201).send({ success: true, status: 'OPEN', expiresAt: new Date(expiresAt).toISOString() });
        });
        route('GET', '/photo-handoffs/:id', 'proof', async request => {
            const { row } = authorized.get(request);
            if (row.result) return refreshResult(row.result);
            return { success: true, status: row.staged ? 'CHECKED_PRIVATE' : 'OPEN', expiresAt: new Date(row.expires_at).toISOString() };
        });
        route('PUT', '/photo-handoffs/:id/content', 'proof', async (request, reply) => {
            const { row, proof } = authorized.get(request);
            if (!contentMatches(row, proof, request.body)) throw new PilotError('PHOTO_HANDOFF_CONTENT_MISMATCH', 409);
            if (row.result) return refreshResult(row.result);
            if (row.staged) return reply.code(202).send({ success: true, status: 'CHECKED_PRIVATE' });
            if (request.body.length < 1024) {
                const parsed = parseBody(request.body, request.headers['content-type'] || '', request.headers['content-encoding'] || 'identity');
                const withdrawal = parsed.success && parsed.value;
                if (withdrawal && typeof withdrawal === 'object' && Object.keys(withdrawal).length === 1 && ID.test(withdrawal.withdrawId || '')) {
                    assertOpen();
                    if (!await handoffs.stage(row, now(), { withdrawId: withdrawal.withdrawId }, null)) throw new PilotError('PHOTO_HANDOFF_CHANGED', 409);
                    return reply.code(202).send({ success: true, status: 'CHECKED_PRIVATE' });
                }
            }
            const candidate = validatePhotoSubmission(request.body, { now: now(), key: request.headers['idempotency-key'],
                type: request.headers['content-type'] || '', encoding: request.headers['content-encoding'] || 'identity' });
            if (!candidate.success) throw new PilotError(candidate.error, candidate.status);
            if (processing) throw new PilotError('PHOTO_CODEC_BUSY', 429);
            processing = true;
            try {
                let image;
                try {
                    await inspectImage(candidate.original, candidate.mime);
                    image = await sharp(candidate.original, { limitInputPixels: LIMITS.imagePixels, failOn: 'warning' })
                        .rotate().flatten({ background: '#fff' }).jpeg({ quality: 88 }).toBuffer();
                    const metadata = await sharp(image).metadata();
                    if (metadata.exif || metadata.xmp || metadata.iptc || metadata.icc || metadata.orientation || image.length > LIMITS.imageBytes) throw Error();
                } catch (_) { throw new PilotError('PHOTO_IMAGE_REJECTED', 422); }
                if ((await inspectSafety(image))?.decision !== 'approve') throw new PilotError('PHOTO_SAFETY_REJECTED', 422);
                assertWritable(candidate.visibleUntil);
                const { fingerprint, picture, tip, visibleUntil } = candidate;
                if (!await handoffs.stage(row, now(), { fingerprint, picture, tip, visibleUntil }, image)) throw new PilotError('PHOTO_HANDOFF_CHANGED', 409);
                return reply.code(202).send({ success: true, status: 'CHECKED_PRIVATE' });
            } finally { processing = false; }
        }, BODY_LIMIT);
        route('POST', '/photo-handoffs/:id/commit', 'write', async (request, reply) => {
            if (request.body !== undefined) throw new PilotError('INVALID_HANDOFF_REQUEST', 400);
            const worker = authorized.get(request).handoff;
            const row = await handoffs.find(worker.id, now(), true);
            if (!row || !matchesWorker(row, worker)) throw new PilotError('NOT_FOUND', 404);
            if (row.result) return refreshResult(row.result);
            if (!row.staged) throw new PilotError('PHOTO_HANDOFF_NOT_READY', 409);
            let receipt, replay = false;
            try {
                if (row.candidate.withdrawId) {
                    assertOpen();
                    receipt = await persistence.withdraw(row.candidate.withdrawId, now());
                    if (!receipt) throw new PilotError('NOT_FOUND', 404);
                } else {
                    const result = await persistence.admit(row.candidate, row.image, now(), until => {
                        assertWritable(until);
                        if (Date.parse(row.expires_at) <= Date.parse(now())) throw new PilotError('PHOTO_HANDOFF_EXPIRED', 409);
                    });
                    receipt = result.row;
                    replay = result.replay;
                }
            } catch (error) {
                if (error instanceof PilotError && ['SOURCE_RATE_LIMIT', 'PHOTO_PILOT_CAPACITY', 'PHOTO_RECORD_CONFLICT',
                    'PHOTO_RECORD_WITHDRAWN', 'SOURCE_ACTIVE_PROOF_EXPIRED', 'NOT_FOUND'].includes(error.code)) {
                    const saved = await handoffs.finish(row, { success: false, error: error.code, status: error.status });
                    return reply.code(saved.status || 200).send(await refreshResult(saved));
                }
                throw error;
            }
            const result = await handoffs.finish(row, { success: true, replay, receipt: formatReceipt(receipt, now()) });
            return reply.code(replay || row.candidate.withdrawId ? 200 : 201).send(await refreshResult(result));
        });
        async function refreshResult(result) {
            if (result.success === false) return result;
            const row = await persistence.receipt(result.receipt.id);
            if (!row) throw new PilotError('NOT_FOUND', 404);
            assertOpen();
            return { ...result, receipt: formatReceipt(row, now()) };
        }
        route('GET', '/photo-receipts/:id', 'read', async request => {
            if (!ID.test(request.params.id)) throw new PilotError('NOT_FOUND', 404);
            const row = await persistence.receipt(request.params.id);
            if (!row) throw new PilotError('NOT_FOUND', 404);
            assertOpen();
            return { success: true, receipt: formatReceipt(row, now()) };
        });
        route('GET', '/photo-cards', false, async () => {
            const rows = await persistence.cards(now());
            assertOpen();
            const at = Date.parse(now());
            return { success: true, cards: rows.filter(row => Date.parse(row.visible_until) > at).map(publicCard) };
        });
        route('GET', '/photo-media/:id', false, async (request, reply) => {
            if (!ID.test(request.params.id)) throw new PilotError('NOT_FOUND', 404);
            const row = await persistence.media(request.params.id, now());
            if (!row || sha(row.image) !== row.image_hash || Date.parse(row.visible_until) <= Date.parse(now())) throw new PilotError('NOT_FOUND', 404);
            assertOpen();
            return reply.type('image/jpeg').send(row.image);
        });
    });
}

module.exports = { install };
