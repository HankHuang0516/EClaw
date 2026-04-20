/**
 * Embedding client — thin wrapper around OpenAI / Voyage embedding APIs.
 *
 * Design goals:
 *   1. Fail gracefully when no API key is configured — caller handles null return
 *   2. Support BYO (bring-your-own) key via device-vars (same pattern as Track 4
 *      Claude channel binding); fall back to server env var
 *   3. Provider-agnostic: OpenAI text-embedding-3-small (1536 dim) is the default;
 *      Voyage-3 (1024 dim) is selectable via CHAT_EMBEDDING_PROVIDER env var, but
 *      the chat_messages.embedding column is fixed at vector(1536) so Voyage
 *      requires schema re-provisioning — handled by failing loudly at embed time.
 */

const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_DIM = 1536;

function pickProvider() {
    const p = String(process.env.CHAT_EMBEDDING_PROVIDER || 'openai').toLowerCase();
    if (p === 'voyage') return 'voyage';
    return 'openai';
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
