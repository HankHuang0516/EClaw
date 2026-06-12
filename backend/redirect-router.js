/**
 * Unified redirect entry + telemetry — docs/redirect-state-machine-spec.md
 * (APPROVED 2026-06-12, #6 review). Card: card_14571f26914b9c1eae148362
 * Phase A (web slice).
 *
 * Routes (mounted at app root):
 *   GET  /r/:target               — universal entry: sig check → telemetry → 302
 *   POST /api/redirect/mint       — server-side signed-link minting (#6 am. 2)
 *   POST /api/redirect/telemetry  — client beacon for page-side transitions
 *   GET  /api/redirect/stats      — success rate per target/platform
 *
 * Per the approved open-point 1: Phase A goes straight to web (no app-attempt
 * window) — the 400 ms attempt activates with Phase B (App Links).
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const safeEqual = require('./safe-equal');
const registry = require('./shared/route-registry');

const SIG_TTL_DEFAULT_S = 7 * 24 * 3600;   // minted links live a week unless overridden
const RETENTION_DAYS = 30;                  // approved open-point 2
const TRACE_RE = /^rt_[a-f0-9]{12}$/;
const STATES = ['RECEIVED', 'SIG_REJECTED', 'WEB_DIRECT', 'WEB_FALLBACK', 'APP_ATTEMPT', 'APP_OPENED', 'LOGIN_REDIRECT', 'TARGET_RENDERED'];

let pool = null;
let devicesRef = null;
let signingSecret = null;
let purgeTimer = null;

function init({ chatPool, devices, jwtSecret }) {
    pool = chatPool || null;
    devicesRef = devices || null;
    // Reuses JWT_SECRET per spec §3 (no-new-keys); server-side only (#6 am. 2).
    signingSecret = jwtSecret || process.env.JWT_SECRET || null;
    ensureSchema().catch(err => console.warn('[Redirect] schema init failed:', err.message));
    if (!purgeTimer) {
        purgeTimer = setInterval(() => purgeOldEvents().catch(() => {}), 24 * 3600 * 1000);
        if (purgeTimer.unref) purgeTimer.unref();
    }
}

async function ensureSchema() {
    if (!pool) return;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS redirect_events (
            id              BIGSERIAL PRIMARY KEY,
            trace_id        TEXT        NOT NULL,
            state           TEXT        NOT NULL,
            target          TEXT        NOT NULL,
            platform        TEXT        NULL,
            fallback_reason TEXT        NULL,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS redirect_events_trace_idx
        ON redirect_events (trace_id, created_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS redirect_events_created_idx
        ON redirect_events (created_at DESC)`);
    await purgeOldEvents();
}

async function purgeOldEvents() {
    if (!pool) return;
    await pool.query(
        `DELETE FROM redirect_events WHERE created_at < NOW() - ($1 || ' days')::interval`,
        [RETENTION_DAYS]
    );
}

function mintTraceId() {
    return 'rt_' + crypto.randomBytes(6).toString('hex');
}

// HMAC over `target|sortedParams|exp` — spec §3.
function computeSig(target, params, exp) {
    const route = registry.ROUTES[target];
    const canonical = (route ? route.params : []).slice().sort()
        .map(k => k + '=' + String(params[k] ?? '')).join('&');
    return crypto.createHmac('sha256', String(signingSecret))
        .update(target + '|' + canonical + '|' + exp)
        .digest('hex').slice(0, 32);
}

function verifySig(target, params, exp, sig) {
    if (!signingSecret) return false;
    const expNum = Number(exp);
    if (!Number.isFinite(expNum) || expNum * 1000 < Date.now()) return false;
    if (typeof sig !== 'string' || sig.length !== 32) return false;
    return safeEqual(computeSig(target, params, expNum), sig);
}

function detectPlatform(req) {
    const ua = String(req.headers['user-agent'] || '');
    if (/EClawAndroid|EClawIOS/i.test(ua)) return 'app_webview';
    if (/Android|iPhone|iPad|Mobile/i.test(ua)) return 'mobile_web';
    if (/bot|crawler|spider|curl|wget/i.test(ua)) return 'bot';
    return 'desktop_web';
}

async function logEvent(traceId, state, target, platform, fallbackReason) {
    if (!pool) return;
    try {
        await pool.query(
            `INSERT INTO redirect_events (trace_id, state, target, platform, fallback_reason)
             VALUES ($1, $2, $3, $4, $5)`,
            [traceId, state, target, platform || null, fallbackReason || null]
        );
    } catch (err) {
        console.warn('[Redirect] logEvent failed:', err.message);
    }
}

// Same auth contract as entity-status's authDeviceOrBot, trimmed to what the
// mint/stats endpoints need (no cookie path — these are bot/owner APIs).
function authDeviceOrBot(req) {
    const src = Object.assign({}, req.query, req.body || {});
    const deviceId = src.deviceId;
    if (!deviceId || !devicesRef || !devicesRef[deviceId]) return null;
    const device = devicesRef[deviceId];
    if (src.deviceSecret && safeEqual(device.deviceSecret, src.deviceSecret)) {
        return { deviceId };
    }
    if (src.botSecret) {
        const ents = device.entities || {};
        const eid = parseInt(src.entityId) || 0;
        if (eid > 0) {
            const e = ents[eid];
            if (e && e.isBound && e.botSecret && safeEqual(e.botSecret, src.botSecret)) return { deviceId, entityId: eid };
        } else {
            const match = Object.entries(ents).find(([, e]) =>
                e && e.isBound && e.botSecret && safeEqual(e.botSecret, src.botSecret));
            if (match) return { deviceId, entityId: Number(match[0]) };
        }
    }
    return null;
}

const router = express.Router();

// ── universal entry ──────────────────────────────────────────────────────
router.get('/r/:target', async (req, res) => {
    const target = String(req.params.target || '');
    const traceId = TRACE_RE.test(String(req.query.traceId || '')) ? req.query.traceId : mintTraceId();
    const platform = detectPlatform(req);

    if (!registry.isKnownTarget(target)) {
        await logEvent(traceId, 'SIG_REJECTED', target.slice(0, 64), platform, 'unknown_target');
        return res.redirect(302, '/portal/dashboard.html?redirectError=unknown');
    }
    await logEvent(traceId, 'RECEIVED', target, platform);

    const route = registry.ROUTES[target];
    const params = {};
    for (const name of route.params) params[name] = req.query[name];

    const paramCheck = registry.validateParams(target, params);
    if (!paramCheck.ok) {
        await logEvent(traceId, 'SIG_REJECTED', target, platform, paramCheck.error);
        return res.redirect(302, '/portal/dashboard.html?redirectError=invalid');
    }

    if (route.sensitive && !verifySig(target, params, req.query.exp, req.query.sig)) {
        // never a dead end — spec §3
        await logEvent(traceId, 'SIG_REJECTED', target, platform, 'bad_or_expired_sig');
        return res.redirect(302, '/portal/dashboard.html?redirectError=expired');
    }

    const dest = registry.buildWebUrl(target, params);
    const sep = dest.includes('?') ? '&' : '?';
    const hashIdx = dest.indexOf('#');
    const withTrace = hashIdx === -1
        ? dest + sep + 'traceId=' + traceId
        : dest.slice(0, hashIdx) + sep + 'traceId=' + traceId + dest.slice(hashIdx);

    // Phase B: Android mobile browsers get the 400 ms APP_ATTEMPT interstitial
    // (spec §4). Installed+verified apps never reach here — the OS routes the
    // link natively — so this covers app-not-installed / unverified, falling
    // back to the web target. Other platforms keep the Phase A straight 302.
    if (platform === 'mobile_web' && /Android/i.test(String(req.headers['user-agent'] || ''))) {
        await logEvent(traceId, 'APP_ATTEMPT', target, platform);
        return res.status(200).type('html').send(appAttemptInterstitial(withTrace, traceId, target));
    }
    await logEvent(traceId, 'WEB_DIRECT', target, platform);
    return res.redirect(302, withTrace);
});

// 400 ms app-attempt window (spec §3/§4, approved open-point 1 — activates
// with Phase B). Logs WEB_FALLBACK via the telemetry beacon when the timer
// fires, then JS-redirects to the web destination.
function appAttemptInterstitial(destUrl, traceId, target) {
    const dest = JSON.stringify(destUrl);
    const body = JSON.stringify({ traceId, state: 'WEB_FALLBACK', target, platform: 'mobile_web', fallbackReason: 'app_attempt_timeout' });
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="robots" content="noindex">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>EClaw</title></head>
<body style="background:#0D0D1A;margin:0">
<script>
setTimeout(function () {
    try { navigator.sendBeacon('/api/redirect/telemetry', new Blob([${JSON.stringify(body)}], { type: 'application/json' })); } catch (e) {}
    location.replace(${dest});
}, 400);
</script>
<noscript><meta http-equiv="refresh" content="0;url=${destUrl.replace(/"/g, '&quot;')}"></noscript>
</body></html>`;
}

// ── Android App Links verification (Phase B) ─────────────────────────────
// Digital Asset Links statement for com.hank.clawlive. Fingerprints come from
// ASSETLINKS_FINGERPRINTS (comma-separated SHA-256 cert digests) so the Play
// App Signing certificate can be added without a deploy-time code change; the
// committed default is the local release-key (upload) certificate.
const ANDROID_PACKAGE = 'com.hank.clawlive';
const UPLOAD_CERT_SHA256 = '0D:F0:18:33:A4:41:C4:02:74:9C:CF:4A:5A:59:F2:0C:62:00:3D:59:91:86:36:98:17:D5:89:50:47:DB:E8:10';

function assetlinksFingerprints() {
    const fromEnv = String(process.env.ASSETLINKS_FINGERPRINTS || '')
        .split(',').map(s => s.trim()).filter(Boolean);
    return fromEnv.length ? fromEnv : [UPLOAD_CERT_SHA256];
}

router.get('/.well-known/assetlinks.json', (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
    return res.json([{
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
            namespace: 'android_app',
            package_name: ANDROID_PACKAGE,
            sha256_cert_fingerprints: assetlinksFingerprints(),
        },
    }]);
});

// ── iOS Universal Links AASA (Phase C) ───────────────────────────────────
// apple-app-site-association maps https://eclawbot.com/r/* to the app whose
// `applinks:eclawbot.com` entitlement already exists (spec §3, #6 amendment 3).
// The appID is <TeamID>.<bundleID>; the Team ID lives in IOS_TEAM_ID (managed
// signing keeps it out of the repo). Without it we 404 rather than publish a
// broken AASA — a malformed file makes iOS silently stop verifying the domain.
const IOS_BUNDLE_ID = 'com.eclawbot.app';

function serveAASA(req, res) {
    const teamId = String(process.env.IOS_TEAM_ID || '').trim();
    if (!/^[A-Z0-9]{10}$/.test(teamId)) {
        return res.status(404).json({ error: 'aasa_unconfigured' });
    }
    // AASA must be served as application/json, no redirect, over HTTPS.
    res.type('application/json');
    res.set('Cache-Control', 'public, max-age=3600');
    return res.json({
        applinks: {
            apps: [],
            details: [{
                appID: `${teamId}.${IOS_BUNDLE_ID}`,
                paths: ['/r/*'],
            }],
        },
    });
}

// Apple fetches the root path first; the .well-known location is the modern
// canonical one. Serve both so old and new iOS both verify.
router.get('/apple-app-site-association', serveAASA);
router.get('/.well-known/apple-app-site-association', serveAASA);

// ── server-side mint (#6 amendment 2) ───────────────────────────────────
router.post('/api/redirect/mint', express.json(), async (req, res) => {
    const auth = authDeviceOrBot(req);
    if (!auth) return res.status(403).json({ success: false, error: 'Invalid credentials' });
    const { target, params } = req.body || {};
    const check = registry.validateParams(String(target || ''), params || {});
    if (!check.ok) return res.status(400).json({ success: false, error: check.error });
    const traceId = mintTraceId();
    let url = registry.buildUniversalUrl(target, params, traceId);
    if (registry.ROUTES[target].sensitive) {
        if (!signingSecret) return res.status(500).json({ success: false, error: 'signing_unavailable' });
        const ttl = Math.min(Number(req.body.ttlSeconds) || SIG_TTL_DEFAULT_S, 30 * 24 * 3600);
        const exp = Math.floor(Date.now() / 1000) + ttl;
        const sig = computeSig(target, params, exp);
        url += '&exp=' + exp + '&sig=' + sig;
    }
    return res.json({ success: true, url, traceId });
});

// ── client beacon for page-side transitions (TARGET_RENDERED etc.) ──────
router.post('/api/redirect/telemetry', express.json(), async (req, res) => {
    const { traceId, state, target } = req.body || {};
    if (!TRACE_RE.test(String(traceId || '')) || !STATES.includes(state) || !registry.isKnownTarget(String(target || ''))) {
        return res.status(400).json({ success: false, error: 'invalid_event' });
    }
    await logEvent(traceId, state, target, detectPlatform(req),
        typeof req.body.fallbackReason === 'string' ? req.body.fallbackReason.slice(0, 128) : null);
    return res.json({ success: true });
});

// ── stats: success rate per target/platform (spec §5) ───────────────────
router.get('/api/redirect/stats', async (req, res) => {
    const auth = authDeviceOrBot(req);
    if (!auth) return res.status(403).json({ success: false, error: 'Invalid credentials' });
    if (!pool) return res.json({ success: true, window: null, rows: [] });
    const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), RETENTION_DAYS);
    try {
        const r = await pool.query(`
            SELECT target, platform,
                   COUNT(*) FILTER (WHERE state = 'RECEIVED')::int                          AS received,
                   COUNT(DISTINCT trace_id) FILTER (WHERE state IN ('TARGET_RENDERED','APP_OPENED'))::int AS landed,
                   COUNT(*) FILTER (WHERE state = 'SIG_REJECTED')::int                      AS rejected
              FROM redirect_events
             WHERE created_at > NOW() - ($1 || ' days')::interval
             GROUP BY target, platform
             ORDER BY target, platform`,
            [days]
        );
        return res.json({ success: true, windowDays: days, rows: r.rows });
    } catch (err) {
        console.error('[Redirect] stats error:', err.message);
        return res.status(500).json({ success: false, error: 'internal' });
    }
});

module.exports = {
    router,
    init,
    _internal: { computeSig, verifySig, detectPlatform, mintTraceId, authDeviceOrBot, STATES, TRACE_RE },
};
