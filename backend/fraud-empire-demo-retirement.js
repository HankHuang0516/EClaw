/* global self */
'use strict';
const { posix } = require('node:path');
const RETIREMENT_ID = 'fraud-empire-demo-retired-20261019-r1';
const ROOTS = ['/AiHankApps/projects/fraud-empire/', '/mission/AiHankApps/projects/fraud-empire/'];
const SCOPES = ROOTS.flatMap(root => [root, root + 'private-host-r15/']);
const COPY = {"zh-TW":{"lang":"zh-Hant","name":"\u8a50\u9a19\u5e1d\u570b","status":"Android \u8207 iOS APP \u958b\u767c\u4e2d","title":"\u7db2\u9801\u8a66\u73a9\u5df2\u4e0b\u67b6","body":"\u672c\u5c08\u6848\u5df2\u8f49\u5411\u96d9\u5e73\u53f0 APP \u672c\u9ad4\u958b\u767c\uff0c\u539f\u7db2\u9801 Demo\u3001\u8a66\u73a9\u5165\u53e3\u8207\u66ff\u4ee3\u8a66\u73a9\u8def\u5f91\u4e0d\u518d\u516c\u958b\u63d0\u4f9b\u3002","download":"\u76ee\u524d\u6c92\u6709\u516c\u958b\u4e0b\u8f09\u6216\u8a66\u73a9\u7248\u672c\u3002","save":"\u6b64\u6b21\u4e0b\u67b6\u7a0b\u5e8f\u4e0d\u6703\u8b80\u53d6\u6216\u6e05\u9664\u60a8\u7684\u500b\u4eba\u5b58\u6a94\u3002","offline":"\u96e2\u7dda\u88dd\u7f6e\u5df2\u4e0b\u8f09\u7684\u526f\u672c\uff0c\u7db2\u7ad9\u7121\u6cd5\u4fdd\u8b49\u9060\u7aef\u64a4\u56de\u3002","back":"\u8fd4\u56de APP \u4f5c\u54c1\u96c6"},"zh-CN":{"lang":"zh-Hans","name":"\u8bc8\u9a97\u5e1d\u56fd","status":"Android \u4e0e iOS APP \u5f00\u53d1\u4e2d","title":"\u7f51\u9875\u8bd5\u73a9\u5df2\u4e0b\u67b6","body":"\u672c\u9879\u76ee\u5df2\u8f6c\u5411\u53cc\u5e73\u53f0 APP \u672c\u4f53\u5f00\u53d1\uff0c\u539f\u7f51\u9875 Demo\u3001\u8bd5\u73a9\u5165\u53e3\u4e0e\u66ff\u4ee3\u8bd5\u73a9\u8def\u5f84\u4e0d\u518d\u516c\u5f00\u63d0\u4f9b\u3002","download":"\u76ee\u524d\u6ca1\u6709\u516c\u5f00\u4e0b\u8f7d\u6216\u8bd5\u73a9\u7248\u672c\u3002","save":"\u672c\u6b21\u4e0b\u67b6\u7a0b\u5e8f\u4e0d\u4f1a\u8bfb\u53d6\u6216\u6e05\u9664\u60a8\u7684\u4e2a\u4eba\u5b58\u6863\u3002","offline":"\u79bb\u7ebf\u8bbe\u5907\u5df2\u4e0b\u8f7d\u7684\u526f\u672c\uff0c\u7f51\u7ad9\u65e0\u6cd5\u4fdd\u8bc1\u8fdc\u7a0b\u64a4\u56de\u3002","back":"\u8fd4\u56de APP \u4f5c\u54c1\u96c6"},"en":{"lang":"en","name":"Fraud Empire","status":"Android and iOS apps in development","title":"Web demo retired","body":"Development is moving to the Android and iOS apps. The web demo, playable links and alternate demo routes are no longer publicly available.","download":"No public app download or playable demo is available.","save":"This retirement does not read or clear your personal saved games.","offline":"Downloaded copies on offline devices cannot be guaranteed to be remotely withdrawn.","back":"Back to the app portfolio"},"ja":{"lang":"ja","name":"\u8a50\u6b3a\u5e1d\u56fd","status":"Android\u30fbiOS \u30a2\u30d7\u30ea\u3092\u958b\u767a\u4e2d","title":"Web \u4f53\u9a13\u7248\u306e\u516c\u958b\u3092\u7d42\u4e86\u3057\u307e\u3057\u305f","body":"\u958b\u767a\u306f Android\u30fbiOS \u30a2\u30d7\u30ea\u672c\u4f53\u3078\u79fb\u884c\u3057\u3066\u3044\u307e\u3059\u3002Web \u4f53\u9a13\u7248\u3001\u30d7\u30ec\u30a4\u7528\u30ea\u30f3\u30af\u3001\u4ee3\u66ff\u30eb\u30fc\u30c8\u306e\u516c\u958b\u306f\u7d42\u4e86\u3057\u307e\u3057\u305f\u3002","download":"\u73fe\u5728\u3001\u516c\u958b\u30c0\u30a6\u30f3\u30ed\u30fc\u30c9\u3084\u4f53\u9a13\u7248\u306f\u3042\u308a\u307e\u305b\u3093\u3002","save":"\u4eca\u56de\u306e\u516c\u958b\u7d42\u4e86\u51e6\u7406\u306f\u3001\u500b\u4eba\u306e\u30bb\u30fc\u30d6\u30c7\u30fc\u30bf\u3092\u8aad\u307f\u53d6\u3063\u305f\u308a\u524a\u9664\u3057\u305f\u308a\u3057\u307e\u305b\u3093\u3002","offline":"\u30aa\u30d5\u30e9\u30a4\u30f3\u7aef\u672b\u306b\u4fdd\u5b58\u3055\u308c\u305f\u30b3\u30d4\u30fc\u306e\u9060\u9694\u64a4\u56de\u306f\u4fdd\u8a3c\u3067\u304d\u307e\u305b\u3093\u3002","back":"\u30a2\u30d7\u30ea\u4f5c\u54c1\u96c6\u306b\u623b\u308b"},"ko":{"lang":"ko","name":"\uc0ac\uae30 \uc81c\uad6d","status":"Android \ubc0f iOS \uc571 \uac1c\ubc1c \uc911","title":"\uc6f9 \uccb4\ud5d8\ud310 \uacf5\uac1c\uac00 \uc885\ub8cc\ub418\uc5c8\uc2b5\ub2c8\ub2e4","body":"Android \ubc0f iOS \uc571 \ubcf8\uccb4 \uac1c\ubc1c\ub85c \uc804\ud658\ud588\uc2b5\ub2c8\ub2e4. \uc6f9 \uccb4\ud5d8\ud310, \uc2e4\ud589 \ub9c1\ud06c \ubc0f \ub300\uccb4 \uccb4\ud5d8 \uacbd\ub85c\ub294 \ub354 \uc774\uc0c1 \uacf5\uac1c\ud558\uc9c0 \uc54a\uc2b5\ub2c8\ub2e4.","download":"\ud604\uc7ac \uacf5\uac1c \ub2e4\uc6b4\ub85c\ub4dc\ub098 \uccb4\ud5d8\ud310\uc740 \uc5c6\uc2b5\ub2c8\ub2e4.","save":"\uc774\ubc88 \uacf5\uac1c \uc885\ub8cc \uc808\ucc28\ub294 \uac1c\uc778 \uc800\uc7a5 \ub370\uc774\ud130\ub97c \uc77d\uac70\ub098 \uc0ad\uc81c\ud558\uc9c0 \uc54a\uc2b5\ub2c8\ub2e4.","offline":"\uc624\ud504\ub77c\uc778 \uae30\uae30\uc5d0 \ub2e4\uc6b4\ub85c\ub4dc\ud55c \uc0ac\ubcf8\uc740 \uc6d0\uaca9 \ud68c\uc218\ub97c \ubcf4\uc7a5\ud560 \uc218 \uc5c6\uc2b5\ub2c8\ub2e4.","back":"\uc571 \ud3ec\ud2b8\ud3f4\ub9ac\uc624\ub85c \ub3cc\uc544\uac00\uae30"}};
function selectLocale(value = '') {
    for (const item of String(value).split(',')) {
        const code = item.split(';')[0].trim().toLowerCase();
        if (/^zh(?:-|$)/.test(code)) return /^zh-(cn|hans|sg)(?:-|$)/.test(code) ? 'zh-CN' : 'zh-TW';
        if (/^ja(?:-|$)/.test(code)) return 'ja';
        if (/^ko(?:-|$)/.test(code)) return 'ko';
        if (/^en(?:-|$)/.test(code)) return 'en';
    }
    return 'zh-TW';
}
function noticeHtml(locale = 'zh-TW') {
    const c = COPY[locale] || COPY['zh-TW'];
    const update = '(' + function updateExistingDemoWorkers(scopes, browser) {
        const { navigator, location } = browser;
        if (!('serviceWorker' in navigator)) return;
        navigator.serviceWorker.getRegistrations().then(async registrations => {
            for (const registration of registrations) {
                const u = new URL(registration.scope);
                if (u.origin === location.origin && scopes.includes(u.pathname)) {
                    try { await registration.update(); } catch { /* Offline copies are not remotely revocable. */ }
                }
            }
        }).catch(() => {});
    }.toString() + ')(' + JSON.stringify(SCOPES) + ',window);';
    return '<!doctype html><html lang="' + c.lang + '" data-demo-retired="' + RETIREMENT_ID + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>' + c.name + ' | ' + c.status + '</title><link rel="icon" href="/AiHankApps/projects/fraud-empire/player-icon-192.png"><style>*{box-sizing:border-box}body{margin:0;min-height:100svh;color:#253c33;background:radial-gradient(ellipse at 85% 0,#dbe5dc,transparent 50%),repeating-linear-gradient(0deg,#f8f5ec 0,#f8f5ec 3px,#f1eee5 4px);font-family:"Songti TC","Noto Serif TC",Georgia,serif;display:grid;place-items:center;padding:24px}main{width:min(100%,740px);padding:clamp(24px,6vw,60px);border:1px solid #c6cfc1;border-radius:24px;background:#fffefaee;box-shadow:0 24px 70px #2b3d2b10}.brand{display:flex;align-items:center;gap:22px;border-bottom:1px solid #d6ddcf;padding-bottom:28px}.brand img{width:88px;height:88px;border-radius:20px;flex-shrink:0}h1{font-size:clamp(27px,6vw,44px);margin:6px 0;line-height:1.25}.status{font:14px Georgia,serif;letter-spacing:.06em;color:#5b735f}h2{font-size:24px;margin-top:32px}p{line-height:1.9;overflow-wrap:anywhere}.note{font-size:14px;color:#667565;border-left:2px solid #c6cfc1;padding-left:16px}a{display:inline-block;color:#284b39;border:1px solid #9eb19e;border-radius:999px;padding:12px 22px;text-decoration:none;margin-top:14px}a:focus-visible{outline:3px solid #8a572f;outline-offset:4px}@media(max-width:390px){body{padding:16px}.brand{gap:14px}.brand img{width:64px;height:64px;border-radius:14px}.status{font-size:12px}}</style></head><body><main><header class="brand"><img src="/AiHankApps/projects/fraud-empire/player-icon-192.png" width="192" height="192" alt="' + c.name + '"><div><p class="status">' + c.status + '</p><h1>' + c.name + '</h1></div></header><h2>' + c.title + '</h2><p>' + c.body + '</p><p>' + c.download + '</p><p class="note">' + c.save + '<br>' + c.offline + '</p><a href="/AiHankApps/">' + c.back + '</a></main><script>' + update + '</script></body></html>';
}
function retirementWorker(config) {
    const origin = new self.URL(self.registration.scope).origin;
    const scope = new self.URL(self.registration.scope).pathname;
    if (!config.scopes.includes(scope)) throw new Error('unexpected-demo-retirement-scope');
    const owned = value => {
        try { const u = new self.URL(value); return u.origin === origin && config.roots.some(root => u.pathname.startsWith(root)); }
        catch { return false; }
    };
    const icon = value => {
        const u = new self.URL(value);
        return u.origin === origin && config.roots.some(root => /^player-icon-(180|192|512)\.png$/.test(u.pathname.slice(root.length)) && u.pathname.startsWith(root));
    };
    const cachePrefixes = config.scopes.flatMap(s => ['fraud-player-static:' + s + ':', 'fraud-player-meta:' + s + ':']);
    const destination = new self.URL(config.roots[scope.startsWith('/mission/') ? 1 : 0], origin).href;
    self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
    self.addEventListener('activate', event => event.waitUntil((async () => {
        let cacheCleanupComplete = true;
        try { await self.clients.claim(); } catch { /* Still retire owned clients and registration. */ }
        try {
            for (const key of await self.caches.keys()) {
                if (cachePrefixes.some(prefix => key.startsWith(prefix))) {
                    try { if (!await self.caches.delete(key)) cacheCleanupComplete = false; }
                    catch { cacheCleanupComplete = false; }
                }
            }
        } catch { cacheCleanupComplete = false; }
        try {
            const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
            for (const client of clients) {
                if (!owned(client.url)) continue;
                try { client.postMessage({ type: 'FRAUD_DEMO_RETIRED', retirementId: config.id, cacheCleanupComplete }); } catch { /* Navigation still retires the page. */ }
                try { await client.navigate(destination); } catch { /* Offline / closing clients cannot be recalled. */ }
            }
        } finally { await self.registration.unregister(); }
    })()));
    self.addEventListener('fetch', event => {
        if (event.request.method !== 'GET' || !owned(event.request.url)) return;
        const url = new self.URL(event.request.url);
        if (icon(url.href) || config.scopes.some(s => url.pathname === s + 'player-service-worker.js')) {
            event.respondWith(self.fetch(event.request));
            return;
        }
        const root = config.roots.find(r => url.pathname.startsWith(r));
        const status = url.pathname === root || url.pathname === root + 'index.html' ? 200 : 410;
        const locale = config.selectLocale(event.request.headers.get('accept-language') || self.navigator?.language || '');
        event.respondWith(Promise.resolve(new self.Response(config.notices[locale], { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Fraud-Empire-Demo': config.id } })));
    });
}
const workerConfig = { id: RETIREMENT_ID, roots: ROOTS, scopes: SCOPES, notices: Object.fromEntries(Object.keys(COPY).map(key => [key, noticeHtml(key)])) };
const workerSource = "'use strict';\n(" + retirementWorker.toString() + ')(Object.assign(' + JSON.stringify(workerConfig) + ',{selectLocale:' + selectLocale.toString() + '}));\n';
function normalizedPath(value) {
    try { return posix.normalize(decodeURIComponent(new URL(value, 'http://local.invalid').pathname).replace(/\\/g, '/')); }
    catch { return null; }
}
function retireFraudEmpireDemo(req, res, next) {
    const pathname = normalizedPath(req.originalUrl || req.url);
    if (!pathname) return next();
    const root = ROOTS.find(base => pathname.toLowerCase() === base.slice(0, -1).toLowerCase() || pathname.toLowerCase().startsWith(base.toLowerCase()));
    if (!root) return next();
    const relative = pathname.slice(root.length - 1).toLowerCase();
    if (/^\/player-icon-(180|192|512)\.png$/.test(relative) && ['GET', 'HEAD'].includes(req.method)) return next();
    res.set({ 'Cache-Control': 'no-store', 'CDN-Cache-Control': 'no-store', 'Cloudflare-CDN-Cache-Control': 'no-store', 'X-Fraud-Empire-Demo': RETIREMENT_ID });
    if (req.method === 'GET' && ['/player-service-worker.js', '/private-host-r15/player-service-worker.js'].includes(relative)) {
        res.set('Service-Worker-Allowed', root + (relative.startsWith('/private-host-r15/') ? 'private-host-r15/' : ''));
        return res.type('application/javascript').send(workerSource);
    }
    const introduction = ['', '/', '/index.html'].includes(relative) && ['GET', 'HEAD'].includes(req.method);
    return res.status(introduction ? 200 : 410).type('html').send(noticeHtml(selectLocale(req.get('accept-language'))));
}
module.exports = { RETIREMENT_ID, ROOTS, SCOPES, COPY, selectLocale, noticeHtml, workerSource, normalizedPath, retireFraudEmpireDemo };
