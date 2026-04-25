// mission-mindmap.js — Phase A static-mock integration (PR-A)
//
// Lazy-loaded on first expand of the "🧠 心智圖" card in mission.html.
// PR-A ships the mockup verbatim (52 nodes / 76 edges / 8 subsystems) so
// Hank can verify layout + interaction in production.
// PR-B will replace MOCK_NODES/MOCK_EDGES by mapping /api/mission/cards
// (assignedTo→sys, status→active|blocked|done) and chat embedding coords.
(function (global) {
  'use strict';

  if (global.MissionMindmap) return;

  const CDN = 'https://cdn.jsdelivr.net/npm/cytoscape@3.28.1/dist/cytoscape.min.js';

  const SYS = {
    invite:    { color: '#f43f5e', label: '邀請成長' },
    device:    { color: '#06b6d4', label: '裝置' },
    i18n:      { color: '#a855f7', label: 'i18n' },
    kanban:    { color: '#22c55e', label: '看板' },
    chat:      { color: '#3b82f6', label: '聊天' },
    payment:   { color: '#eab308', label: '支付' },
    broadcast: { color: '#f97316', label: '廣播' },
    bridge:    { color: '#ec4899', label: '橋接' },
  };

  const MOCK_NODES = [
  // 邀請 (7)
  { id: 'inv-hub', label: '邀請系統', sys: 'invite', tier: 'domain', status: 'active', summary: '8 碼邀請、redeem、tier milestone、funnel telemetry。本週 0/9 兌換率 0%。' },
  { id: 'inv-code', label: '8 碼生碼', sys: 'invite', tier: 'topic', status: 'done' },
  { id: 'inv-redeem', label: 'Redeem flow', sys: 'invite', tier: 'topic', status: 'active' },
  { id: 'inv-tier', label: 'Tier milestone', sys: 'invite', tier: 'topic', status: 'active', summary: 'Tier 1=邀請 1 人解鎖 chip preview' },
  { id: 'inv-leader', label: 'Leaderboard', sys: 'invite', tier: 'topic', status: 'blocked', summary: '需要先有 30+ 用戶才有意義' },
  { id: 'inv-funnel', label: 'Funnel telemetry', sys: 'invite', tier: 'leaf', status: 'active' },
  { id: 'inv-qr', label: 'QR 海報生成', sys: 'invite', tier: 'leaf', status: 'done' },

  // 裝置 (6)
  { id: 'dev-hub', label: '裝置 / Device', sys: 'device', tier: 'domain', status: 'active', summary: 'deviceId+secret 認證、輪替、health probe。' },
  { id: 'dev-rotate', label: 'Secret 輪替', sys: 'device', tier: 'topic', status: 'active', summary: 'POST /api/device/rotate-secret + 一次性 dialog' },
  { id: 'dev-health', label: 'rental-health cron', sys: 'device', tier: 'topic', status: 'done' },
  { id: 'dev-vars', label: 'device-vars vault', sys: 'device', tier: 'topic', status: 'done' },
  { id: 'dev-switch', label: 'Switch Device', sys: 'device', tier: 'leaf', status: 'blocked', summary: '12.4h stale; 等 i18n' },
  { id: 'dev-logs', label: '/api/logs (DEVICE_SECRET)', sys: 'device', tier: 'leaf', status: 'done' },

  // i18n (8)
  { id: 'i18n-hub', label: 'i18n 13 locale', sys: 'i18n', tier: 'domain', status: 'active', summary: 'en/zh/zh-TW/ja/ko/de/es/fr/pt/it/vi/th/id/ms/hi/ar — chip_popover 缺 10' },
  { id: 'i18n-shared', label: 'shared/i18n.js (live)', sys: 'i18n', tier: 'topic', status: 'active', summary: '~61k lines, 唯一被 HTML import' },
  { id: 'i18n-deadtop', label: '頂層 ./i18n.js (dead)', sys: 'i18n', tier: 'leaf', status: 'done', summary: '已 git rm + CI guard' },
  { id: 'i18n-chip', label: 'chip_popover_*', sys: 'i18n', tier: 'topic', status: 'blocked', summary: 'Mac_E 兩次 wrong-file fail' },
  { id: 'i18n-kb', label: 'kb_/kanban_*', sys: 'i18n', tier: 'topic', status: 'blocked' },
  { id: 'i18n-strict-ci', label: 'i18n-check.js (strict)', sys: 'i18n', tier: 'leaf', status: 'done' },
  { id: 'i18n-key-audit', label: '558 stray }, audit', sys: 'i18n', tier: 'leaf', status: 'done' },
  { id: 'i18n-translator', label: 'Mac_E i18n agent', sys: 'i18n', tier: 'leaf', status: 'blocked', summary: '錯檔路徑寫死，已 STOP' },

  // 看板 (7)
  { id: 'kb-hub', label: '看板系統', sys: 'kanban', tier: 'domain', status: 'active' },
  { id: 'kb-card', label: '/mission/card API', sys: 'kanban', tier: 'topic', status: 'done' },
  { id: 'kb-screenshot-gate', label: 'screenshot 截圖閘', sys: 'kanban', tier: 'topic', status: 'active' },
  { id: 'kb-r2-ttl', label: 'R2 TTL ≥3 days', sys: 'kanban', tier: 'leaf', status: 'done', summary: 'PR #2090 merged' },
  { id: 'kb-deeplink', label: '深層連結 anchor scroll', sys: 'kanban', tier: 'leaf', status: 'done' },
  { id: 'kb-notes-tab', label: '筆記 tab snake_case bug', sys: 'kanban', tier: 'leaf', status: 'active' },
  { id: 'kb-mention', label: '@mention → entityId', sys: 'kanban', tier: 'topic', status: 'active' },

  // 聊天 (8)
  { id: 'chat-hub', label: '聊天 / Chat', sys: 'chat', tier: 'domain', status: 'active' },
  { id: 'chat-chip', label: '智慧引用晶片', sys: 'chat', tier: 'topic', status: 'active', summary: '@chip_popover_X 點擊預覽' },
  { id: 'chat-chip-recursive', label: '預覽卡內遞迴 chip', sys: 'chat', tier: 'leaf', status: 'active' },
  { id: 'chat-pin-btn', label: '📌 重新引用按鈕', sys: 'chat', tier: 'leaf', status: 'done', summary: 'PR #2089 merged' },
  { id: 'chat-history-api', label: '/api/chat/history', sys: 'chat', tier: 'topic', status: 'done' },
  { id: 'chat-schedule', label: '排程訊息 (long-press)', sys: 'chat', tier: 'topic', status: 'done' },
  { id: 'chat-embed', label: 'embed=1 mode', sys: 'chat', tier: 'leaf', status: 'done' },
  { id: 'chat-share', label: 'share-chat.html 公開', sys: 'chat', tier: 'leaf', status: 'active' },

  // 支付 (5)
  { id: 'pay-hub', label: '支付 / 訂閱', sys: 'payment', tier: 'domain', status: 'active' },
  { id: 'pay-topup-b', label: 'Top-up Path B (sandbox)', sys: 'payment', tier: 'topic', status: 'active', summary: 'Android emu 已有 Play 帳號' },
  { id: 'pay-iap-android', label: 'Android IAP', sys: 'payment', tier: 'topic', status: 'active' },
  { id: 'pay-iap-ios', label: 'iOS StoreKit', sys: 'payment', tier: 'topic', status: 'blocked', summary: '等 Apple Connect 設定' },
  { id: 'pay-wallet', label: 'wallet.html 餘額', sys: 'payment', tier: 'leaf', status: 'done' },

  // 廣播 (6)
  { id: 'bcast-hub', label: '廣播 / Publisher', sys: 'broadcast', tier: 'domain', status: 'active' },
  { id: 'bcast-x', label: 'X (Twitter)', sys: 'broadcast', tier: 'topic', status: 'active' },
  { id: 'bcast-mastodon', label: 'Mastodon', sys: 'broadcast', tier: 'leaf', status: 'done', summary: '已棄用 2026-04-15' },
  { id: 'bcast-wp', label: 'WordPress.com', sys: 'broadcast', tier: 'leaf', status: 'done', summary: '已退役 2026-04-20' },
  { id: 'bcast-cron', label: 'Daily viral cron', sys: 'broadcast', tier: 'topic', status: 'active' },
  { id: 'bcast-design', label: 'Claude Design 視覺', sys: 'broadcast', tier: 'leaf', status: 'active' },

  // 橋接 (5)
  { id: 'br-hub', label: '橋接 / Bridge', sys: 'bridge', tier: 'domain', status: 'active' },
  { id: 'br-auth', label: 'bridge-auth (osascript)', sys: 'bridge', tier: 'topic', status: 'done' },
  { id: 'br-eye', label: 'eye 螢幕全覽', sys: 'bridge', tier: 'leaf', status: 'done' },
  { id: 'br-hermes-docker', label: 'hermes-bridge service', sys: 'bridge', tier: 'topic', status: 'done', summary: 'card_7102c915 closed' },
  { id: 'br-unit-u01', label: 'U01 = app E2E', sys: 'bridge', tier: 'leaf', status: 'active' },
]

  const MOCK_EDGES = [
  // 邀請 tree
  ['inv-hub','inv-code'],['inv-hub','inv-redeem'],['inv-hub','inv-tier'],
  ['inv-hub','inv-leader'],['inv-redeem','inv-funnel'],['inv-code','inv-qr'],
  // 裝置 tree
  ['dev-hub','dev-rotate'],['dev-hub','dev-health'],['dev-hub','dev-vars'],
  ['dev-hub','dev-switch'],['dev-hub','dev-logs'],
  // i18n tree
  ['i18n-hub','i18n-shared'],['i18n-hub','i18n-chip'],['i18n-hub','i18n-kb'],
  ['i18n-shared','i18n-strict-ci'],['i18n-shared','i18n-key-audit'],
  ['i18n-shared','i18n-deadtop'],['i18n-hub','i18n-translator'],
  // 看板 tree
  ['kb-hub','kb-card'],['kb-hub','kb-screenshot-gate'],['kb-screenshot-gate','kb-r2-ttl'],
  ['kb-hub','kb-deeplink'],['kb-hub','kb-notes-tab'],['kb-hub','kb-mention'],
  // 聊天 tree
  ['chat-hub','chat-chip'],['chat-chip','chat-chip-recursive'],['chat-chip','chat-pin-btn'],
  ['chat-hub','chat-history-api'],['chat-hub','chat-schedule'],['chat-hub','chat-embed'],
  ['chat-hub','chat-share'],
  // 支付 tree
  ['pay-hub','pay-topup-b'],['pay-hub','pay-iap-android'],['pay-hub','pay-iap-ios'],
  ['pay-hub','pay-wallet'],['pay-iap-android','pay-topup-b'],
  // 廣播 tree
  ['bcast-hub','bcast-x'],['bcast-hub','bcast-mastodon'],['bcast-hub','bcast-wp'],
  ['bcast-hub','bcast-cron'],['bcast-cron','bcast-design'],
  // 橋接 tree
  ['br-hub','br-auth'],['br-auth','br-eye'],['br-hub','br-hermes-docker'],['br-hub','br-unit-u01'],

  // ⛓ Cross-system dependencies (different style)
  ['i18n-chip','chat-chip','depends'],         // chip 引用要等 i18n
  ['i18n-kb','kb-hub','depends'],
  ['i18n-translator','br-auth','via'],         // i18n 派工經 bridge-auth
  ['inv-redeem','dev-vars','via'],
  ['inv-tier','chat-chip','unlocks'],
  ['kb-screenshot-gate','bcast-cron','required'],
  ['chat-schedule','kb-mention','reuses'],
  ['br-hermes-docker','i18n-translator','runs'],
  ['pay-topup-b','dev-health','telemetry'],
  ['bcast-x','dev-vars','reads-key'],
  ['bcast-design','br-auth','uses'],
  ['kb-card','chat-history-api','share-DB'],
  ['inv-funnel','bcast-cron','feeds'],
  ['dev-switch','i18n-chip','blocked-by'],
  ['chat-pin-btn','i18n-chip','i18n-key'],
  ['kb-deeplink','chat-chip','same-anchor'],
  ['br-unit-u01','kb-screenshot-gate','attaches'],
  ['chat-share','bcast-x','outbound'],
  ['inv-qr','bcast-design','asset'],
]

  const STYLE_ID = 'mission-mindmap-style';
  const STYLE_CSS = `
    :root {
      --bg: #0d1117; --bg-elev: #161b22;
      --card-border: #2a2f3a; --text: #e6edf3;
      --text-secondary: #8b949e;
    }
    .mm-root {
      display: grid;
      grid-template-columns: 220px 1fr 320px;
      height: 540px;
      background: var(--bg, #0d1117);
      border: 1px solid var(--card-border, #2a2f3a);
      border-radius: 8px; overflow: hidden;
      font-size: 13px; color: var(--text, #e6edf3);
    }
    .sys-rail {
      background: var(--bg-elev, #161b22);
      border-right: 1px solid var(--card-border, #2a2f3a);
      padding: 14px 12px; overflow-y: auto;
      display: flex; flex-direction: column; gap: 10px;
    }
    .sys-row {
      display: flex; align-items: center; gap: 7px;
      padding: 5px 8px; border-radius: 5px; cursor: pointer;
      font-size: 12px; transition: background 0.15s;
    }
    .sys-row:hover { background: rgba(255,255,255,0.06); }
    .sys-row.active { background: rgba(255,255,255,0.10); }
    .sys-row .swatch { width: 8px; height: 8px; border-radius: 2px; flex: none; }
    .sys-row .name { flex: 1; color: var(--text, #e6edf3); }
    .sys-row .count {
      font-size: 10px; background: rgba(255,255,255,0.08);
      padding: 1px 6px; border-radius: 8px; color: var(--text-secondary, #8b949e);
    }
    .mm-rail-toolbar {
      display: flex; flex-direction: column; gap: 6px;
    }
    .mm-search {
      width: 100%; box-sizing: border-box;
      background: var(--bg, #0d1117); color: var(--text, #e6edf3);
      border: 1px solid var(--card-border, #2a2f3a);
      border-radius: 5px; padding: 6px 8px; font-size: 12px;
      outline: none; transition: border-color 0.15s;
    }
    .mm-search:focus { border-color: #3b82f6; }
    .mm-add-btn {
      background: #3b82f6; color: #fff; border: none;
      border-radius: 5px; padding: 6px 10px; font-size: 12px;
      cursor: pointer; font-weight: 600; transition: filter 0.15s;
    }
    .mm-add-btn:hover { filter: brightness(1.1); }
    .mm-sep {
      height: 1px; background: var(--card-border, #2a2f3a);
      margin: 4px -12px;
    }
    .legend-block {
      padding-top: 4px; margin-top: auto;
    }
    .legend-block h4 {
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;
      color: var(--text-secondary, #8b949e); margin: 0 0 6px 0;
    }
    .legend-row {
      display: flex; align-items: center; gap: 6px;
      font-size: 11px; color: var(--text-secondary, #8b949e); margin-bottom: 3px;
    }
    .status-ring {
      width: 8px; height: 8px; border-radius: 50%; flex: none;
    }
    .status-ring.active { background: #fde047; }
    .status-ring.blocked { background: #ef4444; }
    .status-ring.done { background: #22c55e; }
    .summary-block {
      padding-top: 4px; font-size: 11px;
      color: var(--text-secondary, #8b949e); line-height: 1.6;
    }
    .mm-modal-bg {
      position: fixed; inset: 0; background: rgba(0,0,0,0.55);
      display: none; align-items: center; justify-content: center; z-index: 1000;
    }
    .mm-modal-bg.visible { display: flex; }
    .mm-modal {
      background: var(--bg-elev, #161b22); border: 1px solid var(--card-border, #2a2f3a);
      border-radius: 8px; padding: 18px 20px; min-width: 320px;
      color: var(--text, #e6edf3); font-size: 13px;
    }
    .mm-modal h3 { margin: 0 0 12px 0; font-size: 14px; }
    .mm-modal label { display: block; font-size: 11px; color: var(--text-secondary, #8b949e); margin: 8px 0 3px; }
    .mm-modal input, .mm-modal select {
      width: 100%; box-sizing: border-box;
      background: var(--bg, #0d1117); color: var(--text, #e6edf3);
      border: 1px solid var(--card-border, #2a2f3a);
      border-radius: 4px; padding: 5px 8px; font-size: 12px; outline: none;
    }
    .mm-modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
    .mm-modal-actions button {
      padding: 6px 14px; border-radius: 4px; border: none; cursor: pointer; font-size: 12px;
    }
    .mm-modal-cancel { background: transparent; color: var(--text-secondary, #8b949e); }
    .mm-modal-submit { background: #3b82f6; color: #fff; font-weight: 600; }
    .sys-row.hilite { background: rgba(59,130,246,0.18); outline: 1px solid #3b82f6; }
    .summary-block .num { color: var(--text, #e6edf3); font-weight: 600; }
    .mind-canvas-wrap {
      position: relative; background: var(--bg, #0d1117); overflow: hidden;
    }
    .mm-toolbar {
      position: absolute; top: 12px; left: 12px; z-index: 10;
      display: flex; gap: 6px;
      background: rgba(22,27,34,0.85); backdrop-filter: blur(8px);
      border: 1px solid var(--card-border, #2a2f3a);
      border-radius: 8px; padding: 6px;
    }
    .mm-toolbar button {
      background: transparent; border: none; color: var(--text, #e6edf3);
      padding: 5px 10px; border-radius: 5px; cursor: pointer; font-size: 12px;
    }
    .mm-toolbar button:hover { background: rgba(255,255,255,0.08); }
    .mm-tier {
      position: absolute; top: 14px; left: 50%; transform: translateX(-50%);
      font-size: 10px; color: var(--text-secondary, #8b949e);
      z-index: 5; pointer-events: none;
    }
    .mm-tier strong { color: var(--text, #e6edf3); }
    .mm-cy { position: absolute; inset: 0; }
    .mind-side {
      background: var(--bg-elev, #161b22);
      border-left: 1px solid var(--card-border, #2a2f3a);
      display: flex; flex-direction: column; overflow-y: auto;
    }
    .mm-empty {
      display: flex; flex-direction: column; align-items: center;
      justify-content: center; height: 100%; padding: 24px; text-align: center;
      color: var(--text-secondary, #8b949e); font-size: 13px;
    }
    .mm-empty .mm-emoji { font-size: 28px; margin-bottom: 8px; }
    .mm-empty .mm-hint {
      margin-top: 8px; font-size: 10px; opacity: 0.7; line-height: 1.6;
    }
    .mm-detail {
      padding: 14px; display: none; flex-direction: column; gap: 10px; overflow-y: auto;
    }
    .mm-detail.visible { display: flex; }
    .mm-detail h4 { font-size: 14px; margin: 0; color: var(--text, #e6edf3); }
    .mm-pills { display: flex; gap: 5px; flex-wrap: wrap; }
    .mm-pill {
      font-size: 10px; padding: 2px 7px; border-radius: 10px;
      font-weight: 600; letter-spacing: 0.4px;
    }
    .mm-pill-status.active { background: rgba(253,224,71,0.15); color: #fde047; }
    .mm-pill-status.blocked { background: rgba(239,68,68,0.15); color: #ef4444; }
    .mm-pill-status.done { background: rgba(34,197,94,0.15); color: #22c55e; }
    .mm-summary-text {
      color: var(--text-secondary, #8b949e); font-size: 12px; line-height: 1.55;
    }
    .mm-section h5 {
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.6px;
      color: var(--text-secondary, #8b949e); margin: 0 0 6px 0; font-weight: 600;
    }
    .mm-related { display: flex; flex-direction: column; gap: 3px; }
    .mm-related-row {
      font-size: 11px; padding: 5px 7px; border-radius: 4px;
      background: rgba(255,255,255,0.03); cursor: pointer;
      display: flex; align-items: center; gap: 6px;
    }
    .mm-related-row:hover { background: rgba(255,255,255,0.07); }
    .mm-related-row .swatch { width: 7px; height: 7px; border-radius: 2px; flex: none; }
  `;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = STYLE_CSS;
    document.head.appendChild(s);
  }

  function loadCytoscape() {
    if (global.cytoscape) return Promise.resolve(global.cytoscape);
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${CDN}"]`);
      if (existing) {
        existing.addEventListener('load', () => resolve(global.cytoscape));
        existing.addEventListener('error', reject);
        return;
      }
      const s = document.createElement('script');
      s.src = CDN;
      s.onload = () => resolve(global.cytoscape);
      s.onerror = () => reject(new Error('cytoscape CDN failed'));
      document.head.appendChild(s);
    });
  }

  function countBySys(nodes) {
    const counts = {};
    for (const n of nodes) counts[n.sys] = (counts[n.sys] || 0) + 1;
    return counts;
  }

  function renderShell(rootEl, nodes, edges) {
    const counts = countBySys(nodes);
    const railRows = Object.entries(SYS).map(([key, s]) => {
      const c = counts[key] || 0;
      return `<div class="sys-row" data-sys="${key}">
        <span class="swatch" style="background:${s.color}"></span>
        <span class="name">${s.label}</span>
        <span class="count">${c}</span>
      </div>`;
    }).join('');

    const crossCount = edges.filter(e => e.length === 3).length;

    rootEl.innerHTML = `
      <aside class="sys-rail">
        <div class="mm-rail-toolbar">
          <input type="text" class="mm-search" placeholder="🔍 搜尋節點..." aria-label="搜尋節點">
          <button class="mm-add-btn" data-act="add-node">+ 新節點</button>
        </div>
        <div class="mm-sep"></div>
        <h3>子系統</h3>
        ${railRows}
        <div class="mm-sep"></div>
        <div class="legend-block">
          <h3>節點狀態</h3>
          <div class="legend-row"><span class="status-ring active"></span>進行中</div>
          <div class="legend-row"><span class="status-ring blocked"></span>阻塞</div>
          <div class="legend-row"><span class="status-ring done"></span>完成</div>
        </div>
        <div class="mm-sep"></div>
        <div class="summary-block">
          <span class="num">${nodes.length}</span> 節點 ·
          <span class="num">${edges.length}</span> 連線<br>
          <span class="num">${crossCount}</span> 跨系統依賴
        </div>
      </aside>
      <div class="mm-modal-bg" data-modal>
        <div class="mm-modal">
          <h3>新增節點</h3>
          <label>標籤 (label)</label>
          <input type="text" data-modal-label placeholder="例：新功能名稱">
          <label>子系統</label>
          <select data-modal-sys>
            ${Object.entries(SYS).map(([k, s]) => `<option value="${k}">${s.label}</option>`).join('')}
          </select>
          <label>層級 (tier)</label>
          <select data-modal-tier>
            <option value="domain">domain</option>
            <option value="topic" selected>topic</option>
            <option value="leaf">leaf</option>
          </select>
          <label>狀態</label>
          <select data-modal-status>
            <option value="active" selected>active</option>
            <option value="blocked">blocked</option>
            <option value="done">done</option>
          </select>
          <div class="mm-modal-actions">
            <button class="mm-modal-cancel" data-modal-cancel>取消</button>
            <button class="mm-modal-submit" data-modal-submit>新增</button>
          </div>
        </div>
      </div>
      <div class="mind-canvas-wrap">
        <div class="mm-toolbar">
          <button data-act="fit">🎯 Fit</button>
          <button data-act="reset">🔄 重整</button>
        </div>
        <div class="mm-tier">L1 · <strong>Topics</strong></div>
        <div class="mm-cy"></div>
      </div>
      <aside class="mind-side">
        <div class="mm-empty">
          <div class="mm-emoji">🧠</div>
          點任一節點查看相關依賴。
          <div class="mm-hint">滾輪 zoom · 拖曳 pan<br>左側點子系統可單獨高亮</div>
        </div>
        <div class="mm-detail">
          <h4></h4>
          <div class="mm-pills"></div>
          <div class="mm-summary-text"></div>
          <div class="mm-section">
            <h5>跨系統相關節點</h5>
            <div class="mm-related"></div>
          </div>
        </div>
      </aside>
    `;
  }

  function buildCy(canvasEl, nodes, edges) {
    const nodesById = Object.fromEntries(nodes.map(n => [n.id, n]));
    const cyNodes = nodes.map(n => ({ data: { ...n, sysColor: SYS[n.sys].color } }));
    const cyEdges = edges.map(([s, t, label]) => ({
      data: { id: `${s}__${t}`, source: s, target: t, label: label || '', cross: !!label }
    }));

    const cy = global.cytoscape({
      container: canvasEl,
      elements: [...cyNodes, ...cyEdges],
      layout: {
        name: 'cose', padding: 30, animate: false, fit: true,
        idealEdgeLength: 95, nodeRepulsion: 8500, edgeElasticity: 100,
        nestingFactor: 1.2, gravity: 0.3, numIter: 1800, componentSpacing: 70,
      },
      style: [
        { selector: 'node', style: {
          'label': 'data(label)',
          'color': '#e6edf3',
          'font-size': 10,
          'font-weight': 600,
          'text-valign': 'center',
          'text-halign': 'center',
          'text-wrap': 'wrap',
          'text-max-width': 80,
          'background-color': 'data(sysColor)',
          'background-opacity': 0.18,
          'border-width': 2,
          'border-color': 'data(sysColor)',
          'width': 54,
          'height': 54,
          'shape': 'round-rectangle',
        }},
        { selector: 'node[tier="domain"]', style: {
          'width': 88, 'height': 88, 'font-size': 12,
          'background-opacity': 0.28, 'border-width': 3,
        }},
        { selector: 'node[tier="topic"]', style: {
          'width': 68, 'height': 68, 'font-size': 11, 'background-opacity': 0.2,
        }},
        { selector: 'node[tier="leaf"]', style: {
          'width': 50, 'height': 50, 'font-size': 9, 'background-opacity': 0.13,
        }},
        { selector: 'node[status="active"]', style: { 'overlay-color': '#fde047', 'overlay-opacity': 0.06 }},
        { selector: 'node[status="blocked"]', style: {
          'border-color': '#ef4444', 'border-style': 'solid',
          'overlay-color': '#ef4444', 'overlay-opacity': 0.08,
        }},
        { selector: 'node[status="done"]', style: { 'border-style': 'dashed', 'opacity': 0.6 }},
        { selector: 'node:selected', style: {
          'border-color': '#fde047', 'border-width': 4,
          'overlay-color': '#fde047', 'overlay-opacity': 0.18,
        }},
        { selector: 'edge', style: {
          'width': 1.1,
          'line-color': '#2a2f3a',
          'target-arrow-color': '#2a2f3a',
          'target-arrow-shape': 'triangle',
          'curve-style': 'bezier',
          'opacity': 0.55,
          'arrow-scale': 0.75,
        }},
        { selector: 'edge[cross="true"]', style: {
          'line-color': '#fbbf24',
          'target-arrow-color': '#fbbf24',
          'line-style': 'dashed',
          'opacity': 0.7,
          'width': 1.3,
          'label': 'data(label)',
          'font-size': 8,
          'color': '#fbbf24',
          'text-background-color': '#0d1117',
          'text-background-opacity': 0.85,
          'text-background-padding': 2,
        }},
        { selector: 'edge:selected', style: {
          'line-color': '#fde047', 'target-arrow-color': '#fde047',
          'opacity': 1, 'width': 2.5,
        }},
        { selector: '.faded', style: { 'opacity': 0.12 }},
        { selector: '.highlighted', style: { 'opacity': 1 }},
      ],
    });

    return { cy, nodesById };
  }

  function bindEvents(rootEl, cy, nodesById) {
    const emptyEl = rootEl.querySelector('.mm-empty');
    const detailEl = rootEl.querySelector('.mm-detail');
    const titleEl = detailEl.querySelector('h4');
    const pillsEl = detailEl.querySelector('.mm-pills');
    const summaryEl = detailEl.querySelector('.mm-summary-text');
    const relatedEl = detailEl.querySelector('.mm-related');
    const tierEl = rootEl.querySelector('.mm-tier');

    function showSide(n) {
      emptyEl.style.display = 'none';
      detailEl.classList.add('visible');
      const d = n.data();
      titleEl.textContent = d.label;
      const sysMeta = SYS[d.sys];
      pillsEl.innerHTML = `
        <span class="mm-pill" style="background:${sysMeta.color}26;color:${sysMeta.color};">${sysMeta.label}</span>
        <span class="mm-pill mm-pill-status ${d.status}">${d.status}</span>
      `;
      summaryEl.textContent = d.summary || `(${sysMeta.label} 子系統 · ${d.tier})`;

      relatedEl.innerHTML = '';
      const seen = new Set();
      n.neighborhood('node').forEach(nb => {
        if (nb.id() === n.id()) return;
        const nd = nb.data();
        if (nd.sys === d.sys) return;
        if (seen.has(nb.id())) return;
        seen.add(nb.id());
        const row = document.createElement('div');
        row.className = 'mm-related-row';
        row.dataset.target = nb.id();
        row.innerHTML = `
          <span class="swatch" style="background:${SYS[nd.sys].color}"></span>
          <span>${nd.label}</span>
          <span style="color:var(--text-secondary,#8b949e);font-size:10px;margin-left:auto;">${SYS[nd.sys].label}</span>
        `;
        relatedEl.appendChild(row);
      });
      if (!relatedEl.children.length) {
        relatedEl.innerHTML = '<div style="font-size:11px;color:var(--text-secondary,#8b949e);padding:5px;">沒有跨系統依賴</div>';
      }
    }

    cy.on('tap', 'node', (evt) => {
      const n = evt.target;
      cy.elements().removeClass('faded').removeClass('highlighted');
      cy.elements().addClass('faded');
      n.removeClass('faded').addClass('highlighted');
      n.neighborhood().removeClass('faded').addClass('highlighted');
      showSide(n);
    });

    cy.on('tap', (evt) => {
      if (evt.target === cy) {
        cy.elements().removeClass('faded').removeClass('highlighted');
        emptyEl.style.display = 'block';
        detailEl.classList.remove('visible');
      }
    });

    cy.on('zoom', () => {
      const z = cy.zoom();
      let tier = 'L1', label = 'Topics';
      if (z < 0.55) { tier = 'L0'; label = 'Overview'; }
      else if (z >= 1.4) { tier = 'L2'; label = 'Detail'; }
      tierEl.innerHTML = `${tier} · <strong>${label}</strong>`;
    });

    relatedEl.addEventListener('click', (evt) => {
      const row = evt.target.closest('.mm-related-row');
      if (!row) return;
      const target = cy.getElementById(row.dataset.target);
      if (!target.length) return;
      cy.elements().removeClass('faded').removeClass('highlighted');
      cy.elements().addClass('faded');
      target.removeClass('faded').addClass('highlighted');
      target.neighborhood().removeClass('faded').addClass('highlighted');
      cy.center(target);
      showSide(target);
    });

    rootEl.querySelectorAll('.sys-row').forEach(row => {
      row.addEventListener('click', () => {
        const sys = row.dataset.sys;
        const wasActive = row.classList.contains('active');
        rootEl.querySelectorAll('.sys-row').forEach(r => r.classList.remove('active'));
        cy.elements().removeClass('faded');
        if (wasActive) return;
        row.classList.add('active');
        cy.nodes().forEach(n => { if (n.data('sys') !== sys) n.addClass('faded'); });
        cy.edges().forEach(e => {
          const sa = nodesById[e.data('source')]?.sys;
          const ta = nodesById[e.data('target')]?.sys;
          if (sa !== sys && ta !== sys) e.addClass('faded');
        });
      });
    });

    rootEl.querySelectorAll('.mm-toolbar button').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        if (act === 'fit') cy.fit(undefined, 30);
        if (act === 'reset') {
          cy.elements().removeClass('faded').removeClass('highlighted');
          rootEl.querySelectorAll('.sys-row').forEach(r => r.classList.remove('active'));
          rootEl.querySelectorAll('.sys-row.hilite').forEach(r => r.classList.remove('hilite'));
          const sb = rootEl.querySelector('.mm-search');
          if (sb) sb.value = '';
          emptyEl.style.display = 'block';
          detailEl.classList.remove('visible');
          cy.fit(undefined, 30);
        }
      });
    });

    const searchEl = rootEl.querySelector('.mm-search');
    if (searchEl) {
      searchEl.addEventListener('input', () => {
        const q = searchEl.value.trim().toLowerCase();
        cy.elements().removeClass('faded').removeClass('highlighted');
        rootEl.querySelectorAll('.sys-row').forEach(r => r.classList.remove('hilite'));
        if (!q) return;
        const matched = cy.nodes().filter(n =>
            String(n.data('label') || '').toLowerCase().includes(q));
        if (!matched.length) {
          cy.nodes().addClass('faded');
          return;
        }
        cy.elements().addClass('faded');
        matched.removeClass('faded').addClass('highlighted');
        const matchedSys = new Set(matched.map(n => n.data('sys')));
        matchedSys.forEach(sys => {
          const row = rootEl.querySelector('.sys-row[data-sys="' + sys + '"]');
          if (row) row.classList.add('hilite');
        });
      });
    }

    const modalBg = rootEl.querySelector('[data-modal]');
    const addBtn = rootEl.querySelector('[data-act="add-node"]');
    if (modalBg && addBtn) {
      const labelInput = modalBg.querySelector('[data-modal-label]');
      const sysSel = modalBg.querySelector('[data-modal-sys]');
      const tierSel = modalBg.querySelector('[data-modal-tier]');
      const statusSel = modalBg.querySelector('[data-modal-status]');
      const closeModal = () => {
        modalBg.classList.remove('visible');
        labelInput.value = '';
      };
      addBtn.addEventListener('click', () => {
        labelInput.value = '';
        modalBg.classList.add('visible');
        labelInput.focus();
      });
      modalBg.querySelector('[data-modal-cancel]').addEventListener('click', closeModal);
      modalBg.addEventListener('click', e => { if (e.target === modalBg) closeModal(); });
      modalBg.querySelector('[data-modal-submit]').addEventListener('click', () => {
        const label = labelInput.value.trim();
        if (!label) { labelInput.focus(); return; }
        const sys = sysSel.value;
        const tier = tierSel.value;
        const status = statusSel.value;
        const id = 'usr-' + Date.now().toString(36);
        const sysMeta = SYS[sys];
        nodesById[id] = { id, label, sys, tier, status };
        cy.add({
          group: 'nodes',
          data: { id, label, sys, tier, status, sysColor: sysMeta.color },
          renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 },
        });
        const railRow = rootEl.querySelector('.sys-row[data-sys="' + sys + '"] .count');
        if (railRow) railRow.textContent = String(parseInt(railRow.textContent || '0', 10) + 1);
        closeModal();
      });
    }

    return { showSide };
  }

  async function init(opts) {
    const { rootEl, data } = opts || {};
    if (!rootEl) throw new Error('MissionMindmap.init: rootEl required');

    const nodes = (data && data.nodes) || MOCK_NODES;
    const edges = (data && data.edges) || MOCK_EDGES;

    injectStyle();
    rootEl.classList.add('mm-root');
    // Clear any inline display set by callers ("block"/"none" toggles) so the
    // .mm-root grid rule wins. Callers should toggle visibility via a class
    // (e.g. .mm-hidden { display: none }) or by replacing inline display with ''.
    if (rootEl.style.display === 'block') rootEl.style.display = '';
    renderShell(rootEl, nodes, edges);

    await loadCytoscape();

    const canvasEl = rootEl.querySelector('.mm-cy');
    const { cy, nodesById } = buildCy(canvasEl, nodes, edges);
    const ctrl = bindEvents(rootEl, cy, nodesById);

    return { cy, ...ctrl, nodes, edges };
  }

  global.MissionMindmap = { init, SYS, MOCK_NODES, MOCK_EDGES };
})(window);
