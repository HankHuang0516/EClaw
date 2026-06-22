'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { chromium } = require('playwright');

const router = express.Router();

const MAX_COORDINATE = 100000;
const MAX_VIEWPORT = 20000;
// SSRF hardening: in prod, default origin allow-list excludes loopback; any operator
// override is still gated by the hard guard in isAllowedHost (see below).
const IS_PROD =
    process.env.NODE_ENV === 'production' ||
    process.env.RAILWAY_ENVIRONMENT === 'production';
const DEFAULT_ALLOWED_HOSTS = IS_PROD
    ? 'eclawbot.com'
    : 'eclawbot.com,localhost,127.0.0.1';
const ALLOWED_HOSTS = (process.env.POINT_EDIT_ALLOWED_HOSTS || DEFAULT_ALLOWED_HOSTS)
    .split(',')
    .map((s) => s.trim())
    .map((s) => normalizeHostname(s))
    .filter(Boolean);
const BROWSER_LAUNCH_TIMEOUT_MS = 30000;
const PAGE_NAV_TIMEOUT_MS = 20000;

// Per-route rate limit: resolveCoordinate boots a headless Playwright page per
// request — much heavier than typical API calls — so the global 100/min cap
// is too loose. Default 15/min/IP; operators can tune via env. Disabled when
// RATE_LIMIT_DISABLED=1 (used in dev + jest).
const RESOLVE_RATE_LIMIT_MAX = Math.max(
    1,
    Number(process.env.POINT_EDIT_RATE_LIMIT_PER_MIN || 15)
);
const resolveCoordinateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: RESOLVE_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.RATE_LIMIT_DISABLED === '1',
    message: {
        success: false,
        error: 'rate_limited',
        message: `Point-edit resolve-coordinate rate limit exceeded (max ${RESOLVE_RATE_LIMIT_MAX}/min per IP).`,
    },
});

let _browserPromise = null;
async function getBrowser() {
    if (!_browserPromise) {
        _browserPromise = chromium
            .launch({ headless: true, timeout: BROWSER_LAUNCH_TIMEOUT_MS })
            .catch((err) => {
                _browserPromise = null;
                throw err;
            });
    }
    return _browserPromise;
}

async function closeBrowser() {
    if (_browserPromise) {
        try {
            const browser = await _browserPromise;
            await browser.close();
        } catch (_) {
            // ignore
        }
        _browserPromise = null;
    }
}

function toFiniteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function normalizeUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
    try {
        return new URL(rawUrl, 'https://eclawbot.com');
    } catch (_) {
        return null;
    }
}

function normalizeHostname(hostname) {
    if (typeof hostname !== 'string') return '';
    return hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

function isPrivateIpv4(hostname) {
    // Returns true if hostname is a literal IPv4 in a private/loopback/link-local range.
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
    if (!m) return false;
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 10 || a === 127) return true;        // any-host, RFC1918 10/8, loopback
    if (a === 169 && b === 254) return true;                  // link-local (incl. AWS metadata 169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true;         // RFC1918 172.16/12
    if (a === 192 && b === 168) return true;                  // RFC1918 192.168/16
    return false;
}

function isPrivateIpv6(hostname) {
    const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (h === '::1') return true;                              // loopback
    if (h.startsWith('fe80:')) return true;                    // link-local
    if (/^(fc|fd)[0-9a-f]{0,2}:/.test(h)) return true;         // ULA (fc00::/7)
    return false;
}

