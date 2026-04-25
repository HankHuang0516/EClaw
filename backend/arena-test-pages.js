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
 * PR2 will add: drag_drop, navigation, distraction.
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
            const opts = f.options.map(o =>
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
        default:                   return renderUnsupported(session, config, sessionToken, apiBase);
    }
}

module.exports = { renderArenaTestPage };
