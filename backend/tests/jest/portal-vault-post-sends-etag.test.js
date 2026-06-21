'use strict';

// card_9bd4b4c0 — recurring ErrLog "[Vars] POST without expectedUpdatedAt
// against non-empty row (source=web)".
//
// Root cause: two web vault-save paths POSTed to /api/device-vars WITHOUT the
// optimistic-lock token `expectedUpdatedAt`, so they (a) carried the same
// multi-device last-write-wins race the etag protocol (PR #3422/3423) was meant
// to close and (b) tripped the server's strict-no-etag warn guard
// (index.js ~21956, covered by device-vars-strict-no-etag.test.js).
//
//   - backend/public/portal/publisher-setup.html  (deliberate 4-key X save)
//   - backend/public/portal/mission.html          (background syncVarsToServer)
//
// chat.html and env-vars.html already did GET-then-POST-with-etag. This test
// pins ALL web POST paths to that pattern so a future edit can't silently
// regress one back to a no-etag POST and re-open this recurring card.

const fs = require('fs');
const path = require('path');

const PORTAL_DIR = path.join(__dirname, '..', '..', 'public', 'portal');

function read(file) {
    return fs.readFileSync(path.join(PORTAL_DIR, file), 'utf8');
}

describe('portal vault-save paths send expectedUpdatedAt (card_9bd4b4c0)', () => {
    test('publisher-setup.html GETs updatedAt then POSTs with expectedUpdatedAt', () => {
        const src = read('publisher-setup.html');
        // Reads the server snapshot to obtain the etag…
        expect(src).toMatch(/apiCall\(\s*['"]GET['"]\s*,\s*[`'"]\/api\/device-vars/);
        // …and threads it into the POST body as expectedUpdatedAt.
        expect(src).toMatch(/body\.expectedUpdatedAt\s*=\s*serverData\.updatedAt/);
        expect(src).toMatch(/apiCall\(\s*['"]POST['"]\s*,\s*['"]\/api\/device-vars['"]\s*,\s*body\s*\)/);
    });

    test('mission.html syncVarsToServer GETs updatedAt then POSTs with expectedUpdatedAt', () => {
        const src = read('mission.html');
        expect(src).toMatch(/apiCall\(\s*['"]GET['"]\s*,\s*[`'"]\/api\/device-vars/);
        expect(src).toMatch(/body\.expectedUpdatedAt\s*=\s*serverData\.updatedAt/);
        expect(src).toMatch(/apiCall\(\s*['"]POST['"]\s*,\s*['"]\/api\/device-vars['"]\s*,\s*body\s*\)/);
    });

    test('chat.html / env-vars.html keep their existing etag handling (regression guard)', () => {
        expect(read('chat.html')).toMatch(/expectedUpdatedAt/);
        expect(read('env-vars.html')).toMatch(/expectedUpdatedAt/);
    });

    // Comprehensive guard: ANY portal file that POSTs to /api/device-vars MUST
    // also reference expectedUpdatedAt somewhere in the file. Catches a brand-new
    // page that copies the old no-etag POST shape.
    test('every portal file POSTing to /api/device-vars references expectedUpdatedAt', () => {
        const offenders = [];
        for (const file of fs.readdirSync(PORTAL_DIR)) {
            if (!file.endsWith('.html')) continue;
            const src = read(file);
            const postsVault = /apiCall\(\s*['"]POST['"]\s*,\s*['"]\/api\/device-vars['"]/.test(src);
            if (postsVault && !src.includes('expectedUpdatedAt')) {
                offenders.push(file);
            }
        }
        expect(offenders).toEqual([]);
    });
});
