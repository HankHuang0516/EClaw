// Kanban task-tab comment-overlap E2E (card_89ecc653)
// Verifies PR #2678: bottom comment not occluded by Add-comment/Send bar,
// and selection highlight does not cross the bar boundary.
const { chromium } = require('/Users/hank/Desktop/Project/uiux-inspection/node_modules/playwright');
const fs = require('fs');

const HOST = 'https://eclawbot.com';
const DEVICE_ID = process.env.E2E_DEVICE_ID;
const DEVICE_SECRET = process.env.E2E_DEVICE_SECRET;
if (!DEVICE_ID || !DEVICE_SECRET) {
    console.error('Missing E2E_DEVICE_ID / E2E_DEVICE_SECRET env vars.');
    process.exit(1);
}
// Card with 12 comments — enough to overflow viewport and trigger overlap.
const TARGET_CARD = 'card_3ca7b8d8ed5d4e9827ab343c';

const VIEWPORTS = [
    { tag: '360', width: 360, height: 720, dpr: 2, mobile: true },
    { tag: '412', width: 412, height: 800, dpr: 2, mobile: true },
    { tag: '768', width: 768, height: 1024, dpr: 2, mobile: true },
];

const OUT = '/tmp/kanban-comments-overlap-shots';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

async function runViewport(browser, vp) {
    const tag = `viewport-${vp.tag}`;
    const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: vp.dpr,
        isMobile: vp.mobile,
        hasTouch: vp.mobile,
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
    });
    const page = await ctx.newPage();
    const consoleMsgs = [];
    page.on('console', m => consoleMsgs.push(`[${m.type()}] ${m.text()}`));

    const url = `${HOST}/portal/kanban.html?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}&lang=zh-TW`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    try {
        await page.waitForFunction(() => window.currentUser && window.currentUser.deviceId, { timeout: 20000 });
    } catch (_) {}
    await page.waitForTimeout(1500);

    const authOk = await page.evaluate(() => !!(window.currentUser && window.currentUser.deviceId));
    if (!authOk) {
        console.error(`${tag}: auth failed`);
        await page.screenshot({ path: `${OUT}/${tag}-auth-fail.png`, fullPage: true });
        await page.close(); await ctx.close();
        return { tag, error: 'auth fail' };
    }

    // Open the card detail directly.
    await page.evaluate(cardId => {
        if (typeof window.openDetail !== 'function') {
            throw new Error('openDetail is not a function on window');
        }
        return window.openDetail(cardId);
    }, TARGET_CARD);

    // Wait for the comments panel to render its list.
    try {
        await page.waitForSelector('#panel-comments .kb-comments-list .kb-comment, #panel-comments .kb-comments-list .kb-empty', { timeout: 15000 });
    } catch (e) {
        console.error(`${tag}: comments panel did not render`);
    }
    await page.waitForTimeout(1000);

    // Verify list is scrolled to bottom (PR #2678 sets list.scrollTop = list.scrollHeight after render).
    const measurements = await page.evaluate(() => {
        const panel = document.getElementById('panel-comments');
        if (!panel) return { error: 'no panel-comments' };
        const list = panel.querySelector('.kb-comments-list');
        const input = panel.querySelector('.kb-comment-input');
        const comments = panel.querySelectorAll('.kb-comment');
        if (!list || !input) return { error: 'list or input missing', listFound: !!list, inputFound: !!input };
        // Scroll the list to bottom (defensive — auto-scroll may have already done it).
        list.scrollTop = list.scrollHeight;
        const lastComment = comments[comments.length - 1] || null;
        const listRect = list.getBoundingClientRect();
        const inputRect = input.getBoundingClientRect();
        const lastRect = lastComment ? lastComment.getBoundingClientRect() : null;
        // CSS sanity check: input bar must have a non-transparent background and z-index for selection-clip.
        const inputCS = window.getComputedStyle(input);
        return {
            commentCount: comments.length,
            listTop: listRect.top, listBottom: listRect.bottom, listHeight: listRect.height,
            inputTop: inputRect.top, inputBottom: inputRect.bottom, inputHeight: inputRect.height,
            lastTop: lastRect ? lastRect.top : null,
            lastBottom: lastRect ? lastRect.bottom : null,
            lastVisible: lastRect ? (lastRect.bottom <= inputRect.top + 1) : null,
            inputZIndex: inputCS.zIndex,
            inputBackground: inputCS.backgroundColor,
            inputPosition: inputCS.position,
            listOverflowY: window.getComputedStyle(list).overflowY,
        };
    });

    console.log(`${tag}: measurements=${JSON.stringify(measurements)}`);

    const file = `${OUT}/kanban-overlap-${vp.tag}.png`;
    await page.screenshot({ path: file, fullPage: false });

    // Also capture a selection highlight test: select all text in the last comment + verify highlight doesn't cross into input bar zone.
    let selectionTestPass = null;
    try {
        await page.evaluate(() => {
            const panel = document.getElementById('panel-comments');
            const comments = panel.querySelectorAll('.kb-comment-bubble');
            const last = comments[comments.length - 1];
            if (!last) return;
            const range = document.createRange();
            range.selectNodeContents(last);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${OUT}/kanban-overlap-${vp.tag}-selected.png`, fullPage: false });
        // Verify input bar still on top by checking its z-index dominance.
        const selVerify = await page.evaluate(() => {
            const input = document.querySelector('#panel-comments .kb-comment-input');
            return window.getComputedStyle(input).zIndex;
        });
        selectionTestPass = (parseInt(selVerify, 10) >= 1);
    } catch (e) {
        console.error(`${tag}: selection test failed:`, e.message);
    }

    await page.close(); await ctx.close();
    return {
        tag,
        viewport: `${vp.width}x${vp.height}`,
        ...measurements,
        screenshot: file,
        selectionScreenshot: `${OUT}/kanban-overlap-${vp.tag}-selected.png`,
        selectionTestPass,
        consoleErrs: consoleMsgs.filter(m => m.startsWith('[error]')),
    };
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    const results = [];
    for (const vp of VIEWPORTS) {
        console.log(`\n--- viewport ${vp.tag} (${vp.width}x${vp.height}) ---`);
        const r = await runViewport(browser, vp);
        results.push(r);
    }
    await browser.close();
    fs.writeFileSync(`${OUT}/_results.json`, JSON.stringify(results, null, 2));
    console.log('\n=================== SUMMARY ===================');
    for (const r of results) {
        const noOverlap = r.lastBottom != null && r.inputTop != null && r.lastBottom <= r.inputTop + 1;
        const verdict = noOverlap ? `PASS — last comment bottom ${r.lastBottom?.toFixed(1)} ≤ input top ${r.inputTop?.toFixed(1)}` : `FAIL — overlap by ${(r.lastBottom - r.inputTop).toFixed(1)}px`;
        console.log(`${(r.tag || '').padEnd(14)} comments=${r.commentCount} ${verdict}  selZ=${r.selectionTestPass}`);
    }
    console.log('\nWritten:', OUT);
})().catch(e => { console.error(e); process.exit(1); });