function isAllowedRequestUrl(rawUrl) {
    // Pure scheme + host check, used by both the initial-URL gate (via isAllowedHost)
    // and the per-request Playwright route interceptor. Blocks non-http(s) schemes
    // (data:, file:, javascript:, etc.) and prod loopback/private/link-local/ULA hosts.
    let url;
    try {
        url = new URL(rawUrl);
    } catch (_) {
        return false;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    if (IS_PROD && url.protocol !== 'https:') return false;

    const hostname = normalizeHostname(url.hostname);
    if (IS_PROD) {
        if (hostname === 'localhost') return false;
        if (isPrivateIpv4(hostname)) return false;
        if (isPrivateIpv6(hostname)) return false;
    }
    return ALLOWED_HOSTS.some(
        (h) => hostname === h || hostname.endsWith('.' + h),
    );
}

function isAllowedHost(url) {
    if (!url) return false;
    return isAllowedRequestUrl(url.toString());
}

async function installRequestGuard(context) {
    await context.route('**/*', async (route) => {
        const requestUrl = route.request().url();
        if (!isAllowedRequestUrl(requestUrl)) {
            return route.abort('addressunreachable');
        }
        return route.continue();
    });
}

function validateCoordinateBody(body) {
    const x = toFiniteNumber(body && body.x);
    const y = toFiniteNumber(body && body.y);
    const viewportW = toFiniteNumber(body && body.viewportW);
    const viewportH = toFiniteNumber(body && body.viewportH);
    const url = normalizeUrl(body && body.url);

    if (x === null || y === null) {
        return { error: 'x and y are required finite numbers' };
    }
    if (viewportW === null || viewportH === null || viewportW <= 0 || viewportH <= 0) {
        return { error: 'viewportW and viewportH are required positive numbers' };
    }
    if (
        Math.abs(x) > MAX_COORDINATE ||
        Math.abs(y) > MAX_COORDINATE ||
        viewportW > MAX_VIEWPORT ||
        viewportH > MAX_VIEWPORT
    ) {
        return { error: 'coordinate payload is outside supported bounds' };
    }
    if (!url) {
        return { error: 'url is required and must be a valid URL' };
    }
    if (IS_PROD && url.protocol !== 'https:') {
        return { error: 'insecure_scheme', protocol: url.protocol };
    }
    if (!isAllowedHost(url)) {
        return { error: 'unsupported_origin', hostname: url.hostname };
    }
    return { value: { x, y, viewportW, viewportH, url } };
}

const SCRIPT_BLOCK_RE = /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi;
const ON_ATTR_RE = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const JAVASCRIPT_URL_RE = /(href|src)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi;

// Strips obvious script vectors so this outerHTML is safe to embed in a JSON
// response that callers render as TEXT (debug panel, copy-paste, syntax
// highlight). If a future caller ever passes this string back into the DOM via
// innerHTML / dangerouslySetInnerHTML, swap to sanitize-html or DOMPurify —
// regex strips are not a full XSS sanitizer.
function sanitizeOuterHTML(html) {
    if (typeof html !== 'string') return '';
    return html
        .replace(SCRIPT_BLOCK_RE, '')
        .replace(ON_ATTR_RE, '')
        .replace(JAVASCRIPT_URL_RE, '$1="#"');
}

/* eslint-disable no-undef */
// buildSelectorScript returns a function executed via page.evaluate() inside
// the headless browser, where `window` and `document` are valid globals.
function buildSelectorScript() {
    return ({ x, y }) => {
        function cssEscape(s) {
            if (window.CSS && window.CSS.escape) return window.CSS.escape(s);
            return String(s).replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch);
        }
        function selectorFor(el) {
            if (!el || el === document.documentElement) return 'html';
            if (el.id) return '#' + cssEscape(el.id);
            const tag = el.tagName.toLowerCase();
            const parent = el.parentElement;
            if (!parent) return tag;
            const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
            const idx = same.indexOf(el) + 1;
            const head = selectorFor(parent);
            return head + ' > ' + tag + ':nth-of-type(' + idx + ')';
        }
        const el = document.elementFromPoint(x, y);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const anchor =
            el.closest('[id]') ||
            el.closest('section, article, main, header, footer, nav, [role="region"]');
        const outerHTML = el.outerHTML.length > 4000
            ? el.outerHTML.slice(0, 4000) + '...'
            : el.outerHTML;
        return {
            selector: selectorFor(el),
            anchorId: anchor && anchor.id ? anchor.id : null,
            outerHTML,
            textSnippet: (el.innerText || el.textContent || '').trim().slice(0, 240),
            rect: {
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                w: Math.round(rect.width),
                h: Math.round(rect.height),
            },
            tagName: el.tagName.toLowerCase(),
        };
    };
}
/* eslint-enable no-undef */

