/**
 * Embedding client — thin wrapper around OpenAI / Voyage / local embedding backends.
 *
 * Design goals:
 *   1. Fail gracefully when no API key is configured — caller handles null return
 *   2. Support BYO (bring-your-own) key via device-vars (same pattern as Track 4
 *      Claude channel binding); fall back to server env var
 *   3. Provider-agnostic via CHAT_EMBEDDING_PROVIDER:
 *        - 'openai' (default): text-embedding-3-small, 1536 dim — needs OPENAI_API_KEY
 *        - 'voyage': voyage-3, 1024 dim — needs VOYAGE_API_KEY
 *        - 'local': @xenova/transformers ONNX, multilingual-e5-small, 384 dim —
 *          ZERO API key, runs in-process. Model weights auto-download once then
 *          run offline. Picked for keyless multilingual (Globe-user) deployments.
 *      The chat_messages.embedding column is provisioned to vector(DEFAULT_DIM);
 *      chat-embedding.js#normalizeEmbeddingColumn auto-migrates + rebuilds the HNSW
 *      index + clears mismatched vectors when the active provider's dim changes.
 */

// ---- provider + dimension resolution (read once at module load; env is set at boot)
function pickProvider() {
    const p = String(process.env.CHAT_EMBEDDING_PROVIDER || 'openai').toLowerCase();
    if (p === 'local') return 'local';
    if (p === 'voyage') return 'voyage';
    return 'openai';
}

// Local model is configurable but defaults to the lightweight multilingual e5.
const LOCAL_MODEL = process.env.LOCAL_EMBEDDING_MODEL || 'Xenova/multilingual-e5-small';
const LOCAL_DIM = parseInt(process.env.LOCAL_EMBEDDING_DIM, 10) || 384;

const DIM_BY_PROVIDER = { openai: 1536, voyage: 1024, local: LOCAL_DIM };

const DEFAULT_MODEL = 'text-embedding-3-small';
// DEFAULT_DIM tracks the ACTIVE provider so the schema/guards in chat-embedding.js
// provision the matching vector(N) column. Changing CHAT_EMBEDDING_PROVIDER and
// rebooting triggers an automatic column migration + HNSW rebuild + backfill.
const DEFAULT_DIM = DIM_BY_PROVIDER[pickProvider()] || 1536;

// ---- local ONNX backend (lazy: pipeline + weights load only on first embed) ----
let _localPipelinePromise = null;
function getLocalPipeline() {
    if (!_localPipelinePromise) {
        _localPipelinePromise = (async () => {
            // dynamic import: @xenova/transformers is ESM-only
            const { pipeline, env } = await import('@xenova/transformers');
            // Allow remote weight download (first run) + on-disk cache for reuse.
            env.allowRemoteModels = true;
            return pipeline('feature-extraction', LOCAL_MODEL);
        })().catch((err) => {
            // Reset so a transient failure (e.g. download hiccup) can retry next call.
            _localPipelinePromise = null;
            throw err;
        });
    }
    return _localPipelinePromise;
}

async function embedLocal(text, role) {
    const pipe = await getLocalPipeline();
    // e5 family expects an asymmetric "query: " / "passage: " prefix. Stored
    // messages are passages; search inputs are queries. Default to query.
    const prefix = role === 'passage' ? 'passage: ' : 'query: ';
    const input = /^(query|passage):\s/.test(text) ? text : prefix + text;
    const output = await pipe(input, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
}

async function resolveApiKey(deviceId, provider, getDeviceVar) {
    // Priority: device-vars (BYO) > server env
    if (deviceId && typeof getDeviceVar === 'function') {
        try {
            const key = provider === 'voyage' ? 'VOYAGE_API_KEY' : 'OPENAI_API_KEY';
            const deviceKey = await getDeviceVar(deviceId, key);
            if (deviceKey) return deviceKey;
        } catch (_) { /* fall through to env */ }
    }
    if (provider === 'voyage') return process.env.VOYAGE_API_KEY || null;
    return process.env.OPENAI_API_KEY || null;
}

async function embedOpenAI(text, apiKey, model) {
    const resp = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ model: model || DEFAULT_MODEL, input: text })
    });
    if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`OpenAI embedding ${resp.status}: ${body.slice(0, 200)}`);
    }
    const data = await resp.json();
    return data.data?.[0]?.embedding || null;
}

async function embedVoyage(text, apiKey, model) {
    const resp = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ model: model || 'voyage-3', input: [text] })
    });
    if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`Voyage embedding ${resp.status}: ${body.slice(0, 200)}`);
    }
    const data = await resp.json();
    return data.data?.[0]?.embedding || null;
}

/**
 * Generate an embedding vector for `text`.
 * @param {string} text
 * @param {object} opts
 * @param {string} [opts.deviceId] — if supplied, try device-vars first for BYO key
 * @param {function} [opts.getDeviceVar] — async (deviceId, key) => string|null
 * @returns {Promise<number[]|null>} — null when no API key or API call fails
 */
async function generateEmbedding(text, opts = {}) {
    if (!text || typeof text !== 'string' || text.trim().length === 0) return null;
    const clipped = text.length > 8000 ? text.slice(0, 8000) : text;
    const provider = pickProvider();
    // Local backend needs no API key — runs the ONNX model in-process.
    if (provider === 'local') {
        try {
            return await embedLocal(clipped, opts.role);
        } catch (err) {
            console.warn('[Embedding] local generateEmbedding failed:', err.message);
            return null;
        }
    }
    const apiKey = await resolveApiKey(opts.deviceId, provider, opts.getDeviceVar);
    if (!apiKey) return null;
    try {
        if (provider === 'voyage') return await embedVoyage(clipped, apiKey);
        return await embedOpenAI(clipped, apiKey);
    } catch (err) {
        console.warn('[Embedding] generateEmbedding failed:', err.message);
        return null;
    }
}

/**
 * Formats a JS number[] as a pgvector literal. pg driver can also accept a
 * string '[0.1,0.2,...]' cast to vector — this avoids needing the `pgvector`
 * npm package as a dependency.
 */
function toPgVectorLiteral(vec) {
    if (!Array.isArray(vec)) return null;
    return '[' + vec.map((v) => Number.isFinite(v) ? v.toFixed(6) : '0').join(',') + ']';
}

function isConfigured() {
    const provider = pickProvider();
    if (provider === 'local') return true; // no key required — model runs in-process
    return !!(provider === 'voyage' ? process.env.VOYAGE_API_KEY : process.env.OPENAI_API_KEY);
}

module.exports = {
    DEFAULT_MODEL,
    DEFAULT_DIM,
    generateEmbedding,
    toPgVectorLiteral,
    isConfigured,
    pickProvider
};
