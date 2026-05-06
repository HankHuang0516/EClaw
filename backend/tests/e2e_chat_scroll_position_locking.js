/**
 * E2E Test: Chat Scroll Position Locking (rework)
 *
 * Verifies that when the user has scrolled up to read history, ≥10 new
 * incoming messages do NOT yank their viewport back to the bottom.
 *
 * Strategy:
 *   - Load /portal/chat.html with BROADCAST_TEST_DEVICE creds.
 *   - Pad allMessages so the container is scrollable, then scroll to middle.
 *   - Capture scrollTop, fire 10+ window.onSocketChatMessage() calls
 *     (the real WebSocket entry point that calls renderMessages(true)),
 *     and assert scrollTop drift ≤ 50px after each injection.
 *   - Then click #scrollToBottomBtn and assert we land near bottom.
 *
 * CI-safe: headless when E2E_HEADLESS=true / CI=true.
 */

const { chromium } = require('playwright');
const path = require('path');

const TEST_CONFIG = {
    chatUrl: process.env.E2E_CHAT_URL || 'http://localhost:8765/portal/chat.html',
    deviceId: process.env.E2E_DEVICE_ID || 'e2e-stub-device',
    deviceSecret: process.env.E2E_DEVICE_SECRET || 'e2e-stub-secret',
    headless: process.env.CI !== 'false' && (process.env.CI === 'true' || process.env.E2E_HEADLESS !== 'false'),
    timeout: 15000,
    newMessageCount: 12,
};

const TOLERANCE_PX = 50;

