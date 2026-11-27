'use strict';

const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { generateKeyPairSync, sign } = require('node:crypto');
const { install } = require('./photo-intake.cjs');
const { sha } = require('./photo-contract.cjs');
const { prepare } = require('./dot-submit.cjs');
const { AUDIENCE, PHOTO_AUDIENCE, ISSUER, REPOSITORY, REF, WORKFLOW, createSourceVerifier } = require('./dot-identity.cjs');

const DSN = 'postgresql://postgres:fixture-local-only@fixture.railway.internal:5432/stray_photo_publish_fixture';
const PIN = 'a'.repeat(40), BASE = '/external-intake/v1';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const plus = (value, key, updated) => ({ ...value, [key]: updated });

async function main() {
    assert.equal(process.env.DATABASE_URL, DSN);
    assert.equal(process.platform, 'linux');
    assert.equal(process.arch, 'x64');
    const dependencies = createRequire('/app/package.json');
    const { Pool } = dependencies('pg'), sharp = dependencies('sharp');
    const { inspectImageUpload } = await import('/app/apps/api/dist/moderation.js');
    const { inspectPhotoSafety } = await import('/app/apps/api/dist/photoSafety.js');
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const keys = async () => [{ ...publicKey.export({ format: 'jwk' }), kid: 'test-only', alg: 'RS256', use: 'sig' }];
    let clock = Date.parse('2026-11-27T00:00:00.000Z'), enabled = true;
    const now = () => new Date(clock).toISOString();
    const pool = new Pool({ connectionString: DSN, max: 2, connectionTimeoutMillis: 2000, query_timeout: 4000, statement_timeout: 3000 });
    const app = dependencies('fastify')();
    const authenticate = createSourceVerifier({ workflowSha: PIN, audience: PHOTO_AUDIENCE, now: () => clock, loadKeys: keys });
    function auth(audience = PHOTO_AUDIENCE) {
        const seconds = Math.floor(clock / 1000);
        const value = encode({ alg: 'RS256', kid: 'test-only' }) + '.' + encode({
            iss: ISSUER, aud: audience, sub: `repo:${REPOSITORY}:ref:${REF}`, repository: REPOSITORY,
            repository_id: '1150444936', repository_owner_id: '96640428', actor_id: '96640428', ref: REF,
            event_name: 'push', runner_environment: 'github-hosted', workflow_ref: WORKFLOW, workflow_sha: PIN,
            run_attempt: '2', iat: seconds - 5, nbf: seconds - 5, exp: seconds + 295,
        });
        return 'Bearer ' + value + '.' + sign('RSA-SHA256', Buffer.from(value), privateKey).toString('base64url');
    }
    try {
        await install(app, { pool, verifySource: authenticate, sharp, inspectImage: inspectImageUpload,
            inspectSafety: inspectPhotoSafety, enabled: () => enabled, now });
        await app.ready();
        const hit = (method, path, headers, payload) => app.inject({ method, url: BASE + path, headers, payload });
        const get = (path, authorization) => hit('GET', path, authorization ? { authorization } : {});
        const post = (value, authorization = auth()) => hit('POST', '/photo-tips', {
            authorization, 'content-type': 'application/json', 'idempotency-key': value.tip.source.recordKey,
        }, JSON.stringify(value));
        async function fixture(id, color) {
            const lead = prepare({ impound_no: id, data_source: 'Regional Animal Services of King County', state: 'WA',
                record_type: 'FOUND', animal_type: 'Dog', date_type: 'Date Found', date: '2026-11-25T00:00:00.000' });
            const original = await sharp({ create: { width: 128, height: 128, channels: 3, background: color } })
                .withExif({ IFD0: { Artist: 'SYNTHETIC_ONLY' }, IFD3: { GPSLatitudeRef:'N', GPSLatitude:'0/1 0/1 0/1',
                    GPSLongitudeRef:'E', GPSLongitude:'0/1 0/1 0/1' } }).png().toBuffer();
            assert.ok((await sharp(original).metadata()).exif);
            return { tip: lead.payload, sourceEvidence: { status: 'ACTIVE', checkedAt: now(), recordKey: lead.key,
                caseUrl: 'https://data.kingcounty.gov/resource/azpa-gwmk/' + id }, photo: {
                content: original.toString('base64'), mime: 'image/png', sha256: sha(original),
                verification: { recordKey: lead.key, originalSha256: sha(original), originalCapture: true,
                    sameAnimalConfirmed: true, animalRecognizable: true, noFacesOrPlates: true, noPersonalData: true, noSensitiveVisualLocation: true },
                rights: { license: 'CC_BY_4_0', credit: 'Synthetic photo author', permissionUrl: 'https://example.invalid/qa-private-proof',
                    creditUrl: 'https://example.invalid/qa-credit', permitsRedaction: true, creditApprovedForPublic: true },
            }};
        }
        const a = await fixture('qa-local-a', '#2C6E4A'), b = await fixture('qa-local-b', '#4970A5');
        assert.equal((await get('/photo-status')).statusCode, 403);
        assert.equal((await get('/photo-status', auth(AUDIENCE))).statusCode, 403);
        assert.equal((await get('/photo-status', auth())).json().publication, 'AUTOMATIC_IF_VERIFIED');
        assert.equal((await post(a, 'Bearer invalid')).statusCode, 403);
        assert.equal((await post(plus(a, 'photo', null))).statusCode, 422);
        assert.equal((await post(plus(a, 'sourceEvidence', plus(a.sourceEvidence, 'status', 'UNKNOWN')))).json().error, 'SOURCE_ACTIVE_PROOF_REQUIRED');
        assert.equal((await post(plus(a, 'sourceEvidence', plus(a.sourceEvidence, 'checkedAt', new Date(clock - 900000).toISOString())))).json().error,
            'SOURCE_ACTIVE_PROOF_EXPIRED');
        assert.equal((await post(plus(a, 'photo', plus(a.photo, 'verification', plus(a.photo.verification, 'sameAnimalConfirmed', false))))).json().error,
            'PHOTO_VERIFICATION_REQUIRED');
        assert.equal((await post(plus(a, 'photo', plus(a.photo, 'rights', plus(a.photo.rights, 'permitsRedaction', false))))).json().error,
            'PHOTO_REPUBLICATION_RIGHTS_REQUIRED');
        assert.equal((await post(plus(a, 'photo', plus(a.photo, 'mime', 'image/jpeg')))).json().error, 'PHOTO_IMAGE_REJECTED');
        assert.deepEqual((await get('/photo-cards')).json().cards, []);
        const first = await post(a);
        assert.equal(first.statusCode, 201, first.body);
        const receipt = first.json().receipt;
        assert.match(receipt.id, /^photo_[a-f0-9]{32}$/);
        assert.equal(receipt.status, 'PUBLISHED');
        assert.equal((await get('/photo-receipts/' + receipt.id, auth())).json().receipt.id, receipt.id);
        const same = await post(a);
        assert.equal(same.statusCode, 200);
        assert.deepEqual(same.json().receipt, receipt);
        const listing = await get('/photo-cards');
        const card = listing.json().cards[0];
        assert.equal(card.photo.credit, 'Synthetic photo author');
        assert.equal(card.location.regionCode, 'US-WA');
        assert.equal(card.location.coordinates, null);
        assert.ok(!listing.body.includes(a.tip.source.recordKey) && !listing.body.includes('qa-private-proof'));
        const media = await get('/photo-media/' + receipt.id);
        assert.equal(media.statusCode, 200);
        assert.equal(media.headers['cache-control'], 'no-store');
        const stored = await sharp(media.rawPayload).metadata();
        assert.ok(stored.format === 'jpeg' && !stored.exif && !stored.xmp && !stored.icc && !stored.orientation);
        assert.equal((await post(b)).statusCode, 429);
        clock += 3600000;
        assert.equal((await get('/photo-media/' + receipt.id)).statusCode, 404);
        b.sourceEvidence.checkedAt = now();
        const second = await post(b);
        assert.equal(second.statusCode, 201, second.body);
        const other = second.json().receipt;
        assert.notEqual(receipt.id, other.id);
        const withdrawn = await hit('POST', '/photo-tips/' + other.id + '/withdraw', { authorization: auth() });
        assert.equal(withdrawn.json().receipt.status, 'WITHDRAWN');
        assert.equal((await get('/photo-media/' + other.id)).statusCode, 404);
        assert.equal((await post(b)).statusCode, 409);
        assert.equal((await pool.query('SELECT count(*)::int n FROM stray_dot_photo_v1.tips')).rows[0].n, 2);
        assert.deepEqual((await get('/photo-cards')).json().cards, []);
        enabled = false;
        assert.equal((await get('/photo-cards')).statusCode, 503);
        console.log(JSON.stringify({ synthetic: true, receipts: [receipt, other].map(row => 'masked-' + sha(row.id).slice(0, 12)),
            cases: 2, autoPublished: true, noHumanReview: true, sameReceipt: true, expiryHidden: true,
            withdrawnHidden: true, unauthorizedDenied: true, metadataRemoved: true, bundledSafetyModelRan: true }));
    } finally { await app.close(); await pool.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
