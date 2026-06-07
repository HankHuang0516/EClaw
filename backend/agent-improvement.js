// ============================================
// Agent Improvement Module — Phase 0 #2a (ingestion endpoint)
// Card: card_2024e5eebe1411b9a798fc28
// Parent: card_be59aa034883fe36d3645a27
//
// Wires Phase 0 #1's episode schema into a durable store so that downstream
// phases (Phase 1 #3 preflight lint, Phase 4 #9 rule promotion) have data
// to mine. Auth shape matches /api/entity-status (deviceId + deviceSecret
// OR deviceId + botSecret; cross-entity observation per 2026-06-06 directive).
//
// Endpoints:
//   POST /api/agent-improvement/episode   → ingest one episode
//   GET  /api/agent-improvement/episodes  → list (filterable by entityId/painTag)
//
// Out-of-scope (Phase 0 #2b / later):
//   - Retroactive 24h ingest (post-deploy curl probe, separate close-loop)
//   - LLM-based classifier (current heuristic is keyword + taskType)
//   - Frontend surface
// ============================================

'use strict';

const express = require('express');
const safeEqual = require('./safe-equal');
const {
    PAIN_TAXONOMY,
    SEVERITY_LEVELS,
    validateEpisode,
    assertNoSecrets,
} = require('./agent-improvement/episode-schema');

let pool = null;
let devicesRef = null;

function initTable(chatPool) {
    pool = chatPool;
    return pool.query(`
        CREATE TABLE IF NOT EXISTS agent_improvement_episodes (
            id BIGSERIAL PRIMARY KEY,
            device_id VARCHAR(64) NOT NULL,
            card_id VARCHAR(64) NOT NULL,
            entity_id INT NOT NULL,
            task_type VARCHAR(64) NOT NULL,
            pain_tags JSONB NOT NULL,
            deliverable TEXT NOT NULL,
            user_visible_result TEXT NOT NULL,
            evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
            missed_checks JSONB NOT NULL DEFAULT '[]'::jsonb,
            user_feedback TEXT,
            severity VARCHAR(8) NOT NULL,
            occurred_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_aie_lookup
            ON agent_improvement_episodes(device_id, entity_id, occurred_at DESC);
        CREATE INDEX IF NOT EXISTS idx_aie_card
            ON agent_improvement_episodes(device_id, card_id);
    `);
}

function bindDevicesRef(ref) {
    devicesRef = ref;
}

// Keyword → painTag heuristic. Order matters: first match wins per taxonomy
// scan but we accumulate matches into a set so a single feedback line can
// emit multiple tags. Upgrade path: swap this for an LLM classifier behind
// the same signature without changing call sites.
const KEYWORD_TO_TAG = Object.freeze([
    { tag: 'delivery_reliability', kws: ['offline', 'queue', 'reconnect', 'delivery', '斷線', '送不出', '訊息被阻擋', '無法送達', 'retry', 'backoff'] },
    { tag: 'auth_session',         kws: ['login', 'session', '登入', '重新登入', 'token', 'refresh', '401', 'auth', '帳號'] },
    { tag: 'redirect_deeplink',    kws: ['redirect', 'deep link', 'deeplink', '轉導', 'universal link', 'app links', 'route'] },
    { tag: 'ux_feedback',          kws: ['feedback', '回饋', '使用者看不到', 'silent', '無感', 'no signal', '不知道送出沒'] },
    { tag: 'agent_ownership',      kws: ['偷懶', 'slack', 'ownership', '誰負責', 'handoff', 'idle', '沒人接'] },
    { tag: 'task_context',         kws: ['不知道該做', 'context', '不知道做甚麼', '不知道自己要做', 'scope unclear', '沒說清楚'] },
    { tag: 'test_coverage',        kws: ['測試', 'test', 'coverage', 'no e2e', 'mock', '沒測'] },
    { tag: 'scope_completeness',   kws: ['不能一次到位', '修修改改', 'rework', 'partial', '未完成', 'incomplete'] },
]);

const TASKTYPE_TO_TAG = Object.freeze({
    pr_review: 'scope_completeness',
    test_coverage: 'test_coverage',
    spec_draft: 'task_context',
    bugfix: 'ux_feedback',
});

/**
 * Heuristic classifier. Returns a non-empty array of painTag strings.
 * Falls back to ['scope_completeness'] when no signal matches — that tag is
 * the catch-all "we shipped something incomplete" bucket.
 * @param {string} text
 * @param {string} [taskType]
 * @returns {string[]}
 */
function classifyPainTags(text, taskType) {
    const hits = new Set();
    const haystack = (text || '').toLowerCase();
    for (const { tag, kws } of KEYWORD_TO_TAG) {
        for (const kw of kws) {
            if (haystack.includes(kw.toLowerCase())) {
                hits.add(tag);
                break;
            }
        }
    }
    if (taskType && TASKTYPE_TO_TAG[taskType]) hits.add(TASKTYPE_TO_TAG[taskType]);
    if (hits.size === 0) hits.add('scope_completeness');
    return Array.from(hits);
}

/**
 * Validate + redact-assert + insert. Throws on validation failure or secret
 * hit. Returns inserted row id. Caller owns the SQL pool reference.
 * @param {object} episode
 * @param {{query: Function}} dbPool
 * @returns {Promise<{id: number}>}
 */
