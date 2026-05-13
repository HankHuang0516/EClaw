#!/usr/bin/env node
/*
 * Chat scroll position locking E2E/regression harness.
 *
 * Purpose:
 *   Reproduce the third scroll-jump class: user scrolls to the middle of a
 *   history list, then socket/system updates trigger a full render. A naive
 *   `container.innerHTML = ...` without explicit restoration may drift or jump.
 *
 * Run:
 *   node backend/tests/e2e_chat_scroll_position_locking.js
 *
 * Optional real-app mode:
 *   ECLAW_CHAT_E2E_URL=http://localhost:3000/portal/chat.html node ...
 *
 * The default fixture mode uses Playwright with a minimal chat DOM and the same
 * anchor-preserving algorithm required by chat.html so CI/reviewer can collect
 * numeric drift logs even without a logged-in portal session.
 */

const assert = require('assert');

async function main() {
    let chromium;
    try {
        ({ chromium } = require('playwright'));
    } catch (err) {
        console.error('Playwright is required for this E2E harness. Install with: npm i -D playwright');
        process.exit(2);
    }

    const browser = await chromium.launch({ headless: true });
    const viewports = [
        { name: 'desktop-1280', width: 1280, height: 900 },
        { name: 'mobile-412', width: 412, height: 900 },
    ];
    const results = [];
    try {
        for (const viewport of viewports) {
            const page = await browser.newPage({ viewport });
            await installFixture(page);

            results.push(await scenarioSocketEvents(page, viewport.name));
            results.push(await scenarioRealMessageInsert(page, viewport.name));
            results.push(await scenarioAsyncHeightChange(page, viewport.name));

            await page.close();
        }
    } finally {
        await browser.close();
    }

    console.log(JSON.stringify({ ok: true, maxAllowedDriftPx: 5, results }, null, 2));
    for (const r of results) {
        assert(Math.abs(r.driftPx) <= r.maxAllowedDriftPx, `${r.name} drift ${r.driftPx}px > ${r.maxAllowedDriftPx}px`);
        assert(!r.jumpedToTop, `${r.name} jumped to top`);
        assert(!r.jumpedToBottom, `${r.name} jumped to bottom`);
    }
}

async function installFixture(page) {
    await page.setContent(`<!doctype html>
<html><head><style>
body{margin:0;font-family:sans-serif}.chat{height:620px;overflow:auto;border:1px solid #ddd}.chat-msg{min-height:72px;margin:8px;padding:12px;border-radius:10px;background:#f8fafc;border:1px solid #e2e8f0}.system{background:#fff7ed}.media{height:44px;background:#dbeafe;margin-top:8px;border-radius:8px}
</style></head><body><div id="chatMessages" class="chat"></div></body></html>`);
    await page.addScriptTag({ content: `
const CHAT_BOTTOM_TOLERANCE_PX = 50;
let allMessages = [];
for (let i = 0; i < 90; i++) allMessages.push({ id: 'm-' + i, text: 'History message ' + i, kind: 'normal' });
function isChatAtBottom(container, tolerance = CHAT_BOTTOM_TOLERANCE_PX) { return container.scrollTop + container.clientHeight >= container.scrollHeight - tolerance; }
function captureChatScrollAnchor(container) {
  const wasAtBottom = isChatAtBottom(container);
  const lock = { wasAtBottom, scrollTop: container.scrollTop, scrollHeight: container.scrollHeight, id: null, top: 0 };
  if (wasAtBottom) return lock;
  const cRect = container.getBoundingClientRect();
  for (const el of Array.from(container.querySelectorAll('.chat-msg[data-message-id]'))) {
    const id = el.dataset.messageId;
    const rect = el.getBoundingClientRect();
    if (id && rect.bottom > cRect.top + 1 && rect.top < cRect.bottom - 1) { lock.id = id; lock.top = rect.top - cRect.top; break; }
  }
  return lock;
}
function restoreChatScrollAnchor(container, lock, forceBottom = false) {
  if (forceBottom || lock.wasAtBottom) { container.scrollTop = container.scrollHeight; return; }
  const anchor = lock.id ? Array.from(container.querySelectorAll('.chat-msg[data-message-id]')).find(el => el.dataset.messageId === lock.id) : null;
  if (anchor) {
    const cRect = container.getBoundingClientRect();
    const newTop = anchor.getBoundingClientRect().top - cRect.top;
    container.scrollTop += newTop - lock.top;
  } else {
    container.scrollTop = lock.scrollTop;
  }
}
function renderMessages() {
  const container = document.getElementById('chatMessages');
  const lock = captureChatScrollAnchor(container);
  const shouldFollowBottom = lock.wasAtBottom;
  container.innerHTML = allMessages.map(m => '<div class="chat-msg '+(m.kind==='system'?'system':'')+'" data-message-id="'+m.id+'"><b>'+m.id+'</b><div>'+m.text+'</div>'+(m.media?'<div class="media"></div>':'')+'</div>').join('');
  restoreChatScrollAnchor(container, lock, shouldFollowBottom);
}
function currentAnchor() {
  const container = document.getElementById('chatMessages');
  const lock = captureChatScrollAnchor(container);
  return { id: lock.id, top: lock.top, scrollTop: container.scrollTop, scrollHeight: container.scrollHeight, clientHeight: container.clientHeight };
}
function midScroll() { const c = document.getElementById('chatMessages'); c.scrollTop = Math.floor(c.scrollHeight / 2); return currentAnchor(); }
function appendSocketEvents(count) { for (let i=0;i<count;i++) allMessages.push({ id:'sock-'+Date.now()+'-'+i, text:'socket event '+i, kind: i % 2 ? 'system' : 'normal' }); renderMessages(); return currentAnchor(); }
function appendRealMessages(count) { for (let i=0;i<count;i++) allMessages.push({ id:'real-'+Date.now()+'-'+i, text:'real new message '+i, kind:'normal' }); renderMessages(); return currentAnchor(); }
function asyncHeightChangeBeforeAnchor() { const c = document.getElementById('chatMessages'); const lock = captureChatScrollAnchor(c); allMessages[Math.max(0, allMessages.findIndex(m => m.id === lock.id) - 3)].media = true; renderMessages(); return currentAnchor(); }
renderMessages();
` });
}

async function measure(page, name, mutateFn, maxAllowedDriftPx = 5) {
    const before = await page.evaluate(() => midScroll());
    const after = await page.evaluate(mutateFn);
    const driftPx = Number((after.top - before.top).toFixed(3));
    const jumpedToTop = after.scrollTop <= 2;
    const jumpedToBottom = after.scrollTop + after.clientHeight >= after.scrollHeight - 2;
    return { name, anchorId: before.id, beforeTop: before.top, afterTop: after.top, driftPx, jumpedToTop, jumpedToBottom, maxAllowedDriftPx };
}

function scenarioSocketEvents(page, viewportName) {
    return measure(page, `${viewportName}:12-socket-events`, () => appendSocketEvents(12));
}
function scenarioRealMessageInsert(page, viewportName) {
    return measure(page, `${viewportName}:12-real-message-insert`, () => appendRealMessages(12));
}
function scenarioAsyncHeightChange(page, viewportName) {
    return measure(page, `${viewportName}:async-height-change`, () => asyncHeightChangeBeforeAnchor());
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
