// mission-mindmap.js — PR-B v4 (chip+📌 + responsive)
//
// Lazy-loaded on first expand of the "🧠 心智圖" card in mission.html.
// Renders the user's own kanban cards as a graph; data is fetched from
// /api/mission/mindmap by the embedding page and passed in via init({data}).
// When the device has zero cards the module renders an empty-state hint —
// no demo seed data is shipped (every device sees only its own work).
//
// Interaction model (rewritten 2026-04-25 after Hank rejected v3 dense):
//   • Tap a node → spawn a floating 引用預覽卡 (chip popover) anchored near
//     the node, mirroring autolink-chip-preview.js semantics in chat.
//   • 📌 button → moves the chip to a top-right 釘選 tray (pin-tray) and
//     closes the popover. Clicking a pinned chip re-opens its popover.
//   • ✖ or canvas tap → close the active popover. ESC → close all + unpin.
//   • Cross-system "相關節點" rows inside the popover re-render as nested
//     chips (recursive — replaces the active popover with the next one).
//   • No more 320px right side panel: the chips ARE the detail surface.
//
// Responsive: <=720px viewport (mobile portrait) → sys-rail collapses to a
// horizontal scrolling strip above the canvas; canvas takes full width;
// popover anchors to viewport-bottom as a bottom-sheet.
(function (global) {
  'use strict';

  if (global.MissionMindmap) return;

  const CDN = 'https://cdn.jsdelivr.net/npm/cytoscape@3.28.1/dist/cytoscape.min.js';

  // Subsystem registry — single source of truth for mindmap node styling.
  // Each key matches the `sys` field that the kanban → mindmap mapper
  // (backend/kanban.js → /api/mission/mindmap) emits per card. The color
  // also drives sys-rail swatches and cytoscape edge tinting.
  //
  // Why a constant: subsystem palette is a design decision, not user data.
  // Adding a subsystem requires three coordinated changes (this dict, the
  // backend mapper, an i18n key for the label) so the cost is intentional.
  // Source authority: Hank — palette locked 2026-04-25 with the chip+📌
  // redesign; do not recolor without his approval (palette is reused in
  // info.html and roadmap.html previews).
  // SYS.label values are ENGLISH fallbacks used when window.i18n is unavailable
  // or the locale lacks `mm_sys_<key>`. Localized labels come from sysLabel().
  const SYS = {
    invite:     { color: '#f43f5e', label: 'Invite & growth' },
    device:     { color: '#06b6d4', label: 'Device' },
    i18n:       { color: '#a855f7', label: 'i18n' },
    kanban:     { color: '#22c55e', label: 'Kanban' },
    chat:       { color: '#3b82f6', label: 'Chat' },
    payment:    { color: '#eab308', label: 'Payment' },
    broadcast:  { color: '#f97316', label: 'Broadcast' },
    bridge:     { color: '#ec4899', label: 'Bridge' },
    automation: { color: '#64748b', label: 'Automation' },
  };

  const t = (key, fallback) => (window.i18n && window.i18n.t && window.i18n.t(key)) || fallback;
  const sysLabel = (key) => t('mm_sys_' + key, SYS[key]?.label || key);


  const STYLE_ID = 'mission-mindmap-style';
  const STYLE_CSS = `
    .mm-root {
      --mm-bg: #0d1117; --mm-bg-elev: #161b22;
      --mm-border: #2a2f3a; --mm-text: #e6edf3;
      --mm-text-secondary: #8b949e;
      display: grid;
      grid-template-columns: 200px 1fr;
      grid-template-rows: 1fr;
      height: 540px;
      background: var(--mm-bg);
      border: 1px solid var(--mm-border);
      border-radius: 8px; overflow: hidden;
      font-size: 13px; color: var(--mm-text);
      position: relative;
    }
    .mm-root:fullscreen, .mm-root:-webkit-full-screen {
      height: 100vh; width: 100vw; border-radius: 0; border: none;
    }
    body.mm-display-mode .mm-root {
      height: 100vh; width: 100vw; border-radius: 0; border: none;
    }
    .mm-root .sys-rail {
      background: var(--mm-bg-elev);
      border-right: 1px solid var(--mm-border);
      padding: 12px 10px; overflow-y: auto;
      display: flex; flex-direction: column; gap: 8px;
    }
    .mm-root .sys-rail h3 {
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;
      color: var(--mm-text-secondary); margin: 6px 0 2px 0; font-weight: 600;
    }
    .mm-root .sys-row {
      display: flex; align-items: center; gap: 7px;
      padding: 5px 7px; border-radius: 5px; cursor: pointer;
      font-size: 12px; transition: background 0.15s;
      flex: none;
    }
    .mm-root .sys-row:hover { background: rgba(255,255,255,0.06); }
    .mm-root .sys-row.active { background: rgba(255,255,255,0.10); }
    .mm-root .sys-row.hilite { background: rgba(59,130,246,0.18); outline: 1px solid #3b82f6; }
    .mm-root .sys-row .swatch { width: 8px; height: 8px; border-radius: 2px; flex: none; }
    .mm-root .sys-row .name { flex: 1; color: var(--mm-text); }
    .mm-root .sys-row .count {
      font-size: 10px; background: rgba(255,255,255,0.08);
      padding: 1px 6px; border-radius: 8px; color: var(--mm-text-secondary);
    }
    .mm-root .mm-rail-toolbar {
      display: flex; flex-direction: column; gap: 6px;
    }
    .mm-root .mm-search {
      width: 100%; box-sizing: border-box;
      background: var(--mm-bg); color: var(--mm-text);
      border: 1px solid var(--mm-border);
      border-radius: 5px; padding: 6px 8px; font-size: 12px;
      outline: none; transition: border-color 0.15s;
    }
    .mm-root .mm-search:focus { border-color: #3b82f6; }
    .mm-root .mm-add-btn {
      background: #3b82f6; color: #fff; border: none;
      border-radius: 5px; padding: 6px 10px; font-size: 12px;
      cursor: pointer; font-weight: 600; transition: filter 0.15s;
    }
    .mm-root .mm-add-btn:hover { filter: brightness(1.1); }
    .mm-root .mm-sep {
      height: 1px; background: var(--mm-border);
      margin: 4px -10px;
    }
    .mm-root .legend-block { padding-top: 2px; }
    .mm-root .legend-row {
      display: flex; align-items: center; gap: 6px;
      font-size: 11px; color: var(--mm-text-secondary); margin-bottom: 3px;
    }
    .mm-root .status-ring { width: 8px; height: 8px; border-radius: 50%; flex: none; }
    .mm-root .status-ring.active { background: #fde047; }
    .mm-root .status-ring.blocked { background: #ef4444; }
    .mm-root .status-ring.done { background: #22c55e; }
    .mm-root .summary-block {
      padding-top: 2px; font-size: 11px;
      color: var(--mm-text-secondary); line-height: 1.6;
      margin-top: auto;
    }
    .mm-root .summary-block .num { color: var(--mm-text); font-weight: 600; }

    /* Canvas wrap */
    .mm-root .mind-canvas-wrap {
      position: relative; background: var(--mm-bg); overflow: hidden;
    }
    .mm-root .mm-toolbar {
      position: absolute; top: 10px; left: 10px; z-index: 10;
      display: flex; gap: 4px;
      background: rgba(22,27,34,0.85); backdrop-filter: blur(8px);
      border: 1px solid var(--mm-border);
      border-radius: 8px; padding: 4px;
    }
    .mm-root .mm-toolbar button {
      background: transparent; border: none; color: var(--mm-text);
      padding: 5px 10px; border-radius: 5px; cursor: pointer; font-size: 12px;
    }
    .mm-root .mm-toolbar button:hover { background: rgba(255,255,255,0.08); }
    .mm-root .mm-tier {
      position: absolute; top: 14px; left: 50%; transform: translateX(-50%);
      font-size: 10px; color: var(--mm-text-secondary);
      z-index: 5; pointer-events: none;
    }
    .mm-root .mm-tier strong { color: var(--mm-text); }
    .mm-root .mm-cy { position: absolute; inset: 0; }

    /* Pin tray (top-right of canvas) */
    .mm-root .mm-pin-tray {
      position: absolute; top: 10px; right: 10px; z-index: 11;
      display: flex; gap: 4px; flex-wrap: wrap;
      max-width: calc(100% - 200px);
      background: rgba(22,27,34,0.85); backdrop-filter: blur(8px);
      border: 1px solid var(--mm-border); border-radius: 8px; padding: 4px;
    }
    .mm-root .mm-pin-tray:empty { display: none; }
    .mm-root .mm-pin-chip {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 3px 5px 3px 7px; border-radius: 11px;
      background: rgba(255,255,255,0.08); font-size: 11px; cursor: pointer;
      color: var(--mm-text); user-select: none;
      transition: background 0.15s;
    }
    .mm-root .mm-pin-chip:hover { background: rgba(255,255,255,0.14); }
    .mm-root .mm-pin-chip .swatch { width: 6px; height: 6px; border-radius: 50%; flex: none; }
    .mm-root .mm-pin-chip .x {
      opacity: 0.45; padding: 0 2px; line-height: 1; font-size: 13px;
      color: var(--mm-text-secondary);
    }
    .mm-root .mm-pin-chip:hover .x { opacity: 1; }

    /* Chip popover (the 引用預覽卡) */
    .mm-root .mm-chip-pop {
      position: absolute; z-index: 50;
      width: min(300px, calc(100% - 24px));
      background: var(--mm-bg-elev);
      border: 1px solid var(--mm-border); border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.55);
      font-size: 12px; color: var(--mm-text);
      animation: mm-pop-in 0.12s ease-out;
    }
    @keyframes mm-pop-in {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .mm-root .mm-chip-pop-header {
      display: flex; align-items: center; gap: 6px;
      padding: 9px 10px 7px;
      border-bottom: 1px solid var(--mm-border);
    }
    .mm-root .mm-chip-pop-header .swatch {
      width: 8px; height: 8px; border-radius: 2px; flex: none;
    }
    .mm-root .mm-chip-pop-title {
      font-weight: 600; flex: 1; font-size: 13px;
      color: var(--mm-text);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .mm-root .mm-chip-pop-status {
      font-size: 9px; padding: 2px 6px; border-radius: 8px;
      font-weight: 600; letter-spacing: 0.4px; flex: none;
    }
    .mm-root .mm-chip-pop-status.active { background: rgba(253,224,71,0.15); color: #fde047; }
    .mm-root .mm-chip-pop-status.blocked { background: rgba(239,68,68,0.15); color: #ef4444; }
    .mm-root .mm-chip-pop-status.done { background: rgba(34,197,94,0.15); color: #22c55e; }
    .mm-root .mm-chip-pop-btn {
      background: transparent; border: none; cursor: pointer;
      color: var(--mm-text-secondary); font-size: 13px;
      padding: 2px 5px; border-radius: 4px; line-height: 1;
      transition: background 0.15s, color 0.15s;
      flex: none;
    }
    .mm-root .mm-chip-pop-btn:hover {
      background: rgba(255,255,255,0.08); color: var(--mm-text);
    }
    .mm-root .mm-chip-pop-btn.pin-btn:hover { color: #fde047; }
    .mm-root .mm-chip-pop-btn.cite-btn:hover { color: #a78bfa; }
    .mm-root .mm-chip-pop-btn.is-disabled {
      opacity: 0.35; cursor: not-allowed;
    }
    .mm-root .mm-chip-pop-btn.is-disabled:hover {
      background: transparent; color: var(--mm-text-secondary);
    }
    .mm-root .mm-chip-pop-body { padding: 8px 10px 10px; }
    .mm-root .mm-chip-pop-summary {
      color: var(--mm-text-secondary); font-size: 11.5px;
      line-height: 1.55; margin-bottom: 8px;
    }
    .mm-root .mm-chip-pop-section h5 {
      font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.6px;
      color: var(--mm-text-secondary); margin: 6px 0 4px 0; font-weight: 600;
    }
    .mm-root .mm-chip-pop-related { display: flex; flex-direction: column; gap: 2px; }
    .mm-root .mm-chip-pop-related-row {
      font-size: 11px; padding: 4px 6px; border-radius: 4px;
      background: rgba(255,255,255,0.03); cursor: pointer;
      display: flex; align-items: center; gap: 6px;
      transition: background 0.15s;
    }
    .mm-root .mm-chip-pop-related-row:hover { background: rgba(255,255,255,0.09); }
    .mm-root .mm-chip-pop-related-row .swatch { width: 7px; height: 7px; border-radius: 2px; flex: none; }
    .mm-root .mm-chip-pop-related-row .relname {
      flex: 1; color: var(--mm-text);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .mm-root .mm-chip-pop-related-row .relsys {
      color: var(--mm-text-secondary); font-size: 10px; flex: none;
    }
    .mm-root .mm-chip-pop-empty {
      font-size: 11px; color: var(--mm-text-secondary); padding: 4px 4px;
    }

    /* Add-node modal */
    .mm-root .mm-modal-bg {
      position: fixed; inset: 0; background: rgba(0,0,0,0.55);
      display: none; align-items: center; justify-content: center; z-index: 1000;
    }
    .mm-root .mm-modal-bg.visible { display: flex; }
    .mm-root .mm-modal {
      background: var(--mm-bg-elev); border: 1px solid var(--mm-border);
      border-radius: 8px; padding: 18px 20px; min-width: 280px; max-width: 92vw;
      color: var(--mm-text); font-size: 13px;
    }
    .mm-root .mm-modal h3 { margin: 0 0 12px 0; font-size: 14px; }
    .mm-root .mm-modal label { display: block; font-size: 11px; color: var(--mm-text-secondary); margin: 8px 0 3px; }
    .mm-root .mm-modal input, .mm-root .mm-modal select {
      width: 100%; box-sizing: border-box;
      background: var(--mm-bg); color: var(--mm-text);
      border: 1px solid var(--mm-border);
      border-radius: 4px; padding: 5px 8px; font-size: 12px; outline: none;
    }
    .mm-root .mm-modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
    .mm-root .mm-modal-actions button {
      padding: 6px 14px; border-radius: 4px; border: none; cursor: pointer; font-size: 12px;
    }
    .mm-root .mm-modal-cancel { background: transparent; color: var(--mm-text-secondary); }
    .mm-root .mm-modal-submit { background: #3b82f6; color: #fff; font-weight: 600; }

    /* Toast */
    .mm-root .mm-toast {
      position: absolute; bottom: 14px; left: 50%; transform: translateX(-50%);
      background: rgba(22,27,34,0.95); border: 1px solid var(--mm-border);
      color: var(--mm-text); padding: 6px 12px; border-radius: 6px;
      font-size: 11px; z-index: 100; pointer-events: none;
      transition: opacity 0.25s;
    }

    /* ── Mobile portrait (<=720px) ── */
    @media (max-width: 720px) {
      .mm-root {
        grid-template-columns: 1fr;
        grid-template-rows: auto 1fr;
        height: min(540px, 70vh);
      }
      .mm-root .sys-rail {
        flex-direction: row;
        overflow-x: auto; overflow-y: hidden;
        padding: 8px 8px;
        border-right: none;
        border-bottom: 1px solid var(--mm-border);
        gap: 6px; align-items: center;
        scrollbar-width: thin;
      }
      .mm-root .sys-rail h3,
      .mm-root .legend-block,
      .mm-root .summary-block,
      .mm-root .mm-sep { display: none; }
      .mm-root .mm-rail-toolbar {
        flex-direction: row;
        flex: 0 0 auto;
        gap: 5px; min-width: unset;
      }
      .mm-root .mm-search {
        width: 130px; padding: 5px 7px; font-size: 11.5px;
      }
      .mm-root .mm-add-btn {
        padding: 5px 9px; font-size: 11.5px; flex: none;
      }
      .mm-root .sys-row {
        padding: 4px 8px; flex: 0 0 auto;
        font-size: 11px; gap: 5px;
        border: 1px solid var(--mm-border);
      }
      .mm-root .sys-row .name { white-space: nowrap; }
      /* Popover becomes a bottom-sheet */
      .mm-root .mm-chip-pop {
        position: absolute !important;
        left: 8px !important; right: 8px !important;
        top: auto !important; bottom: 8px !important;
        width: auto !important;
      }
      .mm-root .mm-pin-tray {
        max-width: calc(100% - 90px);
        top: 8px; right: 8px;
      }
      .mm-root .mm-toolbar {
        top: 8px; left: 8px; padding: 3px;
      }
      .mm-root .mm-toolbar button {
        padding: 4px 8px; font-size: 11.5px;
      }
      .mm-root .mm-tier {
        top: 50px; font-size: 9px;
      }
    }
    .mm-root.mm-empty {
      display: flex; align-items: center; justify-content: center;
      grid-template-columns: none;
    }
    .mm-empty-card {
      max-width: 360px; padding: 28px 24px; text-align: center;
      background: var(--mm-bg-elev); border: 1px solid var(--mm-border);
      border-radius: 10px; color: var(--mm-text);
    }
    .mm-empty-emoji { font-size: 36px; margin-bottom: 10px; }
    .mm-empty-title { font-size: 16px; margin: 0 0 8px 0; font-weight: 600; }
    .mm-empty-hint {
      font-size: 13px; margin: 0 0 16px 0; line-height: 1.5;
      color: var(--mm-text-secondary);
    }
    .mm-empty-cta {
      display: inline-block; padding: 8px 16px; font-size: 13px;
      background: #22c55e; color: #0d1117; border-radius: 6px;
      text-decoration: none; font-weight: 600;
    }
    .mm-empty-cta:hover { background: #16a34a; }
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

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
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
        <span class="name">${sysLabel(key)}</span>
        <span class="count">${c}</span>
      </div>`;
    }).join('');

    const crossCount = edges.filter(e => e.length === 3).length;

    const searchPlaceholder = t('mm_search_placeholder', '🔍 Search nodes…');
    const searchAria = t('mm_search_aria', 'Search nodes');
    const addNodeBtn = t('mm_add_node', '+ New node');
    const subsystemsHeading = t('mm_subsystems', 'Subsystems');
    const statusHeading = t('mm_node_status', 'Node status');
    const statusActive = t('mm_status_active', 'Active');
    const statusBlocked = t('mm_status_blocked', 'Blocked');
    const statusDone = t('mm_status_done', 'Done');
    const labelNodes = t('mm_label_nodes', 'nodes');
    const labelEdges = t('mm_label_edges', 'edges');
    const labelCross = t('mm_label_cross', 'cross-system dependencies');
    const modalTitle = t('mm_modal_title', 'Add node');
    const modalLabel = t('mm_modal_label', 'Label');
    const modalLabelPlaceholder = t('mm_modal_label_placeholder', 'e.g. new feature name');
    const modalSys = t('mm_modal_sys', 'Subsystem');
    const modalTier = t('mm_modal_tier', 'Tier');
    const modalStatus = t('mm_modal_status', 'Status');
    const btnCancel = t('mm_btn_cancel', 'Cancel');
    const btnAdd = t('mm_btn_add', 'Add');
    const titleFit = t('mm_title_fit', 'Fit');
    const titleReset = t('mm_title_reset', 'Reset layout');
    const titleFullscreen = t('mm_title_fullscreen', 'Fullscreen');

    rootEl.innerHTML = `
      <aside class="sys-rail">
        <div class="mm-rail-toolbar">
          <input type="text" class="mm-search" placeholder="${escapeHtml(searchPlaceholder)}" aria-label="${escapeHtml(searchAria)}">
          <button class="mm-add-btn" data-act="add-node">${escapeHtml(addNodeBtn)}</button>
        </div>
        <div class="mm-sep"></div>
        <h3>${escapeHtml(subsystemsHeading)}</h3>
        ${railRows}
        <div class="mm-sep"></div>
        <div class="legend-block">
          <h3>${escapeHtml(statusHeading)}</h3>
          <div class="legend-row"><span class="status-ring active"></span>${escapeHtml(statusActive)}</div>
          <div class="legend-row"><span class="status-ring blocked"></span>${escapeHtml(statusBlocked)}</div>
          <div class="legend-row"><span class="status-ring done"></span>${escapeHtml(statusDone)}</div>
        </div>
        <div class="mm-sep"></div>
        <div class="summary-block">
          <span class="num">${nodes.length}</span> ${escapeHtml(labelNodes)} ·
          <span class="num">${edges.length}</span> ${escapeHtml(labelEdges)}<br>
          <span class="num">${crossCount}</span> ${escapeHtml(labelCross)}
        </div>
      </aside>
      <div class="mm-modal-bg" data-modal>
        <div class="mm-modal">
          <h3>${escapeHtml(modalTitle)}</h3>
          <label>${escapeHtml(modalLabel)}</label>
          <input type="text" data-modal-label placeholder="${escapeHtml(modalLabelPlaceholder)}">
          <label>${escapeHtml(modalSys)}</label>
          <select data-modal-sys>
            ${Object.entries(SYS).map(([k]) => `<option value="${k}">${escapeHtml(sysLabel(k))}</option>`).join('')}
          </select>
          <label>${escapeHtml(modalTier)}</label>
          <select data-modal-tier>
            <option value="domain">domain</option>
            <option value="topic" selected>topic</option>
            <option value="leaf">leaf</option>
          </select>
          <label>${escapeHtml(modalStatus)}</label>
          <select data-modal-status>
            <option value="active" selected>active</option>
            <option value="blocked">blocked</option>
            <option value="done">done</option>
          </select>
          <div class="mm-modal-actions">
            <button class="mm-modal-cancel" data-modal-cancel>${escapeHtml(btnCancel)}</button>
            <button class="mm-modal-submit" data-modal-submit>${escapeHtml(btnAdd)}</button>
          </div>
        </div>
      </div>
      <div class="mind-canvas-wrap">
        <div class="mm-toolbar">
          <button data-act="fit" title="${escapeHtml(titleFit)}">🎯</button>
          <button data-act="reset" title="${escapeHtml(titleReset)}">🔄</button>
          <button data-act="fullscreen" title="${escapeHtml(titleFullscreen)}" aria-label="${escapeHtml(titleFullscreen)}">⛶</button>
        </div>
        <div class="mm-pin-tray" data-pin-tray></div>
        <div class="mm-tier">L1 · <strong>Topics</strong></div>
        <div class="mm-cy"></div>
      </div>
    `;
  }

  function buildCy(canvasEl, nodes, edges) {
    const nodesById = Object.fromEntries(nodes.map(n => [n.id, n]));
    const cyNodes = nodes.map(n => {
      const sysColor = (SYS[n.sys] || SYS.kanban).color;
      const cyNode = { data: { ...n, sysColor } };
      const c = n.coord;
      if (c && Number.isFinite(c.x) && Number.isFinite(c.y)) cyNode.position = { x: c.x, y: c.y };
      return cyNode;
    });
    const cyEdges = edges.map(([s, t, label]) => ({
      data: { id: `${s}__${t}`, source: s, target: t, label: label || '', cross: !!label }
    }));

    const cy = global.cytoscape({
      container: canvasEl,
      elements: [...cyNodes, ...cyEdges],
      layout: {
        name: 'cose', padding: 30, animate: false, fit: true, randomize: false,
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
        { selector: 'node.pinned', style: {
          'border-color': '#fde047', 'border-width': 3,
          'overlay-color': '#fde047', 'overlay-opacity': 0.15,
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

  // ── Chip popover + pin tray controller ──
  function createChipController(rootEl, cy, nodesById) {
    const wrap = rootEl.querySelector('.mind-canvas-wrap');
    const pinTray = rootEl.querySelector('[data-pin-tray]');
    const pinned = new Map(); // id → { node }
    let activePop = null;     // currently visible popover element (at most 1)
    let activeId = null;      // node id backing activePop

    function isMobile() {
      return window.matchMedia('(max-width: 720px)').matches;
    }

    function buildRelatedRows(node) {
      const seen = new Set();
      const rows = [];
      node.neighborhood('node').forEach(nb => {
        if (nb.id() === node.id()) return;
        const nd = nb.data();
        if (nd.sys === node.data('sys')) return;
        if (seen.has(nb.id())) return;
        seen.add(nb.id());
        rows.push({
          id: nb.id(),
          label: nd.label,
          sys: nd.sys,
          sysColor: SYS[nd.sys].color,
          sysLabel: sysLabel(nd.sys),
        });
      });
      return rows;
    }

    function buildPopHtml(d, isPinned, related) {
      const sysMeta = SYS[d.sys];
      // Pin = local bookmark to top-tray of this page (no deep-link, no API).
      // Distinct from cite (📌, deep-links into chat) — different icons to
      // avoid the 📌 collision now that cite uses the canonical 引用 emoji.
      const pinTitle = isPinned
        ? t('mm_pin_remove', 'Unpin')
        : t('mm_pin_add', 'Pin to top tray (this page only)');
      const pinIcon = isPinned ? '📍' : '🔖';
      const pinClass = isPinned ? 'pin-btn pinned' : 'pin-btn';
      // Citable IDs: real mindmap UUIDs (mindmap_xxxx) or kanban card prefix IDs
      // (card_xxxxxxxx). Virtual `sys:*` hubs are aggregations, not entities.
      // Anything else (slug seed nodes like inv-hub) is non-citable demo data.
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(d.id);
      const isCardId = /^card_[a-f0-9]{8}([a-f0-9]{16}|-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?$/i.test(d.id);
      const isVirtualHub = String(d.id).startsWith('sys:');
      const canCite = isUuid || isCardId;
      const citeTitle = canCite
        ? t('mm_cite_enabled', 'Quote into chat — jumps to chat with the chip token pre-filled')
        : isVirtualHub
          ? t('mm_cite_hub_blocked', 'Subsystem hub is an aggregate node and cannot be cited')
          : t('mm_cite_demo_blocked', 'Demo data is not citable — add a real mindmap node first');
      const citeClass = canCite ? 'cite-btn' : 'cite-btn is-disabled';
      const summary = d.summary || t('mm_summary_default', '{sys} subsystem · {tier}')
        .replace('{sys}', sysLabel(d.sys))
        .replace('{tier}', d.tier);
      const relatedHtml = related.length
        ? related.map(r => `
            <div class="mm-chip-pop-related-row" data-related-id="${escapeHtml(r.id)}">
              <span class="swatch" style="background:${r.sysColor}"></span>
              <span class="relname">${escapeHtml(r.label)}</span>
              <span class="relsys">${escapeHtml(r.sysLabel)}</span>
            </div>`).join('')
        : `<div class="mm-chip-pop-empty">${escapeHtml(t('mm_no_cross_deps', 'No cross-system dependencies'))}</div>`;

      // 建卡 — Phase 4 write-side: stash node canvas coord (x,y) into
      // localStorage and hand off to kanban.html, which auto-opens the
      // new-card dialog with title pre-filled and chatAnchorCoord wired
      // through to POST /api/mission/card. Available on every node
      // (including demo seeds) — the coord is the value, not the node ID.
      const cardTitle = t('mm_card_from_node', 'Create kanban card from this node — auto-anchors mindmap coordinate');
      const closeTitle = t('mm_close', 'Close');
      const relatedHeading = t('mm_related_heading', 'Cross-system related nodes');
      return `
        <div class="mm-chip-pop-header">
          <span class="swatch" style="background:${sysMeta.color}"></span>
          <span class="mm-chip-pop-title" title="${escapeHtml(d.label)}">${escapeHtml(d.label)}</span>
          <span class="mm-chip-pop-status ${escapeHtml(d.status)}">${escapeHtml(d.status)}</span>
          <button class="mm-chip-pop-btn ${citeClass}" data-pop-act="cite" title="${escapeHtml(citeTitle)}">📌</button>
          <button class="mm-chip-pop-btn card-btn" data-pop-act="card" title="${escapeHtml(cardTitle)}">➕</button>
          <button class="mm-chip-pop-btn ${pinClass}" data-pop-act="pin" title="${escapeHtml(pinTitle)}">${pinIcon}</button>
          <button class="mm-chip-pop-btn" data-pop-act="close" title="${escapeHtml(closeTitle)}">✖</button>
        </div>
        <div class="mm-chip-pop-body">
          <div class="mm-chip-pop-summary">${escapeHtml(summary)}</div>
          <div class="mm-chip-pop-section">
            <h5>${escapeHtml(relatedHeading)}</h5>
            <div class="mm-chip-pop-related">${relatedHtml}</div>
          </div>
        </div>
      `;
    }

    function positionPop(pop, node) {
      if (isMobile()) {
        // CSS handles positioning via @media bottom-sheet rule
        pop.style.left = '';
        pop.style.top = '';
        return;
      }
      const wrapRect = wrap.getBoundingClientRect();
      const pos = node.renderedPosition();
      const popW = 300, popH = pop.offsetHeight || 200;
      let left = pos.x + 28;
      let top = pos.y - popH / 2;
      if (left + popW > wrapRect.width - 8) left = pos.x - popW - 28;
      if (left < 8) left = 8;
      if (top < 50) top = 50;
      if (top + popH > wrapRect.height - 8) top = wrapRect.height - popH - 8;
      pop.style.left = left + 'px';
      pop.style.top = top + 'px';
    }

    function closeActive() {
      if (activePop) {
        activePop.remove();
        activePop = null;
      }
      activeId = null;
    }

    function openPop(nodeId) {
      const node = cy.getElementById(nodeId);
      if (!node || node.empty()) return;
      const d = node.data();

      closeActive();

      const pop = document.createElement('div');
      pop.className = 'mm-chip-pop';
      pop.dataset.nodeId = nodeId;
      const related = buildRelatedRows(node);
      pop.innerHTML = buildPopHtml(d, pinned.has(nodeId), related);
      wrap.appendChild(pop);
      // After insertion, height is known — position
      positionPop(pop, node);

      activePop = pop;
      activeId = nodeId;

      // Highlight the node + neighborhood
      cy.elements().removeClass('faded').removeClass('highlighted');
      cy.elements().addClass('faded');
      node.removeClass('faded').addClass('highlighted');
      node.neighborhood().removeClass('faded').addClass('highlighted');

      pop.addEventListener('click', (e) => {
        const relRow = e.target.closest('[data-related-id]');
        if (relRow) {
          e.stopPropagation();
          const targetId = relRow.dataset.relatedId;
          openPop(targetId);
          const target = cy.getElementById(targetId);
          if (target.length) cy.center(target);
          return;
        }
        const btn = e.target.closest('[data-pop-act]');
        if (!btn) return;
        e.stopPropagation();
        const act = btn.dataset.popAct;
        if (act === 'close') {
          closeActive();
          cy.elements().removeClass('faded').removeClass('highlighted');
          return;
        }
        if (act === 'pin') {
          if (pinned.has(nodeId)) {
            unpin(nodeId);
          } else {
            pin(nodeId, d);
          }
        }
        if (act === 'cite') {
          if (btn.classList.contains('is-disabled')) {
            showToast(String(nodeId).startsWith('sys:')
              ? t('mm_toast_hub_cite_blocked', 'Subsystem hub is an aggregate — pick a child node to cite')
              : t('mm_toast_demo_cite_blocked', 'Demo data is not citable — add a real mindmap node first'));
            return;
          }
          // card_<hex> nodes are kanban cards — chat's entity-link-render auto-detects
          // the prefix and renders a card chip. UUID nodes use the legacy mindmap_ token.
          const isCard = /^card_[a-f0-9]{8}/i.test(nodeId);
          const token = isCard ? nodeId : 'mindmap_' + nodeId;
          const kind = isCard
            ? t('mm_kind_card', 'card')
            : t('mm_kind_node', 'mindmap node');
          // Unified 引用到聊天 UX — same path as card-holder/files/mission
          // dialog 📌 buttons. Hands the token to chat as quote context +
          // pre-fills the message input so the user just hits send. The
          // chat onload reader (chat.html) consumes eclaw_pending_quote +
          // optional prefillInput. Falls back to clipboard copy if neither
          // postMessage nor localStorage path is available (offline / no
          // chat page mounted).
          const quoteSource = t('mm_quote_source', 'Mind map');
          const quoteTitle = d.label || token;
          const quoteExcerpt = token;
          try {
            if (typeof global.quoteToChat === 'function') {
              global.quoteToChat(quoteSource, quoteTitle, quoteExcerpt, { prefillInput: token });
            } else if (global.self !== global.top) {
              global.parent.postMessage({
                type: 'eclaw_quote',
                source: quoteSource,
                title: quoteTitle,
                excerpt: quoteExcerpt,
                prefillInput: token,
              }, global.location.origin);
            } else {
              global.localStorage.setItem('eclaw_pending_quote', JSON.stringify({
                source: quoteSource,
                title: quoteTitle,
                excerpt: quoteExcerpt,
                prefillInput: token,
                ts: Date.now(),
              }));
              global.location.href = '/portal/chat.html';
            }
            showToast(t('mm_toast_cite_ok', 'Quoted {kind} "{title}" to chat — message box pre-filled, just hit send')
              .replace('{kind}', kind)
              .replace('{title}', quoteTitle.slice(0, 18)));
          } catch (err) {
            // Last resort — clipboard copy + manual paste hint
            copyToClipboard(token).then(ok => {
              showToast(ok
                ? t('mm_toast_cite_fallback', 'Direct quote failed — token copied, paste it into chat: {token}…')
                    .replace('{token}', token.slice(0, 22))
                : t('mm_toast_cite_failed', 'Quote failed ({err}): {token}')
                    .replace('{err}', (err && err.message) || 'unknown')
                    .replace('{token}', token));
            });
          }
        }
        if (act === 'card') {
          // Phase 4 write-side: hand the kanban.html new-card form a
          // pre-filled title + chat_anchor_coord captured from the live
          // cytoscape model position. Kanban reads eclaw_pending_mindmap_card
          // on load and forwards chatAnchorCoord into POST /api/mission/card.
          // The chat-anchor picker stays mandatory (validator/Phase 3 gate),
          // so the user still pins an originating chat message.
          try {
            const node = cy.getElementById(nodeId);
            const pos = node && node.length ? node.position() : null;
            if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
              showToast(t('mm_toast_coord_failed', 'Could not read coordinate — cannot anchor card'));
              return;
            }
            const payload = {
              x: pos.x,
              y: pos.y,
              title: d.label || nodeId,
              sys: d.sys || '',
              nodeId,
              ts: Date.now(),
            };
            global.localStorage.setItem('eclaw_pending_mindmap_card', JSON.stringify(payload));
            showToast(t('mm_toast_card_pending', 'Creating card… coordinate anchored ({x}, {y})')
              .replace('{x}', Math.round(pos.x))
              .replace('{y}', Math.round(pos.y)));
            global.location.href = '/portal/kanban.html';
          } catch (err) {
            showToast(t('mm_toast_card_failed', 'Card creation failed: {err}')
              .replace('{err}', (err && err.message) || 'unknown'));
          }
        }
      });
    }

    function copyToClipboard(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(() => true).catch(() => fallbackCopy(text));
      }
      return Promise.resolve(fallbackCopy(text));
    }

    function fallbackCopy(text) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (_) { return false; }
    }

    function showToast(msg) {
      const root = rootEl.querySelector('.mind-canvas-wrap') || rootEl;
      const tip = document.createElement('div');
      tip.className = 'mm-toast';
      tip.textContent = msg;
      root.appendChild(tip);
      setTimeout(() => { tip.style.opacity = '0'; }, 1800);
      setTimeout(() => { tip.remove(); }, 2200);
    }

    function pin(nodeId, d) {
      pinned.set(nodeId, { id: nodeId, label: d.label, sys: d.sys });
      cy.getElementById(nodeId).addClass('pinned');
      renderTray();
      // Re-render the popover so its 📌 → 📍 toggle reflects the new state
      if (activeId === nodeId) openPop(nodeId);
    }

    function unpin(nodeId) {
      pinned.delete(nodeId);
      cy.getElementById(nodeId).removeClass('pinned');
      renderTray();
      if (activeId === nodeId) openPop(nodeId);
    }

    function renderTray() {
      pinTray.innerHTML = '';
      pinned.forEach((p) => {
        const chip = document.createElement('div');
        chip.className = 'mm-pin-chip';
        chip.dataset.nodeId = p.id;
        chip.innerHTML = `
          <span class="swatch" style="background:${SYS[p.sys].color}"></span>
          <span class="lbl">${escapeHtml(p.label)}</span>
          <span class="x" data-pin-x="${escapeHtml(p.id)}">×</span>
        `;
        pinTray.appendChild(chip);
      });
    }

    pinTray.addEventListener('click', (e) => {
      const xBtn = e.target.closest('[data-pin-x]');
      if (xBtn) {
        e.stopPropagation();
        unpin(xBtn.dataset.pinX);
        return;
      }
      const chip = e.target.closest('.mm-pin-chip');
      if (chip && chip.dataset.nodeId) {
        const target = cy.getElementById(chip.dataset.nodeId);
        if (target.length) cy.center(target);
        openPop(chip.dataset.nodeId);
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && activePop) closeActive();
    });

    return { openPop, closeActive, pinned, isMobile };
  }

  function bindEvents(rootEl, cy, nodesById) {
    const tierEl = rootEl.querySelector('.mm-tier');
    const ctrl = createChipController(rootEl, cy, nodesById);

    cy.on('tap', 'node', (evt) => {
      ctrl.openPop(evt.target.id());
    });

    cy.on('tap', (evt) => {
      if (evt.target === cy) {
        ctrl.closeActive();
        cy.elements().removeClass('faded').removeClass('highlighted');
      }
    });

    cy.on('zoom', () => {
      const z = cy.zoom();
      let tier = 'L1', label = 'Topics';
      if (z < 0.55) { tier = 'L0'; label = 'Overview'; }
      else if (z >= 1.4) { tier = 'L2'; label = 'Detail'; }
      tierEl.innerHTML = `${tier} · <strong>${label}</strong>`;
    });

    rootEl.querySelectorAll('.sys-row').forEach(row => {
      row.addEventListener('click', () => {
        const sys = row.dataset.sys;
        const wasActive = row.classList.contains('active');
        rootEl.querySelectorAll('.sys-row').forEach(r => r.classList.remove('active'));
        cy.elements().removeClass('faded');
        if (wasActive) {
          cy.animate({ fit: { eles: cy.elements(), padding: 30 }, duration: 500, easing: 'ease-in-out' });
          return;
        }
        row.classList.add('active');
        cy.nodes().forEach(n => { if (n.data('sys') !== sys) n.addClass('faded'); });
        cy.edges().forEach(e => {
          const sa = nodesById[e.data('source')]?.sys;
          const ta = nodesById[e.data('target')]?.sys;
          if (sa !== sys && ta !== sys) e.addClass('faded');
        });
        const focusNodes = cy.nodes().filter(n => n.data('sys') === sys);
        if (focusNodes.length) {
          cy.animate({ fit: { eles: focusNodes, padding: 60 }, duration: 600, easing: 'ease-in-out' });
        }
      });
    });

    const fsTarget = rootEl;
    const fsBtn = rootEl.querySelector('.mm-toolbar [data-act="fullscreen"]');
    function isFsActive() {
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      return !!fsEl && (fsEl === fsTarget || fsEl.contains(fsTarget));
    }
    function updateFsBtn() {
      if (!fsBtn) return;
      const active = isFsActive();
      fsBtn.title = active
        ? t('mm_title_exit_fullscreen', 'Exit fullscreen')
        : t('mm_title_fullscreen', 'Fullscreen');
      fsBtn.setAttribute('aria-label', fsBtn.title);
      fsBtn.textContent = active ? '⛶✕' : '⛶';
    }
    function toggleFs() {
      const req = fsTarget.requestFullscreen || fsTarget.webkitRequestFullscreen;
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (isFsActive()) {
        exit && exit.call(document);
      } else if (req) {
        req.call(fsTarget).catch(err => console.warn('[Mindmap] Fullscreen rejected:', err));
      }
    }
    ['fullscreenchange', 'webkitfullscreenchange'].forEach(evt => {
      document.addEventListener(evt, () => {
        updateFsBtn();
        if (cy) setTimeout(() => { cy.resize(); cy.fit(undefined, 30); }, 80);
      });
    });
    updateFsBtn();

    rootEl.querySelectorAll('.mm-toolbar button').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        if (act === 'fit') cy.fit(undefined, 30);
        if (act === 'fullscreen') toggleFs();
        if (act === 'reset') {
          ctrl.closeActive();
          cy.elements().removeClass('faded').removeClass('highlighted').removeClass('pinned');
          ctrl.pinned.clear();
          rootEl.querySelector('[data-pin-tray]').innerHTML = '';
          rootEl.querySelectorAll('.sys-row').forEach(r => r.classList.remove('active'));
          rootEl.querySelectorAll('.sys-row.hilite').forEach(r => r.classList.remove('hilite'));
          const sb = rootEl.querySelector('.mm-search');
          if (sb) sb.value = '';
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

    return ctrl;
  }

  function renderEmptyState(rootEl) {
    injectStyle();
    rootEl.classList.add('mm-root');
    rootEl.classList.add('mm-empty');
    if (rootEl.style.display === 'block') rootEl.style.display = '';
    const title = t('mm_empty_title', 'Mind-map has no nodes yet');
    const hint = t('mm_empty_hint', 'Create a kanban card and this view will automatically connect tasks, sub-cards and chat anchors into a graph.');
    const cta = t('mm_empty_cta', 'Open kanban — add your first card');
    rootEl.innerHTML = `
      <div class="mm-empty-card">
        <div class="mm-empty-emoji">🧠</div>
        <h3 class="mm-empty-title">${title}</h3>
        <p class="mm-empty-hint">${hint}</p>
        <a class="mm-empty-cta" href="kanban.html">${cta}</a>
      </div>
    `;
  }

  async function init(opts) {
    const { rootEl, data } = opts || {};
    if (!rootEl) throw new Error('MissionMindmap.init: rootEl required');

    const nodes = (data && Array.isArray(data.nodes)) ? data.nodes : [];
    const edges = (data && Array.isArray(data.edges)) ? data.edges : [];

    if (nodes.length === 0) {
      renderEmptyState(rootEl);
      return { empty: true, nodes, edges };
    }

    injectStyle();
    rootEl.classList.add('mm-root');
    if (rootEl.style.display === 'block') rootEl.style.display = '';
    renderShell(rootEl, nodes, edges);

    await loadCytoscape();

    const canvasEl = rootEl.querySelector('.mm-cy');
    const { cy, nodesById } = buildCy(canvasEl, nodes, edges);
    const ctrl = bindEvents(rootEl, cy, nodesById);

    return { cy, ...ctrl, nodes, edges };
  }

  global.MissionMindmap = { init, SYS };
})(window);
