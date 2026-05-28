'use strict';

const express = require('express');

const router = express.Router();

const MAX_COORDINATE = 100000;
const MAX_VIEWPORT = 20000;

const TARGETS = [
    {
        targetId: 'hero.title',
        selector: '[data-point-edit-id="hero.title"]',
        anchorId: 'hero',
        astPath: 'backend/public/portal/info.html:4959#hero.title',
        textSnippet: 'Faster than dragging files around',
        outerHTML: '<h2 class="ped-hero-title" data-point-edit-id="hero.title" data-i18n="ped_sb_hero_title">Faster than dragging files around</h2>',
        desktop: { x: 0.285, y: 0.315, w: 0.31, h: 0.045 },
        mobile: { x: 0.50, y: 0.315, w: 0.78, h: 0.045 },
    },
    {
        targetId: 'hero.sub',
        selector: '[data-point-edit-id="hero.sub"]',
        anchorId: 'hero',
        astPath: 'backend/public/portal/info.html:4960#hero.sub',
        textSnippet: 'Point at any element on the page and ask Claude to edit it.',
        outerHTML: '<p class="ped-hero-sub" data-point-edit-id="hero.sub" data-i18n="ped_sb_hero_sub">Point at any element on the page and ask Claude to edit it.</p>',
        desktop: { x: 0.315, y: 0.358, w: 0.36, h: 0.035 },
        mobile: { x: 0.50, y: 0.358, w: 0.82, h: 0.035 },
    },
    {
        targetId: 'feature.title',
        selector: '[data-point-edit-id="feature.title"]',
        anchorId: 'feature.card',
        astPath: 'backend/public/portal/info.html:4964#feature.title',
        textSnippet: 'Zero install',
        outerHTML: '<h3 class="ped-feature-title" data-point-edit-id="feature.title" data-i18n="ped_sb_feature_title">Zero install</h3>',
        desktop: { x: 0.205, y: 0.432, w: 0.12, h: 0.032 },
        mobile: { x: 0.37, y: 0.432, w: 0.30, h: 0.032 },
    },
    {
        targetId: 'feature.body',
        selector: '[data-point-edit-id="feature.body"]',
        anchorId: 'feature.card',
        astPath: 'backend/public/portal/info.html:4965#feature.body',
        textSnippet: 'Works in any browser. No extension. The page is the target.',
        outerHTML: '<p class="ped-feature-body" data-point-edit-id="feature.body" data-i18n="ped_sb_feature_body">Works in any browser. No extension. The page is the target.</p>',
        desktop: { x: 0.33, y: 0.475, w: 0.34, h: 0.035 },
        mobile: { x: 0.55, y: 0.475, w: 0.72, h: 0.035 },
    },
    {
        targetId: 'cta.button',
        selector: '[data-point-edit-id="cta.button"]',
        anchorId: 'cta.block',
        astPath: 'backend/public/portal/info.html:4968#cta.button',
        textSnippet: 'Buy Now',
        outerHTML: '<button class="ped-cta-btn" type="button" data-point-edit-id="cta.button" data-i18n="ped_sb_cta_label">Buy Now</button>',
        desktop: { x: 0.165, y: 0.558, w: 0.095, h: 0.048 },
        mobile: { x: 0.245, y: 0.558, w: 0.25, h: 0.048 },
    },
    {
        targetId: 'cta.foot',
        selector: '[data-point-edit-id="cta.foot"]',
        anchorId: 'cta.block',
        astPath: 'backend/public/portal/info.html:4969#cta.foot',
        textSnippet: 'or browse the catalogue',
        outerHTML: '<span class="ped-cta-foot" data-point-edit-id="cta.foot" data-i18n="ped_sb_cta_foot">&mdash; or browse the catalogue</span>',
        desktop: { x: 0.30, y: 0.558, w: 0.18, h: 0.032 },
        mobile: { x: 0.56, y: 0.558, w: 0.42, h: 0.032 },
    },
    {
        targetId: 'note.p1',
        selector: '[data-point-edit-id="note.p1"]',
        anchorId: 'note.block',
        astPath: 'backend/public/portal/info.html:4972#note.p1',
        textSnippet: 'Friction matters. The editor that needs three steps to find a button loses to the one that takes one click.',
        outerHTML: '<p data-point-edit-id="note.p1" data-i18n="ped_sb_note_p1">Friction matters. The editor that needs three steps to find a button loses to the one that takes one click. Point-and-edit cuts the address-typing tax: instead of describing where an element lives in your DOM tree, you point.</p>',
        desktop: { x: 0.33, y: 0.660, w: 0.43, h: 0.105 },
        mobile: { x: 0.50, y: 0.660, w: 0.82, h: 0.125 },
    },
    {
        targetId: 'note.p2',
        selector: '[data-point-edit-id="note.p2"]',
        anchorId: 'note.block',
        astPath: 'backend/public/portal/info.html:4973#note.p2',
        textSnippet: 'Try selecting a fragment of this very sentence in Track D mode - the selection itself becomes the anchor.',
        outerHTML: '<p data-point-edit-id="note.p2" data-i18n="ped_sb_note_p2">Try selecting a fragment of <em data-point-edit-id="note.em">this very sentence</em> in Track D mode - the selection itself becomes the anchor.</p>',
        desktop: { x: 0.34, y: 0.755, w: 0.42, h: 0.065 },
        mobile: { x: 0.50, y: 0.775, w: 0.82, h: 0.085 },
    },
    {
        targetId: 'agent.name',
        selector: '[data-point-edit-id="agent.name"]',
        anchorId: 'agent.card',
        astPath: 'backend/public/portal/info.html:4978#agent.name',
        textSnippet: 'EClaw Agent',
        outerHTML: '<span class="ped-agent-name" data-point-edit-id="agent.name" data-i18n="ped_sb_agent_name">EClaw Agent</span>',
        desktop: { x: 0.20, y: 0.855, w: 0.12, h: 0.032 },
        mobile: { x: 0.36, y: 0.872, w: 0.30, h: 0.032 },
    },
    {
        targetId: 'agent.tag',
        selector: '[data-point-edit-id="agent.tag"]',
        anchorId: 'agent.card',
        astPath: 'backend/public/portal/info.html:4980#agent.tag',
        textSnippet: 'I edit your page in place. Tell me what to change.',
        outerHTML: '<p class="ped-agent-tag" data-point-edit-id="agent.tag" data-i18n="ped_sb_agent_tag">I edit your page in place. Tell me what to change.</p>',
        desktop: { x: 0.30, y: 0.905, w: 0.32, h: 0.035 },
        mobile: { x: 0.50, y: 0.920, w: 0.76, h: 0.035 },
    },
];

function toFiniteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function round(value) {
    return Math.round(value * 1000) / 1000;
}

function normalizeUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
    try {
        return new URL(rawUrl, 'https://eclawbot.com');
    } catch (_) {
        return null;
    }
}

function isPointEditDemoUrl(url) {
    if (!url) return false;
    if (url.pathname === '/info' || url.pathname === '/portal/info.html') return true;
    return false;
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
    if (Math.abs(x) > MAX_COORDINATE || Math.abs(y) > MAX_COORDINATE || viewportW > MAX_VIEWPORT || viewportH > MAX_VIEWPORT) {
        return { error: 'coordinate payload is outside supported bounds' };
    }
    if (!url) {
        return { error: 'url is required and must be a valid URL' };
    }
    return { value: { x, y, viewportW, viewportH, url } };
}

function chooseProfile(viewportW) {
    return viewportW <= 760 ? 'mobile' : 'desktop';
}

function rectFromProfile(profileRect, viewportW, viewportH) {
    const w = Math.max(1, Math.round(profileRect.w * viewportW));
    const h = Math.max(1, Math.round(profileRect.h * viewportH));
    const cx = profileRect.x * viewportW;
    const cy = profileRect.y * viewportH;
    return {
        x: Math.round(cx - w / 2),
        y: Math.round(cy - h / 2),
        w,
        h,
    };
}

function scoreTarget(target, nx, ny, profile) {
    const anchor = target[profile];
    const dx = nx - anchor.x;
    const dy = ny - anchor.y;
    return Math.sqrt((dx * dx * 1.35) + (dy * dy));
}

function resolveCoordinate(input) {
    const profile = chooseProfile(input.viewportW);
    const nx = clamp(input.x / input.viewportW, 0, 1);
    const ny = clamp(input.y / input.viewportH, 0, 1);

    let best = null;
    for (const target of TARGETS) {
        const score = scoreTarget(target, nx, ny, profile);
        if (!best || score < best.score) best = { target, score };
    }

    if (!best || best.score > 0.38) return null;

    const target = best.target;
    const rect = rectFromProfile(target[profile], input.viewportW, input.viewportH);
    const confidence = round(clamp(0.96 - best.score * 1.35, 0.65, 0.96));

    return {
        mode: 'coord',
        targetId: target.targetId,
        selector: target.selector,
        anchorId: target.anchorId,
        coordinates: {
            x: Math.round(input.x),
            y: Math.round(input.y),
            viewportW: Math.round(input.viewportW),
            viewportH: Math.round(input.viewportH),
            normalizedX: round(nx),
            normalizedY: round(ny),
        },
        outerHTML: target.outerHTML,
        textSnippet: target.textSnippet,
        rect,
        confidence,
        sourceHint: `ast:${target.astPath}`,
        astPath: target.astPath,
    };
}

router.post('/resolve-coordinate', (req, res) => {
    const parsed = validateCoordinateBody(req.body || {});
    if (parsed.error) return res.status(400).json({ success: false, error: parsed.error });

    const input = parsed.value;
    if (!isPointEditDemoUrl(input.url)) {
        return res.status(422).json({
            success: false,
            error: 'unsupported_url',
            message: 'Coordinate resolver currently supports the point-edit demo page.',
        });
    }

    const target = resolveCoordinate(input);
    if (!target) {
        return res.status(404).json({
            success: false,
            error: 'target_not_found',
            message: 'No point-edit target was close enough to the submitted coordinate.',
        });
    }

    res.json(target);
});

module.exports = {
    router,
    resolveCoordinate,
    validateCoordinateBody,
    isPointEditDemoUrl,
    TARGETS,
};
