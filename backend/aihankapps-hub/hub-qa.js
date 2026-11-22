/* global window, document, fetch, crypto */
(function () {
  'use strict';
  const API = '/api/aihankapps/hub/qa/timehut';
  const drafts = new Map();
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const t = k => window.HubQaText.t(k);
  async function request(url, options) {
    const r = await fetch(url, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, options));
    const value = await r.json();
    if (!r.ok || !value.success) { const e = new Error(value.error || 'QA_UNAVAILABLE'); e.status = r.status; throw e; }
    return value;
  }
  function stamp(s) { return new Date(s).toLocaleString(document.documentElement.lang || 'zh-TW', { timeZone: 'Asia/Taipei' }); }
  function mount(host) {
    host.innerHTML = '<section class="card qa-review"><h2>' + t('title') + '</h2><p role="status">' + t('loading') + '</p></section>';
    let batch, comments = [], results = [];
    async function load() {
      let cursor = '0', all = [], answer;
      do {
        answer = await request(API + '?after=' + cursor);
        all = all.concat(answer.comments); cursor = answer.nextCursor;
      } while (answer.hasMore);
      if (!host.isConnected) return;
      batch = answer.batch; comments = all; results = answer.results;
      paint();
    }
    function paint() {
      if (!batch) { host.innerHTML = '<section class="card qa-review"><h2>' + t('title') + '</h2><p>' + t('empty') + '</p></section>'; return; }
      const coverage = batch.coverage || {};
      const table = '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>' + t('dimension') + '</th><th>Android</th><th>iOS</th></tr></thead><tbody>' + Object.entries(coverage).map(([k, v]) => '<tr><th>' + esc(k) + '</th>' + ['android', 'ios'].map(p => '<td>' + (v[p] ? esc(v[p].passed + ' / ' + v[p].denominator + ' · ' + v[p].percent.toFixed(4) + '%') : '—') + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
      if (batch.reviewState === 'archived') {
        host.innerHTML = '<section class="card qa-review qa-next-stage"><header class="card-h"><div><h2>' + t('nextTitle') + '</h2><p>' + t('completedIntro') + '</p></div></header><p class="note">' + t('noNewReview') + '</p><p>' + esc(batch.phaseSummary || '') + '</p><details><summary>' + t('coverage') + '</summary>' + table + '<p>' + esc(batch.coverageNote) + '</p></details><p class="hint">' + t('updated') + ' ' + esc(stamp(batch.updatedAt)) + ' · ' + t('hourly') + '</p><p>' + t('replyToAlert') + '</p><details class="qa-completed"><summary>' + t('completedBatch') + ' (10)</summary>' + batch.items.map(archivedItem).join('') + '</details></section>';
        return;
      }
      host.innerHTML = '<section class="card qa-review"><header class="card-h"><div><h2>' + t('title') + '</h2><p>' + t('intro') + '</p></div></header><p class="note">' + t('pending') + '</p><details><summary>' + t('coverage') + '</summary>' + table + '<p>' + esc(batch.coverageNote) + '</p></details><p class="hint">' + t('updated') + ' ' + esc(stamp(batch.updatedAt)) + ' · ' + t('hourly') + '</p><p>' + esc(batch.releasePolicy) + '</p><div class="qa-items">' + batch.items.map(item).join('') + '</div></section>';
      host.querySelectorAll('form[data-qa-item]').forEach(form => {
        const id = form.dataset.qaItem, revision = form.dataset.qaRevision, key = id + ':' + revision;
        const saved = drafts.get(key);
        if (saved) { form.elements.body.value = saved.body; form.elements.decision.value = saved.decision; }
        const remember = () => { const old = drafts.get(key); const body = form.elements.body.value, decision = form.elements.decision.value; drafts.set(key, { body, decision, requestId: old && old.body === body && old.decision === decision ? old.requestId : crypto.randomUUID() }); };
        form.oninput = remember; form.onchange = remember;
        form.onsubmit = async e => {
          e.preventDefault(); remember();
          const d = drafts.get(key), button = form.querySelector('button'), status = form.querySelector('[role="status"]');
          if (!d.body.trim()) { status.textContent = t('required'); return; }
          button.disabled = true; status.textContent = t('sending');
          try {
            await request(API + '/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item: id, revision, ...d }) });
            drafts.delete(key); status.textContent = t('saved');
            // Append feedback/result history without replacing other drafts.
            await load();
            const next = host.querySelector('[data-qa-item="' + id + '"] [role="status"]');
            if (next) next.textContent = t('saved');
          } catch (err) { status.textContent = t(err.status === 409 ? 'stale' : 'failed'); button.disabled = false; }
        };
      });
      host.querySelectorAll('[data-qa-play]').forEach(button => {
        button.onclick = () => {
          const i = batch.items.find(x => x.id === button.dataset.qaPlay), box = button.parentElement;
          const image = document.createElement('img'); image.alt = i.id + ' · ' + i.title + ' · before / after'; image.loading = 'lazy';
          const status = box.querySelector('[role="status"]');
          status.textContent = t('loading');
          image.onload = () => { status.textContent = ''; };
          image.onerror = () => { status.textContent = t('mediaFailed'); image.remove(); button.hidden = false; };
          image.src = API + '/media/' + i.id + '?v=' + encodeURIComponent(i.sha256);
          button.hidden = true; box.appendChild(image);
        };
      });
    }
    function archivedItem(i) {
      const cs = comments.filter(c => c.item === i.id), rs = results.filter(r => r.item === i.id);
      const entries = cs.map(c => ({ at: c.created_at, title: t('comment') + ' #' + c.id, body: c.body })).concat(rs.map(r => ({ at: r.created_at, title: t('result'), body: r.body }))).sort((a, b) => new Date(a.at) - new Date(b.at));
      return '<article class="qa-archived"><h3>' + esc(i.id + ' · ' + i.title) + '</h3><p>' + esc(i.status) + '</p><details><summary>' + t('history') + ' (' + entries.length + ')</summary><ol class="qa-history">' + entries.map(c => '<li><b>' + esc(c.title) + '</b><time>' + esc(stamp(c.at)) + '</time><p>' + esc(c.body) + '</p></li>').join('') + '</ol></details></article>';
    }
    function item(i) {
      const cs = comments.filter(c => c.item === i.id), rs = results.filter(r => r.item === i.id);
      const timeline = cs.map(c => ({ at: c.created_at, title: t('comment') + ' #' + c.id + ' · ' + t(c.decision), body: c.body, revision: c.revision })).concat(rs.map(r => ({ at: r.created_at, title: t('result') + (r.comment_id ? ' · #' + r.comment_id : ''), body: r.body, revision: '' }))).sort((a, b) => new Date(a.at) - new Date(b.at));
      return '<article class="qa-item" id="qa-' + i.id + '"><h3>' + esc(i.id + ' · ' + i.title) + '</h3><p class="qa-state">' + esc(i.status) + '</p><dl><dt>Before</dt><dd>' + esc(i.before) + '</dd><dt>After</dt><dd>' + esc(i.after) + '</dd></dl><div class="qa-media"><button type="button" class="btn" data-qa-play="' + i.id + '">' + t('play') + '</button><span role="status"></span></div><p class="hint">' + esc(i.releaseStatus) + '</p><details' + (timeline.length ? ' open' : '') + '><summary>' + t('history') + ' (' + timeline.length + ')</summary><ol class="qa-history">' + timeline.map(c => '<li><b>' + esc(c.title) + '</b><time>' + esc(stamp(c.at)) + (c.revision ? ' · ' + esc(c.revision) : '') + '</time><p>' + esc(c.body) + '</p></li>').join('') + '</ol></details><form data-qa-item="' + i.id + '" data-qa-revision="' + esc(i.revision) + '"><label for="qa-decision-' + i.id + '">' + t('decision') + '</label><select id="qa-decision-' + i.id + '" name="decision"><option value="comment">' + t('comment') + '</option><option value="changes">' + t('changes') + '</option><option value="approve">' + t('approve') + '</option></select><label for="qa-body-' + i.id + '">' + t('write') + '</label><textarea id="qa-body-' + i.id + '" name="body" maxlength="4000" rows="3" required></textarea><div class="qa-submit"><button type="submit" class="btn is-primary">' + t('submit') + '</button><span role="status" aria-live="polite"></span></div></form></article>';
    }
    load().catch(() => { if (host.isConnected) host.innerHTML = '<section class="card qa-review"><h2>' + t('title') + '</h2><p role="alert">' + t('loadFailed') + '</p></section>'; });
  }
  window.HubQa = { mount };
})();
