'use strict';

/**
 * Regression: chat + card-detail image rendering (cards card_e8b4bc7b / card_c17d3c7b)
 *
 * 1. Chat image attachments render as an inline <img> THUMBNAIL (opens the
 *    lightbox on tap), not a tappable file chip.
 * 2. Card-detail always surfaces attached images even when the screenshot-review
 *    gate (requiresScreenshotReview) is off — under a 附件 block.
 * 3. The entity-modal close (✕) button is pinned to the top-right CORNER of the
 *    chip container so it is not obscured by the 📌 requote icon.
 *
 * These are static assertions over public/portal/chat.html — the same style as
 * chat-kanban-message-deeplink-static.test.js — because the render logic lives
 * inside a large closure that is impractical to import. Behaviour is separately
 * proven by a headless render harness (see PR description).
 */

const fs = require('fs');
const path = require('path');

const CHAT_HTML = path.join(__dirname, '../../public/portal/chat.html');

describe('chat/card image rendering', () => {
    let html;
    beforeAll(() => { html = fs.readFileSync(CHAT_HTML, 'utf8'); });

    describe('1. inline image thumbnails in chat', () => {
        test('image attachments emit an <img> thumbnail (not the file chip)', () => {
            expect(html).toContain('class="msg-attachment-img" data-attachment-fileid=');
            expect(html).toContain('onclick="event.stopPropagation();openAttachmentImage(this)"');
            expect(html).toContain('loading="lazy"');
        });

        test('image branch runs BEFORE the tappable file-chip builder', () => {
            const imgIdx = html.indexOf('class="msg-attachment-img" data-attachment-fileid=');
            const chipIdx = html.indexOf("onclick=\"previewAttachment('${fileIdAttr}')\"");
            expect(imgIdx).toBeGreaterThan(-1);
            expect(chipIdx).toBeGreaterThan(-1);
            expect(imgIdx).toBeLessThan(chipIdx);
        });

        test('lazy media loader hydrates img[data-attachment-fileid] and stashes resolvedUrl', () => {
            expect(html).toContain('img[data-attachment-fileid]');
            expect(html).toContain('el.dataset.resolvedUrl = data.url;');
        });

        test('openAttachmentImage opens the existing lightbox', () => {
            expect(html).toContain('async function openAttachmentImage(imgEl)');
            expect(html).toContain('openChatLightbox(ready, name)');
        });

        test('thumbnail CSS caps at ~220px and is rounded', () => {
            const block = (html.match(/\.msg-attachment-img\s*\{[\s\S]*?\}/) || [''])[0];
            expect(block).toMatch(/max-width:\s*220px/);
            expect(block).toMatch(/border-radius:\s*10px/);
        });
    });

    describe('2. card-detail surfaces images even when review gate is off', () => {
        test('gate-off path renders attached images under a 附件 block', () => {
            expect(html).toContain('🖼️ 附件');
        });

        test('gate-on path keeps the 截圖審查 review banner', () => {
            expect(html).toContain('📸 截圖審查');
            expect(html).toContain('此卡需截圖審查');
        });
    });

    describe('3. entity-modal close button pinned to top-right corner', () => {
        test('markup places a corner close button above content', () => {
            expect(html).toContain('class="entity-modal-close entity-modal-close-corner"');
        });

        test('corner close is absolutely positioned with a >=40px tap target', () => {
            const block = (html.match(/\.entity-modal-close-corner\s*\{[\s\S]*?\}/) || [''])[0];
            expect(block).toMatch(/position:\s*absolute/);
            expect(block).toMatch(/width:\s*40px/);
            expect(block).toMatch(/height:\s*40px/);
        });

        test('modal-box is a positioning context and header reserves room', () => {
            const boxBlock = (html.match(/#entityPreviewModal \.modal-box\s*\{[\s\S]*?\}/) || [''])[0];
            expect(boxBlock).toMatch(/position:\s*relative/);
            const hdrBlock = (html.match(/#entityPreviewModal \.entity-modal-header\s*\{[\s\S]*?\}/) || [''])[0];
            expect(hdrBlock).toMatch(/padding-right:\s*44px/);
        });
    });
});
