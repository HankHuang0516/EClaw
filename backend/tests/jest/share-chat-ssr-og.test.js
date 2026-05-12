/**
 * Regression: /c/:publicCode must SSR per-bot OG meta + JSON-LD for crawlers.
 *
 * Pre-fix (PR #1993): Express served static share-chat.html verbatim, and
 * OG/JSON-LD were populated by client JS after entity lookup. Crawlers
 * (FB/Twitter/Slack/LinkedIn/iMessage/Discord) don't run JS, so they saw
 * generic "EClawbot - Chat" meta with no per-bot info.
 *
 * Post-fix: the route reads the template, runs string-replace over 7
 * anchors (title, description, canonical, og:title, og:description, og:url,
 * jsonld-data), and sends the personalized HTML. Client JS still runs to
 * refine for real visitors.
 */

const fs = require('fs');
const src = fs.readFileSync(require.resolve('../../index'), 'utf8');

describe('share-chat SSR helper', () => {
    function slice(anchor, span = 5500) {
        const i = src.indexOf(anchor);
        expect(i).toBeGreaterThan(-1);
        return src.slice(i, i + span);
    }

    const helperBlock = slice('function _renderShareChatSSR(', 5500);
    const routeBlock = slice("app.get('/c/:code',", 800);

    it('helper is defined', () => {
        expect(helperBlock).toMatch(/function _renderShareChatSSR\(code\) \{/);
    });

    it('returns null when publicCode is unknown', () => {
        expect(helperBlock).toMatch(/const target = publicCodeIndex\[code\];\s*\n\s*if \(!target\) return null;/);
    });

    it('returns null when entity missing', () => {
        expect(helperBlock).toMatch(/if \(!entity\) return null;/);
    });

    it('personalises <title>', () => {
        expect(helperBlock).toMatch(/<title>Chat with \$\{nameAttr\} - EClawbot<\/title>/);
    });

    it('personalises og:title, og:description, og:url', () => {
        expect(helperBlock).toContain('og:title');
        expect(helperBlock).toContain('og:description');
        expect(helperBlock).toContain('og:url');
        expect(helperBlock).toContain('id="og-title"');
        expect(helperBlock).toContain('id="og-desc"');
        expect(helperBlock).toContain('id="og-url"');
    });

    it('personalises og:image with entity avatar (fallback default)', () => {
        expect(helperBlock).toContain('id="og-image"');
        expect(helperBlock).toMatch(/og:image"\s+content="\$\{avatarAttr\}"/);
    });

    it('personalises twitter:title / twitter:description / twitter:image', () => {
        expect(helperBlock).toContain('id="twitter-title"');
        expect(helperBlock).toContain('id="twitter-desc"');
        expect(helperBlock).toContain('id="twitter-image"');
        expect(helperBlock).toMatch(/twitter:title"\s+content="\$\{ogTitleAttr\}"/);
        expect(helperBlock).toMatch(/twitter:description"\s+content="\$\{descAttr\}"/);
        expect(helperBlock).toMatch(/twitter:image"\s+content="\$\{avatarAttr\}"/);
    });

    it('avatar URL falls back to default when not absolute http(s)', () => {
        expect(helperBlock).toMatch(/avatarUrl = .*\^https\?:\\\/\\\/.*entity\.avatar.*og-image\.png/s);
    });

    it('personalises canonical link', () => {
        expect(helperBlock).toMatch(/<link rel="canonical" href="\$\{url\}">/);
    });

    it('injects JSON-LD payload into the jsonld-data script tag', () => {
        expect(helperBlock).toMatch(/id="jsonld-data">\$\{jsonldStr\}<\/script>/);
    });

    it('JSON-LD includes schema.org SoftwareApplication shape', () => {
        expect(helperBlock).toContain("'@context': 'https://schema.org'");
        expect(helperBlock).toContain("'@type': 'SoftwareApplication'");
        expect(helperBlock).toMatch(/applicationCategory:\s*'BusinessApplication'/);
        expect(helperBlock).toMatch(/author:\s*\{\s*'@type':\s*'Person'/);
    });

    it('only sets image when avatar is an absolute http(s) url', () => {
        expect(helperBlock).toMatch(/entity\.avatar\.startsWith\('http'\)/);
    });

    it('escapes </script> in JSON-LD to prevent payload break-out', () => {
        expect(helperBlock).toMatch(/\.replace\(\/<\\\/\(script\)\/gi/);
    });

    it('HTML-escapes attribute values (prevents injection via entity name)', () => {
        expect(helperBlock).toContain('_escapeHtmlAttr(name)');
        expect(helperBlock).toContain('_escapeHtmlAttr(descText)');
    });

    it('template is cached after first load (no per-request fs read)', () => {
        expect(slice('function _loadShareChatTemplate()', 300))
            .toMatch(/_shareChatTemplateCache === null/);
    });
});

describe('/c/:code route wires SSR before falling back to static', () => {
    const routeBlock = (() => {
        const i = src.indexOf("app.get('/c/:code',");
        return src.slice(i, i + 800);
    })();

    it('calls _renderShareChatSSR for not-logged-in visitors', () => {
        expect(routeBlock).toContain('_renderShareChatSSR(req.params.code)');
    });

    it('sends rendered HTML with text/html + no-cache when SSR succeeds', () => {
        expect(routeBlock).toMatch(/Content-Type['"]\s*,\s*['"]text\/html/);
        expect(routeBlock).toMatch(/Cache-Control['"]\s*,\s*['"]no-cache/);
        expect(routeBlock).toContain('res.send(rendered)');
    });

    it('falls back to static file when SSR returns null (unknown code)', () => {
        expect(routeBlock).toContain('res.sendFile(_SHARE_CHAT_HTML_PATH)');
    });

    it('SSR errors are caught and logged, not thrown', () => {
        expect(routeBlock).toMatch(/try\s*\{/);
        expect(routeBlock).toMatch(/console\.warn\(`\[\/c\/:code\] SSR failed/);
    });

    it('logged-in users still redirect to /portal/chat.html', () => {
        expect(routeBlock).toMatch(/req\.user\.deviceId.*\n.*res\.redirect\(`\/portal\/chat\.html/);
    });
});
