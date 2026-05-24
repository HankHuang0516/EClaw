/**
 * Dashboard Agent Policy card — static analysis.
 */

const fs = require('fs');
const path = require('path');

const DASHBOARD_HTML = path.resolve(__dirname, '../../public/portal/dashboard.html');

describe('Dashboard Agent Policy card', () => {
    let html;

    beforeAll(() => {
        html = fs.readFileSync(DASHBOARD_HTML, 'utf8');
    });

    test('renders a dashboard Agent Policy status card', () => {
        expect(html).toContain('id="dashboardAgentPolicyCard"');
        expect(html).toContain('id="dashboardAgentPolicyCard" aria-labelledby="dashboardAgentPolicyTitle" aria-hidden="true"');
        expect(html).toContain('.agent-policy-card {');
        expect(html).toContain('display: none;');
        expect(html).toContain('.agent-policy-card.is-visible');
        expect(html).toContain('id="dashboardAgentPolicyStatus"');
        expect(html).toContain('id="dashboardAgentPolicyEnabledBadge"');
        expect(html).toContain('id="dashboardAgentPolicyDetails"');
    });

    test('only shows the Agent Policy card while dashboard edit mode is active', () => {
        expect(html).not.toContain('loadDashboardPromptPolicy().catch(err => console.warn(\'[AgentPolicy] dashboard load failed\', err));\n\n            if (__embeddedOrg)');
        expect(html).toContain('function setDashboardAgentPolicyCardVisible(visible)');
        expect(html).toContain("card.classList.toggle('is-visible', visible);");
        expect(html).toContain("card.setAttribute('aria-hidden', visible ? 'false' : 'true');");
        expect(html).toContain('setDashboardAgentPolicyCardVisible(false);');
        expect(html).toContain('setDashboardAgentPolicyCardVisible(true);');
    });

    test('supports entity/channel preview controls from the dashboard', () => {
        expect(html).toContain('id="dashboardPolicyPreviewEntity"');
        expect(html).toContain('id="dashboardPolicyPreviewChannel"');
        expect(html).toContain('id="dashboardPolicyDetectedChannel"');
        expect(html).toContain('<option value="codex">codex</option>');
        expect(html).toContain('<option value="claude_code">claude_code</option>');
        expect(html).toContain('<option value="hermes">hermes</option>');
        expect(html).toContain('oninput="handleDashboardPolicyEntityInput()"');
        expect(html).toContain('function previewDashboardPromptPolicy()');
        expect(html).toContain('/api/channel/prompt-policy?deviceId=');
    });

    test('infers the policy channel from the selected entity', () => {
        expect(html).toContain('function inferDashboardPolicyChannel(entityId)');
        expect(html).toContain('function getDashboardPolicyEntitySignal(entity = {})');
        expect(html).toContain('function syncDashboardPolicyChannelSelect(options = {})');
        expect(html).toContain("return { channel: 'codex'");
        expect(html).toContain("return { channel: 'claude_code'");
        expect(html).toContain("return { channel: 'hermes'");
        expect(html).toContain("return { channel: 'generic'");
        expect(html).toContain("entity.channelProvider");
        expect(html).toContain('Detected channel: ${inference.channel}');
    });

    test('links dashboard users into the scoped Settings editor', () => {
        expect(html).toContain('function openDashboardAgentPolicyEditor(scope)');
        expect(html).toContain("agentPolicy: '1'");
        expect(html).toContain("window.location.href = 'settings.html?' + params.toString() + '#agent-policy';");
    });

    test('loads device policy summary without exposing secrets in page text', () => {
        expect(html).toContain('function loadDashboardPromptPolicy()');
        expect(html).toContain('/api/device/prompt-policy?deviceId=');
        expect(html).toContain("'/api/entity/' + encodeURIComponent(entityId) + '/prompt-policy?deviceId='");
        // Ensure no raw secret values are embedded in visible text or JS —
        // but allow documentation <code>deviceSecret</code> references in help text.
        const secretLeakPattern = /["']deviceSecret["']\s*:\s*["']/;
        expect(html).not.toMatch(secretLeakPattern);
    });
});
