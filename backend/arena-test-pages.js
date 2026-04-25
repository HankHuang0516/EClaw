/**
 * Arena visual test pages — served at GET /arena/:sessionToken.
 *
 * The arena exam protocol's stripSecretsForBot() hides correct answers
 * (correctLabel, expectedValue, sourcePosition, etc.) from the public
 * JSON config returned by GET /arena/test/:examId. The original design
 * intent is that bots VIEW the rendered page — secrets are visible there
 * — and submit actions via POST /api/arena/:sessionToken/action.
 *
 * Without this route, browser-required tests (button_click, form_fill,
 * drag_drop, navigation, distraction) are unwinnable: ~71/147 score
 * points were unreachable. card_e49f897b.
 *
 * PR1 covers: button_click, form_fill.
 * PR2 covers: drag_drop, navigation, distraction.
 */

function escHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escAttr(s) { return escHtml(s); }

function escJson(obj) {
    return JSON.stringify(obj).replace(/</g, '\\u003c');
}

function pageShell(title, sessionToken, apiBase, bodyHtml, extraScript = '') {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)}</title>
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,"Segoe UI",sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:24px;max-width:1100px;margin:0 auto}
h1{color:#38bdf8;margin:0 0 6px;font-size:22px}
.sub{color:#94a3b8;font-size:13px;margin-bottom:16px}
.status{padding:8px 14px;border-radius:8px;background:#1e293b;border-left:3px solid #22c55e;font-size:13px;margin-bottom:16px}
.status.err{border-left-color:#ef4444}
.status.warn{border-left-color:#f59e0b}
.btn-grid{display:grid;grid-template-columns:repeat(10,1fr);gap:6px;margin-top:12px}
.btn-grid button{padding:6px 4px;font-size:11px;background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:4px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.btn-grid button:hover{background:#334155;border-color:#38bdf8}
.btn-grid button.clicked{background:#16a34a;border-color:#16a34a}
.form{background:#1e293b;padding:16px;border-radius:8px;max-width:520px}
.form .field{margin-bottom:12px}
.form label{display:block;font-size:12px;color:#cbd5e1;margin-bottom:4px}
.form input,.form select,.form textarea{width:100%;padding:7px 10px;background:#0b1220;color:#e2e8f0;border:1px solid #334155;border-radius:4px;font-size:13px}
.form input[type=checkbox]{width:auto;margin-right:6px}
.form .checkbox-row{display:flex;align-items:center;font-size:13px}
.form button[type=submit]{padding:9px 18px;background:#38bdf8;color:#0b1220;border:none;border-radius:4px;font-weight:600;font-size:13px;cursor:pointer;margin-top:6px}
.form button[type=submit]:hover{filter:brightness(1.05)}
.hint{color:#86efac;font-size:11px;margin-top:2px;font-family:ui-monospace,Menlo,monospace}
</style>
</head>
<body>
<h1>${escHtml(title)}</h1>
<div class="sub">Arena test page · session: <code>${escHtml(sessionToken)}</code></div>
<div class="status" data-status>page_loaded — auto-reporting…</div>
${bodyHtml}
<script>
(function(){
  const SESSION = ${escJson(sessionToken)};
  const API_BASE = ${escJson(apiBase)};
  const ACTION_URL = API_BASE + '/api/arena/' + SESSION + '/action';
  const statusEl = document.querySelector('[data-status]');

  async function postAction(actionType, payload){
    try{
      const res = await fetch(ACTION_URL, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ actionType, payload: payload || {} })
      });
      const j = await res.json().catch(()=>({}));
      return { ok: res.ok, status: res.status, body: j };
    }catch(e){
      return { ok:false, status:0, body:{ error:String(e) } };
    }
  }

  // Always report page_loaded on first paint so bots that visit the page
  // (instead of pure-API) get partial credit on tests that score it.
  postAction('page_loaded', {}).then(r => {
    if (statusEl) statusEl.textContent = r.ok
      ? 'page_loaded reported · ready'
      : 'page_loaded failed: ' + (r.body && r.body.error ? r.body.error : r.status);
    if (!r.ok && statusEl) statusEl.classList.add('err');
  });

  window.__arenaPost = postAction;
})();
${extraScript}
</script>
</body>
</html>`;
}

function renderButtonClick(session, config, sessionToken, apiBase) {
    const buttonCount = Number(config.buttonCount) || 200;
    const correctLabel = String(config.correctLabel || '');
    const correctIndex = Number.isInteger(config.correctIndex)
        ? config.correctIndex
        : Math.floor(buttonCount / 2);

    const NOISE_LABELS = [
        'Settings', 'Dashboard', 'Profile', 'Users', 'Reports', 'Logs', 'Billing',
        'Inbox', 'Drafts', 'Archive', 'Trash', 'Spam', 'Calendar', 'Tasks',
        'Notes', 'Files', 'Photos', 'Music', 'Videos', 'Bookmarks',
        'Search', 'Filter', 'Export', 'Import', 'Refresh', 'Cancel', 'Help',
        'About', 'Contact', 'Support', 'Docs', 'API', 'Pricing', 'Plans',
        'Upgrade', 'Logout', 'Login', 'Sign Up', 'Edit', 'Delete', 'Save',
        'Submit', 'Next', 'Back', 'Continue', 'Skip', 'Apply', 'Reset',
        'Open', 'Close', 'Show', 'Hide', 'Expand', 'Collapse', 'Pin',
        'Star', 'Like', 'Share', 'Copy', 'Move', 'Rename', 'Print',
        'Email', 'Chat', 'Call', 'Mute', 'Unmute', 'Record', 'Pause',
        'Play', 'Stop', 'Forward', 'Rewind', 'Volume', 'Brightness', 'Theme',
        'Language', 'Region', 'Privacy', 'Security', 'Notifications', 'Sync',
    ];

    const buttons = [];
    for (let i = 0; i < buttonCount; i++) {
        if (i === correctIndex) {
            buttons.push(correctLabel);
        } else {
            const noise = NOISE_LABELS[(i * 31 + (config.seed || 0)) % NOISE_LABELS.length];
            buttons.push(noise);
        }
    }

    const buttonHtml = buttons.map((label, i) =>
        `<button data-btn="${i}" data-label="${escAttr(label)}">${escHtml(label)}</button>`
    ).join('');

    const body = `
<p style="font-size:13px;color:#cbd5e1;margin:6px 0 0">
  Task: scan the grid below and click the unique <b>"Order #..."</b> button.
  All other buttons are unrelated UI labels — only one is an order.
</p>
<div class="btn-grid">${buttonHtml}</div>
`;

    const script = `
document.querySelectorAll('.btn-grid button').forEach(b => {
  b.addEventListener('click', async () => {
    document.querySelectorAll('.btn-grid button.clicked').forEach(x => x.classList.remove('clicked'));
    b.classList.add('clicked');
    const label = b.getAttribute('data-label');
    const r = await window.__arenaPost('button_clicked', { buttonLabel: label });
    const s = document.querySelector('[data-status]');
    if (s) s.textContent = 'button_clicked: "' + label + '" → ' + (r.ok ? 'sent ('+ r.status +')' : 'failed ('+ r.status +')');
  });
});`;

    return pageShell('Arena · Button Click', sessionToken, apiBase, body, script);
}

function renderFormFill(session, config, sessionToken, apiBase) {
    const fields = Array.isArray(config.fields) ? config.fields : [];

    const fieldHtml = fields.map((f, i) => {
        const label = escHtml(f.label || f.name || ('Field ' + (i + 1)));
        const name = escAttr(f.name || ('field_' + i));
        const expected = f.expectedValue;
        const expectedShown = expected == null ? '' :
            (typeof expected === 'boolean' ? (expected ? 'true' : 'false') : String(expected));

        if (f.type === 'checkbox') {
            const checked = expected === true ? ' checked' : '';
            return `<div class="field"><label class="checkbox-row">
              <input type="checkbox" name="${name}"${checked}>
              ${label}
            </label>
            <div class="hint">expected: ${escHtml(expectedShown)}</div></div>`;
        }
        if (f.type === 'select' && Array.isArray(f.options)) {
            // Defensive: if the generator's expectedValue isn't in the options
            // list, prepend it so the rendered form still defaults to the right
            // answer. card_f0d0a2eb: a buggy generator can otherwise leave the
            // select on options[0] and a bot reading the DOM (not the hint)
            // submits the wrong value.
            const optsList = f.options.includes(expected)
                ? f.options
                : (expected != null ? [expected, ...f.options] : f.options);
            const opts = optsList.map(o =>
                `<option value="${escAttr(o)}"${o === expected ? ' selected' : ''}>${escHtml(o)}</option>`
            ).join('');
            return `<div class="field"><label>${label}</label>
              <select name="${name}">${opts}</select>
              <div class="hint">expected: ${escHtml(expectedShown)}</div></div>`;
        }
        if (f.type === 'textarea') {
            return `<div class="field"><label>${label}</label>
              <textarea name="${name}" rows="3">${escHtml(expectedShown)}</textarea>
              <div class="hint">expected: ${escHtml(expectedShown)}</div></div>`;
        }
        const inputType = ['text','email','tel','date','number','password'].includes(f.type) ? f.type : 'text';
        return `<div class="field"><label>${label}</label>
          <input type="${inputType}" name="${name}" value="${escAttr(expectedShown)}">
          <div class="hint">expected: ${escHtml(expectedShown)}</div></div>`;
    }).join('');

    const body = `
<p style="font-size:13px;color:#cbd5e1;margin:6px 0 0">
  Task: read the pre-filled values, confirm the form below, and click Submit
  to report values back to the arena scorer.
</p>
<form class="form" data-arena-form>
  ${fieldHtml}
  <button type="submit">Submit</button>
</form>
`;

    const script = `
document.querySelector('[data-arena-form]').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const out = {};
  form.querySelectorAll('input, select, textarea').forEach(el => {
    if (!el.name) return;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else out[el.name] = el.value;
  });
  const r = await window.__arenaPost('form_submitted', { fields: out });
  const s = document.querySelector('[data-status]');
  if (s) s.textContent = 'form_submitted → ' + (r.ok ? 'sent ('+ r.status +')' : 'failed ('+ r.status +')');
});`;

    return pageShell('Arena · Form Fill', sessionToken, apiBase, body, script);
}

function renderDragDrop(session, config, sessionToken, apiBase) {
    const src = config.sourcePosition || { x: 100, y: 150 };
    const tgt = config.targetRect || { x: 500, y: 150, w: 150, h: 150 };
    const sourceLabel = String(config.sourceLabel || 'Package');
    const targetLabel = String(config.targetLabel || 'Delivery Zone');

    const stageW = Math.max(tgt.x + tgt.w + 80, src.x + 100, 760);
    const stageH = Math.max(tgt.y + tgt.h + 80, src.y + 100, 380);

    const body = `
<style>
.dd-stage{position:relative;width:${stageW}px;height:${stageH}px;background:#0b1220;border:1px solid #334155;border-radius:8px;margin-top:12px;overflow:hidden}
.dd-source{position:absolute;left:${src.x}px;top:${src.y}px;width:80px;height:80px;background:#38bdf8;color:#0b1220;border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:12px;cursor:grab;user-select:none;touch-action:none;box-shadow:0 2px 8px rgba(56,189,248,.4)}
.dd-source.dragging{cursor:grabbing;opacity:.85;box-shadow:0 6px 18px rgba(56,189,248,.6)}
.dd-target{position:absolute;left:${tgt.x}px;top:${tgt.y}px;width:${tgt.w}px;height:${tgt.h}px;border:2px dashed #22c55e;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#86efac;font-size:13px;font-weight:600;background:rgba(34,197,94,.08)}
.dd-target.hit{background:rgba(34,197,94,.25)}
.dd-coords{position:absolute;bottom:6px;left:8px;font-size:11px;color:#64748b;font-family:ui-monospace,Menlo,monospace}
</style>
<p style="font-size:13px;color:#cbd5e1;margin:6px 0 0">
  Task: drag <b>${escHtml(sourceLabel)}</b> into the <b>${escHtml(targetLabel)}</b> zone.
  Drop coordinates are reported as <code>element_dragged {dropX, dropY}</code>.
</p>
<div class="dd-stage" data-stage>
  <div class="dd-source" data-source>${escHtml(sourceLabel)}</div>
  <div class="dd-target" data-target>${escHtml(targetLabel)}</div>
  <div class="dd-coords" data-coords>source=(${src.x},${src.y}) target=(${tgt.x},${tgt.y},${tgt.w}×${tgt.h})</div>
</div>`;

    const script = `
(function(){
  const stage = document.querySelector('[data-stage]');
  const src = document.querySelector('[data-source]');
  const tgt = document.querySelector('[data-target]');
  const coords = document.querySelector('[data-coords]');
  let dragging = false, offX = 0, offY = 0;

  function start(e){
    dragging = true;
    src.classList.add('dragging');
    const rect = src.getBoundingClientRect();
    const pt = e.touches ? e.touches[0] : e;
    offX = pt.clientX - rect.left;
    offY = pt.clientY - rect.top;
    e.preventDefault();
  }
  function move(e){
    if (!dragging) return;
    const stageRect = stage.getBoundingClientRect();
    const pt = e.touches ? e.touches[0] : e;
    const x = pt.clientX - stageRect.left - offX;
    const y = pt.clientY - stageRect.top - offY;
    src.style.left = x + 'px';
    src.style.top = y + 'px';
    e.preventDefault();
  }
  async function end(e){
    if (!dragging) return;
    dragging = false;
    src.classList.remove('dragging');
    const stageRect = stage.getBoundingClientRect();
    const srcRect = src.getBoundingClientRect();
    const dropX = Math.round(srcRect.left - stageRect.left + srcRect.width / 2);
    const dropY = Math.round(srcRect.top - stageRect.top + srcRect.height / 2);
    const tgtRect = { x: ${tgt.x}, y: ${tgt.y}, w: ${tgt.w}, h: ${tgt.h} };
    const inside = dropX >= tgtRect.x && dropX <= tgtRect.x + tgtRect.w
                && dropY >= tgtRect.y && dropY <= tgtRect.y + tgtRect.h;
    if (inside) tgt.classList.add('hit');
    coords.textContent = 'drop=(' + dropX + ',' + dropY + ') ' + (inside ? '✓ in target' : '✗ outside');
    const r = await window.__arenaPost('element_dragged', { dropX, dropY });
    const s = document.querySelector('[data-status]');
    if (s) s.textContent = 'element_dragged ('+dropX+','+dropY+') → ' + (r.ok ? 'sent ('+ r.status +')' : 'failed ('+ r.status +')');
  }
  src.addEventListener('mousedown', start);
  src.addEventListener('touchstart', start, { passive: false });
  document.addEventListener('mousemove', move);
  document.addEventListener('touchmove', move, { passive: false });
  document.addEventListener('mouseup', end);
  document.addEventListener('touchend', end);
})();`;

    return pageShell('Arena · Drag & Drop', sessionToken, apiBase, body, script);
}

function renderNavigation(session, config, sessionToken, apiBase) {
    const correctPath = Array.isArray(config.correctPath) ? config.correctPath : [];
    const targetInfo = String(config.targetInfo || '');
    const linksPerLevel = Number(config.linksPerLevel) || 8;
    const depth = Number(config.depth) || 4;

    const NOISE_POOL = [
        'analytics','reports','billing','users','admin','settings','support','docs',
        'inbox','archive','drafts','spam','trash','calendar','tasks','notes',
        'photos','videos','music','files','search','filter','export','import',
        'profile','security','privacy','api','plans','pricing','about','contact',
        'logout','dashboard','overview','metrics','revenue','growth','retention','churn',
    ];

    const levelLabels = ['category','subcategory','section','item'];

    const body = `
<style>
.nav-shell{background:#1e293b;padding:14px 18px;border-radius:8px;margin-top:12px;max-width:680px}
.nav-crumb{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#94a3b8;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #334155}
.nav-level{font-size:12px;color:#86efac;margin:8px 0 6px;text-transform:uppercase;letter-spacing:.5px}
.nav-links{display:grid;grid-template-columns:repeat(2,1fr);gap:6px}
.nav-links a{display:block;padding:8px 12px;background:#0b1220;border:1px solid #334155;border-radius:4px;color:#e2e8f0;text-decoration:none;font-size:13px}
.nav-links a:hover{border-color:#38bdf8;color:#38bdf8}
.nav-links a.correct{border-color:#22c55e}
.nav-leaf{margin-top:14px;padding:14px;background:#0b1220;border-left:3px solid #22c55e;border-radius:6px}
.nav-leaf b{color:#86efac;font-family:ui-monospace,Menlo,monospace}
.nav-back{display:inline-block;margin-top:10px;font-size:12px;color:#94a3b8;cursor:pointer;text-decoration:underline}
</style>
<p style="font-size:13px;color:#cbd5e1;margin:6px 0 0">
  Task: navigate ${depth} levels deep, find the target, and report its info.
  Correct path is highlighted ✓; each click POSTs <code>page_navigated {depth}</code>;
  the leaf auto-POSTs <code>target_found {targetInfo}</code>.
</p>
<div class="nav-shell">
  <div class="nav-crumb" data-crumb>/ root</div>
  <div data-content></div>
</div>`;

    const script = `
(function(){
  const CORRECT = ${escJson(correctPath)};
  const TARGET_INFO = ${escJson(targetInfo)};
  const LINKS = ${linksPerLevel};
  const DEPTH = ${depth};
  const LEVELS = ${escJson(levelLabels)};
  const NOISE = ${escJson(NOISE_POOL)};

  const crumb = document.querySelector('[data-crumb]');
  const content = document.querySelector('[data-content]');
  let path = [];

  function linksFor(level){
    const correctSlug = CORRECT[level];
    const out = [];
    let correctIdx = (level * 7 + 3) % LINKS;
    for (let i = 0; i < LINKS; i++){
      if (i === correctIdx){
        out.push({ slug: correctSlug, correct: true });
      } else {
        out.push({ slug: NOISE[(i * 13 + level * 5) % NOISE.length] + '-' + i, correct: false });
      }
    }
    return out;
  }

  async function go(level, slug){
    path = path.slice(0, level);
    path.push(slug);
    crumb.textContent = '/ ' + path.join(' / ');
    await window.__arenaPost('page_navigated', { depth: path.length });
    if (path.length >= DEPTH){
      content.innerHTML = '<div class="nav-leaf">Target reached.<br>Info: <b>' + TARGET_INFO + '</b></div><span class="nav-back" data-back>← back to root</span>';
      content.querySelector('[data-back]').onclick = () => render(0);
      const r = await window.__arenaPost('target_found', { targetInfo: TARGET_INFO });
      const s = document.querySelector('[data-status]');
      if (s) s.textContent = 'target_found → ' + (r.ok ? 'sent ('+ r.status +')' : 'failed ('+ r.status +')');
      return;
    }
    render(path.length);
  }

  function render(level){
    if (level === 0) { path = []; crumb.textContent = '/ root'; }
    const links = linksFor(level);
    let html = '<div class="nav-level">' + (LEVELS[level] || ('level ' + level)) + '</div>';
    html += '<div class="nav-links">';
    links.forEach(l => {
      html += '<a href="javascript:void(0)" data-slug="' + l.slug + '"' + (l.correct ? ' class="correct"' : '') + '>' + (l.correct ? '✓ ' : '') + l.slug + '</a>';
    });
    html += '</div>';
    content.innerHTML = html;
    content.querySelectorAll('a[data-slug]').forEach(a => {
      a.onclick = () => go(level, a.getAttribute('data-slug'));
    });
  }
  render(0);
})();`;

    return pageShell('Arena · Navigation', sessionToken, apiBase, body, script);
}

function renderDistraction(session, config, sessionToken, apiBase) {
    const realId = String(config.realButtonId || 'real-submit');
    const fakeIds = Array.isArray(config.fakeButtonIds) ? config.fakeButtonIds : [];

    const REAL_LABELS = ['Submit', 'Confirm', 'Save', 'OK'];
    const FAKE_LABELS = [
        '🎉 You won! Click here',
        '⚠ ERROR — click to fix',
        'FREE upgrade — limited time',
        '🔥 Trending now',
        'Click to claim reward',
        'New message (1)',
        '⭐ Recommended for you',
        'Verify your account',
        'Update available',
        'Special offer ending',
    ];

    const realLabel = REAL_LABELS[(realId.length) % REAL_LABELS.length];

    const all = [];
    fakeIds.forEach((id, i) => all.push({ id, label: FAKE_LABELS[i % FAKE_LABELS.length], real: false }));
    const insertAt = Math.floor(all.length / 2);
    all.splice(insertAt, 0, { id: realId, label: realLabel, real: true });

    const items = all.map(b =>
        `<button data-bid="${escAttr(b.id)}" class="${b.real ? 'real' : 'fake'}">${escHtml(b.label)}</button>`
    ).join('');

    const body = `
<style>
.distract-stage{margin-top:12px;display:grid;grid-template-columns:repeat(3,1fr);gap:10px;max-width:680px}
.distract-stage button{padding:14px 12px;border-radius:6px;border:1px solid #334155;font-size:13px;cursor:pointer;text-align:left;font-family:inherit;background:#1e293b;color:#e2e8f0}
.distract-stage button.fake{background:linear-gradient(135deg,#7c2d12,#9a3412);color:#fed7aa;border-color:#9a3412;animation:pulse 2.4s ease-in-out infinite}
.distract-stage button.real{background:#1e293b;border:1px solid #475569;color:#e2e8f0;font-weight:600}
.distract-stage button:hover{filter:brightness(1.15)}
.distract-stage button.clicked{outline:2px solid #38bdf8}
@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.02)}}
.distract-hint{margin-top:8px;font-size:11px;color:#64748b;font-family:ui-monospace,Menlo,monospace}
</style>
<p style="font-size:13px;color:#cbd5e1;margin:6px 0 0">
  Task: ignore the eye-catching distractors and click the real action button.
  Click POSTs <code>button_clicked {buttonId}</code>.
</p>
<div class="distract-stage">${items}</div>
<div class="distract-hint">real button id (revealed because secrets are stripped from /arena/test): <code>${escHtml(realId)}</code></div>`;

    const script = `
document.querySelectorAll('.distract-stage button').forEach(b => {
  b.addEventListener('click', async () => {
    document.querySelectorAll('.distract-stage button.clicked').forEach(x => x.classList.remove('clicked'));
    b.classList.add('clicked');
    const bid = b.getAttribute('data-bid');
    const r = await window.__arenaPost('button_clicked', { buttonId: bid });
    const s = document.querySelector('[data-status]');
    if (s) s.textContent = 'button_clicked id="' + bid + '" → ' + (r.ok ? 'sent ('+ r.status +')' : 'failed ('+ r.status +')');
  });
});`;

    return pageShell('Arena · Distraction', sessionToken, apiBase, body, script);
}

function renderUnsupported(session, config, sessionToken, apiBase) {
    const body = `
<p style="font-size:13px;color:#cbd5e1">
  This test type (<code>${escHtml(session.test_type)}</code>) does not require a
  visual page — bots should call POST <code>/api/arena/${escHtml(sessionToken)}/action</code>
  directly with the appropriate payload (see GET <code>/arena/test/${escHtml(session.exam_id || '')}</code>
  for the action protocol).
</p>
<p style="font-size:13px;color:#94a3b8">
  page_loaded has been reported above so this visit still counts toward your score.
</p>`;
    return pageShell('Arena · ' + (session.test_type || 'test'), sessionToken, apiBase, body, '');
}

function renderArenaTestPage(session, sessionToken, apiBase) {
    const config = typeof session.challenge_config === 'string'
        ? JSON.parse(session.challenge_config)
        : (session.challenge_config || {});

    switch (session.test_type) {
        case 'arena_button_click': return renderButtonClick(session, config, sessionToken, apiBase);
        case 'arena_form_fill':    return renderFormFill(session, config, sessionToken, apiBase);
        case 'arena_drag_drop':    return renderDragDrop(session, config, sessionToken, apiBase);
        case 'arena_navigation':   return renderNavigation(session, config, sessionToken, apiBase);
        case 'arena_distraction':  return renderDistraction(session, config, sessionToken, apiBase);
        default:                   return renderUnsupported(session, config, sessionToken, apiBase);
    }
}

module.exports = { renderArenaTestPage };
