/**
 * Static audit: verify pages using shared agent-card-editor.js don't
 * reference undefined globals. Catches the class of bug where
 * `currentDeviceId` was used in card-holder.html but never declared.
 *
 * This test reads the HTML source and checks for known-bad patterns.
 */

const fs = require('fs');
const path = require('path');

const PORTAL = path.join(__dirname, '..', '..', 'public', 'portal');

// Pages that use AgentCardEditor
const EDITOR_PAGES = ['dashboard.html', 'card-holder.html'];

// Variables that should NOT appear in these pages (they were from inline
// code that got replaced by the shared editor, but may still linger)
const FORBIDDEN_GLOBALS = [
    'currentDeviceId',      // dashboard has currentUser.deviceId, not this
    'currentEntities',      // dashboard has entities[], not this
    'addCapability(',       // old inline function, replaced by shared editor
    'appendCapabilityRow(', // old inline function
    'addEditCapability(',   // old card-holder inline function
];

describe('shared agent-card-editor audit', () => {
    for (const page of EDITOR_PAGES) {
        const filePath = path.join(PORTAL, page);
        if (!fs.existsSync(filePath)) continue;
        const content = fs.readFileSync(filePath, 'utf8');

        test(`${page} includes agent-card-editor.js`, () => {
            expect(content).toContain('agent-card-editor.js');
        });

        for (const forbidden of FORBIDDEN_GLOBALS) {
            test(`${page} does not reference forbidden global: ${forbidden}`, () => {
                // Allow references inside comments (lines starting with // or *)
                const lines = content.split('\n');
                const codeLines = lines.filter(line => {
                    const trimmed = line.trim();
                    return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('<!--');
                });
                const codeContent = codeLines.join('\n');
                expect(codeContent).not.toContain(forbidden);
            });
        }

        test(`${page} does not have editable capability input fields`, () => {
            // Ensure no <input class="ac-cap-name"> or "Add Capability" button
            // exists outside of comments
            expect(content).not.toMatch(/class="ac-cap-name"/);
            expect(content).not.toMatch(/onclick="addCapability\(/);
            expect(content).not.toMatch(/onclick="addEditCapability\(/);
        });
    }

    test('agent-card-editor.js exists', () => {
        const editorPath = path.join(PORTAL, 'shared', 'agent-card-editor.js');
        expect(fs.existsSync(editorPath)).toBe(true);
    });

    test('agent-card-editor.js uses currentUser pattern, not currentDeviceId', () => {
        const editorPath = path.join(PORTAL, 'shared', 'agent-card-editor.js');
        const content = fs.readFileSync(editorPath, 'utf8');
        // Editor should use this.deviceId (injected via constructor), not a global
        expect(content).not.toContain('currentDeviceId');
        expect(content).not.toContain('currentEntities');
        expect(content).toContain('this.deviceId');
    });
});
