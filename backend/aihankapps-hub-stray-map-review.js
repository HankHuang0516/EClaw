'use strict';

const ORIGIN = 'https://api-production-8bc1.up.railway.app';
const PREFIX = '/stray-map/review';
const TOKEN_HEADER = 'x-stray-map-review-token';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REPORT_ACTIONS = ['mark_reviewing', 'dismiss', 'remove', 'remove_and_ban'];
const PHOTO_DECISIONS = ['approve', 'reject', 'hide'];
const PHOTO_FILTERS = ['pending', 'approved', 'rejected'];
const REPORT_FIELDS = ['id', 'targetType', 'reason', 'details', 'status', 'createdAt', 'dueAt', 'resolvedAt', 'resolution',
    'moderatorNote', 'overdue', 'targetSummary', 'targetRemoved', 'targetAuthorBanned', 'alertStatus'];
const PHOTO_FIELDS = ['id', 'createdAt', 'moderationStatus', 'reviewedAt', 'reviewerNote', 'hiddenAt', 'sensitiveContent',
    'sensitiveReason', 'autoModerationDecision', 'autoModerationReason', 'description', 'openReports'];
const activeReport = report => ['open', 'reviewing'].includes(report.status);
const choose = (record, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]]));
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;

function preview(value) {
    if (typeof value !== 'string' || value.length > 2048) return null;
    try {
        const url = new URL(value, ORIGIN);
        if (url.username || url.password || url.search || url.hash) return null;
        if (url.origin === 'https://live.staticflickr.com' && /^\/\d+\/[\w.-]+\.(?:jpe?g|png|webp)$/i.test(url.pathname)) return url.href;
        if (url.origin === ORIGIN && /^\/uploads\/[\w/.-]+\.(?:jpe?g|png|webp)$/i.test(url.pathname)) return url.href;
    } catch (_) { return null; }
    return null;
}

function canWrite(path) {
    const matched = /^\/stray-map\/review\/(?:reports|photos|appeals)\/([^/]+)\/decision$/.exec(path);
    return !!matched && UUID.test(matched[1]);
}

function decision(input, actions, max, noteRequired) {
    if (!plain(input) || Object.keys(input).some(key => !['action', 'note'].includes(key)) || !actions.includes(input.action)
        || (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > max))) return null;
    const note = input.note?.trim();
    if (!note && noteRequired(input.action)) return null;
    return { action: input.action, note: note || undefined };
}

function fail(res, status, error) {
    return res.status(status).json({ success: false, error });
}

class UpstreamError extends Error {
    constructor(status) {
        super('Stray Map review request failed');
        this.status = status;
    }
}

