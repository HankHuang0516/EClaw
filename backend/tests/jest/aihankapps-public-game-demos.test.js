/**
 * Public read-only showcase (public.1) for the two original game plans
 * 《留燈協議》(keep-light) and 《明日返修所》(tomorrow-repair) under
 * /AiHankApps/demos/.
 *
 * Locks:
 * 1. The published tree is exactly the ten reviewed public.1 runtime files, byte for byte.
 * 2. The pages stay anonymous and read-only: no credentials, storage, network, admin or login flow.
 * 3. The existing public /AiHankApps static mount serves every runtime type with the portfolio
 *    cache policy, and the private /AiHankApps/admin-demos boundary stays reserved untouched.
 * 4. The shared rule module still produces the documented first-day outcomes.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const express = require('express');
const request = require('supertest');
const { setAiHankAppsCacheHeaders } = require('../../aihankapps-cache-policy');
const { retireFraudEmpireDemo, ROOTS: RETIRED_ROOTS } = require('../../fraud-empire-demo-retirement');

const backendDir = path.resolve(__dirname, '../..');
const portfolioDir = path.join(backendDir, 'public', 'AiHankApps');
const demosDir = path.join(portfolioDir, 'demos');
const PUBLIC_PREFIX = '/AiHankApps/demos';

// 2026-10-20 public.1 candidate: ten runtime files, fixed by SHA-256.
const PUBLIC1_FILES = {
    'keep-light/index.html': { bytes: 38448, sha256: '07e0758f72490284abf44d70d9fd778045b77b585a0088c7cf54e5d574356201' },
    'keep-light/app.mjs': { bytes: 7727, sha256: 'f1f30b6f5030066f7e6d45d8462d506d0540dd47291361c1745967ca5e4cb0b0' },
    'tomorrow-repair/index.html': { bytes: 30905, sha256: 'fc45f39fb4cb9c110c1bb017637f661bad7732b76b01fbdaf502c5fc3b672a82' },
    'tomorrow-repair/app.mjs': { bytes: 6427, sha256: '5fb53212ed33bbf2038ca8e583f6de9602176cc2b69a33fd06d7a9d48d15b3c4' },
    'style.css': { bytes: 6222, sha256: '30ad5a431e81f3115d5613aecec242dca289e522e629932cf1d72cf2b8a9beb9' },
    'rules.mjs': { bytes: 2035, sha256: '166854c99b10da5b43abd9f9ac05b37cd6b7f9a15ca7f6a6098372baabdb340a' },
    'experience.mjs': { bytes: 3661, sha256: 'e14ac2a50a9110b034f2b46977e0fe543dc7fd8235b92c337639c4714d06ee88' },
    'assets/hall.png': { bytes: 2795376, sha256: 'd450725fbf605fbdc4fba19fdae3b5c1d03ad2fee189a1f0f7ad507701c29496' },
    'assets/workshop.png': { bytes: 2523522, sha256: '33465690a653196f09140b7c6603eca2489bfdf5616098bf53aeb9278acbbd7d' },
    'audio/paper.wav': { bytes: 69164, sha256: '3f39c896f7a4e5ed1ba13ec0c4700a9963845639df6c44baeee41471371976bc' },
};

const PAGES = {
    'keep-light': { title: '留燈協議', version: '企劃 v1.2', image: 'hall.png' },
    'tomorrow-repair': { title: '明日返修所', version: '企劃 v1.2.1', image: 'workshop.png' },
};

const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const read = relative => fs.readFileSync(path.join(demosDir, relative));

function walk(dir, base = dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full, base));
        else out.push(path.relative(base, full).split(path.sep).join('/'));
    }
    return out.sort();
}

function buildPublicMount() {
    // Same chain as index.js: fraud-empire retirement guard, then the shared public static mount.
    const app = express();
    app.use(retireFraudEmpireDemo);
    app.use('/AiHankApps', express.static(portfolioDir, {
        etag: true,
        lastModified: true,
        setHeaders: setAiHankAppsCacheHeaders,
    }));
    return app;
}

function rawGet(app, url) {
    return request(app)
        .get(url)
        .buffer(true)
        .parse((res, callback) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => callback(null, Buffer.concat(chunks)));
        });
}

describe('AiHankApps public game demos (public.1)', () => {
    test('publishes exactly the ten reviewed public.1 runtime files, byte for byte', () => {
        expect(walk(demosDir)).toEqual(Object.keys(PUBLIC1_FILES).sort());
        for (const [relative, expected] of Object.entries(PUBLIC1_FILES)) {
            const buffer = read(relative);
            expect({ relative, bytes: buffer.length, sha256: sha256(buffer) })
                .toEqual({ relative, bytes: expected.bytes, sha256: expected.sha256 });
        }
    });

    test('both pages present themselves as the public.1 first-day showcase and link only relative runtime files', () => {
        for (const [slug, page] of Object.entries(PAGES)) {
            const html = read(`${slug}/index.html`).toString('utf8');
            expect(html).toContain('<html lang="zh-Hant">');
            expect(html).toContain(`<title>${page.title}｜企劃與首日互動</title>`);
            expect(html).toContain(page.version);
            expect(html).toContain('網頁展示 public.1');
            expect(html).toContain('此展示不代表完整遊戲已完成');
            expect(html).toContain('無帳號、無追蹤、無付款');
            expect(html).toContain('<link rel="stylesheet" href="../style.css">');
            expect(html).toContain(`<img src="../assets/${page.image}"`);
            expect(html).toContain('<script type="module" src="./app.mjs"></script>');
            // Only same-directory runtime files are loaded; plan text may cite URLs, but never as a resource.
            expect(html).not.toMatch(/(?:src|href)=["']https?:/i);
            expect(html).not.toMatch(/admin-demos|\/portal\/|login|botSecret|deviceSecret|\/Users\//i);
        }
    });

    test('runtime modules keep the demo in page memory only', () => {
        for (const relative of ['keep-light/app.mjs', 'tomorrow-repair/app.mjs', 'experience.mjs', 'rules.mjs']) {
            const source = read(relative).toString('utf8');
            expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|fetch\(|XMLHttpRequest|sendBeacon|WebSocket|document\.cookie|serviceWorker|import\(/);
            for (const match of source.matchAll(/^import\s.*?from\s*['"]([^'"]+)['"]/gm)) {
                expect(match[1]).toMatch(/^\.\.?\//);
            }
        }
    });

    test('the shared rule module still produces the documented first-day outcomes', () => {
        const rulesUrl = pathToFileURL(path.join(demosDir, 'rules.mjs')).href;
        const script = `
            import { dispatch, bench, rehearsal } from ${JSON.stringify(rulesUrl)};
            const valid = { site: 'ground', staff: ['hall', 'classroom'], plan: 'A', conclusion: 'scope', consents: [true, true, true] };
            const wired = { speed: 'slow', hood: false, wires: [true, true], jamRemoved: true };
            console.log(JSON.stringify({
                twoSite: dispatch(valid),
                oneSite: dispatch({ ...valid, plan: 'B', staff: ['hall', 'standby'] }),
                rejected: [
                    dispatch({ ...valid, site: 'basement' }).ok,
                    dispatch({ ...valid, staff: ['hall', 'hall'] }).ok,
                    dispatch({ ...valid, conclusion: 'bribe' }).ok,
                    dispatch({ ...valid, consents: [true, false, true] }).ok,
                    dispatch({ ...valid, plan: 'B', staff: ['hall', 'classroom'] }).ok,
                ],
                slowBench: bench(wired),
                fastHooded: bench({ ...wired, speed: 'fast', hood: true }),
                benchRejected: [
                    bench({ ...wired, speed: 'fast' }).ok,
                    bench({ ...wired, wires: [true, false] }).ok,
                    bench({ ...wired, jamRemoved: false }).ok,
                ],
                rehearsalRejected: [
                    rehearsal({ pace: 'balanced', clearExit: false }).ok,
                    rehearsal({ pace: 'long', clearExit: true }).ok,
                ],
                shortRevenue: rehearsal({ pace: 'short', clearExit: true }).revenue,
                balancedRevenue: rehearsal({ pace: 'balanced', clearExit: true }).revenue,
            }));
        `;
        const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));

        expect(result.twoSite).toMatchObject({ ok: true, tonight: 18, tomorrow: 0, spent: 2 });
        expect(result.oneSite).toMatchObject({ ok: true, tonight: 12, reserved: 1, balance: 0 });
        expect(result.rejected).toEqual([false, false, false, false, false]);
        expect(result.slowBench).toMatchObject({ ok: true, seconds: 2.4 });
        expect(result.fastHooded).toMatchObject({ ok: true, slots: 5, noise: 35 });
        expect(result.benchRejected).toEqual([false, false, false]);
        expect(result.rehearsalRejected).toEqual([false, false]);
        expect(result.shortRevenue).toBe(60);
        expect(result.balancedRevenue).toBe(90);
    });

    test('the public portfolio mount serves both pages anonymously with revalidating HTML', async () => {
        const app = buildPublicMount();
        for (const [slug, page] of Object.entries(PAGES)) {
            const response = await request(app).get(`${PUBLIC_PREFIX}/${slug}/`);
            expect(response.status).toBe(200);
            expect(response.headers['content-type']).toMatch(/text\/html/);
            expect(response.headers['cache-control']).toBe('no-store, no-cache, max-age=0, must-revalidate');
            expect(response.headers['cdn-cache-control']).toBe('no-store');
            expect(response.headers['cloudflare-cdn-cache-control']).toBe('no-store');
            expect(response.headers['x-fraud-empire-demo']).toBeUndefined();
            expect(response.text).toContain(page.title);
            expect(sha256(Buffer.from(response.text, 'utf8'))).toBe(PUBLIC1_FILES[`${slug}/index.html`].sha256);

            const bare = await request(app).get(`${PUBLIC_PREFIX}/${slug}`);
            expect(bare.status).toBe(301);
            expect(bare.headers.location).toBe(`${PUBLIC_PREFIX}/${slug}/`);
        }
    });

    test('every runtime type is served byte-exact with the portfolio cache policy', async () => {
        const app = buildPublicMount();
        const expectations = [
            ['keep-light/app.mjs', /javascript/, 'public, max-age=600, must-revalidate'],
            ['tomorrow-repair/app.mjs', /javascript/, 'public, max-age=600, must-revalidate'],
            ['rules.mjs', /javascript/, 'public, max-age=600, must-revalidate'],
            ['experience.mjs', /javascript/, 'public, max-age=600, must-revalidate'],
            ['style.css', /text\/css/, 'public, max-age=600, must-revalidate'],
            ['assets/hall.png', /image\/png/, 'public, max-age=604800, immutable'],
            ['assets/workshop.png', /image\/png/, 'public, max-age=604800, immutable'],
            ['audio/paper.wav', /audio\/(?:x-)?wav/, 'public, max-age=604800, immutable'],
        ];
        for (const [relative, type, cacheControl] of expectations) {
            const response = await rawGet(app, `${PUBLIC_PREFIX}/${relative}`);
            expect(response.status).toBe(200);
            expect(response.headers['content-type']).toMatch(type);
            expect(response.headers['cache-control']).toBe(cacheControl);
            expect(response.body.length).toBe(PUBLIC1_FILES[relative].bytes);
            expect(sha256(response.body)).toBe(PUBLIC1_FILES[relative].sha256);
        }
        const missing = await request(app).get(`${PUBLIC_PREFIX}/qa/result.json`);
        expect(missing.status).toBe(404);
    });

    test('index.js keeps the private admin-demos reservation ahead of the shared public mount', () => {
        const source = fs.readFileSync(path.join(backendDir, 'index.js'), 'utf8');
        const privateMount = source.indexOf("app.use('/AiHankApps/admin-demos'");
        const publicMount = source.indexOf("app.use('/AiHankApps', express.static");
        expect(privateMount).toBeGreaterThan(-1);
        expect(publicMount).toBeGreaterThan(privateMount);
        // The public demos ride the shared static mount; no bespoke route, no auth bypass to add.
        expect(source).not.toContain(`'${PUBLIC_PREFIX}`);
        for (const root of RETIRED_ROOTS) {
            expect(`${PUBLIC_PREFIX}/keep-light/`.startsWith(root)).toBe(false);
        }
    });
});
