'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { safeURLs } = require('./prepare-runtime-lock');

const DEV_SELECTION = Object.freeze({ '@types/node': '24.3.0', '@types/nodemailer': '8.0.1',
    '@types/pg': '8.15.5', tsx: '4.20.5', typescript: '5.9.2', vitest: '3.2.4' });
function resolveInstalled(packages, from, name) {
    let scope = from;
    while (scope) {
        const found = packages.find(item => item.path === `${scope}/node_modules/${name}`);
        if (found) return found;
        scope = scope.includes('/node_modules/') ? scope.slice(0, scope.lastIndexOf('/node_modules/')) : '';
    }
    return packages.find(item => item.path === `node_modules/${name}`);
}
function manifests(baseline, capture) {
    const read = p => JSON.parse(fs.readFileSync(path.join(baseline, p)));
    const api = read('apps/api/package.json'), contracts = read('packages/contracts/package.json');
    const pinned = {}, overrides = {};
    for (const pkg of capture.packages) {
        const edges = {};
        for (const name of Object.keys(pkg.dependencies || {})) {
            const installed = resolveInstalled(capture.packages, pkg.path, name);
            if (installed) edges[name] = installed.version;
        }
        if (Object.keys(edges).length) {
            const key = `${pkg.name}@${pkg.version}`;
            if (overrides[key] && JSON.stringify(overrides[key]) !== JSON.stringify(edges)) throw new Error('AMBIGUOUS_RUNTIME_EDGE');
            overrides[key] = edges;
        }
    }
    for (const [name, manifest] of [['api', api], ['contracts', contracts]]) {
        pinned[name] = {};
        for (const dep of Object.keys(manifest.dependencies)) {
            if (dep === '@stray-map/contracts') { manifest.dependencies[dep] = '0.1.0'; continue; }
            const installed = resolveInstalled(capture.packages, '', dep);
            if (!installed) throw new Error('DIRECT_DEPENDENCY_NOT_CAPTURED');
            manifest.dependencies[dep] = installed.version;
            pinned[name][dep] = installed.version;
        }
        manifest.devDependencies = Object.fromEntries(Object.keys(manifest.devDependencies || {}).map(dep => [dep, DEV_SELECTION[dep]]));
        if (Object.values(manifest.devDependencies).some(v => !v)) throw new Error('UNKNOWN_DEV_SELECTION');
    }
    const sharp = capture.packages.find(item => item.name === 'sharp');
    const nativeNames = process.platform === 'darwin' ? [`@img/sharp-darwin-${process.arch}`, `@img/sharp-libvips-darwin-${process.arch}`]
        : [`@img/sharp-linux-${process.arch}`, `@img/sharp-libvips-linux-${process.arch}`];
    const hostNativeAdditions = Object.fromEntries(nativeNames.map(name => {
        const version = sharp?.optionalDependencies?.[name];
        if (!version) throw new Error('HOST_NATIVE_VERSION_NOT_CAPTURED');
        return [name, version];
    }));
    // A Linux hidden lock does not enumerate Darwin optional tarballs. Select the captured sharp-declared host versions.
    api.optionalDependencies = hostNativeAdditions;
    // The original package main points at TS source outside API rootDir. Build a JS/declaration boundary first.
    contracts.main = 'dist/index.js'; contracts.types = 'dist/index.d.ts';
    const root = { name: 'stray-map-isolated-reconstruction', version: '0.1.0', private: true,
        description: 'UNSIGNED isolated runtime-subset reconstruction; not original restored source',
        workspaces: ['apps/api', 'packages/contracts'], engines: { node: '22.23.3', npm: '10.9.9' },
        packageManager: 'npm@10.9.9', scripts: {
            'build:contracts': 'npm exec --workspace @stray-map/contracts -- tsc -p tsconfig.json --noEmit false --declaration --module NodeNext --moduleResolution NodeNext --rootDir src --outDir dist',
            'build:api': 'npm run build --workspace @stray-map/api',
            build: 'npm run build:contracts && npm run build:api' }, overrides };
    return { root, api, contracts, pinned, hostNativeAdditions, devSelection: DEV_SELECTION,
        devExactOriginal: 'UNKNOWN; selected declared minimum versions, not claimed runtime-installed dev tools' };
}
function seedLock(hidden, generated) {
    if (hidden.lockfileVersion !== 3 || !safeURLs(hidden)) throw new Error('UNSAFE_RUNTIME_LOCK');
    const lock = structuredClone(hidden);
    lock.name = generated.root.name; lock.version = generated.root.version;
    lock.packages[''] = { name: generated.root.name, version: generated.root.version,
        workspaces: generated.root.workspaces, engines: generated.root.engines };
    for (const [location, manifest] of [['apps/api', generated.api], ['packages/contracts', generated.contracts]]) {
        lock.packages[location] = { name: manifest.name, version: manifest.version,
            dependencies: manifest.dependencies, devDependencies: manifest.devDependencies,
            ...(manifest.optionalDependencies ? { optionalDependencies: manifest.optionalDependencies } : {}) };
    }
    return lock;
}
function compareProduction(root, capture, lock) {
    const result = { runtime: { node: capture.node, platform: capture.platform, arch: capture.arch },
        rebuilt: { node: process.version, platform: process.platform, arch: process.arch },
        matched: [], mismatched: [], missing: [], platformOmitted: [], optionalOmitted: [], selectedDevelopmentChanges: [], integrityMatched: 0, added: [] };
    const hidden = JSON.parse(fs.readFileSync(path.join(root, '..', 'runtime-hidden-lock.raw.private.json')));
    const native = name => /^@img\/sharp-(?:libvips-)?(?:linux|darwin|win32|freebsd)/.test(name) || /^lightningcss-(?:linux|darwin|win32|freebsd)/.test(name);
    for (const pkg of capture.packages) {
        const file = path.join(root, pkg.path, 'package.json');
        if (!fs.existsSync(file)) {
            const row = { path: pkg.path, name: pkg.name, version: pkg.version }, prior = hidden.packages[pkg.path];
            if (native(pkg.name)) result.platformOmitted.push(row);
            else if (prior?.optional === true) result.optionalOmitted.push({ ...row, reason: 'RUNTIME_OPTIONAL_ENTRY_NOT_INSTALLED_BY_HOST_NPM; NOT_CLAIMED_IDENTICAL' });
            else if (prior?.devOptional === true && DEV_SELECTION[pkg.name]) result.selectedDevelopmentChanges.push({ ...row, newlySelected: DEV_SELECTION[pkg.name], reason: 'NEW_EXACT_DEVELOPMENT_SELECTION' });
            else result.missing.push(row);
            continue;
        }
        const actual = JSON.parse(fs.readFileSync(file));
        const row = { path: pkg.path, name: pkg.name, expected: pkg.version, actual: actual.version };
        (actual.name === pkg.name && actual.version === pkg.version ? result.matched : result.mismatched).push(row);
    }
    for (const [location, item] of Object.entries(lock.packages)) {
        const before = hidden.packages[location];
        if (before?.version === item.version && before.integrity && before.integrity === item.integrity) result.integrityMatched++;
        if (location && !before && fs.existsSync(path.join(root, location, 'package.json'))) result.added.push({ path: location, version: item.version, dev: item.dev === true, optional: item.optional === true });
    }
    return result;
}
module.exports = { manifests, seedLock, compareProduction, resolveInstalled, DEV_SELECTION };
