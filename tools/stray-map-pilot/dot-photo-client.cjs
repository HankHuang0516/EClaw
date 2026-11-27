#!/usr/bin/env node
'use strict';

const { randomBytes } = require('node:crypto');
const { execFile } = require('node:child_process');
const { open } = require('node:fs/promises');
const { constants } = require('node:fs');
const { setTimeout: pause } = require('node:timers/promises');
const { AUDIENCE, REPOSITORY } = require('./dot-identity.cjs');
const { BODY_LIMIT, sha, validatePhotoSubmission } = require('./photo-contract.cjs');
const { parseBody } = require('../stray-map-intake/contract');

function makeHandoff(raw) {
    if (!Buffer.isBuffer(raw) || !raw.length || raw.length > BODY_LIMIT) throw Error('PHOTO_BODY_LIMIT');
    const id = randomBytes(16).toString('hex'), proof = randomBytes(32).toString('hex');
    const digest = sha(Buffer.concat([Buffer.from(proof, 'hex'), raw]));
    return { id, proof, branch: `dot-photo-submit/v1/${id}.${sha(proof)}.${digest}` };
}

function validateManifest(raw, at) {
    const parsed = parseBody(raw, 'application/json', 'identity', BODY_LIMIT);
    if (!parsed.success) throw Error(parsed.error);
    const item = parsed.value;
    if (item && typeof item === 'object' && Object.keys(item).length === 1 && /^photo_[a-f0-9]{32}$/.test(item.withdrawId || '')) return null;
    const key = item?.tip?.source?.recordKey;
    const authorized = validatePhotoSubmission(raw, { now: at, key });
    if (!authorized.success) throw Error(authorized.error);
    return key;
}

function trigger(branch, shaToRun) {
    return new Promise((resolve, reject) => {
        const child = execFile('gh', ['api', '--method', 'POST', `repos/${REPOSITORY}/git/refs`, '--input', '-'],
            { timeout: 25000 }, error => error ? reject(Error('GITHUB_CREATE_RUN_FAILED')) : resolve());
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify({ ref: 'refs/heads/' + branch, sha: shaToRun }));
    });
}

async function deliver(raw, workflowSha, { createBranch = trigger, request = fetch, clock = Date.now, wait = pause } = {}) {
    if (!/^[a-f0-9]{40}$/.test(workflowSha || '')) throw Error('PHOTO_WORKFLOW_PIN_REQUIRED');
    const key = validateManifest(raw, new Date(clock()).toISOString());
    const { id, proof, branch } = makeHandoff(raw);
    const url = `${AUDIENCE}/photo-handoffs/${id}`;
    const headers = { 'X-Photo-Handoff-Proof': proof };
    const call = (target, options = {}) => request(target, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
    await createBranch(branch, workflowSha);

    const openingDeadline = clock() + 150000;
    let openState;
    while (clock() < openingDeadline) {
        const response = await call(url, { headers });
        if (response.ok) { openState = await response.json(); break; }
        if (![404, 429, 503].includes(response.status)) throw Error('PHOTO_HANDOFF_LOOKUP_' + response.status);
        await wait(2500);
    }
    if (openState?.status !== 'OPEN' || !Number.isFinite(Date.parse(openState.expiresAt))) throw Error('PHOTO_HANDOFF_NEVER_OPENED');
    const metadata = { ...headers, 'content-type': 'application/json', ...(key && { 'idempotency-key': key }) };
    let staged;
    try { staged = await call(url + '/content', { method: 'PUT', headers: metadata, body: raw }); }
    catch (_) {
        // Retry only under the same commitment. The publication transaction is never restarted.
        staged = await call(url + '/content', { method: 'PUT', headers: metadata, body: raw });
    }
    if (staged.status === 200) {
        const result = await staged.json();
        if (result.success === true && /^photo_[a-f0-9]{32}$/.test(result.receipt?.id)) return result;
        if (/^[A-Z0-9_]{1,100}$/.test(result.error || '')) throw Error(result.error);
    }
    if (staged.status !== 202) throw Error('PHOTO_HANDOFF_STAGE_' + staged.status);
    while (clock() < Date.parse(openState.expiresAt)) {
        const response = await call(url, { headers });
        if (response.ok) {
            const data = await response.json();
            if (data.success === true && /^photo_[a-f0-9]{32}$/.test(data.receipt?.id)) return data;
            if (data.success === false && /^[A-Z0-9_]{1,100}$/.test(data.error || '')) throw Error(data.error);
        } else if (![404, 429, 503].includes(response.status)) throw Error('PHOTO_HANDOFF_RESULT_' + response.status);
        await wait(2500);
    }
    throw Error('PHOTO_HANDOFF_RECEIPT_UNCONFIRMED');
}

async function main() {
    if (process.argv.length !== 5 || process.argv[2] !== '--submit-verified') throw Error('EXPECTED_SUBMIT_VERIFIED_FILE_AND_WORKFLOW_SHA');
    const input = await open(process.argv[3], constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const file = await input.stat();
        if (!file.isFile() || file.size < 1 || file.size > BODY_LIMIT || (file.mode & 0o077) !== 0) throw Error('PRIVATE_BOUNDED_MANIFEST_REQUIRED');
        const raw = await input.readFile();
        const result = await deliver(raw, process.argv[4]);
        console.log(JSON.stringify(result));
    } finally { await input.close(); }
}

if (require.main === module) main().catch(error => {
    console.error(/^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : 'PHOTO_HANDOFF_FAILED');
    process.exitCode = 1;
});
module.exports = { makeHandoff, deliver };
