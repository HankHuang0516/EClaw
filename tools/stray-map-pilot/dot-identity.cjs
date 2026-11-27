'use strict';

const { createPublicKey, verify } = require('node:crypto');

const REPOSITORY = 'HankHuang0516/EClaw';
const REF = 'refs/heads/codex/stray-map-intake-rehearsal-20261126';
const WORKFLOW = `${REPOSITORY}/.github/workflows/stray-map-dot-intake.yml@${REF}`;
const ISSUER = 'https://token.actions.githubusercontent.com';
const AUDIENCE = 'https://api-production-8bc1.up.railway.app/external-intake/v1';
const PHOTO_AUDIENCE = `${AUDIENCE}/photo-tips`;
const SOURCE = Object.freeze({
    publisherId: 'king-county-ras',
    datasetId: 'found-animals-azpa-gwmk',
    verified: true,
    origin: 'https://data.kingcounty.gov',
    pathPrefix: '/resource/',
    allowedRegions: Object.freeze(['US-WA']),
});
const DEADLINE_SECONDS = 600;

function foundDisplay(kind) {
    return {
        locale: 'en-US',
        title: `${kind === 'CAT' ? 'Cat' : 'Dog'}: found animal lead`,
        description: 'A public King County record reports this animal found in Washington. This third-party lead awaits human review.',
    };
}

function allowPayload(tip) {
    const { animal, display, observation, report, source } = tip;
    const approved = foundDisplay(animal.kind);
    return ['CAT', 'DOG'].includes(animal.kind) && animal.count === null && animal.condition === 'UNKNOWN'
        && observation.precision === 'DATE' && observation.timeZone === 'America/Los_Angeles'
        && report.type === 'FOUND' && report.custody.status === 'UNKNOWN'
        && source.publishedAt.precision === 'UNKNOWN' && /^[a-f0-9]{64}$/.test(source.recordKey)
        && Object.keys(approved).every(key => display[key] === approved[key]);
}

function parsePart(part) {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

async function githubKeys() {
    const response = await fetch(`${ISSUER}/.well-known/jwks`, {
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw Error('OIDC_KEYS_UNAVAILABLE');
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 65536) throw Error('OIDC_KEYS_TOO_LARGE');
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')).keys;
}

function createSourceVerifier({ workflowSha, audience = AUDIENCE, loadKeys = githubKeys, now = Date.now }) {
    if (!/^[a-f0-9]{40}$/.test(workflowSha || '')) throw Error('PINNED_WORKFLOW_REQUIRED');
    if (![AUDIENCE, PHOTO_AUDIENCE].includes(audience)) throw Error('PINNED_AUDIENCE_REQUIRED');
    let keys = new Map();
    let refreshedAt = -Infinity;
    let refreshing;

    async function findKey(kid) {
        const age = now() - refreshedAt;
        if (age >= 3600000 || (!keys.has(kid) && age >= 60000)) {
            if (!refreshing) {
                refreshedAt = now();
                refreshing = loadKeys().then(entries => {
                    if (!Array.isArray(entries) || entries.length > 20) throw Error('INVALID_OIDC_KEYS');
                    keys = new Map(entries.filter(key => key.kty === 'RSA' && key.alg === 'RS256'
                        && key.use === 'sig' && typeof key.kid === 'string').map(key => [key.kid, key]));
                }).catch(error => {
                    keys = new Map();
                    throw error;
                }).finally(() => { refreshing = undefined; });
            }
        }
        await refreshing;
        return keys.get(kid);
    }

    return async function verifySource(request) {
        const value = request.headers.authorization;
        if (typeof value !== 'string' || value.length > 8192) return null;
        const token = /^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(value);
        if (!token) return null;
        const [, encodedHeader, encodedClaims, signature] = token;
        try {
            const header = parsePart(encodedHeader);
            const claim = parsePart(encodedClaims);
            const time = Math.floor(now() / 1000);
            if (header.alg !== 'RS256' || !/^[\w-]{1,128}$/.test(header.kid || '')
                || Object.keys(header).some(key => !['alg', 'kid', 'typ', 'x5t'].includes(key))
                || claim.iss !== ISSUER || claim.aud !== audience || claim.sub !== `repo:${REPOSITORY}:ref:${REF}`
                || claim.repository_id !== '1150444936' || claim.repository_owner_id !== '96640428'
                || claim.repository !== REPOSITORY || claim.ref !== REF || claim.event_name !== 'push'
                || claim.actor_id !== '96640428' || claim.workflow_ref !== WORKFLOW
                || claim.workflow_sha !== workflowSha || claim.runner_environment !== 'github-hosted'
                || !/^[1-9]\d?$/.test(claim.run_attempt || '')
                || (request.method === 'POST' && Number(claim.run_attempt) < 2)
                || ![claim.iat, claim.nbf, claim.exp].every(Number.isSafeInteger)
                || claim.iat > time + 30 || claim.nbf > time + 30 || claim.exp <= time
                || claim.exp <= claim.iat || claim.exp - claim.iat > DEADLINE_SECONDS) return null;
            const jwk = await findKey(header.kid);
            if (!jwk || !verify('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedClaims}`),
                createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(signature, 'base64url'))) return null;
            return { publisherId: SOURCE.publisherId, datasetId: SOURCE.datasetId };
        } catch {
            return null;
        }
    };
}

module.exports = { AUDIENCE, PHOTO_AUDIENCE, ISSUER, SOURCE, REPOSITORY, REF, WORKFLOW, createSourceVerifier, foundDisplay, allowPayload };
