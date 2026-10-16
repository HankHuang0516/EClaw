const express = require('express');
const { createRouters, validate, saveReport } = require('../../fraud-demo-feedback');

const ID = '7b0b62d4-2441-46ce-8b2d-baf732bd45c8';
const media = require('../../public/AiHankApps/projects/fraud-empire/release.json').assets;
const IMAGE = media.find(asset => asset.path.startsWith('images/') && /\.webp$/.test(asset.path)).path;
const PROPOSAL = media.find(asset => asset.path.startsWith('proposal-demos/') && /\.png$/.test(asset.path)).path;
function fixture() {
  return { id: ID, category: 'operation', description: 'QA fixture: an operation needs investigation.', snapshot: {
    schemaVersion: 1, capturedAt: '2026-10-16T02:00:00.000Z', version: 'v4.6.1-demo-feedback-20261016',
    contentHash: 'a'.repeat(64), screen: { module: 'camp', id: 'camp-interaction', sceneId: 'M02',
      stepId: 'M02-N04', visibleText: '目前站位：M02-N04', choices: [{ id: 'inspect', label: '查看', disabled: false }],
      assetIds: [IMAGE] }, game: { day: null, time: null, rank: null, scope: 'not-initialized',
      uninitialized: ['day', 'time', 'rank', 'mood', 'stamina', 'wisdom', 'score', 'xp', 'money'] },
    parameters: { timeline: 1, appliedMinutes: 0 }, recentActions: [{ action: '本次已顯示移動路徑', target: 'M02-N04' }] } };
}
function fakePool() {
  const rows = new Map();
  const calls = [];
  return { rows, calls, query: jest.fn(async (sql, values = []) => {
    calls.push({ sql, values });
    if (sql.includes('CREATE TABLE')) return { rows: [] };
    if (sql.includes('INSERT INTO')) {
      if (rows.has(values[0])) return { rows: [] };
      const row = { id: values[0], payload_hash: values[1], category: values[2], description: values[3],
        snapshot: JSON.parse(values[4]), created_at: '2026-10-16T02:00:01.000Z' };
      rows.set(row.id, row);
      return { rows: [{ id: row.id, created_at: row.created_at }] };
    }
    if (sql.includes('WHERE id = $1')) return { rows: rows.has(values[0]) ? [rows.get(values[0])] : [] };
    return { rows: [...rows.values()] };
  }) };
}

describe('Demo-only private report storage contract', () => {
  test('accepts only the bounded whitelist and retains missing versus actual zero', () => {
    const body = fixture();
    expect(validate(body)).toBe(true);
    expect(body.snapshot.game.day).toBeNull();
    expect(body.snapshot.parameters.appliedMinutes).toBe(0);
    body.snapshot.screen.assetIds = [PROPOSAL];
    expect(validate(body)).toBe(true);
  });
  test('accepts only disclosed selection scalars, never whole hidden state objects', () => {
    const body = fixture();
    Object.assign(body.snapshot.parameters, { selectedJob: 'fang_cen', selectedPiece: 'moon', selectedTicket: null, selectedPieceRotation: 0 });
    expect(validate(body)).toBe(true);
    body.snapshot.parameters.selectedPiece = { flags: ['unrevealed'] };
    expect(validate(body)).toBe(false);
  });
  test('rejects an unregistered image path and an arbitrary external URL', () => {
    const body = fixture();
    body.snapshot.screen.assetIds = ['images/not-in-the-release.webp'];
    expect(validate(body)).toBe(false);
    body.snapshot.screen.assetIds = ['https://example.invalid/private.png'];
    expect(validate(body)).toBe(false);
  });
  test.each(['cookies', 'token', 'storage', 'storyFlags', 'unrevealedBranches'])('rejects extra snapshot field %s', key => {
    const body = fixture();
    body.snapshot[key] = 'must not be collected';
    expect(validate(body)).toBe(false);
  });
  test('rejects blank descriptions, unknown category, excess text and traversal asset IDs', () => {
    const blank = fixture(); blank.description = '   '; expect(validate(blank)).toBe(false);
    const category = fixture(); category.category = 'unknown'; expect(validate(category)).toBe(false);
    const long = fixture(); long.snapshot.screen.visibleText = 'x'.repeat(6001); expect(validate(long)).toBe(false);
    const asset = fixture(); asset.snapshot.screen.assetIds = ['../private.png']; expect(validate(asset)).toBe(false);
  });
  test('confirms a stored row and returns the same ID for an identical retry', async () => {
    const pool = fakePool();
    const first = await saveReport(pool, fixture());
    const retry = await saveReport(pool, fixture());
    expect(first).toMatchObject({ id: ID, duplicate: false });
    expect(retry).toMatchObject({ id: ID, duplicate: true });
    expect(pool.rows.size).toBe(1);
    expect(pool.rows.get(ID).snapshot).toEqual(fixture().snapshot);
    expect(pool.calls.every(call => !/device|telemetry|server_logs|github/i.test(call.sql))).toBe(true);
  });
  test('concurrent duplicate sends do not create two records', async () => {
    const pool = fakePool();
    const results = await Promise.all([saveReport(pool, fixture()), saveReport(pool, fixture())]);
    expect(results.map(r => r.id)).toEqual([ID, ID]);
    expect(pool.rows.size).toBe(1);
  });
  test('a different payload cannot replace an existing report ID', async () => {
    const pool = fakePool();
    await saveReport(pool, fixture());
    const altered = fixture(); altered.description = 'different';
    await expect(saveReport(pool, altered)).rejects.toMatchObject({ status: 409 });
    expect(pool.rows.get(ID).description).toBe(fixture().description);
  });
  test('missing and failed storage never return a success receipt', async () => {
    await expect(saveReport(null, fixture())).rejects.toThrow('storage_unavailable');
    const pool = { query: jest.fn().mockRejectedValue(new Error('private database fault')) };
    await expect(saveReport(pool, fixture())).rejects.toThrow('private database fault');
  });
});

