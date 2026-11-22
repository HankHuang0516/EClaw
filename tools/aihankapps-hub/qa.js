#!/usr/bin/env node
'use strict';
// Private operator bridge. Upload URLs and cloud credentials never enter logs.
const fs = require('fs');
const crypto = require('crypto');
const { runRailway } = require('../aihankapps-gifts/lib/adapters/transport');
const { HUB, containerScript } = require('./triage');
function remote(request) {
    const r = runRailway(HUB, containerScript('aihankapps-hub-qa.js', request), { timeoutMs: 60000 });
    if (!r.value || !r.value.success) throw new Error(r.value && r.value.error || 'QA_REMOTE_FAILED');
    return r.value;
}
async function main(argv = process.argv.slice(2)) {
    const [action, file] = argv;
    if (action === 'read') return remote({ action, after: file || '0' });
    if (!['upload', 'publish', 'result'].includes(action) || !file) throw new Error('Usage: qa.js upload FILES.json | publish BATCH.json | read AFTER_ID | result RESULT.json');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (action === 'publish') return remote({ action, batch: value });
    if (action === 'result') return remote({ ...value, action });
    if (!Array.isArray(value) || value.length !== 10 || new Set(value.map(v => v.item)).size !== 10) throw new Error('QA_UPLOAD_LIST');
    const receipts = [];
    for (const v of value) {
        const bytes = fs.readFileSync(v.path);
        if (!/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii')) || bytes.length !== v.size || crypto.createHash('sha256').update(bytes).digest('hex') !== v.sha256) throw new Error('QA_LOCAL_CHANGED');
        const answer = remote({ action: 'prepare-media', item: v.item, sha256: v.sha256, size: bytes.length });
        const url = new URL(answer.media.url);
        if (url.protocol !== 'https:' || !url.hostname.endsWith('.r2.cloudflarestorage.com')) throw new Error('QA_UPLOAD_ORIGIN');
        const sent = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'image/gif' }, body: bytes, signal: AbortSignal.timeout(60000) });
        if (!sent.ok) throw new Error('QA_UPLOAD_HTTP_' + sent.status);
        receipts.push({ item: v.item, sha256: v.sha256, bytes: bytes.length, uploaded: true });
        process.stderr.write('Uploaded GIF ' + v.item + '\n');
    }
    return { success: true, receipts, note: 'Upload only; publish verifies every cloud GIF against the declared original before exposing the review.' };
}
if (require.main === module) main().then(v => process.stdout.write(JSON.stringify(v) + '\n')).catch(e => { process.stderr.write(JSON.stringify({ success: false, error: /^[A-Z0-9_]+$/.test(e.message) ? e.message : 'QA_OPERATOR_FAILED' }) + '\n'); process.exitCode = 1; });
module.exports = { main, remote };
