require('./helpers/mock-setup');
jest.mock('crypto', () => {
    const actual = jest.requireActual('crypto'); const state = { mapChecks: 0 };
    return { ...actual, adapterTestState: state, createHash: algorithm => {
        const real = actual.createHash(algorithm); const chunks = [];
        const wrapper = { update(value) { chunks.push(Buffer.from(value)); real.update(value); return wrapper; }, digest(encoding) {
            if (Buffer.concat(chunks).includes(Buffer.from('SYNTHETIC ADAPTER RECEIPT'))) {
                state.mapChecks++;
                return 'ecbd4d995be28a4555f622b0ac09e2c4d2d351d2ae9aa19ad76400d7083c0893';
            }
            return real.digest(encoding);
        } }; return wrapper;
    } };
});
const express = require('express');
const request = require('supertest');
const vm = require('vm');
const { newDb } = require('pg-mem');
const crypto = require('crypto');
const { adaptDemoMap, ADAPTATION_VERSION, NOTICE } = require('../../taaze-demo-map-adapter');
const { createRouters, DEMO_ID, SOURCE_SHA256 } = require('../../taaze-demo-share');
const SYNTHETIC_MAP = Buffer.from("(()=>{const status=document.querySelector('#map-status');const center=[42,43];let active=null,marker=null;const map=L.map('map',{scrollWheelZoom:false}).setView(center,13);window.demoMap=map;const tiles=L.tileLayer('https://tile.invalid/{z}/{x}/{y}.png').addTo(map);setTimeout(()=>{status.hidden=true},10000);const select=index=>{window.selected=index;};window.selectDemoMap=select;/* SYNTHETIC ADAPTER RECEIPT */})();");
async function setup() {
    const db = newDb({ noAstCoverageCheck: true });
    db.public.registerFunction({ name: 'pg_advisory_xact_lock', args: ['integer'], returns: 'integer', implementation: () => 1 });
    const { Pool } = db.adapters.createPg(); const pool = new Pool();
    const auth = { authMiddleware: (_req, res) => res.sendStatus(401), adminMiddleware: (_req, res) => res.sendStatus(403) };
    const routers = createRouters(() => pool, auth); const app = express();
    app.use('/AiHankApps/taaze-demo', routers.publicRouter);
    app.use((_req, res) => res.status(200).send('must not fall through'));
    const token = 's'.repeat(43); const path = `/AiHankApps/taaze-demo/${token}/`;
    // Initializes only the schema; no real source, credentials or share is used.
    expect((await request(app).get(path)).status).toBe(404);
    await pool.query('INSERT INTO taaze_demo_bundles(id,source_sha256,bundle_sha256,imported_by) VALUES ($1,$2,$3,$4)', [DEMO_ID, SOURCE_SHA256, 'synthetic-bundle-digest', 'synthetic-admin']);
    await pool.query('INSERT INTO taaze_demo_assets(bundle_id,path,content_type,body) VALUES ($1,$2,$3,$4)', [DEMO_ID, 'map.js', 'text/javascript; charset=utf-8', SYNTHETIC_MAP]);
    await pool.query('INSERT INTO taaze_demo_assets(bundle_id,path,content_type,body) VALUES ($1,$2,$3,$4)', [DEMO_ID, 'products.js', 'text/javascript; charset=utf-8', Buffer.from('window.syntheticProductCount=3;')]);
    await pool.query('INSERT INTO taaze_demo_shares(id,bundle_id,token_hash,created_by,request_id,expires_at) VALUES ($1,$2,$3,$4,$5,NULL)', ['synthetic-map-share', DEMO_ID, crypto.createHash('sha256').update(token).digest('hex'), 'synthetic-admin', 'synthetic-map-request']);
    return { app, pool, path };
}
describe('verified offline map response adaptation v1', () => {
    test('runs a self-contained SVG map and preserves selection callbacks without tiles or timers', () => {
        const adapted = adaptDemoMap(SYNTHETIC_MAP); const source = adapted.toString();
        expect(source).toContain(ADAPTATION_VERSION); expect(source).toContain('L.CRS.Simple'); expect(source).toContain('const center=[0,0]');
        expect(source).not.toMatch(/L\.tileLayer|tile\.invalid|setTimeout|\[42,43\]/);
        const status = { hidden: true, textContent: '', setAttribute: jest.fn() }; const map = { setView: jest.fn().mockReturnThis(), fitBounds: jest.fn() };
        const overlay = { addTo: jest.fn() }; const leaflet = { CRS: { Simple: 'synthetic-simple-crs' }, map: jest.fn(() => map), imageOverlay: jest.fn(() => overlay) };
        const context = { window: {}, document: { querySelector: () => status }, L: leaflet, encodeURIComponent };
        vm.runInNewContext(source, context); expect(status.hidden).toBe(false); expect(status.textContent).toBe(NOTICE);
        expect(leaflet.map.mock.calls[0][1]).toMatchObject({ crs: 'synthetic-simple-crs', minZoom: -2, maxZoom: 2 });
        expect(leaflet.imageOverlay.mock.calls[0][0]).toMatch(/^data:image\/svg\+xml/);
        expect(decodeURIComponent(leaflet.imageOverlay.mock.calls[0][0])).toContain('綠地（示意）');
        expect(map.fitBounds).toHaveBeenCalledTimes(1); context.window.selectDemoMap(2); expect(context.window.selected).toBe(2);
        expect(SYNTHETIC_MAP.toString()).toContain('tile.invalid');
    });
    test('unknown original SHA and changed/missing/duplicate patch markers fail closed', () => {
        expect(() => adaptDemoMap(Buffer.from('unapproved map'))).toThrow('demo_map_adapter_mismatch');
        expect(() => adaptDemoMap(SYNTHETIC_MAP.toString())).toThrow('demo_map_adapter_mismatch');
        for (const changed of [SYNTHETIC_MAP.toString().replace('const center=', 'const changedCenter='), SYNTHETIC_MAP.toString().replace("L.map('map'", "L.map('changed'"), SYNTHETIC_MAP.toString().replace('const tiles=', 'const changedTiles='), SYNTHETIC_MAP.toString() + 'const center=[9,9];']) expect(() => adaptDemoMap(Buffer.from(changed))).toThrow('demo_map_adapter_mismatch');
    });
    test('only live map.js response is adapted; database and every other response remain unchanged', async () => {
        const { app, pool, path } = await setup();
        const response = await request(app).get(path + 'map.js'); expect(response.status).toBe(200); expect(response.text).toContain(ADAPTATION_VERSION);
        expect(response.headers['cache-control']).toBe('private, no-store, no-transform'); expect(response.headers['cdn-cache-control']).toBe('no-store'); expect(response.headers['referrer-policy']).toBe('no-referrer');
        expect(response.headers['content-security-policy']).toContain("img-src 'self' data:;"); expect(response.headers['content-security-policy']).not.toContain('openstreetmap');
        expect((await request(app).head(path + 'map.js')).status).toBe(200);
        expect((await pool.query('SELECT body FROM taaze_demo_assets WHERE path=$1', ['map.js'])).rows[0].body).toEqual(SYNTHETIC_MAP);
        expect((await pool.query('SELECT bundle_sha256 FROM taaze_demo_bundles')).rows[0].bundle_sha256).toBe('synthetic-bundle-digest');
        expect((await request(app).get(path + 'products.js')).text).toBe('window.syntheticProductCount=3;');
    });
    test('missing/wrong/revoked/expired capability denies before adapting; hash mismatch also denies generically', async () => {
        const { app, pool, path } = await setup(); const calls = crypto.adapterTestState.mapChecks;
        for (const denied of ['/AiHankApps/taaze-demo/map.js', `/AiHankApps/taaze-demo/${'x'.repeat(43)}/map.js`]) {
            const result = await request(app).get(denied); expect(result.status).toBe(404); expect(result.text).toBe('Not found'); expect(result.headers['cache-control']).toContain('no-transform');
        }
        await pool.query('UPDATE taaze_demo_shares SET revoked_at=$1', [new Date()]);
        expect((await request(app).get(path + 'map.js')).status).toBe(404); expect((await request(app).head(path + 'map.js')).status).toBe(404);
        await pool.query('UPDATE taaze_demo_shares SET revoked_at=NULL,expires_at=$1', [new Date('2000-01-01')]);
        expect((await request(app).get(path + 'map.js')).status).toBe(404); expect(crypto.adapterTestState.mapChecks).toBe(calls);
        await pool.query('UPDATE taaze_demo_shares SET expires_at=NULL'); await pool.query('UPDATE taaze_demo_assets SET body=$1 WHERE path=$2', [Buffer.from('unapproved map bytes'), 'map.js']);
        const failed = await request(app).get(path + 'map.js'); expect(failed.status).toBe(404); expect(failed.text).toBe('Not found'); expect(failed.headers['cache-control']).toContain('no-transform');
    });
});
