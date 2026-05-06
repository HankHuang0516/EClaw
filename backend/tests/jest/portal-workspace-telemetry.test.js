'use strict';

const fs = require('fs');
const path = require('path');

describe('portal workspace telemetry integration', () => {
    test('shared telemetry SDK exposes trackPageView used by workspace page', () => {
        const telemetryPath = path.join(__dirname, '../../public/shared/telemetry.js');
        const workspacePath = path.join(__dirname, '../../public/portal/workspace.html');

        const telemetryJs = fs.readFileSync(telemetryPath, 'utf8');
        const workspaceHtml = fs.readFileSync(workspacePath, 'utf8');

        expect(workspaceHtml).toContain("telemetry.trackPageView('workspace')");
        expect(telemetryJs).toMatch(/trackPageView\s*\(/);
        expect(telemetryJs).toContain("type: 'page_view'");
    });
});