function mount(router, { limited, fetchImpl = fetch }) {
    async function request(path, token, body) {
        const options = {
            method: body ? 'POST' : 'GET',
            redirect: 'error',
            signal: AbortSignal.timeout(8000),
            headers: { Accept: 'application/json', 'X-Admin-Token': token },
        };
        if (body) {
            options.headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(body);
        }
        const response = await fetchImpl(new URL(path, ORIGIN), options);
        if (!response.ok) {
            await response.body?.cancel();
            throw new UpstreamError(response.status);
        }
        if (!/^application\/json\b/i.test(response.headers.get('content-type') || '')) {
            await response.body?.cancel();
            throw new UpstreamError(502);
        }
        const chunks = [];
        let bytes = 0;
        for await (const chunk of response.body || []) {
            bytes += chunk.byteLength;
            if (bytes > MAX_RESPONSE_BYTES) throw new UpstreamError(502);
            chunks.push(chunk);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }

    function handler(fn) {
        return async (req, res) => {
            if (limited(req)) return fail(res, 429, 'RATE_LIMIT');
            const token = req.get(TOKEN_HEADER);
            if (!token || !/^[\x21-\x7e]{1,512}$/.test(token)) return fail(res, 401, 'REVIEW_TOKEN_REQUIRED');
            try {
                return await fn(req, res, token);
            } catch (error) {
                const status = error instanceof UpstreamError ? error.status : 0;
                if ([401, 403].includes(status)) return fail(res, 401, 'REVIEW_TOKEN_REJECTED');
                if ([400, 404, 409, 429].includes(status)) return fail(res, status, 'REVIEW_REQUEST_DECLINED');
                return fail(res, 502, req.method === 'POST' ? 'REVIEW_OUTCOME_UNKNOWN' : 'REVIEW_UNAVAILABLE');
            }
        };
    }

    async function reports(token) {
        const result = await request('/v1/admin/reports', token);
        if (!Array.isArray(result?.reports) || !result.reports.every(row => plain(row) && UUID.test(row.id))) throw new UpstreamError(502);
        return result.reports;
    }

    router.get(PREFIX + '/reports', handler(async (req, res, token) => {
        if (Object.keys(req.query).length) return fail(res, 400, 'INVALID_REVIEW_REQUEST');
        const rows = await reports(token);
        return res.json({ success: true, rows: rows.map(row => ({ ...choose(row, REPORT_FIELDS), image: preview(row.targetImageUrl) })) });
    }));

    router.get(PREFIX + '/photos', handler(async (req, res, token) => {
        const { status = 'pending', offset = '0' } = req.query;
        if (Object.keys(req.query).some(key => !['status', 'offset'].includes(key)) || !PHOTO_FILTERS.includes(status)
            || typeof offset !== 'string' || !/^\d{1,4}$/.test(offset) || Number(offset) > 5000) return fail(res, 400, 'INVALID_REVIEW_REQUEST');
        const query = new URLSearchParams({ status, offset, limit: '50' });
        const result = await request('/v1/admin/photos?' + query, token);
        if (!Array.isArray(result?.photos) || !result.photos.every(row => plain(row) && UUID.test(row.id))) throw new UpstreamError(502);
        return res.json({
            success: true, hasNext: result.photos.length === 50 && Number(offset) < 5000,
            rows: result.photos.map(row => ({
                ...choose(row, PHOTO_FIELDS),
                image: preview(row.url) || preview(row.thumbnailUrl),
                appeal: plain(row.appeal) && UUID.test(row.appeal.id) ? choose(row.appeal, ['id', 'status', 'message', 'createdAt', 'dueAt']) : null,
            })),
        });
    }));

    router.post(PREFIX + '/reports/:id/decision', handler(async (req, res, token) => {
        const id = req.params.id;
        const input = decision(req.body, REPORT_ACTIONS, 500, action => action.startsWith('remove'));
        if (!UUID.test(id) || !input || Object.keys(req.query).length || !req.is('application/json')) return fail(res, 400, 'INVALID_REVIEW_REQUEST');
        const target = (await reports(token)).find(row => row.id === id);
        if (!target || !UUID.test(target.targetId) || !['animal', 'comment', 'photo'].includes(target.targetType)) return fail(res, 404, 'REVIEW_CASE_MISSING');
        if (!activeReport(target)) return fail(res, 409, 'REVIEW_CASE_CHANGED');
        const outcome = await request('/v1/admin/action', token, { reportId: id, targetId: target.targetId, targetType: target.targetType,
            action: input.action, notes: input.note });
        if (outcome?.ok !== true) throw new UpstreamError(502);
        return res.json({ success: true });
    }));

    for (const [name, upstream, actions, max] of [
        ['photos', 'photos', PHOTO_DECISIONS, 200],
        ['appeals', 'photo-appeals', ['approve', 'reject'], 500],
    ]) {
        router.post(PREFIX + '/' + name + '/:id/decision', handler(async (req, res, token) => {
            const { id } = req.params;
            const input = decision(req.body, actions, max, action => name === 'appeals' || action !== 'approve');
            if (!UUID.test(id) || !input || Object.keys(req.query).length || !req.is('application/json')) return fail(res, 400, 'INVALID_REVIEW_REQUEST');
            const outcome = await request('/v1/admin/' + upstream + '/' + id + '/decision', token, { decision: input.action, note: input.note });
            if (outcome?.ok !== true) throw new UpstreamError(502);
            return res.json({ success: true });
        }));
    }
}

module.exports = { mount, canWrite };