async function ingestEpisode(episode, dbPool) {
    const errs = validateEpisode(episode);
    if (errs.length > 0) {
        const e = new Error(`episode validation failed: ${errs.join('; ')}`);
        e.code = 'EP_INVALID';
        e.details = errs;
        throw e;
    }
    assertNoSecrets(episode); // throws on first hit

    const r = await dbPool.query(`
        INSERT INTO agent_improvement_episodes
            (device_id, card_id, entity_id, task_type, pain_tags,
             deliverable, user_visible_result, evidence, missed_checks,
             user_feedback, severity, occurred_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12)
        RETURNING id
    `, [
        episode._deviceId,                              // populated by route, never trusted from caller
        episode.cardId,
        episode.entityId,
        episode.taskType,
        JSON.stringify(episode.painTags),
        episode.deliverable,
        episode.userVisibleResult,
        JSON.stringify(episode.evidence),
        JSON.stringify(episode.missedChecks),
        episode.userFeedback || null,
        episode.severity,
        episode.occurredAt,
    ]);
    return { id: r.rows[0].id };
}

function authDeviceOrBot(req) {
    const deviceId = req.query.deviceId || req.body?.deviceId;
    const deviceSecret = req.query.deviceSecret || req.body?.deviceSecret;
    const botSecret = req.query.botSecret || req.body?.botSecret;
    const callerEntityId = parseInt(req.query.entityId || req.body?.entityId) || 0;

    if (!deviceId || !devicesRef || !devicesRef[deviceId]) return null;
    const device = devicesRef[deviceId];
    if (deviceSecret && safeEqual(device.deviceSecret, deviceSecret)) {
        return { deviceId, callerEntityId };
    }
    if (botSecret) {
        const ents = device.entities || {};
        if (callerEntityId > 0) {
            const e = ents[callerEntityId];
            if (e && e.isBound && e.botSecret && safeEqual(e.botSecret, botSecret)) {
                return { deviceId, callerEntityId };
            }
        }
    }
    return null;
}

const router = express.Router();

router.post('/episode', express.json({ limit: '256kb' }), async (req, res) => {
    const auth = authDeviceOrBot(req);
    if (!auth) return res.status(403).json({ success: false, error: 'Invalid credentials' });
    if (!pool) return res.status(503).json({ success: false, error: 'store not ready' });

    const ep = req.body || {};
    // Server stamps deviceId from auth so the body cannot impersonate a
    // different device. Heuristic-classify when caller didn't pass painTags.
    if (!Array.isArray(ep.painTags) || ep.painTags.length === 0) {
        ep.painTags = classifyPainTags(
            [ep.deliverable, ep.userVisibleResult, ep.userFeedback].filter(Boolean).join(' \n '),
            ep.taskType,
        );
    }
    ep._deviceId = auth.deviceId;

    try {
        const { id } = await ingestEpisode(ep, pool);
        return res.json({ success: true, id });
    } catch (err) {
        if (err.code === 'EP_INVALID') {
            return res.status(400).json({ success: false, error: err.message, details: err.details });
        }
        if (/secret-shaped/.test(err.message)) {
            return res.status(400).json({ success: false, error: 'episode contains secret-shaped substring; redact before ingest' });
        }
        console.error('[AgentImprovement] ingest error:', err.message);
        return res.status(500).json({ success: false, error: 'internal' });
    }
});

router.get('/episodes', async (req, res) => {
    const auth = authDeviceOrBot(req);
    if (!auth) return res.status(403).json({ success: false, error: 'Invalid credentials' });
    if (!pool) return res.status(503).json({ success: false, error: 'store not ready' });

    const entityId = parseInt(req.query.entityId) || 0;
    const painTag = (req.query.painTag || '').toString();
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);

    const params = [auth.deviceId];
    let where = 'device_id = $1';
    if (entityId > 0) { params.push(entityId); where += ` AND entity_id = $${params.length}`; }
    if (painTag && PAIN_TAXONOMY.includes(painTag)) {
        params.push(painTag);
        where += ` AND pain_tags @> to_jsonb(ARRAY[$${params.length}]::text[])`;
    }
    params.push(limit);

    try {
        const r = await pool.query(`
            SELECT id, card_id AS "cardId", entity_id AS "entityId", task_type AS "taskType",
                   pain_tags AS "painTags", deliverable, user_visible_result AS "userVisibleResult",
                   evidence, missed_checks AS "missedChecks", user_feedback AS "userFeedback",
                   severity, occurred_at AS "occurredAt", created_at AS "createdAt"
            FROM agent_improvement_episodes
            WHERE ${where}
            ORDER BY occurred_at DESC
            LIMIT $${params.length}
        `, params);
        return res.json({ success: true, items: r.rows, taxonomy: PAIN_TAXONOMY, severityLevels: SEVERITY_LEVELS });
    } catch (err) {
        console.error('[AgentImprovement] list error:', err.message);
        return res.status(500).json({ success: false, error: 'internal' });
    }
});

module.exports = {
    initTable,
    bindDevicesRef,
    classifyPainTags,
    ingestEpisode,
    router,
    KEYWORD_TO_TAG,
    TASKTYPE_TO_TAG,
};