async function resolveCoordinate(input) {
    const browser = await getBrowser();
    const viewportW = Math.round(input.viewportW);
    const viewportH = Math.round(input.viewportH);
    const context = await browser.newContext({
        viewport: { width: viewportW, height: viewportH },
        deviceScaleFactor: 1,
    });
    let result = null;
    try {
        await installRequestGuard(context);
        const page = await context.newPage();
        await page.goto(input.url.toString(), {
            waitUntil: 'domcontentloaded',
            timeout: PAGE_NAV_TIMEOUT_MS,
        });
        const x = Math.max(0, Math.min(Math.round(input.x), viewportW - 1));
        const y = Math.max(0, Math.min(Math.round(input.y), viewportH - 1));
        result = await page.evaluate(buildSelectorScript(), { x, y });
    } finally {
        await context.close();
    }
    if (!result) return null;
    return {
        mode: 'coord',
        targetId: result.anchorId || result.selector,
        selector: result.selector,
        anchorId: result.anchorId,
        coordinates: {
            x: Math.round(input.x),
            y: Math.round(input.y),
            viewportW,
            viewportH,
        },
        outerHTML: sanitizeOuterHTML(result.outerHTML),
        textSnippet: result.textSnippet,
        rect: result.rect,
        confidence: 0.90,
        sourceHint: 'live:' + input.url.toString(),
    };
}

router.post('/resolve-coordinate', resolveCoordinateLimiter, async (req, res) => {
    const parsed = validateCoordinateBody(req.body || {});
    if (parsed.error) {
        if (parsed.error === 'unsupported_origin') {
            return res.status(422).json({
                success: false,
                error: 'unsupported_origin',
                message: 'Origin ' + parsed.hostname + ' is not in POINT_EDIT_ALLOWED_HOSTS.',
            });
        }
        if (parsed.error === 'insecure_scheme') {
            return res.status(422).json({
                success: false,
                error: 'insecure_scheme',
                message: 'Scheme ' + parsed.protocol + ' is not allowed; https is required in production.',
            });
        }
        return res.status(400).json({ success: false, error: parsed.error });
    }
    try {
        const target = await resolveCoordinate(parsed.value);
        if (!target) {
            return res.status(404).json({
                success: false,
                error: 'target_not_found',
                message: 'No element at that coordinate.',
            });
        }
        return res.json(target);
    } catch (err) {
        // Concise, single-line message. Playwright prints a multi-line "install
        // browsers" banner (╔══ … npx playwright install … <3 Playwright Team)
        // when the Chromium executable is missing; logging the full err object
        // makes the prod ErrLog monitor split that banner into ~9 separate ERROR
        // cards. Log ONE line and, for the capability gap, degrade to 503.
        const firstLine = String(err && err.message ? err.message : err).split('\n')[0];
        const browserMissing = /Executable doesn't exist|playwright install|browserType\.launch/i
            .test(err && err.message ? err.message : '');
        if (browserMissing) {
            // Headless Chromium isn't provisioned in this runtime (nixpacks prod
            // runs `npm install` only, not `npx playwright install`). Treat as a
            // disabled capability, not a crash. To ENABLE point-edit in prod, add
            // `npx playwright install --with-deps chromium` to the build.
            console.error('[point-edit] headless Chromium unavailable in this runtime — point-edit disabled (enable via `npx playwright install chromium`)');
            return res.status(503).json({
                success: false,
                error: 'point_edit_unavailable',
                message: 'Point-edit (headless browser) is not available in this environment.',
            });
        }
        console.error('[point-edit] resolver failure:', firstLine);
        return res.status(500).json({
            success: false,
            error: 'resolver_failure',
            message: firstLine,
        });
    }
});

const TARGETS = [];
function isPointEditDemoUrl(_url) {
    return true;
}

module.exports = {
    router,
    resolveCoordinate,
    validateCoordinateBody,
    isPointEditDemoUrl,
    TARGETS,
    sanitizeOuterHTML,
    isAllowedRequestUrl,
    installRequestGuard,
    closeBrowser,
};
