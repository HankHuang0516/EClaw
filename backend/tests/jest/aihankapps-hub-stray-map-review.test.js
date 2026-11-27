const express = require('express');
const request = require('./helpers/local-supertest');
const { createRouters } = require('../../aihankapps-hub');

const base = '/api/aihankapps/hub/stray-map/review/';
const origin = 'https://eclawbot.com';
const token = 'synthetic-review-token';
const id = '11111111-1111-4111-8111-111111111111';
const targetId = '22222222-2222-4222-8222-222222222222';
const target = { id, targetId, targetType: 'animal', status: 'open', details: '<script>synthetic()</script>',
    targetImageUrl: 'https://untrusted.invalid/image.png', targetDeviceId: 'private-device' };

async function fixture() {
    const fetchStrayMapReview = jest.fn(async (url, options) => {
        expect(url.origin).toBe('https://api-production-8bc1.up.railway.app');
        expect(options.redirect).toBe('error');
        expect(options.headers['X-Admin-Token']).toBe(token);
        expect(options.headers.Cookie).toBeUndefined();
        if (url.pathname === '/v1/admin/reports') return Response.json({ reports: [target] });
        if (url.pathname === '/v1/admin/photos') return Response.json({ photos: [{ id, moderationStatus: 'pending',
            ownerDeviceId: 'private-device', url: 'https://live.staticflickr.com/123/synthetic.jpg',
            appeal: { id, status: 'open', sourceId: 'secret-source' } }] });
        return Response.json({ ok: true, privateValue: 'drop' });
    });
    const app = express().use(express.json());
    const { api, page } = createRouters({
        getPool: () => null, getAuthPool: () => null, isReady: () => true, fetchStrayMapReview,
        authMiddleware(req, res, next) { return req.get('X-Test-User') ? next() : res.status(401).end(); },
        adminMiddleware(req, res, next) { return req.get('X-Test-User') === 'admin' ? next() : res.status(403).end(); },
    });
    app.use('/api/aihankapps/hub', api);
    app.use('/AiHankApps/hub', page);
    return { client: await request(app), fetchStrayMapReview };
}
const admin = req => req.set('X-Test-User', 'admin').set('X-Stray-Map-Review-Token', token);

describe('Stray Map manual review in the admin hub', () => {
    test('requires the existing role, review token and same-origin writes before contacting Stray Map', async () => {
        const { client, fetchStrayMapReview } = await fixture();
        await client.get(base + 'reports').expect(401);
        await client.get(base + 'reports').set('X-Test-User', 'member').expect(403);
        await client.get(base + 'reports').set('X-Test-User', 'admin').expect(401);
        await admin(client.post(base + 'reports/' + id + '/decision')).send({ action: 'dismiss' }).expect(403);
        await admin(client.post(base + 'photos/' + id + '/decision')).set('Origin', 'https://untrusted.invalid').send({ action: 'approve' }).expect(403);
        await admin(client.post(base + 'reports/other/decision')).set('Origin', origin).send({ action: 'dismiss' }).expect(405);
        expect(fetchStrayMapReview).not.toHaveBeenCalled();
        await client.get('/AiHankApps/hub/hub-stray-map-review.js').expect(401);
        await admin(client.get('/AiHankApps/hub/hub-stray-map-review.js')).expect(200);
    });

    test('lists private review records and projects only allowlisted photo previews and fields', async () => {
        const { client } = await fixture();
        const reports = await admin(client.get(base + 'reports')).expect('Cache-Control', /private.*no-store/).expect(200);
        expect(reports.body.rows[0]).toMatchObject({ details: target.details, image: null });
        expect(reports.text).not.toMatch(/private-device|untrusted|synthetic-review-token/);
        const photos = await admin(client.get(base + 'photos?status=pending&offset=0')).expect(200);
        expect(photos.body).toMatchObject({ hasNext: false, rows: [{ image: 'https://live.staticflickr.com/123/synthetic.jpg', appeal: { id, status: 'open' } }] });
        expect(photos.text).not.toMatch(/private-device|secret-source/);
    });

    test('derives the report target upstream and validates photo and appeal decisions', async () => {
        const { client, fetchStrayMapReview } = await fixture();
        const post = path => admin(client.post(base + path)).set('Origin', origin);
        await post('reports/' + id + '/decision').send({ action: 'remove' }).expect(400);
        await post('reports/' + id + '/decision').send({ action: 'dismiss', targetId: id }).expect(400);
        await post('reports/' + id + '/decision').send({ action: 'remove', note: 'Synthetic' }).expect(200, { success: true });
        expect(JSON.parse(fetchStrayMapReview.mock.calls[1][1].body)).toEqual({
            reportId: id, targetId, targetType: 'animal', action: 'remove', notes: 'Synthetic',
        });
        await post('photos/' + id + '/decision').send({ action: 'approve' }).expect(200);
        await post('appeals/' + id + '/decision').send({ action: 'reject' }).expect(400);
        await post('appeals/' + id + '/decision').send({ action: 'reject', note: 'Synthetic' }).expect(200);
        expect(fetchStrayMapReview.mock.calls.map(call => call[0].pathname)).toEqual([
            '/v1/admin/reports', '/v1/admin/action', '/v1/admin/photos/' + id + '/decision', '/v1/admin/photo-appeals/' + id + '/decision',
        ]);
    });

    test('distinguishes invalid token, unavailable data and uncertain writes without leaking upstream bodies or replaying', async () => {
        const { client, fetchStrayMapReview } = await fixture();
        fetchStrayMapReview.mockResolvedValueOnce(Response.json({ error: 'upstream-private' }, { status: 401 }));
        await admin(client.get(base + 'reports')).expect(401, { success: false, error: 'REVIEW_TOKEN_REJECTED' });
        fetchStrayMapReview.mockRejectedValueOnce(new Error('upstream-private'));
        await admin(client.get(base + 'reports')).expect(502, { success: false, error: 'REVIEW_UNAVAILABLE' });
        fetchStrayMapReview.mockRejectedValueOnce(new Error('upstream-private'));
        await admin(client.post(base + 'photos/' + id + '/decision')).set('Origin', origin).send({ action: 'approve' })
            .expect(502, { success: false, error: 'REVIEW_OUTCOME_UNKNOWN' });
        expect(fetchStrayMapReview).toHaveBeenCalledTimes(3);
    });
});
