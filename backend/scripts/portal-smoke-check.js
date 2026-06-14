#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const CRITICAL_PAGES = [
    {
        file: 'portal/dashboard.html',
        anchors: ['id="entityGrid"', 'function loadEntities', 'entity_poll_empty_skipped', 'serverReady'],
    },
    {
        file: 'portal/chat.html',
        anchors: ['id="chatMessages"', 'id="targetBar"', 'id="messageInput"', 'async function sendMessage'],
    },
    {
        file: 'portal/kanban.html',
        anchors: ['id="kbBoard"', 'id="col-todo"', 'id="detailModal"', 'function postComment'],
    },
    {
        file: 'portal/info.html',
        anchors: ['id="panel-channel-plugins"', 'id="guide-codex-channel"', 'codex-eclaw-bridge'],
    },
    {
        file: 'portal/marketplace.html',
        anchors: ['id="listingGrid"', 'id="detailModal"', '/api/rental/marketplace?', '/api/rental/contract'],
    },
];

function fail(errors, file, message) {
    errors.push(`${file}: ${message}`);
}

function isExternal(url) {
    return /^(https?:)?\/\//i.test(url) || /^(mailto|tel):/i.test(url);
}

function cleanAssetUrl(raw) {
    return raw.split('#')[0].split('?')[0];
}

function resolveAsset(pageFile, rawUrl) {
    const url = cleanAssetUrl(rawUrl);
    if (!url || isExternal(url)) return null;
    if (url === '/socket.io/socket.io.js') return null;
    // /shared-core/* is an Express static mount onto backend/shared/ (index.js
    // line ~881). Translate so the smoke check finds the source file.
    if (url.startsWith('/shared-core/')) return path.join(ROOT, 'shared', url.slice('/shared-core/'.length));
    if (url.startsWith('/')) return path.join(PUBLIC, url);
    return path.join(path.dirname(path.join(PUBLIC, pageFile)), url);
}

function assertAssetsExist(pageFile, html, errors) {
    const attrRe = /<(script|link)\b[^>]*(?:src|href)=["']([^"']+)["'][^>]*>/gi;
    for (const match of html.matchAll(attrRe)) {
        const tag = match[0];
        const url = match[2];
        if (tag.startsWith('<link') && !/\brel=["']?stylesheet["']?/i.test(tag)) continue;
        const resolved = resolveAsset(pageFile, url);
        if (resolved && !fs.existsSync(resolved)) {
            fail(errors, pageFile, `missing asset ${url}`);
        }
    }
}

function assertInlineScriptsParse(pageFile, html, errors) {
    let index = 0;
    const inlineScriptRe = /<script\b(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi;
    for (const match of html.matchAll(inlineScriptRe)) {
        index += 1;
        const attrs = match[1] || '';
        if (/\btype=["']application\/ld\+json["']/i.test(attrs)) continue;
        const code = match[2].trim();
        if (!code) continue;
        try {
            new vm.Script(code, { filename: `${pageFile}#inline-script-${index}.js` });
        } catch (err) {
            fail(errors, pageFile, `inline script ${index} syntax error: ${err.message}`);
        }
    }
}

function assertAnchors(page, html, errors) {
    for (const anchor of page.anchors) {
        if (!html.includes(anchor)) {
            fail(errors, page.file, `missing critical anchor ${anchor}`);
        }
    }
}

function runPortalSmokeCheck() {
    const errors = [];
    for (const page of CRITICAL_PAGES) {
        const abs = path.join(PUBLIC, page.file);
        if (!fs.existsSync(abs)) {
            fail(errors, page.file, 'page file missing');
            continue;
        }
        const html = fs.readFileSync(abs, 'utf8');
        assertAnchors(page, html, errors);
        assertAssetsExist(page.file, html, errors);
        assertInlineScriptsParse(page.file, html, errors);
    }
    return { ok: errors.length === 0, errors };
}

if (require.main === module) {
    const result = runPortalSmokeCheck();
    if (!result.ok) {
        console.error('Portal smoke check failed:\n' + result.errors.map(e => `  - ${e}`).join('\n'));
        process.exit(1);
    }
    console.log('Portal smoke check passed');
}

module.exports = { runPortalSmokeCheck };
