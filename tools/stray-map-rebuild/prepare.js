'use strict';
// Isolated build preparation only. Does not execute source server/migrations/tests or read credentials.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { manifests, seedLock, compareProduction } = require('./prepare-lock');
const { safeURLs, stripMetadata } = require('./prepare-runtime-lock');
const VERSION = '22.23.3';
const hash = raw => createHash('sha256').update(raw).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file));
const write = (file, data) => fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
const BASE = '/Volumes/ProjectsData/portfolio-private-staging/';

function context(root) {
    root = path.resolve(root);
    if (!root.startsWith(BASE) || fs.realpathSync(root) !== root || fs.lstatSync(root).isSymbolicLink()) throw new Error('PRIVATE_EXISTING_ROOT_REQUIRED');
    const workspace = path.join(root, 'workspace'), toolchain = path.join(root, 'toolchain');
    const nodeDir = path.join(toolchain, `node-v${VERSION}-${process.platform}-${process.arch}`);
    const resultFile = path.join(root, 'PREPARE_RESULT.private.json');
    const result = fs.existsSync(resultFile) ? json(resultFile) : { kind: 'ISOLATED_RUNTIME_SUBSET_RECONSTRUCTION', signed: 'none',
        originalRestoration: false, productionEquivalent: false, paths: { root, workspace, toolchain },
        known: '54 baseline files individually hash checked; captured installed package versions and sanitized runtime hidden lock',
        rewritten: ['package.json', 'apps/api/package.json', 'packages/contracts/package.json', 'tsconfig.base.json', 'package-lock.json'],
        unknown: ['original root tsconfig', 'original root lock and complete original source', 'exact original dev tool resolution', 'original build pipeline and provenance signature'], stages: {} };
    result.readyForSyntheticIntegration = false;
    return { root, workspace, toolchain, nodeDir, node: path.join(nodeDir, 'bin/node'), npm: path.join(nodeDir, 'lib/node_modules/npm/bin/npm-cli.js'), resultFile, result };
}
function cleanEnv(ctx) {
    const home = path.join(ctx.root, 'empty-home'), tmp = path.join(ctx.root, 'tmp');
    fs.mkdirSync(home, { recursive: true, mode: 0o700 }); fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
    const globalConfig = path.join(home, 'empty-global.npmrc');
    if (!fs.existsSync(globalConfig)) fs.writeFileSync(globalConfig, '', { mode: 0o600, flag: 'wx' });
    return { PATH: `${path.dirname(ctx.node)}:/usr/bin:/bin`, HOME: home, TMPDIR: tmp,
        LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TZ: 'UTC',
        NPM_CONFIG_USERCONFIG: '/dev/null', NPM_CONFIG_GLOBALCONFIG: globalConfig,
        NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/', NPM_CONFIG_CACHE: path.join(ctx.root, 'npm-cache'),
        NPM_CONFIG_IGNORE_SCRIPTS: 'true', NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false', NPM_CONFIG_UPDATE_NOTIFIER: 'false' };
}
function run(ctx, name, command, args, cwd = ctx.workspace) {
    const p = spawnSync(command, args, { cwd, env: cleanEnv(ctx), encoding: 'utf8', timeout: 600000, maxBuffer: 8 * 1024 * 1024 });
    write(path.join(ctx.root, `${name}.log.private.txt`), `${p.stdout || ''}${p.stderr || ''}`);
    if (p.error || p.status !== 0) throw new Error(`${name}_FAILED_SEE_PRIVATE_LOG`);
    return (p.stdout || '').trim();
}
async function fetchBytes(url, max) {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !['nodejs.org', 'registry.npmjs.org'].includes(u.hostname) || u.username || u.password || u.search) throw new Error('PUBLIC_DOWNLOAD_ONLY');
    const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error(`PUBLIC_DOWNLOAD_HTTP_${r.status}`);
    const chunks = []; let length = 0;
    for await (const chunk of r.body) { length += chunk.length; if (length > max) throw new Error('DOWNLOAD_LIMIT'); chunks.push(Buffer.from(chunk)); }
    return Buffer.concat(chunks);
}
async function toolchain(ctx) {
    if (!['darwin', 'linux'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)) throw new Error('UNSUPPORTED_HOST');
    fs.mkdirSync(ctx.toolchain, { recursive: true, mode: 0o700 });
    const file = `node-v${VERSION}-${process.platform}-${process.arch}.tar.gz`, url = `https://nodejs.org/dist/v${VERSION}/`;
    const sums = await fetchBytes(`${url}SHASUMS256.txt`, 65536);
    const expected = sums.toString().split('\n').map(line => line.trim().split(/\s+/)).find(row => row[1] === file)?.[0];
    if (!/^[a-f0-9]{64}$/.test(expected || '')) throw new Error('OFFICIAL_SHA_NOT_FOUND');
    write(path.join(ctx.toolchain, 'SHASUMS256.txt'), sums.toString());
    const archive = path.join(ctx.toolchain, file);
    if (!fs.existsSync(archive)) fs.writeFileSync(archive, await fetchBytes(url + file, 100 * 1024 * 1024), { mode: 0o600, flag: 'wx' });
    if (hash(fs.readFileSync(archive)) !== expected) throw new Error('OFFICIAL_SHA_MISMATCH');
    if (!fs.existsSync(ctx.nodeDir)) run(ctx, 'toolchain-extract', '/usr/bin/tar', ['-xzf', archive, '-C', ctx.toolchain], ctx.root);
    const node = run(ctx, 'toolchain-node', ctx.node, ['--version'], ctx.root);
    const npm = run(ctx, 'toolchain-npm', ctx.node, [ctx.npm, '--version'], ctx.root);
    if (node !== `v${VERSION}` || npm !== '10.9.9') throw new Error('TOOLCHAIN_VERSION_MISMATCH');
    ctx.result.versions = { node, npm, platform: process.platform, arch: process.arch };
    ctx.result.toolchainEvidence = { source: url + file, sha256: expected, officialSHA256Matched: true, signatureVerified: false, signed: 'none' };
}
function workspace(ctx) {
    if (fs.existsSync(ctx.workspace)) throw new Error('WORKSPACE_ALREADY_EXISTS');
    const baseline = path.join(ctx.root, 'baseline'), capture = json(path.join(ctx.root, 'runtime-capture.private.json'));
    const manifest = json(path.join(ctx.root, 'BASELINE_MANIFEST.private.json'));
    for (const item of manifest.files) {
        if (!/^(?:apps\/api\/(?:src|migrations|content)\/[\w/.-]+|apps\/api\/(?:package|tsconfig)\.json|packages\/contracts\/[\w/.-]+|package\.json)$/.test(item.path)
            || item.path.split('/').includes('..') || item.path.includes('.env')) throw new Error('BASELINE_PATH_NOT_ALLOWED');
        const file = path.join(baseline, item.path);
        if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink() || hash(fs.readFileSync(file)) !== item.sha256) throw new Error('BASELINE_HASH_MISMATCH');
    }
    fs.mkdirSync(ctx.workspace, { mode: 0o700 });
    for (const item of manifest.files) { const target = path.join(ctx.workspace, item.path); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.copyFileSync(path.join(baseline, item.path), target, fs.constants.COPYFILE_EXCL); }
    const generated = manifests(baseline, capture);
    const rewrites = [['package.json', generated.root], ['apps/api/package.json', generated.api], ['packages/contracts/package.json', generated.contracts]];
    fs.mkdirSync(path.join(ctx.root, 'build-patches'), { recursive: true, mode: 0o700 });
    for (const [name, data] of rewrites) { write(path.join(ctx.workspace, name), data);
        const p = spawnSync('/usr/bin/diff', ['-u', path.join(baseline, name), path.join(ctx.workspace, name)], { encoding: 'utf8' });
        write(path.join(ctx.root, 'build-patches', `${name.replaceAll('/', '__')}.patch`), p.stdout); }
    const baseConfig = { _reconstruction: 'REWRITTEN_UNKNOWN_ORIGINAL', compilerOptions: { target: 'ES2022', module: 'ESNext',
        moduleResolution: 'Bundler', strict: true, esModuleInterop: true, skipLibCheck: true,
        resolveJsonModule: true, forceConsistentCasingInFileNames: true, noEmitOnError: true, types: ['node'] } };
    write(path.join(ctx.workspace, 'tsconfig.base.json'), baseConfig);
    write(path.join(ctx.root, 'build-patches/tsconfig.base.REWRITTEN_UNKNOWN_ORIGINAL.json'), baseConfig);
    write(path.join(ctx.workspace, '.npmrc'), 'registry=https://registry.npmjs.org/\nignore-scripts=true\naudit=false\nfund=false\n');
    write(path.join(ctx.workspace, 'package-lock.json'), seedLock(json(path.join(ctx.root, 'runtime-hidden-lock.raw.private.json')), generated));
    write(path.join(ctx.root, 'DEPENDENCY_SELECTION.private.json'), { ...generated, lockStatus: 'NEW_RECONSTRUCTION_LOCK_SEE_INSTALL_RESULT' });
    ctx.result.baselineFilesChecked = manifest.files.length;
    ctx.result.buildCommands = ['npm run build:contracts', 'npm run build:api'];
    ctx.result.devTools = { selection: generated.devSelection, originalExactVersions: 'UNKNOWN' };
    ctx.result.platformAdaptations = generated.hostNativeAdditions;
}
function install(ctx) { run(ctx, 'fresh-install', ctx.node, [ctx.npm, 'install', '--ignore-scripts', '--registry=https://registry.npmjs.org/', '--userconfig=/dev/null', '--no-audit', '--no-fund']); }
function codec(ctx) {
    const script = `const sharp=require('sharp'); (async()=>{const b=await sharp({create:{width:3,height:2,channels:3,background:{r:12,g:34,b:56}}}).png().toBuffer(); const m=await sharp(b).metadata(); if(m.width!==3||m.height!==2)throw Error('CODEC_ROUNDTRIP'); console.log(JSON.stringify({success:true,sharp:sharp.versions.sharp,vips:sharp.versions.vips,format:m.format,width:m.width,height:m.height,synthetic:true}));})().catch(e=>{console.error(e.message);process.exitCode=1;});`;
    return JSON.parse(run(ctx, 'sharp-host-codec', ctx.node, ['-e', script]));
}
function copyCIWorkspace(ctx) {
    const primary = ctx.workspace, target = path.join(ctx.root, 'workspace-ci');
    if (fs.existsSync(target)) throw new Error('CI_WORKSPACE_ALREADY_EXISTS');
    fs.mkdirSync(target, { mode: 0o700 });
    const files = json(path.join(ctx.root, 'BASELINE_MANIFEST.private.json')).files.map(item => item.path);
    const rewritten = new Set(['package.json', 'apps/api/package.json', 'packages/contracts/package.json']);
    for (const file of [...files, 'package-lock.json', 'tsconfig.base.json', '.npmrc']) {
        const source = rewritten.has(file) || !files.includes(file) ? path.join(primary, file) : path.join(ctx.root, 'baseline', file);
        const to = path.join(target, file); fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
        fs.copyFileSync(source, to, fs.constants.COPYFILE_EXCL);
    }
    ctx.result.paths.ciWorkspace = target;
    return target;
}
function build(ctx, label) {
    // Explicit build scripts only: never start, migrate, seed or execute source tests.
    ctx.result.actualBuildTools = Object.fromEntries(['apps/api', 'packages/contracts'].map(p => {
        const req = createRequire(path.join(ctx.workspace, p, 'package.json'));
        const file = req.resolve('typescript/package.json');
        const actual = json(file).version;
        if (actual !== '5.9.2') throw new Error('BUILD_TYPESCRIPT_SELECTION_MISMATCH');
        return [p, { typescript: actual, path: file }];
    }));
    for (const name of ['contracts', 'api']) run(ctx, `${label}-${name}`, ctx.node, [ctx.npm, 'run', `build:${name}`, '--ignore-scripts']);
}
function outputs(ctx) {
    const out = {};
    function walk(dir) { for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, item.name); if (item.isDirectory()) walk(file); else if (item.isFile()) out[path.relative(ctx.workspace, file)] = hash(fs.readFileSync(file));
    } }
    for (const dir of ['apps/api/dist', 'packages/contracts/dist']) walk(path.join(ctx.workspace, dir));
    return out;
}
function verify(ctx) {
    const capture = json(path.join(ctx.root, 'runtime-capture.private.json')), lock = json(path.join(ctx.workspace, 'package-lock.json'));
    const selection = json(path.join(ctx.root, 'DEPENDENCY_SELECTION.private.json'));
    ctx.result.platformAdaptations = selection.hostNativeAdditions;
    ctx.result.devTools = { selection: selection.devSelection, originalExactVersions: 'UNKNOWN' };
    ctx.result.dependencyEngineNotes = capture.packages.filter(item => item.name === 'nsfwjs').map(item => ({
        name: item.name, version: item.version, declared: item.engines, actualNode: ctx.result.versions.node,
        note: 'npm emits EBADENGINE for exact node 22.13.0 declaration; observed runtime and reconstruction use 22.23.3. Source model/runtime behavior is not validated by tsc or PNG codec.' }));
    const compare = compareProduction(ctx.workspace, capture, lock);
    compare.rebuilt = ctx.result.versions;
    write(path.join(ctx.root, 'PRODUCTION_DEPENDENCY_COMPARISON.private.json'), compare);
    const manifest = json(path.join(ctx.root, 'BASELINE_MANIFEST.private.json'));
    ctx.result.baselineFilesChecked = manifest.files.length;
    const remaining = manifest.files.filter(item => !ctx.result.rewritten.includes(item.path));
    if (!remaining.every(item => hash(fs.readFileSync(path.join(ctx.workspace, item.path))) === item.sha256)) throw new Error('UNCHANGED_BASELINE_DRIFT');
    ctx.result.baselineUnmodified = remaining.length;
    ctx.result.productionComparison = Object.fromEntries(['matched', 'mismatched', 'missing', 'platformOmitted', 'optionalOmitted', 'selectedDevelopmentChanges', 'added'].map(k => [k, compare[k].length]));
    ctx.result.productionComparison.integrityMatched = compare.integrityMatched;
    ctx.result.newLock = { sha256: hash(fs.readFileSync(path.join(ctx.workspace, 'package-lock.json'))), kind: 'NEW_RECONSTRUCTION_LOCK_NOT_ORIGINAL' };
    if (compare.mismatched.length || compare.missing.length) throw new Error('RUNTIME_PACKAGE_COMPARISON_DIFF_SEE_REPORT');
}
async function main(root, phase = 'all') {
    const ctx = context(root);
    const phases = phase === 'all' ? ['toolchain', 'workspace', 'install', 'fresh-primary', 'codec', 'build', 'ci', 'verify'] : [phase];
    for (const step of phases) {
        try {
            if (step === 'toolchain') await toolchain(ctx);
            else if (step === 'workspace') workspace(ctx);
            else if (step === 'build-config') {
                const generated = manifests(path.join(ctx.root, 'baseline'), json(path.join(ctx.root, 'runtime-capture.private.json')));
                for (const [name, data] of [['package.json', generated.root], ['apps/api/package.json', generated.api], ['packages/contracts/package.json', generated.contracts]]) {
                    write(path.join(ctx.workspace, name), data);
                    const p = spawnSync('/usr/bin/diff', ['-u', path.join(ctx.root, 'baseline', name), path.join(ctx.workspace, name)], { encoding: 'utf8' });
                    write(path.join(ctx.root, 'build-patches', `${name.replaceAll('/', '__')}.patch`), p.stdout);
                }
                write(path.join(ctx.root, 'DEPENDENCY_SELECTION.private.json'), generated);
                ctx.result.buildCommands = ['npm run build:contracts', 'npm run build:api'];
                ctx.result.platformAdaptations = generated.hostNativeAdditions;
                ctx.result.devTools = { selection: generated.devSelection, originalExactVersions: 'UNKNOWN' };
                write(path.join(ctx.root, 'build-patches/tsconfig.base.REWRITTEN_UNKNOWN_ORIGINAL.json'), json(path.join(ctx.workspace, 'tsconfig.base.json')));
            }
            else if (step === 'install') install(ctx);
            else if (step === 'fresh-primary') {
                if (!safeURLs(stripMetadata(json(path.join(ctx.workspace, 'package-lock.json'))))) throw new Error('UNSAFE_NEW_LOCK_URLS');
                run(ctx, 'primary-new-lock-ci', ctx.node, [ctx.npm, 'ci', '--ignore-scripts', '--registry=https://registry.npmjs.org/', '--userconfig=/dev/null', '--no-audit', '--no-fund']);
            }
            else if (step === 'codec') ctx.result.hostCodec = codec(ctx);
            else if (step === 'build') { build(ctx, 'first-build'); write(path.join(ctx.root, 'FIRST_BUILD_OUTPUTS.private.json'), outputs(ctx)); }
            else if (step === 'ci') {
                const primary = ctx.workspace;
                ctx.workspace = copyCIWorkspace(ctx);
                const before = hash(fs.readFileSync(path.join(ctx.workspace, 'package-lock.json')));
                run(ctx, 'new-lock-ci', ctx.node, [ctx.npm, 'ci', '--ignore-scripts', '--registry=https://registry.npmjs.org/', '--userconfig=/dev/null', '--no-audit', '--no-fund']);
                const hostCodec = codec(ctx);
                build(ctx, 'ci-build');
                const first = json(path.join(ctx.root, 'FIRST_BUILD_OUTPUTS.private.json')), second = outputs(ctx);
                const sameOutputs = JSON.stringify(first) === JSON.stringify(second), unchangedLock = before === hash(fs.readFileSync(path.join(ctx.workspace, 'package-lock.json')));
                ctx.result.reproducibility = { sameOutputs, unchangedLock, files: Object.keys(second).length, scriptsDuringInstall: false,
                    separateWorkspace: ctx.workspace, hostCodec };
                ctx.workspace = primary;
                if (!sameOutputs || !unchangedLock) throw new Error('CI_REPRODUCIBILITY_DIFF');
            } else if (step === 'verify') verify(ctx); else throw new Error('UNKNOWN_PREPARE_PHASE');
            ctx.result.stages[step] = { success: true, at: new Date().toISOString() };
            ctx.result.readyForSyntheticIntegration = ['toolchain', 'install', 'fresh-primary', 'codec', 'build', 'ci', 'verify']
                .every(name => ctx.result.stages[name]?.success === true) && ctx.result.reproducibility?.sameOutputs === true;
        } catch (error) { ctx.result.stages[step] = { success: false, error: error.message, at: new Date().toISOString() }; write(ctx.resultFile, ctx.result); throw error; }
        write(ctx.resultFile, ctx.result); console.log(JSON.stringify({ stage: step, success: true }));
    }
}
if (require.main === module) main(process.argv[2], process.argv[3]).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, context, cleanEnv, fetchBytes, outputs };
