/**
 * Settings Agent Policy dashboard editor — static analysis.
 */

const fs = require('fs');
const path = require('path');

const SETTINGS_HTML = path.resolve(__dirname, '../../public/portal/settings.html');

describe('Settings Agent Policy dashboard editor', () => {
    let html;

    beforeAll(() => {
        html = fs.readFileSync(SETTINGS_HTML, 'utf8');
    });

    test('exposes device/entity scope controls', () => {
        expect(html).toContain('data-testid="prompt-policy-scope-controls"');
        expect(html).toContain('id="promptPolicyScope"');
        expect(html).toContain('<option value="device">Device default</option>');
        expect(html).toContain('<option value="entity">Entity override</option>');
        expect(html).toContain('id="promptPolicyEntityId"');
        expect(html).toContain('function getPromptPolicyScope()');
    });

    test('routes load and save through the selected prompt policy scope', () => {
        expect(html).toContain('function getPromptPolicyRequest');
        expect(html).toContain('/api/entity/${entityId}/prompt-policy');
        expect(html).toContain('/api/device/prompt-policy');
        expect(html).toContain('request.getPath');
        expect(html).toContain('request.putPath');
        expect(html).toContain('Save Entity Policy');
        expect(html).toContain('Save Device Policy');
    });

    test('supports Codex, Claude Code, Hermes, and generic preview channels', () => {
        expect(html).toContain('id="promptPolicyCodexOverride"');
        expect(html).toContain('id="promptPolicyClaudeOverride"');
        expect(html).toContain('id="promptPolicyHermesOverride"');
        expect(html).toContain('<option value="codex">codex</option>');
        expect(html).toContain('<option value="claude_code">claude_code</option>');
        expect(html).toContain('<option value="hermes">hermes</option>');
        expect(html).toContain('<option value="generic">generic</option>');
    });

    test('saves Hermes override in channelOverrides', () => {
        expect(html).toContain('hermes: {');
        expect(html).toContain("instructions: getPromptPolicyLines('promptPolicyHermesOverride')");
        expect(html).toContain("policy.channelOverrides?.hermes?.instructions || []");
    });

    test('supports dashboard deep links into a scoped Agent Policy editor', () => {
        expect(html).toContain('id="agentPolicySection"');
        expect(html).toContain('function applyAgentPolicyDeepLink');
        expect(html).toContain("params.get('agentPolicy') === '1'");
        expect(html).toContain("params.get('scope') === 'entity'");
        expect(html).toContain("window.location.hash === '#agent-policy'");
        expect(html).toContain("loadPromptPolicy(user)");
        expect(html).toContain("requestAnimationFrame(() =>");
    });

    test('applies Agent Policy deep links after settings content is visible', () => {
        const showContentIndex = html.indexOf("document.getElementById('pageContent').style.display = '';");
        const deepLinkIndex = html.indexOf("if (typeof applyDeepLinkFocus === 'function') applyDeepLinkFocus();");
        expect(showContentIndex).toBeGreaterThan(-1);
        expect(deepLinkIndex).toBeGreaterThan(-1);
        expect(showContentIndex).toBeLessThan(deepLinkIndex);
    });
});
