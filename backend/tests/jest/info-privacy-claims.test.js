/**
 * Regression coverage for the public Info privacy/security slide exposure.
 * The retained slide file currently contains legal-risk claims and must not be
 * linked or embedded from user-visible Info page entry points until rewritten.
 */

const fs = require('fs');
const path = require('path');

const PORTAL_DIR = path.resolve(__dirname, '../../public/portal');
const INFO_HTML = path.join(PORTAL_DIR, 'info.html');
const INDEX_JS = path.resolve(__dirname, '../../index.js');

function walkFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (full === path.join(PORTAL_DIR, 'assets', 'slides')) continue;
            walkFiles(full, out);
        } else if (/\.(html|js|css)$/i.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

describe('Info privacy/security slide exposure', () => {
    test('info.html does not link or thumbnail the risky privacy slide', () => {
        const source = fs.readFileSync(INFO_HTML, 'utf8');
        expect(source).not.toMatch(/href=["']assets\/slides\/info-privacy\.html["']/);
        expect(source).not.toMatch(/src=["']assets\/slides\/info-privacy-thumb\.png["']/);
        expect(source).not.toMatch(/data-i18n=["']info_privacy_slide_cta["']/);
    });

    test('no public portal file outside the slide folder references the risky privacy slide', () => {
        const offenders = walkFiles(PORTAL_DIR).filter((file) => {
            const source = fs.readFileSync(file, 'utf8');
            return /info-privacy(?:-mobile)?\.html|info-privacy-thumb\.png/.test(source);
        }).map((file) => path.relative(PORTAL_DIR, file));

        expect(offenders).toEqual([]);
    });
});

describe('info-privacy-claims debug endpoint registration', () => {
    test('backend exposes an authenticated temporary debug endpoint for exposure verification', () => {
        const source = fs.readFileSync(INDEX_JS, 'utf8');
        expect(source).toMatch(/app\.get\(['"]\/api\/debug\/info-privacy-claims['"]/);
        expect(source).toMatch(/linksPrivacySlide/);
        expect(source).toMatch(/publicPortalReferences/);
        expect(source).toMatch(/slideStillContainsRiskyClaims/);
    });
});