describe('private report HTTP authorization', () => {
  let server;
  let base;
  let pool;
  beforeAll(async () => {
    pool = fakePool();
    const app = express(); app.use(express.json());
    // These unit-only credentials are not registered in production.
    const auth = (req, res, next) => req.get('x-unit-role') ? next() : res.status(401).json({ success: false });
    const admin = (req, res, next) => req.get('x-unit-role') === 'admin' ? next() : res.status(403).json({ success: false });
    const routers = createRouters(() => pool, auth, admin);
    app.use('/reports', routers.intake); app.use('/admin/reports', routers.admin);
    app.use('/debug/reports', routers.debug);
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = 'http://127.0.0.1:' + server.address().port;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  test('real HTTP save followed by authenticated same-ID fixture readback', async () => {
    const response = await fetch(base + '/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fixture()) });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ saved: true, id: ID });
    const read = await fetch(base + '/admin/reports/' + ID, { headers: { 'x-unit-role': 'admin' } });
    expect(read.status).toBe(200);
    expect((await read.json()).report.snapshot).toEqual(fixture().snapshot);
    expect(read.headers.get('cache-control')).toBe('no-store');
  });
  test('unauthenticated and non-admin reads are denied; no public report GET', async () => {
    expect((await fetch(base + '/admin/reports/' + ID)).status).toBe(401);
    expect((await fetch(base + '/admin/reports/' + ID, { headers: { 'x-unit-role': 'member' } })).status).toBe(403);
    expect((await fetch(base + '/reports/' + ID)).status).toBe(404);
  });
  test('an empty report is not acknowledged', async () => {
    const body = fixture(); body.description = '';
    const response = await fetch(base + '/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, saved: false });
  });
  test('debug reads still require the existing administrator role', async () => {
    expect((await fetch(base + '/debug/reports/' + ID)).status).toBe(401);
    expect((await fetch(base + '/debug/reports/' + ID, { headers: { 'x-unit-role': 'member' } })).status).toBe(403);
    const response = await fetch(base + '/debug/reports/' + ID, { headers: { 'x-unit-role': 'admin' } });
    expect(response.status).toBe(200);
    expect((await response.json()).report.snapshot).toEqual(fixture().snapshot);
  });
  test('production hides debug reads even from administrators', async () => {
    const oldNode = process.env.NODE_ENV;
    const oldRailway = process.env.RAILWAY_ENVIRONMENT;
    try {
      process.env.NODE_ENV = 'production';
      process.env.RAILWAY_ENVIRONMENT = 'production';
      expect((await fetch(base + '/debug/reports/' + ID, { headers: { 'x-unit-role': 'admin' } })).status).toBe(404);
    } finally {
      if (oldNode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldNode;
      if (oldRailway === undefined) delete process.env.RAILWAY_ENVIRONMENT; else process.env.RAILWAY_ENVIRONMENT = oldRailway;
    }
  });
  test('an explicitly designated debug environment retains administrator checks', async () => {
    const oldNode = process.env.NODE_ENV;
    const oldRailway = process.env.RAILWAY_ENVIRONMENT;
    try {
      process.env.NODE_ENV = 'production';
      process.env.RAILWAY_ENVIRONMENT = 'debug';
      expect((await fetch(base + '/debug/reports/' + ID)).status).toBe(401);
      expect((await fetch(base + '/debug/reports/' + ID, { headers: { 'x-unit-role': 'admin' } })).status).toBe(200);
    } finally {
      if (oldNode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldNode;
      if (oldRailway === undefined) delete process.env.RAILWAY_ENVIRONMENT; else process.env.RAILWAY_ENVIRONMENT = oldRailway;
    }
  });
});