async function runChatScrollPositionLockingTest() {
    const browser = await chromium.launch({ headless: TEST_CONFIG.headless });
    const context = await browser.newContext({ viewport: { width: 412, height: 850 } });
    const page = await context.newPage();
    const evidenceDir = process.env.E2E_EVIDENCE_DIR || '/tmp/scroll-lock-evidence';
    require('fs').mkdirSync(evidenceDir, { recursive: true });

    // Stub all /api/* and any external calls so chat.html boots offline.
    await page.route('**/api/**', route => {
        const url = route.request().url();
        const stubUser = {
            deviceId: TEST_CONFIG.deviceId,
            deviceSecret: TEST_CONFIG.deviceSecret,
            entityId: 2,
            displayName: 'E2E Stub',
        };
        let body = { success: true, ok: true, messages: [], cards: [], notes: [], entities: [], user: stubUser };
        if (/\/auth\/me/.test(url)) body = { success: true, user: stubUser };
        else if (/\/auth\/device-login/.test(url)) body = { success: true, user: stubUser };
        else if (/\/chat\/history/.test(url)) body = { success: true, messages: [] };
        else if (/\/mission\/dashboard/.test(url)) body = { success: true, tasks: [], notes: [], rules: [], skills: [] };
        else if (/\/mission\/cards/.test(url)) body = { success: true, cards: [] };
        else if (/\/entity/.test(url)) body = { success: true, entities: [] };
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    // Block external CDNs / sockets we don't need
    await page.route(/(^https:\/\/cdn|^wss:|^https:\/\/.*socket\.io)/, route => route.abort());

    const consoleErrors = [];
    page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message));
    page.on('console', msg => {
        if (msg.type() !== 'error') return;
        const text = msg.text();
        // Suppress noise from intentionally-blocked external resources
        if (/Failed to load resource|net::ERR_FAILED|Socket\.IO/i.test(text)) return;
        consoleErrors.push('console.error: ' + text);
    });

    try {
        const url = `${TEST_CONFIG.chatUrl}?deviceId=${TEST_CONFIG.deviceId}&deviceSecret=${TEST_CONFIG.deviceSecret}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TEST_CONFIG.timeout });
        await page.waitForSelector('#chatMessages', { timeout: TEST_CONFIG.timeout });
        await page.waitForTimeout(1200); // let initial init settle

        // Pad allMessages so the container is scrollable. Use the real entry point
        // so the rendered DOM matches production.
        await page.evaluate((padCount) => {
            if (typeof window.onSocketChatMessage !== 'function') {
                throw new Error('onSocketChatMessage not exposed');
            }
            const baseTs = Date.now() - padCount * 60000;
            for (let i = 0; i < padCount; i++) {
                window.onSocketChatMessage({
                    id: `e2e-pad-${i}-${Date.now()}`,
                    text: `[E2E pad ${i + 1}] lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
                    is_from_bot: i % 2 === 0,
                    is_from_user: i % 2 !== 0,
                    entity_id: i % 2 === 0 ? 5 : null,
                    source: i % 2 === 0 ? 'entity:5' : 'web_chat',
                    timestamp: baseTs + i * 60000,
                });
            }
        }, 30);

        await page.waitForTimeout(500);

        // Make sure the container actually overflows; if not, the test is meaningless.
        const overflow = await page.evaluate(() => {
            const c = document.getElementById('chatMessages');
            return { scrollHeight: c.scrollHeight, clientHeight: c.clientHeight, scrollTop: c.scrollTop };
        });
        if (overflow.scrollHeight - overflow.clientHeight < 200) {
            throw new Error(`Container not scrollable enough: ${JSON.stringify(overflow)}`);
        }

        // Scroll to ~40% from top (i.e. user reading history).
        const captured = await page.evaluate(() => {
            const c = document.getElementById('chatMessages');
            c.scrollTop = Math.floor(c.scrollHeight * 0.4);
            c.dispatchEvent(new Event('scroll'));
            return c.scrollTop;
        });
        await page.waitForTimeout(200);
        const screenshotBefore = path.join(evidenceDir, 'scroll-lock-before.png');
        await page.screenshot({ path: screenshotBefore, fullPage: false });

        // Fire ≥10 new messages and check after each one.
        const drifts = [];
        for (let i = 0; i < 12; i++) {
            await page.evaluate((idx) => {
                window.onSocketChatMessage({
                    id: `e2e-new-${idx}-${Date.now()}`,
                    text: `[E2E new ${idx + 1}] incoming chatter from bot`,
                    is_from_bot: true,
                    is_from_user: false,
                    entity_id: 5,
                    source: 'entity:5',
                    timestamp: Date.now(),
                });
            }, i);
            await page.waitForTimeout(120);
            const after = await page.evaluate(() => document.getElementById('chatMessages').scrollTop);
            drifts.push({ i: i + 1, scrollTop: after, drift: Math.abs(after - captured) });
        }

        const maxDrift = drifts.reduce((m, d) => Math.max(m, d.drift), 0);
        const screenshotAfter = path.join(evidenceDir, 'scroll-lock-after-12msgs.png');
        await page.screenshot({ path: screenshotAfter, fullPage: false });

        // Verify jump-to-bottom button surfaced
        const jumpBtnVisible = await page.locator('#scrollToBottomBtn.visible').count() > 0;

        // Click jump-to-bottom and verify we land near bottom
        if (jumpBtnVisible) {
            await page.click('#scrollToBottomBtn');
            // smooth-scroll can take ~1-2s; poll until close to bottom or timeout
            await page.waitForFunction(() => {
                const c = document.getElementById('chatMessages');
                return c.scrollHeight - c.scrollTop - c.clientHeight < 200;
            }, { timeout: 5000 }).catch(() => {});
        }
        const finalState = await page.evaluate(() => {
            const c = document.getElementById('chatMessages');
            return {
                scrollTop: c.scrollTop,
                distanceFromBottom: c.scrollHeight - c.scrollTop - c.clientHeight,
            };
        });
        const screenshotJump = path.join(evidenceDir, 'scroll-lock-after-jump.png');
        await page.screenshot({ path: screenshotJump, fullPage: false });

        const passed = (
            maxDrift <= TOLERANCE_PX &&
            jumpBtnVisible &&
            finalState.distanceFromBottom < 200 &&
            consoleErrors.length === 0
        );

        const report = {
            passed,
            captured,
            maxDrift,
            tolerance: TOLERANCE_PX,
            messageCount: drifts.length,
            jumpBtnVisible,
            finalState,
            consoleErrors,
            drifts,
            evidence: { before: screenshotBefore, after: screenshotAfter, afterJump: screenshotJump },
        };
        console.log(JSON.stringify(report, null, 2));
        return report;
    } finally {
        await browser.close();
    }
}

if (require.main === module) {
    runChatScrollPositionLockingTest().then(r => {
        process.exit(r.passed ? 0 : 1);
    }).catch(err => {
        console.error('E2E error:', err);
        process.exit(2);
    });
}

module.exports = { runChatScrollPositionLockingTest };
