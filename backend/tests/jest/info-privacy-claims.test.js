const fs = require('fs');
const path = require('path');

describe('Info enterprise false claims regression', () => {
    test('info.html does not link or thumbnail the false enterprise claims slide', () => {
        const infoPath = path.join(__dirname, '../../public/portal/info.html');
        const infoHtml = fs.readFileSync(infoPath, 'utf8');

        // Should not link to enterprise slide
        expect(infoHtml).not.toMatch(/href=["']assets\/slides\/info-enterprise\.html["']/);

        // Should not display enterprise thumbnail
        expect(infoHtml).not.toMatch(/src=["']assets\/slides\/info-enterprise-thumb\.png["']/);

        // Should not use enterprise i18n key
        expect(infoHtml).not.toMatch(/data-i18n=["']info_enterprise_slide_cta["']/);
    });

    test('no public portal file outside the slide folder references the false enterprise slide', () => {
        const portalDir = path.join(__dirname, '../../public/portal');
        const slideDir = path.join(portalDir, 'assets', 'slides');

        const checkDirectory = (dir) => {
            const entries = fs.readdirSync(dir, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    // Skip the slides directory itself - that's where the files can legitimately exist
                    if (fullPath === slideDir) continue;
                    checkDirectory(fullPath);
                } else if (/\.(html|js|css)$/i.test(entry.name)) {
                    const content = fs.readFileSync(fullPath, 'utf8');

                    // Check for references to enterprise slide files
                    expect(content).not.toMatch(/info-enterprise(?:-thumb)?\.(?:html|png)/);
                }
            }
        };

        checkDirectory(portalDir);
    });
});