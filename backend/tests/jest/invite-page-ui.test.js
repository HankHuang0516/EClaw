const fs = require('fs');
const path = require('path');

describe('invite page self-improvement UI', () => {
    const invitePath = path.join(__dirname, '../../public/portal/invite.html');
    const html = fs.readFileSync(invitePath, 'utf8');

    test('renders a live share status and explicit share-link copy action', () => {
        expect(html).toContain('id="invShareStatus" role="status" aria-live="polite" aria-atomic="true"');
        expect(html).toContain('id="invCopyLinkBtn" onclick="copyInviteLink()" disabled');
        expect(html).toContain('function setInviteShareStatus(message, state = \'idle\')');
        expect(html).toContain('function setInviteShareLink(shareUrl)');
        expect(html).toContain('shareEl.dataset.shareUrl = shareUrl || \'\'');
        expect(html).toContain('if (copyLinkBtn) copyLinkBtn.disabled = !shareUrl');
    });

    test('uses clipboard fallback and visible failure feedback for both copy actions', () => {
        expect(html).toContain('async function writeClipboardText(text)');
        expect(html).toContain('navigator.clipboard.writeText(text)');
        expect(html).toContain("document.execCommand('copy')");
        expect(html).toContain('async function copyCode()');
        expect(html).toContain('async function copyInviteLink()');
        expect(html).toContain("tt('invite_qr_toast_copied', 'Copied to clipboard')");
        expect(html).toContain("tt('toast_copy_failed', 'Failed to copy");
    });

    test('does not leave anonymous users with loading invite widgets', () => {
        expect(html).toContain('function setInviteSignedOutState()');
        expect(html).toContain("tt('session_invalid_relogin', 'Please log in to continue')");
        expect(html).toContain("if (!user) { setInviteSignedOutState(); return; }");
        expect(html).toContain('if (timeline) timeline.innerHTML = `<div class="inv-timeline-empty">${msg}</div>`');
        expect(html).toContain('if (funnel) funnel.innerHTML = `<div class="inv-timeline-empty">${msg}</div>`');
    });

    test('keeps invite controls stable on narrow screens', () => {
        expect(html).toMatch(/@media \(max-width:\s*560px\)[\s\S]*\.inv-code-box,\s*\n\s*\.inv-redeem\s*\{\s*flex-direction:\s*column;/);
        expect(html).toMatch(/\.inv-copy-btn,\s*\n\s*\.inv-redeem button,\s*\n\s*\.inv-share-btn\s*\{[\s\S]*min-height:\s*44px/);
        expect(html).toMatch(/\.kvalue-funnel\s*\{\s*grid-template-columns:\s*1fr;/);
    });

    test('translation helper falls back instead of rendering raw missing keys', () => {
        expect(html).toContain('return value && value !== k ? value : fb;');
    });
});
