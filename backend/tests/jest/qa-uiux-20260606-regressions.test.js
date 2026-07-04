'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const kanbanHtml = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'kanban.html'), 'utf8');
const communityHtml = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'community.html'), 'utf8');
const portalStyle = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'shared', 'style.css'), 'utf8');
const publisherHtml = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'publisher.html'), 'utf8');

function loadCommunityFunction(name, nextMarker) {
    const start = communityHtml.indexOf(`function ${name}`);
    const end = communityHtml.indexOf(nextMarker, start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const sandbox = { result: null };
    vm.createContext(sandbox);
    vm.runInContext(`${communityHtml.slice(start, end)}\nresult = ${name};`, sandbox);
    return sandbox.result;
}

describe('QA/UIUX 2026-06-06 regression guards', () => {
    test('kanban automation status filter includes Backlog and migrates the legacy 5-status default', () => {
        expect(kanbanHtml).toContain("const AUTO_FILTER_STATUSES = ['backlog','todo','in_progress','review','done','blocked'];");
        expect(kanbanHtml).toContain('const LEGACY_AUTO_FILTER_STATUSES');
        expect(kanbanHtml).toContain("return isLegacyFullDefault ? ['backlog', ...known] : known;");
    });

    test('Bot Plaza search ignores stale loadBots responses from older filter/search requests', () => {
        expect(communityHtml).toContain('let loadBotsRequestSeq = 0;');
        expect(communityHtml).toContain('const requestSeq = ++loadBotsRequestSeq;');
        expect(communityHtml).toContain('if (requestSeq !== loadBotsRequestSeq) return;');
        expect(communityHtml).toContain('if (requestSeq === loadBotsRequestSeq)');
    });

    test('Bot Plaza normalizes object-shaped community capability maps before rendering chips', () => {
        expect(communityHtml).toContain('function normalizeCommunityCapabilities(raw)');
        expect(communityHtml).toContain('Object.entries(raw)');
        expect(communityHtml).toContain('value.supported === false');
        expect(communityHtml).toContain('caps: normalizeCommunityCapabilities(r.capabilities)');
        expect(communityHtml).not.toContain('caps: (r.capabilities || []).map');

        const normalize = loadCommunityFunction('normalizeCommunityCapabilities', 'async function loadBots');
        expect(normalize([{ id: 'vision' }, { name: 'Web Browse' }, 'coding'])).toEqual(['vision', 'Web Browse', 'coding']);
        expect(normalize({
            voice: { supported: true, probes: [] },
            reasoning: { supported: false, probes: [] },
            custom: { supported: true, name: 'Custom Tool' },
        })).toEqual(['voice', 'Custom Tool']);
        expect(normalize('search')).toEqual(['search']);
        expect(normalize(null)).toEqual([]);
    });

    test('authenticated portal nav compresses at laptop desktop widths before account controls overflow', () => {
        expect(portalStyle).toContain('@media (min-width: 769px) and (max-width: 1440px)');
        expect(portalStyle).toContain('.nav-links {\n        min-width: 0;\n        overflow: hidden;');
        expect(portalStyle).toContain('.nav-user .email {\n        max-width: 96px;');
    });

    test('Publisher API key row wraps on narrow mobile screens', () => {
        expect(publisherHtml).toContain('@media (max-width: 480px)');
        expect(publisherHtml).toContain('.key-bar {\n                flex-wrap: wrap;');
        expect(publisherHtml).toContain('flex: 1 1 150px;');
    });
});
