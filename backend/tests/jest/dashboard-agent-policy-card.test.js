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
        expect(html).toContain('id="dashboardAgentPolicyStatus"');
        expect(html).toContain('id="dashboardAgentPolicyEnabledBadge"');
        expect(html).toContain('id="dashboardAgentPolicyDetails"');
    });

    test('supports entity/channel preview controls from the dashboard', () => {
        expect(html).toContain('id="dashboardPolicyPreviewEntity"');
        expect(html).toContain('id="dashboardPolicyPreviewChannel"');
        expect(html).toContain('<option value="codex">codex</option>');
        expect(html).toContain('<option value="claude_code">claude_code</option>');
        expect(html).toContain('<option value="hermes">hermes</option>');
        expect(html).toContain('function previewDashboardPromptPolicy()');
        expect(html).toContain('/api/channel/prompt-policy?deviceId=');
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
        expect(html).not.toContain('deviceSecret</');
        expect(html).not.toContain('botSecret</');
    });
});
