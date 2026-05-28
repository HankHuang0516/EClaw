'use strict';

const express = require('express');
const { chromium } = require('playwright');

const router = express.Router();

const MAX_COORDINATE = 100000;
const MAX_VIEWPORT = 20000;
const ALLOWED_HOSTS = (process.env.POINT_EDIT_ALLOWED_HOSTS || 'eclawbot.com,localhost,127.0.0.1')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const BROWSER_LAUNCH_TIMEOUT_MS = 30000;
const PAGE_NAV_TIMEOUT_MS = 20000;

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

function isAllowedHost(url) {
    if (!url) return false;
    return ALLOWED_HOSTS.some(
        (h) => url.hostname === h || url.hostname.endsWith('.' + h),
    );
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
    if (!isAllowedHost(url)) {
        return { error: 'unsupported_origin', hostname: url.hostname };
    }
    return { value: { x, y, viewportW, viewportH, url } };
}

const SCRIPT_BLOCK_RE = /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi;
const ON_ATTR_RE = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const JAVASCRIPT_URL_RE = /(href|src)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi;

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

router.post('/resolve-coordinate', async (req, res) => {
    const parsed = validateCoordinateBody(req.body || {});
    if (parsed.error) {
        if (parsed.error === 'unsupported_origin') {
            return res.status(422).json({
                success: false,
                error: 'unsupported_origin',
                message: 'Origin ' + parsed.hostname + ' is not in POINT_EDIT_ALLOWED_HOSTS.',
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
        console.error('[point-edit] resolver failure:', err);
        return res.status(500).json({
            success: false,
            error: 'resolver_failure',
            message: err.message,
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
    closeBrowser,
};
