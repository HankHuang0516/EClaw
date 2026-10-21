'use strict';

/**
 * Petdx grid performance + avatar-picker entry (Hank 2026-10-21).
 *
 * Root cause of "Petdx 伙伴瀏覽器 webview 很卡": every one of the 60 grid
 * cards ran its own rAF loop and drawImage()'d a full 1536×1872 spritesheet
 * (~11.5 MB decoded) on every display refresh. That overflowed the decoded-
 * image budget → sheets re-decoded on the main thread → <1 fps under a 4×
 * CPU-throttled mobile profile (measured: 0.4 fps idle, 5.1 s of long tasks
 * per 4 s window). Fix, locked here:
 *   1. renderer repaints a spritesheet canvas only when the frame changes;
 *   2. frames are blitted from a small pre-scaled strip cut ONCE per sheet;
 *   3. the emoji fallback is painted once, not every frame;
 *   4. the browser grid only creates/animates cards near the viewport and
 *      only probes (downloads) sprites for cards that became visible.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const RENDERER_PATH = path.join(ROOT, 'public', 'shared', 'petdx-renderer.js');

// ── Fake browser primitives (jest env is node) ──────────────────────────
function makeCtx(label, log) {
    return {
        label,
        imageSmoothingEnabled: true,
        clearRect: jest.fn(),
        save: jest.fn(), restore: jest.fn(),
        fillRect: jest.fn(), beginPath: jest.fn(), arc: jest.fn(), fill: jest.fn(),
        fillText: jest.fn(),
        drawImage: jest.fn((src, ...args) => log.push({ on: label, src, args })),
        fillStyle: '', font: '', textAlign: '', textBaseline: '',
    };
}

let rafQueue;
let images;
let drawLog;
let stripCanvases;
let nowMs;

beforeEach(() => {
    rafQueue = [];
    images = [];
    drawLog = [];
    stripCanvases = [];
    nowMs = 0;
    global.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
    global.cancelAnimationFrame = () => {};
    jest.spyOn(performance, 'now').mockImplementation(() => nowMs);
    global.Image = class {
        constructor() { this.onload = null; this.onerror = null; images.push(this); }
        set src(v) { this._src = v; }
        get src() { return this._src; }
    };
    global.document = {
        createElement: (tag) => {
            if (tag !== 'canvas') throw new Error('unexpected element ' + tag);
            const c = { width: 0, height: 0 };
            const ctx = makeCtx('strip', drawLog);
            c.getContext = () => ctx;
            stripCanvases.push(c);
            return c;
        },
    };
});

afterEach(() => {
    jest.restoreAllMocks();
    delete global.document;
    delete global.Image;
});

// Fresh module per test so the sprite/strip caches don't leak between cases.
function loadRenderer() {
    let mod;
    jest.isolateModules(() => { mod = require(RENDERER_PATH); });
    return mod;
}

// Run one rAF frame at time `t` ms.
function frameAt(t) {
    nowMs = t;
    const q = rafQueue;
    rafQueue = [];
    q.forEach(cb => cb(t));
}

const IDLE_FRAMES = [280, 110, 110, 140, 140, 320];
function spriteDescriptor(url) {
    return {
        id: 'petdx-' + url,
        name: 'Feili',
        assetType: 'spritesheet',
        kind: 'pet',
        asset: {
            url, cols: 8, rows: 9, frameWidth: 192, frameHeight: 208,
            animations: { idle: { row: 0, frames: IDLE_FRAMES }, failed: { row: 5, count: 8, dur: 140, last: 240 } },
        },
        supportedStates: ['IDLE', 'BUSY'],
        stateAssets: { IDLE: { animation: 'idle', loop: true }, BUSY: { animation: 'failed', loop: true } },
    };
}

function makeCardCanvas(size = 200) {
    const ctx = makeCtx('card', drawLog);
    return { canvas: { width: size, height: size, getContext: () => ctx }, ctx };
}

function startSprite(R, url, size) {
    const { canvas, ctx } = makeCardCanvas(size);
    const r = R.createRenderer({ canvas, descriptor: spriteDescriptor(url), state: 'IDLE' });
    r.start();
    return { r, ctx };
}

describe('petdx-renderer spritesheet repaint budget', () => {
    test('repaints only when the frame index changes, not every rAF tick', () => {
        const R = loadRenderer();
        const { ctx } = startSprite(R, '/s/a.webp');
        frameAt(0);
        images[0].onload();

        // 60 Hz for the first 280 ms = idle frame 0 the whole time.
        for (let t = 16; t < 280; t += 16) frameAt(t);
        expect(ctx.drawImage).toHaveBeenCalledTimes(1);

        frameAt(290); // → frame 1 (280..390)
        expect(ctx.drawImage).toHaveBeenCalledTimes(2);
        frameAt(300);
        frameAt(380);
        expect(ctx.drawImage).toHaveBeenCalledTimes(2);
    });

    test('cuts the animation row out of the big sheet once and blits from the strip', () => {
        const R = loadRenderer();
        const { ctx } = startSprite(R, '/s/b.webp');
        frameAt(0);
        images[0].onload();
        for (let t = 0; t < 2400; t += 16) frameAt(t); // > two full idle loops

        const sheet = images[0];
        const sheetDraws = drawLog.filter(d => d.src === sheet);
        // One copy per idle frame into the strip, never again.
        expect(sheetDraws).toHaveLength(IDLE_FRAMES.length);
        expect(sheetDraws.every(d => d.on === 'strip')).toBe(true);
        // Card canvas only ever reads the strip, never the full sheet.
        expect(ctx.drawImage.mock.calls.every(c => c[0] === stripCanvases[0])).toBe(true);

        // Strip = 6 frames × 192 px wide (200/208 scale → 185×200 cell).
        expect(stripCanvases[0].height).toBe(200);
        expect(stripCanvases[0].width).toBe(185 * IDLE_FRAMES.length);
        // Frame 0 source rect + centred integer destination.
        expect(ctx.drawImage.mock.calls[0].slice(1)).toEqual([0, 0, 185, 200, 8, 0, 185, 200]);
    });

    test('second card on the same sheet and size reuses the strip', () => {
        const R = loadRenderer();
        startSprite(R, '/s/c.webp');
        frameAt(0);
        images[0].onload();
        frameAt(16);
        const { ctx: ctx2 } = startSprite(R, '/s/c.webp');
        frameAt(32);
        expect(stripCanvases).toHaveLength(1);
        expect(ctx2.drawImage).toHaveBeenCalledTimes(1);
        expect(ctx2.drawImage.mock.calls[0][0]).toBe(stripCanvases[0]);
    });

    test('failed sprite paints the emoji fallback once, not every frame', () => {
        const R = loadRenderer();
        const { ctx } = startSprite(R, '/s/broken.png');
        frameAt(0);
        images[0].onerror();
        for (let t = 16; t < 1000; t += 16) frameAt(t);
        expect(ctx.fillRect).toHaveBeenCalledTimes(1);
        expect(ctx.fillText).toHaveBeenCalledTimes(2); // emoji + name-initial badge, once
    });

    test('holds the canvas clear (no repeated work) until the sheet is ready', () => {
        const R = loadRenderer();
        const { ctx } = startSprite(R, '/s/slow.webp');
        for (let t = 0; t < 500; t += 16) frameAt(t);
        expect(ctx.clearRect).toHaveBeenCalledTimes(1);
        expect(ctx.drawImage).not.toHaveBeenCalled();
    });

    test('setState repaints immediately with the new animation row', () => {
        const R = loadRenderer();
        const { r, ctx } = startSprite(R, '/s/d.webp');
        frameAt(0);
        images[0].onload();
        frameAt(16);
        expect(ctx.drawImage).toHaveBeenCalledTimes(1);
        r.setState('BUSY');
        frameAt(32);
        expect(ctx.drawImage).toHaveBeenCalledTimes(2);
        // BUSY → `failed` animation row 5: a second strip for that row.
        expect(stripCanvases).toHaveLength(2);
        const rowCopies = drawLog.filter(d => d.on === 'strip' && d.args[1] === 5 * 208);
        expect(rowCopies).toHaveLength(8);
    });

    test('stop() then start() repaints the current frame', () => {
        const R = loadRenderer();
        const { r, ctx } = startSprite(R, '/s/e.webp');
        frameAt(0);
        images[0].onload();
        frameAt(16);
        r.stop();
        r.start();
        frameAt(32);
        expect(ctx.drawImage).toHaveBeenCalledTimes(2);
    });

    test('without a DOM it still draws straight from the sheet (old path)', () => {
        delete global.document;
        const R = loadRenderer();
        const { ctx } = startSprite(R, '/s/f.webp');
        frameAt(0);
        images[0].onload();
        frameAt(16);
        frameAt(32);
        expect(ctx.drawImage).toHaveBeenCalledTimes(1);
        expect(ctx.drawImage.mock.calls[0][0]).toBe(images[0]);
        expect(ctx.drawImage.mock.calls[0].slice(1, 5)).toEqual([0, 0, 192, 208]);
    });

    test('procedural companions keep animating every fps tick', () => {
        const R = loadRenderer();
        const { canvas, ctx } = makeCardCanvas(200);
        const r = R.createRenderer({
            canvas,
            descriptor: {
                id: 'proc', assetType: 'procedural', asset: { renderer: 'fallback-blob', params: {} },
                supportedStates: ['IDLE'], stateAssets: { IDLE: { fps: 4, loop: true } },
            },
        });
        r.start();
        for (let t = 0; t <= 1040; t += 16) frameAt(t);
        // 4 fps throttle (unchanged): frames at 256, 512, 768, 1024 ms.
        expect(ctx.clearRect).toHaveBeenCalledTimes(4);
    });
});

describe('petdx-browser grid only animates cards near the viewport', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'petdx-browser.html'), 'utf8');

    test('uses an IntersectionObserver to start/stop card renderers', () => {
        expect(html).toMatch(/new IntersectionObserver\(onCardVisibility/);
        expect(html).toMatch(/if \(entry\.isIntersecting\) activateCard\(node\)/);
        expect(html).toMatch(/node\._petdxRenderer\.stop\(\)/);
    });

    test('renderCardNode defers renderer creation to scheduleCard', () => {
        const body = html.slice(html.indexOf('function renderCardNode('), html.indexOf('function rendererKeyFromCard('));
        expect(body).toMatch(/scheduleCard\(div, canvas, descriptor, onFirstVisible\)/);
        expect(body).not.toMatch(/PetdxRenderer\.createRenderer/);
    });

    test('sprite load-failure probe only fires once a card is visible', () => {
        expect(html).toMatch(/demoteOnLoadFail \? \(\) => setupLoadDemotion\(node, card, grid\) : null/);
        expect(html).toMatch(/if \(pending\.onFirstVisible\) pending\.onFirstVisible\(\)/);
    });

    test('teardown disconnects the observer before clearing the grid', () => {
        expect(html).toMatch(/function tearDownRenderers\(\) \{\s*if \(cardObserver\) cardObserver\.disconnect\(\);/);
    });

    test('falls back to immediate (deferred) activation without IntersectionObserver', () => {
        expect(html).toMatch(/else Promise\.resolve\(\)\.then\(\(\) => activateCard\(node\)\)/);
    });
});

describe('avatar picker → Petdx Companion Browser entry', () => {
    const dash = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'dashboard.html'), 'utf8');
    const i18nSrc = fs.readFileSync(path.join(ROOT, 'public', 'shared', 'i18n.js'), 'utf8');

    test('picker renders the entry button with i18n labels', () => {
        const body = dash.slice(dash.indexOf('function openAvatarPicker('), dash.indexOf('// Handle emoji selection'));
        expect(body).toMatch(/id="avatarPetdxEntry"/);
        expect(body).toMatch(/data-i18n="dash_avatar_petdx"/);
        expect(body).toMatch(/data-i18n="dash_avatar_petdx_hint"/);
    });

    test('entry opens the browser scoped to the clicked entity', () => {
        expect(dash).toMatch(/window\.location\.href = 'petdx-browser\.html\?entityId=' \+ encodeURIComponent\(entityId\)/);
    });

    test('both labels exist in all 15 full locales', () => {
        expect(i18nSrc.match(/"dash_avatar_petdx":/g)).toHaveLength(15);
        expect(i18nSrc.match(/"dash_avatar_petdx_hint":/g)).toHaveLength(15);
    });
});
