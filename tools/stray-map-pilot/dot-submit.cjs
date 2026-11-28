'use strict';

const { createHash } = require('node:crypto');
const { AUDIENCE, PHOTO_AUDIENCE, SOURCE, createSourceVerifier, foundDisplay } = require('./dot-identity.cjs');

const UNKNOWN = Object.freeze({ precision: 'UNKNOWN', value: null, timeZone: null });
const sha = text => createHash('sha256').update(text).digest('hex');

function sourceRecordKey(row, scope = SOURCE) {
    if (row?.data_source !== 'Regional Animal Services of King County' || row.record_type !== 'FOUND'
        || typeof row.impound_no !== 'string' || !/^[a-zA-Z0-9-]{1,32}$/.test(row.impound_no)) return null;
    return sha(JSON.stringify([scope.publisherId, scope.datasetId, row.impound_no]));
}

function prepare(row, scope = SOURCE) {
    const key = sourceRecordKey(row, scope);
    if (!key || row.state !== 'WA' || row.date_type !== 'Date Found' || !['Cat', 'Dog'].includes(row.animal_type)) return null;
    const date = typeof row.date === 'string' && /^(\d{4}-\d{2}-\d{2})T00:00:00\.000$/.exec(row.date)?.[1];
    if (!date) return null;
    const midnight = new Date(`${date}T00:00:00Z`);
    if (!Number.isFinite(+midnight) || midnight.toISOString().slice(0, 10) !== date) return null;
    const { publisherId, datasetId } = scope;
    return {
        key, payload: {
            schemaVersion: 3, thirdParty: true, selfWitness: false,
            source: { publisherId, datasetId, recordKey: key, url: null, publishedAt: UNKNOWN },
            observation: { precision: 'DATE', value: date, timeZone: 'America/Los_Angeles' },
            animal: { kind: row.animal_type.toUpperCase(), count: null, condition: 'UNKNOWN' },
            location: { countryCode: 'US', regionCode: 'US-WA', sensitivity: 'NONE' },
            display: foundDisplay(row.animal_type.toUpperCase()),
            photos: [],
            report: { type: 'FOUND', locationMeaning: 'FOUND_AT', custody: { status: 'UNKNOWN', asOf: UNKNOWN } },
        },
    };
}

async function request(url, options = {}) {
    return fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(12000) });
}

async function authorization(audience) {
    const url = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.actions.githubusercontent.com')) throw Error('OIDC_RUNTIME_REQUIRED');
    url.searchParams.set('audience', audience);
    const response = await request(url, {
        headers: { authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    });
    if (!response.ok) throw Error('OIDC_ISSUE_FAILED');
    const { value } = await response.json();
    if (typeof value !== 'string') throw Error('OIDC_ISSUE_FAILED');
    return `Bearer ${value}`;
}

async function main(mode) {
    if (!['verify-photo', 'probe-photo', 'check-photo-source'].includes(mode) || process.env.GITHUB_ACTIONS !== 'true'
        || process.env.GITHUB_TRIGGERING_ACTOR !== 'HankHuang0516') throw Error('AUTHORIZED_MANUAL_JOB_REQUIRED');
    if (mode === 'check-photo-source') {
        // This dataset publishes discoverable reports, but its schema does not supply the verified per-photo permission or an active-case decision.
        const source = await request(new URL('/api/views/azpa-gwmk', SOURCE.origin));
        if (!source.ok || (await source.json()).id !== 'azpa-gwmk') throw Error('SOURCE_UNAVAILABLE');
        console.log('SOURCE_ON_HOLD active-case and photo-republication proof not established');
        return;
    }
    const auth = await authorization(PHOTO_AUDIENCE);
    const verifySource = createSourceVerifier({ workflowSha: process.env.GITHUB_SHA, audience: PHOTO_AUDIENCE });
    if (!await verifySource({ method: 'GET', headers: { authorization: auth } })) {
        throw Error('SIGNED_WORKFLOW_IDENTITY_REJECTED');
    }
    if (mode === 'verify-photo') {
        console.log('OIDC_WORKFLOW_IDENTITY_VERIFIED');
        return;
    }
    const url = `${AUDIENCE}/photo-status`;
    const signed = await request(url, { headers: { authorization: auth } });
    const anonymous = await request(url);
    const cards = await request(`${AUDIENCE}/photo-cards`);
    if (signed.status !== 200 || (await signed.json()).publication !== 'AUTOMATIC_IF_VERIFIED'
        || anonymous.status !== 403 || cards.status !== 200 || !Array.isArray((await cards.json()).cards)) {
        throw Error('PRODUCTION_PHOTO_IDENTITY_BOUNDARY_MISMATCH');
    }
    console.log('OFFICIAL_PHOTO_INTAKE_VERIFIED signed=200 anonymous=403 cards=200');
}

if (require.main === module) {
    main(process.argv[2]).catch(error => {
        // The public workflow never emits raw upstream messages, responses, tokens, or source identifiers.
        const code = /^[A-Z0-9_]{1,70}$/.test(error.message) ? error.message : 'REQUEST_FAILED';
        console.error(code);
        process.exitCode = 1;
    });
}
module.exports = { prepare, sourceRecordKey };
