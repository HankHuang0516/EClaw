const fs = require('fs');
const path = require('path');

/**
 * chat.html duplicate sendto control removal (card_02d168587d93479d5d684cc3).
 *
 * The sendto picker (card_91d5c93b) is the visible recipient UI; the legacy
 * `#targetBarRow` checkbox row is kept ONLY as hidden state-backing that
 * getSelectedTargets()/sendMessage() read. A CSS `display:flex` was overriding
 * the row's `hidden` attribute, rendering a duplicate visible 傳送給 checkbox row
 * beside the picker. This locks in: (a) the hidden row is actually hidden,
 * (b) contacts were merged into the picker so hiding the row doesn't orphan them.
 */
describe('chat.html — duplicate sendto control removed (card_02d16858)', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../public/portal/chat.html'), 'utf8');

    test('hidden target-bar-row is forced display:none (kills the visible duplicate)', () => {
        expect(html).toMatch(/\.target-bar-row\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
    });

    test('underlying checkbox row still exists as hidden state-backing (not deleted)', () => {
        // The DOM contract getSelectedTargets()/sendMessage() depend on must remain.
        expect(html).toContain('id="targetBarRow"');
        expect(html).toContain('hidden aria-hidden="true"');
        expect(html).toContain("document.querySelectorAll('.target-entity-check input[type=\"checkbox\"]')");
    });

    test('renderTargetBar skips overflow measurement when the row is hidden', () => {
        expect(html).toContain('if (row.hidden)');
    });

    test('contacts merged into the sendto picker (not orphaned by hiding the bar)', () => {
        expect(html).toContain('data-picker-contact');
        expect(html).toContain('sendto-picker-section-label');
        expect(html).toContain('function showSendtoPickerAddContact');
        // confirm writes contact rows back to the hidden .target-contact-check backing
        expect(html).toContain("input[data-picker-contact]");
        expect(html).toContain('.target-contact-check input[type="checkbox"][data-contact-code=');
    });

    test('Select-all stays entity-only (does not secretly select contacts)', () => {
        // toggleSendtoPickerSelectAll only touches data-picker-entity rows.
        expect(html).toMatch(/function toggleSendtoPickerSelectAll[\s\S]*?#sendtoPickerList input\[data-picker-entity\]/);
    });
});
