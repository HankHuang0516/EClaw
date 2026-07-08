const fs = require('fs');
const path = require('path');

describe('delete account page self-improvement UI', () => {
    const pagePath = path.join(__dirname, '../../public/portal/delete-account.html');
    const i18nPath = path.join(__dirname, '../../public/shared/i18n.js');
    const html = fs.readFileSync(pagePath, 'utf8');
    const i18n = fs.readFileSync(i18nPath, 'utf8');

    test('shows the complete deletion data scope before sign-in', () => {
        expect(html).toContain('aria-labelledby="deletedDataTitle"');
        [
            'delete_account_data_account',
            'delete_account_data_chat',
            'delete_account_data_mission',
            'delete_account_data_schedules',
            'delete_account_data_vars',
            'delete_account_data_bots',
            'delete_account_data_telemetry',
        ].forEach((key) => {
            expect(html).toContain(`data-i18n="${key}"`);
        });
    });

    test('announces readiness and keeps the destructive action locked until confirmed', () => {
        expect(html).toContain('class="delete-readiness" id="deleteReadiness" role="status" aria-live="polite" aria-atomic="true" data-state="locked"');
        expect(html).toContain('id="deleteReadinessTitle" data-i18n="delete_account_ready_locked_title"');
        expect(html).toContain('id="deleteReadinessText" data-i18n="delete_account_ready_locked"');
        expect(html).toContain('id="confirmCheck" onchange="updateDeleteBtn()" aria-describedby="deleteWarning deleteReadinessText"');
        expect(html).toContain('id="deleteBtn" onclick="deleteAccount()" disabled aria-disabled="true" aria-describedby="deleteWarning deleteReadinessText"');
        expect(html).toContain("btn.setAttribute('aria-disabled', String(!checked));");
        expect(html).toContain("readiness.dataset.state = checked ? 'ready' : 'locked';");
        expect(html).toContain("i18n.t(checked ? 'delete_account_ready_enabled_title' : 'delete_account_ready_locked_title')");
        expect(html).toContain("i18n.t(checked ? 'delete_account_ready_enabled' : 'delete_account_ready_locked')");
    });

    test('uses live error regions and busy/focus state for the multi-step flow', () => {
        expect(html).toContain('id="signMsg" role="alert" aria-live="assertive" aria-atomic="true" hidden');
        expect(html).toContain('id="deleteMsg" role="alert" aria-live="assertive" aria-atomic="true" hidden');
        expect(html).toContain("btn.setAttribute('aria-busy', 'true');");
        expect(html).toContain("document.getElementById('stepConfirm').setAttribute('aria-busy', 'true');");
        expect(html).toContain("btn.removeAttribute('aria-busy');");
        expect(html).toContain("focusHeading('confirmHeading');");
        expect(html).toContain("focusHeading('doneHeading');");
        expect(html).toContain('function focusHeading(id)');
    });

    test('keeps controls touch-safe on narrow webview widths', () => {
        expect(html).toContain('@media (max-width: 520px)');
        expect(html).toMatch(/\.card\s*\{[\s\S]*padding:\s*22px/);
        expect(html).toMatch(/\.user-email\s*\{[\s\S]*word-break:\s*break-word/);
        expect(html).toMatch(/\.btn\s*\{[\s\S]*min-height:\s*44px/);
    });

    test('defines English and zh readiness translations', () => {
        [
            '"delete_account_ready_locked_title": "Deletion is locked"',
            '"delete_account_ready_locked": "Check the confirmation box to enable the final delete button."',
            '"delete_account_ready_enabled_title": "Deletion is enabled"',
            '"delete_account_ready_enabled": "The final delete button is enabled. This action cannot be undone."',
            '"delete_account_ready_locked_title": "刪除仍鎖定"',
            '"delete_account_ready_locked": "勾選確認框後，才會啟用最後刪除按鈕。"',
            '"delete_account_ready_enabled_title": "刪除已啟用"',
            '"delete_account_ready_enabled": "最後刪除按鈕已啟用。此操作無法復原。"',
        ].forEach((snippet) => {
            expect(i18n).toContain(snippet);
        });
    });
});
