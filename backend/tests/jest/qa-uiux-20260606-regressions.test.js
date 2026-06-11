'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const kanbanHtml = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'kanban.html'), 'utf8');
const communityHtml = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'community.html'), 'utf8');
const portalStyle = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'shared', 'style.css'), 'utf8');
const publisherHtml = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'publisher.html'), 'utf8');

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
