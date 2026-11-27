'use strict';

const { createHash } = require('node:crypto');
const { AUDIENCE, SOURCE, createSourceVerifier, foundDisplay } = require('./dot-identity.cjs');

const SOURCE_API = new URL('/resource/azpa-gwmk.json', SOURCE.origin);
SOURCE_API.search = new URLSearchParams({
    $select: 'impound_no,data_source,record_type,animal_type,date,date_type,state',
    $where: "data_source='Regional Animal Services of King County' AND record_type='FOUND' AND state='WA' AND animal_type IN ('Cat','Dog') AND date_type='Date Found'",
    $order: 'date DESC,impound_no ASC',
    $limit: '1',
});
const UNKNOWN = Object.freeze({ precision: 'UNKNOWN', value: null, timeZone: null });
const sha = text => createHash('sha256').update(text).digest('hex');

function prepare(row) {
    if (row?.data_source !== 'Regional Animal Services of King County' || row.state !== 'WA'
        || row.record_type !== 'FOUND' || row.date_type !== 'Date Found' || !['Cat', 'Dog'].includes(row.animal_type)
        || typeof row.impound_no !== 'string' || !/^[a-zA-Z0-9-]{1,32}$/.test(row.impound_no)) return null;
    const date = typeof row.date === 'string' && /^(\d{4}-\d{2}-\d{2})T00:00:00\.000$/.exec(row.date)?.[1];
    if (!date) return null;
    const midnight = new Date(`${date}T00:00:00Z`);
    if (!Number.isFinite(+midnight) || midnight.toISOString().slice(0, 10) !== date) return null;
    const { publisherId, datasetId } = SOURCE;
    const key = sha(JSON.stringify([publisherId, datasetId, row.impound_no]));
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

async function authorization() {
    const url = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.actions.githubusercontent.com')) throw Error('OIDC_RUNTIME_REQUIRED');
    url.searchParams.set('audience', AUDIENCE);
    const response = await request(url, {
        headers: { authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    });
    if (!response.ok) throw Error('OIDC_ISSUE_FAILED');
    const { value } = await response.json();
    if (typeof value !== 'string') throw Error('OIDC_ISSUE_FAILED');
    return `Bearer ${value}`;
}

async function main(mode) {
    if (!['verify', 'probe', 'submit'].includes(mode) || process.env.GITHUB_ACTIONS !== 'true'
        || process.env.GITHUB_TRIGGERING_ACTOR !== 'HankHuang0516'
        || (mode === 'submit' && !(Number(process.env.GITHUB_RUN_ATTEMPT) >= 2))) throw Error('AUTHORIZED_MANUAL_JOB_REQUIRED');
    const auth = await authorization();
    const verifySource = createSourceVerifier({ workflowSha: process.env.GITHUB_SHA });
    if (!await verifySource({ method: mode === 'submit' ? 'POST' : 'GET', headers: { authorization: auth } })) {
        throw Error('SIGNED_WORKFLOW_IDENTITY_REJECTED');
    }
    if (mode === 'verify') {
        console.log('OIDC_WORKFLOW_IDENTITY_VERIFIED');
        return;
    }
    if (mode === 'probe') {
        // A UUID v4 case ID cannot be all zeros. This exercises receipt storage without inserting a case.
        const url = `${AUDIENCE}/receipts/tip_${'0'.repeat(32)}`;
        const signed = await request(url, { headers: { authorization: auth } });
        const anonymous = await request(url);
        const cards = await request(`${AUDIENCE}/cards`);
        if (signed.status !== 404 || (await signed.json()).error !== 'NOT_FOUND'
            || anonymous.status !== 403 || (await anonymous.json()).error !== 'SOURCE_NOT_AUTHORIZED'
            || cards.status !== 503 || (await cards.json()).error !== 'PILOT_CLOSED') throw Error('PRODUCTION_IDENTITY_BOUNDARY_MISMATCH');
        console.log('OFFICIAL_IDENTITY_VERIFIED signed=404 anonymous=403 public=503');
        return;
    }

    const response = await request(SOURCE_API);
    if (!response.ok) throw Error('SOURCE_UNAVAILABLE');
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length > 1) throw Error('INVALID_SOURCE_RESPONSE');
    const candidate = prepare(rows[0]);
    if (!candidate) {
        console.log('MANUAL_CONFIRMATION_REQUIRED no case submitted');
        return;
    }
    const result = await request(`${AUDIENCE}/tips`, {
        method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/json', 'idempotency-key': candidate.key },
        body: JSON.stringify(candidate.payload),
    });
    if (result.status !== 202) throw Error(`INTAKE_HTTP_${result.status}`);
    const { success, receipt, replay } = await result.json();
    if (success !== true || receipt?.status !== 'PENDING' || receipt.publicVisible !== false
        || !/^tip_[a-f0-9]{32}$/.test(receipt.tipId) || typeof replay !== 'boolean') throw Error('PENDING_RECEIPT_REQUIRED');
    const read = await request(`${AUDIENCE}/receipts/${receipt.tipId}`, { headers: { authorization: auth } });
    const checked = read.ok && await read.json();
    if (checked?.success !== true || checked.receipt?.tipId !== receipt.tipId || checked.review !== 'PENDING'
        || checked.receipt.publicVisible !== false) throw Error('RECEIPT_READBACK_FAILED');
    console.log(JSON.stringify({ status: 'PENDING', publicVisible: false, replay, receipt: `masked-${sha(receipt.tipId).slice(0, 12)}` }));
}

if (require.main === module) {
    main(process.argv[2]).catch(error => {
        // The public workflow never emits raw upstream messages, responses, tokens, or source identifiers.
        const code = /^[A-Z0-9_]{1,70}$/.test(error.message) ? error.message : 'REQUEST_FAILED';
        console.error(code);
        process.exitCode = 1;
    });
}
module.exports = { prepare };
