'use strict';

const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { generateKeyPairSync, sign } = require('node:crypto');
const { install } = require('./photo-intake.cjs');
const { sha } = require('./photo-contract.cjs');
const { prepare } = require('./dot-submit.cjs');
const { makeHandoff, deliver } = require('./dot-photo-client.cjs');
const { PHOTO_AUDIENCE, PHOTO_READ_AUDIENCE, ISSUER, REPOSITORY, createSourceVerifier } = require('./dot-identity.cjs');

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
    const settings = { workflowSha: PIN, now: () => clock, loadKeys: keys };
    const verifyRead = createSourceVerifier({ ...settings, audience: PHOTO_READ_AUDIENCE, photoRole: 'read' });
    const verifyWrite = createSourceVerifier({ ...settings, audience: PHOTO_AUDIENCE, photoRole: 'write' });
    let runCount = 1000;
    function auth(role, branch = 'dot-photo-read/v1/' + 'a'.repeat(32), attempt = '1', audience = role === 'read' ? PHOTO_READ_AUDIENCE : PHOTO_AUDIENCE) {
        const seconds = Math.floor(clock / 1000);
        const ref = 'refs/heads/' + branch;
        const workflow = role === 'read' ? 'stray-map-dot-photo-read.yml' : 'stray-map-dot-photo-submit.yml';
        const value = encode({ alg: 'RS256', kid: 'test-only' }) + '.' + encode({
            iss: ISSUER, aud: audience, sub: `repo:${REPOSITORY}:ref:${ref}`, repository: REPOSITORY,
            repository_id: '1150444936', repository_owner_id: '96640428', actor_id: '96640428', ref,
            event_name: 'create', runner_environment: 'github-hosted', workflow_ref: `${REPOSITORY}/.github/workflows/${workflow}@${ref}`, workflow_sha: PIN,
            run_id: String(runCount), run_attempt: attempt, iat: seconds - 5, nbf: seconds - 5, exp: seconds + 295,
        });
        return 'Bearer ' + value + '.' + sign('RSA-SHA256', Buffer.from(value), privateKey).toString('base64url');
    }
    try {
        await install(app, { pool, verifyRead, verifyWrite, sharp, inspectImage: inspectImageUpload,
            inspectSafety: inspectPhotoSafety, enabled: () => enabled, now });
        await app.ready();
        const hit = (method, path, headers, payload) => app.inject({ method, url: BASE + path, headers, payload });
        const get = (path, authorization) => hit('GET', path, authorization ? { authorization } : {});
        async function begin(value) {
            const raw = Buffer.from(JSON.stringify(value)), handoff = makeHandoff(raw);
            const path = '/photo-handoffs/' + handoff.id;
            runCount++;
            const authorization = auth('write', handoff.branch);
            const opened = await hit('POST', path + '/open', { authorization });
            assert.equal(opened.statusCode, 201, opened.body);
            const headers = { 'x-photo-handoff-proof': handoff.proof, 'content-type': 'application/json',
                ...(value.tip && { 'idempotency-key': value.tip.source.recordKey }) };
            return { path, raw, headers, commit: () => hit('POST', path + '/commit', { authorization }),
                stage: () => hit('PUT', path + '/content', headers, raw) };
        }
        async function post(value) {
            const transaction = await begin(value);
            const staged = await transaction.stage();
            return staged.statusCode === 202 ? transaction.commit() : staged;
        }
        const caseBase = 'https://data.kingcounty.gov/resource/azpa-gwmk/';
        const systemRowID = 'row-abcd-efgh.ijkl.json';
        async function fixture(id, color, caseId = id) {
            const lead = prepare({ impound_no: id, data_source: 'Regional Animal Services of King County', state: 'WA',
                record_type: 'FOUND', animal_type: 'Dog', date_type: 'Date Found', date: '2026-11-25T00:00:00.000' });
            const original = await sharp({ create: { width: 128, height: 128, channels: 3, background: color } })
                .withExif({ IFD0: { Artist: 'SYNTHETIC_ONLY' }, IFD3: { GPSLatitudeRef:'N', GPSLatitude:'0/1 0/1 0/1',
                    GPSLongitudeRef:'E', GPSLongitude:'0/1 0/1 0/1' } }).png().toBuffer();
            assert.ok((await sharp(original).metadata()).exif);
            return { tip: lead.payload, sourceEvidence: { status: 'ACTIVE', checkedAt: now(), recordKey: lead.key,
                caseUrl: caseBase + caseId }, photo: {
                content: original.toString('base64'), mime: 'image/png', sha256: sha(original),
                verification: { recordKey: lead.key, originalSha256: sha(original), originalCapture: true,
                    sameAnimalConfirmed: true, animalRecognizable: true, noFacesOrPlates: true, noPersonalData: true, noSensitiveVisualLocation: true },
                rights: { license: 'CC_BY_4_0', credit: 'Synthetic photo author', permissionUrl: 'https://example.invalid/qa-private-proof',
                    creditUrl: 'https://example.invalid/qa-credit', permitsRedaction: true, creditApprovedForPublic: true },
            }};
        }
        const a = await fixture('qa-local-a', '#2C6E4A', systemRowID), b = await fixture('qa-local-b', '#4970A5');
        a.publicDetails = { features: ['BLACK_COAT', 'WHITE_CHEST'], publishCaseLink: true, claimMethod: 'KING_COUNTY_LOST_PET' };
        const invalid = makeHandoff(Buffer.from('{}'));
        const reserved = '/photo-handoffs/' + invalid.id + '/open';
        assert.equal((await get('/photo-status')).statusCode, 403);
        assert.equal((await get('/photo-status', auth('write', invalid.branch))).statusCode, 403);
        assert.equal((await get('/photo-status', auth('read'))).json().publication, 'AUTOMATIC_IF_VERIFIED');
        assert.equal((await hit('POST', reserved, { authorization: auth('read', undefined, '1', PHOTO_AUDIENCE) })).statusCode, 403);
        assert.equal((await hit('POST', reserved, { authorization: auth('write', invalid.branch, '2') })).statusCode, 403);
        assert.equal((await hit('PUT', '/photo-handoffs/' + invalid.id + '/content', {
            'x-photo-handoff-proof': invalid.proof, 'content-type': 'application/json',
        }, '{}')).statusCode, 404);
        for (const [override, reason] of [
            [nowValue => ({ ...a, sourceEvidence: { ...a.sourceEvidence, checkedAt: nowValue }, photo: null }), 'ORIGINAL_IMAGE_BYTES_REQUIRED'],
            [nowValue => ({ ...a, sourceEvidence: { ...a.sourceEvidence, checkedAt: nowValue, status: 'UNKNOWN' } }), 'SOURCE_ACTIVE_PROOF_REQUIRED'],
            [() => plus(a, 'sourceEvidence', plus(a.sourceEvidence, 'checkedAt', new Date(clock - 900000).toISOString())), 'SOURCE_ACTIVE_PROOF_EXPIRED'],
            [nowValue => ({ ...a, sourceEvidence: { ...a.sourceEvidence, checkedAt: nowValue },
                photo: plus(a.photo, 'verification', plus(a.photo.verification, 'sameAnimalConfirmed', false)) }), 'PHOTO_VERIFICATION_REQUIRED'],
            [nowValue => ({ ...a, sourceEvidence: { ...a.sourceEvidence, checkedAt: nowValue },
                photo: plus(a.photo, 'rights', plus(a.photo.rights, 'permitsRedaction', false)) }), 'PHOTO_REPUBLICATION_RIGHTS_REQUIRED'],
        ]) {
            assert.equal((await post(override(now()))).json().error, reason);
            clock += 240001;
        }
        const invalidCaseURLs = [
            a.sourceEvidence.caseUrl.replace('https:', 'http:'),
            a.sourceEvidence.caseUrl.replace('data.kingcounty.gov', 'other.example.org'),
            a.sourceEvidence.caseUrl.replace('data.kingcounty.gov', 'data.kingcounty.gov:8443'),
            a.sourceEvidence.caseUrl.replace('azpa-gwmk', 'other-data'),
            a.sourceEvidence.caseUrl.replace('/resource/', '/RESOURCE/'),
            `${caseBase}nested/${systemRowID}`,
            `${caseBase}row-abcd-efgh.ijk.json`,
            `${caseBase}row-abcd-efgh.ijkl`,
            `${caseBase}row-abcd-efgh%2eijkl.json`,
            `${a.sourceEvidence.caseUrl}?utm_source=qa`,
            `${a.sourceEvidence.caseUrl}?select=id`,
            `${a.sourceEvidence.caseUrl}#qa`,
        ];
        for (const caseUrl of invalidCaseURLs) {
            const rejected = await post({ ...a, sourceEvidence: { ...a.sourceEvidence, caseUrl, checkedAt: now() } });
            assert.equal(rejected.statusCode, 403, caseUrl);
            assert.equal(rejected.json().error, 'SOURCE_ACTIVE_PROOF_REQUIRED', caseUrl);
            clock += 240001;
        }
        const unsafeDetails = [
            { features: ['Call 206-555-0100'] },
            { features: ['BLACK_COAT', 'BLACK_COAT'] },
            { features: ['BLACK_COAT', 'WHITE_COAT', 'BROWN_COAT', 'TAN_COAT', 'GRAY_COAT', 'WHITE_CHEST'] },
            { features: ['__proto__'] },
            { claimMethod: 'https://example.invalid/claim' },
            { publishCaseLink: 'https://example.invalid/case' },
            { description: 'Private messages, addresses and links are excluded' },
            { sourceUrl: 'https://example.invalid/case' },
        ];
        for (const fields of unsafeDetails) {
            const candidate = { ...a, sourceEvidence: { ...a.sourceEvidence, checkedAt: now() },
                publicDetails: { ...a.publicDetails, ...fields } };
            const rejected = await post(candidate);
            assert.equal(rejected.statusCode, 422);
            assert.equal(rejected.json().error, 'INVALID_PHOTO_PUBLIC_DETAILS');
            clock += 240001;
        }
        const unsafeLegacyLink = await post({ ...b, sourceEvidence: { ...b.sourceEvidence, checkedAt: now() }, publicDetails: a.publicDetails });
        assert.equal(unsafeLegacyLink.json().error, 'INVALID_PHOTO_PUBLIC_DETAILS');
        clock += 240001;
        assert.deepEqual((await get('/photo-cards')).json().cards, []);
        a.sourceEvidence.checkedAt = now();
        const aStart = clock;
        let worker;
        const first = await deliver(Buffer.from(JSON.stringify(a)), PIN, {
            clock: () => clock, wait: async () => {},
            createBranch: async (branch, shaToRun) => {
                assert.equal(shaToRun, PIN);
                assert.match(branch, /^dot-photo-submit\/v1\/[a-f0-9]{32}\.[a-f0-9]{64}\.[a-f0-9]{64}$/);
                const id = branch.split('/').at(-1).split('.')[0];
                runCount++;
                const authorization = auth('write', branch);
                worker = { path: '/photo-handoffs/' + id, authorization };
                assert.equal((await hit('POST', worker.path + '/open', { authorization })).statusCode, 201);
                assert.equal((await hit('POST', worker.path + '/commit', { authorization })).statusCode, 409);
            },
            request: async (url, options) => {
                const relative = new URL(url).pathname.slice(BASE.length);
                if (options.method === 'PUT') {
                    const rejected = await hit('PUT', relative, options.headers, Buffer.from('{}'));
                    assert.equal(rejected.json().error, 'PHOTO_HANDOFF_CONTENT_MISMATCH');
                }
                const response = await hit(options.method || 'GET', relative, options.headers, options.body);
                if (options.method === 'PUT' && response.statusCode === 202) {
                    assert.deepEqual((await get('/photo-cards')).json().cards, []);
                    assert.equal(response.json().status, 'CHECKED_PRIVATE');
                    const committed = await hit('POST', worker.path + '/commit', { authorization: worker.authorization });
                    assert.equal(committed.statusCode, 201, committed.body);
                }
                return new Response(response.body, { status: response.statusCode });
            },
        });
        const receipt = first.receipt;
        assert.match(receipt.id, /^photo_[a-f0-9]{32}$/);
        assert.equal(receipt.status, 'PUBLISHED');
        assert.equal((await get('/photo-receipts/' + receipt.id, auth('read'))).json().receipt.id, receipt.id);
        const same = await post(a);
        assert.equal(same.statusCode, 200);
        assert.deepEqual(same.json().receipt, receipt);
        const listing = await get('/photo-cards');
        const card = listing.json().cards[0];
        assert.equal(card.id, receipt.id);
        assert.equal(card.observation.value, '2026-11-25');
        assert.equal(card.observation.precision, 'DATE');
        assert.equal(card.observation.timeZone, 'America/Los_Angeles');
        assert.equal(card.photo.credit, 'Synthetic photo author');
        assert.equal(card.photo.creditUrl, 'https://example.invalid/qa-credit');
        assert.match(card.description, /reported|reports this animal found/);
        assert.doesNotMatch(card.description, /human review/i);
        assert.deepEqual(card.identifyingFeatures, [{ code: 'BLACK_COAT', label: 'Black coat' }, { code: 'WHITE_CHEST', label: 'White chest' }]);
        assert.deepEqual(card.caseStatus, { status: 'ACTIVE', checkedAt: a.sourceEvidence.checkedAt });
        assert.deepEqual(card.source, { label: 'Regional Animal Services of King County',
            credit: 'data provided by permission of King County', url: caseBase + systemRowID });
        assert.deepEqual(card.claim, { label: 'How to reclaim a lost pet', url: 'https://kingcounty.gov/LostAPet' });
        assert.equal(card.location.regionCode, 'US-WA');
        assert.equal(card.location.coordinates, null);
        assert.equal(card.mapMarkerEligible, false);
        assert.ok(!listing.body.includes(a.tip.source.recordKey) && !listing.body.includes('qa-private-proof')
            && !listing.body.includes('qa-local-a'));
        const media = await get('/photo-media/' + receipt.id);
        assert.equal(media.statusCode, 200);
        assert.equal(media.headers['cache-control'], 'no-store');
        const stored = await sharp(media.rawPayload).metadata();
        assert.ok(stored.format === 'jpeg' && !stored.exif && !stored.xmp && !stored.icc && !stored.orientation);
        clock++;
        const refreshed = await post({ ...a, sourceEvidence: { ...a.sourceEvidence, checkedAt: now() },
            publicDetails: { features: ['BLACK_COAT'], publishCaseLink: false, claimMethod: null } });
        assert.equal(refreshed.statusCode, 200);
        assert.equal(refreshed.json().receipt.id, receipt.id);
        const refreshedCard = (await get('/photo-cards')).json().cards[0];
        assert.deepEqual(refreshedCard.identifyingFeatures, [{ code: 'BLACK_COAT', label: 'Black coat' }]);
        assert.equal(refreshedCard.source.url, null);
        assert.equal(refreshedCard.claim, null);
        clock += 240001;
        b.sourceEvidence.checkedAt = now();
        assert.equal((await post(b)).statusCode, 429);
        clock = aStart + 3600000;
        assert.equal((await get('/photo-media/' + receipt.id)).statusCode, 404);
        b.sourceEvidence.checkedAt = now();
        const second = await post(b);
        assert.equal(second.statusCode, 201, second.body);
        const other = second.json().receipt;
        assert.notEqual(receipt.id, other.id);
        const legacyCard = (await get('/photo-cards')).json().cards[0];
        assert.equal(legacyCard.id, other.id);
        assert.equal(legacyCard.source.url, null);
        assert.equal(legacyCard.claim, null);
        assert.deepEqual(legacyCard.identifyingFeatures, []);
        const withdrawn = await post({ withdrawId: other.id });
        assert.equal(withdrawn.json().receipt.status, 'WITHDRAWN');
        assert.equal((await get('/photo-media/' + other.id)).statusCode, 404);
        assert.equal((await post(b)).statusCode, 409);
        assert.equal((await pool.query('SELECT count(*)::int n FROM stray_dot_photo_v1.tips')).rows[0].n, 2);
        assert.deepEqual((await get('/photo-cards')).json().cards, []);
        enabled = false;
        assert.equal((await get('/photo-cards')).statusCode, 503);
        console.log(JSON.stringify({ synthetic: true, receipts: [receipt, other].map(row => 'masked-' + sha(row.id).slice(0, 12)),
            cases: 2, autoPublished: true, noHumanReview: true, sameReceipt: true, expiryHidden: true,
            withdrawnHidden: true, unauthorizedDenied: true, metadataRemoved: true, bundledSafetyModelRan: true,
            readCannotWrite: true, restartedJobDenied: true, privateStagingBeforeCommit: true, exactBodyBinding: true,
            socrataSystemRowIdAccepted: true, legacyCaseUrlAccepted: true, invalidCaseURLsRejected: invalidCaseURLs.length,
            enrichedSingleCard: true, updatedDetailsKeptReceipt: true, unsafePublicDetailsRejected: unsafeDetails.length + 1 }));
    } finally { await app.close(); await pool.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
