const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../../public/portal/index.html'), 'utf8');
const redirect = source.match(/function redirectAfterAuth\(\) \{[\s\S]*?\n        \}/)[0];

describe('progress login return stays on the explicit same-origin page', () => {
    test.each([
        ['/AiHankApps/dot-progress/', '/AiHankApps/dot-progress/'],
        ['//evil.test/AiHankApps/dot-progress/', 'dashboard.html'],
        ['https://evil.test/AiHankApps/dot-progress/', 'dashboard.html'],
        ['/AiHankApps/dot-progress/../../elsewhere', 'dashboard.html'],
        ['/AiHankApps/dot-progress/?next=https://evil.test', 'dashboard.html'],
        ['/portal/chat.html', '/portal/chat.html'],
    ])('%s returns to %s', (returnTo, expected) => {
        const sandbox = { localStorage: { getItem: () => null }, URLSearchParams,
            window: { location: { search: '?return_to=' + encodeURIComponent(returnTo) } } };
        vm.runInNewContext(redirect + '\nredirectAfterAuth();', sandbox);
        expect(sandbox.window.location.href).toBe(expected);
    });
});
