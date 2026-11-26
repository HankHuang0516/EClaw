'use strict';
// Small synthetic boundary checks. No Railway, registry, filesystem mutation, or application imports.
const assert = require('node:assert/strict');
const { safeURLs, stripMetadata } = require('./prepare-runtime-lock');
const { resolveInstalled } = require('./prepare-lock');
let checks = 0;
function check(value, expected) { assert.equal(value, expected); checks++; }
check(safeURLs({ resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz' }), true);
for (const value of ['https://user:synthetic@registry.npmjs.org/a', 'https://example.invalid/a',
    'git+ssh://git@example.invalid/a', 'file:///synthetic/nonexistent']) check(safeURLs({ resolved: value }), false);
check(safeURLs(stripMetadata({ funding: { url: 'https://example.invalid/fund' },
    resolved: 'https://registry.npmjs.org/a/-/a.tgz' })), true);
check(safeURLs({ _authToken: 'synthetic_not_a_secret' }), false);
check(safeURLs({ 'node_modules/token-types': { version: '1.0.0' } }), true);
const packages = [{ path: 'node_modules/x', version: '1' }, { path: 'node_modules/a/node_modules/x', version: '2' }];
check(resolveInstalled(packages, 'node_modules/a', 'x').version, '2');
check(resolveInstalled(packages, 'node_modules/z', 'x').version, '1');
console.log(JSON.stringify({ success: true, synthetic: true, boundaryChecks: checks, networkRequests: 0, sourceExecutions: 0 }));
