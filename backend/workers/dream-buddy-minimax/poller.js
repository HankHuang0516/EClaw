'use strict';
const { setTimeout: delay } = require('node:timers/promises');
const { infer } = require('./runner');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function configuration(env) {
    const base = new URL(env.DREAM_BUDDY_GATEWAY_URL || 'https://eclawbot.com');
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash ||
        base.pathname !== '/') throw new Error('invalid_gateway_url');
    if (typeof env.DREAM_BUDDY_WORKER_TOKEN !== 'string' || env.DREAM_BUDDY_WORKER_TOKEN.length < 32) {
        throw new Error('worker_credential_required');
    }
    return { base: base.origin + '/api/app-bot/inference', token: env.DREAM_BUDDY_WORKER_TOKEN };
}
async function run({ env = process.env, fetchRequest = fetch, inferReply = infer, signal } = {}) {
    const config = configuration(env);
    const api = async (route, body) => {
        const response = await fetchRequest(config.base + route, { method: body ? 'POST' : 'GET',
            headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json' },
            ...(body ? { body: JSON.stringify(body) } : {}),
            redirect: 'error', signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error('gateway_unavailable');
        return response.status === 204 ? null : response.json();
    };
    // Do not advertise readiness until the actual text inference/auth works.
    await inferReply('只回覆「連線成功」。');
    await api('/worker/heartbeat', {});
    let heartbeatFlight = false;
    const heartbeat = setInterval(async () => {
        if (heartbeatFlight) return;
        heartbeatFlight = true;
        try { await api('/worker/heartbeat', {}); } catch { /* next request fails closed */ }
        finally { heartbeatFlight = false; }
    }, 10000);
    try {
        while (!signal?.aborted) {
            try {
                const job = await api('/worker/next');
                if (!job) { await delay(3000, undefined, { signal }); continue; }
                if (!UUID.test(job.jobId) || typeof job.leaseToken !== 'string' || job.leaseToken.length < 32 ||
                    typeof job.prompt !== 'string' || !job.prompt || job.prompt.length > 12000) {
                    throw new Error('invalid_job');
                }
                let result;
                try { result = { status: 'completed', reply: await inferReply(job.prompt) }; }
                catch { result = { status: 'failed' }; }
                // Retry delivery of this SAME result only; never rerun an uncertain inference.
                for (let attempt = 0; attempt < 3; attempt++) {
                    try { await api('/worker/jobs/' + job.jobId + '/result',
                        { ...result, leaseToken: job.leaseToken }); break; }
                    catch { if (attempt < 2) await delay(1500, undefined, { signal }); }
                }
            } catch {
                if (signal?.aborted) break;
                console.error('[DreamBuddyMiniMax] worker request failed');
                await delay(5000, undefined, { signal }).catch(() => {});
            }
        }
    } finally { clearInterval(heartbeat); }
}
if (require.main === module) run().catch(() => {
    console.error('[DreamBuddyMiniMax] text inference is not ready'); process.exitCode = 1;
});
module.exports = { run, configuration };
