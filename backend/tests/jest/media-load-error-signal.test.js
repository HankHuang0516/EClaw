'use strict';

const fs = require('fs');
const path = require('path');

const CHAT_HTML = path.join(__dirname, '../../public/portal/chat.html');
const FILES_HTML = path.join(__dirname, '../../public/portal/files.html');

describe('portal media load failure signals', () => {
    let chatHtml;
    let filesHtml;

    beforeAll(() => {
        chatHtml = fs.readFileSync(CHAT_HTML, 'utf8');
        filesHtml = fs.readFileSync(FILES_HTML, 'utf8');
    });

    test('files photo thumbnails render an explicit broken/retry state', () => {
        expect(filesHtml).toContain('class="file-thumb-error broken retry"');
        expect(filesHtml).toContain('function handleFileThumbError(img)');
        expect(filesHtml).toContain('function retryFileThumb(btn, event)');
        expect(filesHtml).toContain('onerror="handleFileThumbError(this)"');
        expect(filesHtml).not.toContain("onerror=\"this.parentElement.innerHTML='");
    });

    test('chat photo media uses a visible retry placeholder instead of hiding failed images', () => {
        expect(chatHtml).toContain('class="chat-media-error broken retry');
        expect(chatHtml).toContain('function handleChatMediaError(img)');
        expect(chatHtml).toContain('function retryChatMedia(btn)');
        expect(chatHtml).toContain('onerror="handleChatMediaError(this)"');
        expect(chatHtml).toContain('data-backup-src="${backupSrc}"');
        expect(chatHtml).not.toMatch(/class="chat-photo"[\s\S]{0,220}onerror="this\.style\.display='none'"/);
        expect(chatHtml).not.toMatch(/class="chat-inline-img"[\s\S]{0,220}onerror="this\.style\.display='none'"/);
    });

    test('mention profile avatar failure is visible and retryable', () => {
        expect(chatHtml).toContain('class="mention-profile-avatar-shell"');
        expect(chatHtml).toContain('class="mention-avatar-error broken retry"');
        expect(chatHtml).toContain('function handleMentionAvatarError(img)');
        expect(chatHtml).toContain('function retryMentionAvatar(btn)');
        expect(chatHtml).toContain('onerror="handleMentionAvatarError(this)"');
        expect(chatHtml).not.toMatch(/mention-profile-avatar[\s\S]{0,220}onerror="this\.style\.display='none'"/);
    });
});
