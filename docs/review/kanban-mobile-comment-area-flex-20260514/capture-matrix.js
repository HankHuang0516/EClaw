#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '../../..');
const outDir = path.resolve(__dirname);
const base = 'http://127.0.0.1:8765/docs/review/kanban-mobile-comment-area-flex-20260514/harness.html';
const port = 9224 + Math.floor(Math.random() * 400);
const chrome = spawn('/usr/bin/chromium', [
  '--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=/tmp/eclaw-kanban-cdp-${process.pid}`, 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });

let stderr = '';
chrome.stderr.on('data', d => { stderr += d.toString(); });

async function waitForWs() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const pages = await res.json();
        const page = pages.find(p => p.type === 'page' && p.webSocketDebuggerUrl);
        if (page) return page.webSocketDebuggerUrl;
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Timed out waiting for Chromium CDP. stderr=' + stderr.slice(-1000));
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result || {});
    }
  };
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  return {
    async send(method, params = {}) {
      await ready;
      const msgId = ++id;
      ws.send(JSON.stringify({ id: msgId, method, params }));
      return new Promise((resolve, reject) => pending.set(msgId, { resolve, reject }));
    },
    close() { ws.close(); }
  };
}

async function settle(client) {
  for (let i = 0; i < 20; i++) {
    const r = await client.send('Runtime.evaluate', { expression: 'document.readyState + "|" + !!document.body.getAttribute("data-metrics")', returnByValue: true });
    if (r.result?.value === 'complete|true') return;
    await new Promise(r => setTimeout(r, 100));
  }
}

async function capture(client, { w, h, mode, tab = 'comments', focus = false, scroll = true }) {
  await client.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w <= 768 });
  await client.send('Page.navigate', { url: `${base}?mode=${mode}&tab=${tab}${focus ? '&focus=1' : ''}${scroll ? '&scroll=1' : ''}` });
  await settle(client);
  const m = await client.send('Runtime.evaluate', { expression: 'document.body.getAttribute("data-metrics")', returnByValue: true });
  const metrics = JSON.parse(m.result.value);
  let scrollProbe = null;
  if (tab === 'comments') {
    const probe = await client.send('Runtime.evaluate', { expression: `(() => { const el = document.querySelector('.kb-comments-list'); if (!el) return null; const before=el.scrollTop; el.scrollTop = Math.max(0, el.scrollTop - 90); const up=el.scrollTop; el.scrollTop = before + 120; return {before, up, down: el.scrollTop, max: el.scrollHeight - el.clientHeight, movedUp: up < before, movedDown: el.scrollTop > up}; })()`, returnByValue: true });
    scrollProbe = probe.result?.value || null;
  }
  const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  const name = `${mode}-${w}x${h}-${tab}${focus ? '-input-focused' : ''}.png`;
  await fs.writeFile(path.join(outDir, name), Buffer.from(shot.data, 'base64'));
  return { file: name, ...metrics, scrollProbe };
}

(async () => {
  const ws = await waitForWs();
  const client = cdp(ws);
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  const viewports = [[360,740],[412,892],[768,1024],[1280,800],[456,1023]];
  const results = [];
  for (const [w,h] of viewports) {
    for (const mode of ['before','after']) results.push(await capture(client, { w,h,mode }));
  }
  for (const tab of ['notes','files','screenshots']) results.push(await capture(client, { w: 412, h: 892, mode: 'after', tab, scroll:false }));
  results.push(await capture(client, { w: 412, h: 892, mode: 'after', tab:'comments', focus:true }));
  await fs.writeFile(path.join(outDir, 'matrix-results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  client.close();
  chrome.kill('SIGTERM');
})().catch(err => { console.error(err); chrome.kill('SIGTERM'); process.exit(1); });
