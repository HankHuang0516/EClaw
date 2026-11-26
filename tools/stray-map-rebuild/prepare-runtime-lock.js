'use strict';

// Read-only runtime dependency evidence. Never reads environment variables or application data.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { shellFor, runRailway } = require('../aihankapps-gifts/lib/adapters/transport');
const TARGET = Object.freeze({ projectId: '49ba58d4-291d-4203-bba8-deac8d1c3529',
    environment: '7f4b78c8-e894-4414-9f93-a296132374b2', service: 'fb890371-5405-44cf-817b-262899346b7e' });

function safeURLs(value) {
    if (typeof value === 'string' && (value.includes('://') || /^git@/.test(value))) {
        try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === 'registry.npmjs.org'
            && !u.username && !u.password && !u.search && !u.hash && !u.port; } catch { return false; }
    }
    if (Array.isArray(value)) return value.every(safeURLs);
    if (value && typeof value === 'object') return Object.entries(value).every(([key, v]) =>
        !/^(?:_authToken|password|authorization|_auth|secret)$/i.test(key)
        && (key !== 'resolved' || typeof v !== 'string' || /^https:\/\//.test(v) || ['apps/api', 'packages/contracts'].includes(v)) && safeURLs(v));
    return true;
}
function stripMetadata(value, counts = { metadataFieldsRemoved: 0 }) {
    if (Array.isArray(value)) return value.map(item => stripMetadata(item, counts));
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
        if (['funding', 'homepage', 'bugs', 'repository'].includes(key)) { counts.metadataFieldsRemoved++; continue; }
        out[key] = stripMetadata(item, counts);
    }
    return out;
}
function acquire(root) {
    root = path.resolve(root);
    if (!root.startsWith('/Volumes/ProjectsData/portfolio-private-staging/') || fs.realpathSync(root) !== root) throw new Error('PRIVATE_EXISTING_ROOT_REQUIRED');
    const output = path.join(root, 'runtime-hidden-lock.sanitized.private.json');
    if (fs.existsSync(output)) throw new Error('EVIDENCE_EXISTS');
    const script = `
const fs = require('node:fs'), crypto = require('node:crypto');
const safeURLs = ${safeURLs.toString()};
const stripMetadata = ${stripMetadata.toString()};
const file = '/app/node_modules/.package-lock.json';
if (!fs.existsSync(file)) { console.log('GIFT_RESULT ' + JSON.stringify({ available: false })); }
else {
 const s = fs.lstatSync(file);
 if (!s.isFile() || s.isSymbolicLink() || s.size > 8 * 1024 * 1024) throw new Error('UNSAFE_LOCK_FILE');
 const original = fs.readFileSync(file), counts = { metadataFieldsRemoved: 0 };
 const lock = stripMetadata(JSON.parse(original.toString('utf8')), counts);
 const raw = Buffer.from(JSON.stringify(lock, null, 2) + '\\n');
 if (!safeURLs(lock)) console.log('GIFT_RESULT ' + JSON.stringify({ available: true, rejectedUnsafeURLs: true }));
 else console.log('GIFT_RESULT ' + JSON.stringify({ available: true, path: file, bytes: raw.length,
   originalSha256: crypto.createHash('sha256').update(original).digest('hex'), counts,
   sha256: crypto.createHash('sha256').update(raw).digest('hex'), base64: raw.toString('base64'), lockfileVersion: lock.lockfileVersion }));
}`;
    const result = runRailway(TARGET, shellFor(script, ['/app']), { timeoutMs: 60000 });
    if (!result.value || result.exitCode !== 0) throw new Error('RUNTIME_LOCK_READ_FAILED');
    const value = result.value;
    if (value.base64) {
        const raw = Buffer.from(value.base64, 'base64');
        if (createHash('sha256').update(raw).digest('hex') !== value.sha256 || !safeURLs(JSON.parse(raw))) throw new Error('LOCK_VALIDATION_FAILED');
        fs.writeFileSync(path.join(root, 'runtime-hidden-lock.raw.private.json'), raw, { flag: 'wx', mode: 0o600 });
    }
    fs.writeFileSync(output, JSON.stringify({ ...value, base64: undefined, capturedAt: new Date().toISOString(),
        kind: 'RUNTIME_HIDDEN_LOCK_NOT_ORIGINAL_ROOT_LOCK', signed: 'none', target: TARGET }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { available: value.available, rejectedUnsafeURLs: value.rejectedUnsafeURLs || false, bytes: value.bytes, sha256: value.sha256 };
}
if (require.main === module) console.log(JSON.stringify(acquire(process.argv[2])));
module.exports = { acquire, safeURLs, stripMetadata };
