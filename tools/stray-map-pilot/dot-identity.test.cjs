'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const { AUDIENCE, ISSUER, SOURCE, REPOSITORY, REF, WORKFLOW, createSourceVerifier, allowPayload } = require('./dot-identity.cjs');
const { prepare } = require('./dot-submit.cjs');
const { validateTip } = require('../stray-map-intake/contract');

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const unrelatedKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-only', alg: 'RS256', use: 'sig' };
const workflowSha = 'a'.repeat(40);
const now = 1795737600;
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const claims = {
    iss: ISSUER, aud: AUDIENCE, sub: `repo:${REPOSITORY}:ref:${REF}`,
    repository: REPOSITORY, repository_id: '1150444936', repository_owner_id: '96640428',
    actor_id: '96640428', ref: REF, event_name: 'push', runner_environment: 'github-hosted',
    workflow_ref: WORKFLOW, workflow_sha: workflowSha, run_attempt: '2',
    iat: now - 5, nbf: now - 5, exp: now + 295,
};

function signed(overrides = {}, { key = privateKey, header = {}, method = 'GET' } = {}) {
    const body = `${b64({ alg: 'RS256', typ: 'JWT', kid: jwk.kid, ...header })}.${b64({ ...claims, ...overrides })}`;
    const signature = sign('RSA-SHA256', Buffer.from(body), key).toString('base64url');
    return { method, headers: { authorization: `Bearer ${body}.${signature}` } };
}

test('trusts the pinned signed GitHub workflow and grants one source', async () => {
    const authenticate = createSourceVerifier({ workflowSha, loadKeys: async () => [jwk], now: () => now * 1000 });
    const expected = { publisherId: SOURCE.publisherId, datasetId: SOURCE.datasetId };
    assert.deepEqual(await authenticate(signed()), expected);
    assert.deepEqual(await authenticate(signed({}, { method: 'POST' })), expected);
    assert.deepEqual(await authenticate(signed({ run_attempt: '1' })), expected);
    assert.equal(await authenticate(signed({ run_attempt: '1' }, { method: 'POST' })), null);
    assert.equal(await authenticate({ headers: {} }), null);
    assert.equal(await authenticate(signed({}, { key: unrelatedKey })), null);
    assert.equal(await authenticate(signed({}, { header: { alg: 'none' } })), null);
    assert.equal(await authenticate(signed({}, { header: { jku: 'https://example.invalid/jwks' } })), null);
});

test('denies valid signatures outside the trusted workflow, audience or validity', async () => {
    let loads = 0;
    const authenticate = createSourceVerifier({
        workflowSha, loadKeys: async () => { loads++; return [jwk]; }, now: () => now * 1000,
    });
    const denied = { iss: 'https://example.invalid', aud: 'other-service', sub: 'other', repository: 'other',
        repository_id: '1', repository_owner_id: '1', actor_id: '1', ref: 'refs/heads/main', event_name: 'pull_request',
        runner_environment: 'self-hosted', workflow_ref: 'other.yml', workflow_sha: 'b'.repeat(40),
        run_attempt: '0', exp: now, nbf: now + 31, iat: now - 700 };
    for (const [claim, value] of Object.entries(denied)) {
        const request = signed({ [claim]: value }, { method: 'POST' });
        assert.equal(await authenticate(request), null, claim);
    }
    assert.equal(loads, 0);
});

test('coalesces key refreshes and fails closed when the issuer is unavailable', async () => {
    let loads = 0;
    const authenticate = createSourceVerifier({
        workflowSha, loadKeys: async () => { loads++; throw Error('test outage'); }, now: () => now * 1000,
    });
    const results = await Promise.all([authenticate(signed()), authenticate(signed()), authenticate(signed())]);
    assert.deepEqual(results, [null, null, null]);
    assert.equal(loads, 1);
});

test('official adapter retains a local date, stable private key and coarse region only', () => {
    const row = { impound_no: 'synthetic-local-only', data_source: 'Regional Animal Services of King County',
        record_type: 'FOUND', animal_type: 'Cat', state: 'WA', date_type: 'Date Found', date: '2026-11-25T00:00:00.000',
        image: 'https://invalid.example/image.jpg', city: 'Private exact location' };
    const { key, payload } = prepare(row);
    assert.equal(key, prepare({ ...row, city: 'different' }).key);
    assert.equal(payload.location.regionCode, 'US-WA');
    assert.equal(payload.display.locale, 'en-US');
    assert.equal(payload.observation.precision, 'DATE');
    assert.equal(payload.observation.value, '2026-11-25');
    assert.deepEqual(payload.photos, []);
    const body = JSON.stringify(payload);
    assert.doesNotMatch(body, /synthetic-local-only|Private exact location|image.jpg/);
    assert.equal(validateTip(Buffer.from(body), {
        sourcePolicy: SOURCE, submittedAt: '2026-11-27T00:00:00.000Z', contentType: 'application/json',
    }).success, true);
    assert.equal(allowPayload(payload), true);
    assert.equal(allowPayload({ ...payload, report: { ...payload.report, type: 'LOST' } }), false);
    assert.equal(allowPayload({ ...payload, display: { ...payload.display, title: 'Arbitrary title' } }), false);
    for (const nonqualifying of [{ state: null }, { date_type: 'Received on' }, { date: '2026-02-30T00:00:00.000' },
        { data_source: 'other' }, { record_type: 'LOST' }, { animal_type: 'Wildlife' }]) {
        assert.equal(prepare({ ...row, ...nonqualifying }), null);
    }
});
