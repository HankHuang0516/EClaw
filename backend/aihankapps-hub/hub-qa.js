/* global window, document, fetch, crypto */
(function () {
  'use strict';
  const API = '/api/aihankapps/hub/qa/timehut';
  const LEGACY_BATCH = 'timehut-batch01';
  // Private feedback stays in memory, including drafts retained across Hub refreshes.
  const drafts = new Map(), pending = new Map(), mounts = new WeakMap();
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const t = k => window.HubQaText.t(k);
  const keyFor = (batch, item, revision) => JSON.stringify([batch, item, revision]);
  const rowBatch = row => row.batch || LEGACY_BATCH;
  function groupRows(rows) {
    const grouped = new Map();
    for (const row of rows) {
      const key = keyFor(rowBatch(row), row.item);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    }
    return grouped;
  }
  async function request(url, options) {
    const r = await fetch(url, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, options));
    const value = await r.json();
    if (!r.ok || !value.success) { const e = new Error(value.error || 'QA_UNAVAILABLE'); e.status = r.status; throw e; }
    return value;
  }
  function stamp(s) { return new Date(s).toLocaleString(document.documentElement.lang || 'zh-TW', { timeZone: 'Asia/Taipei' }); }
  function coverage(b) {
    return '<details><summary>' + t('coverage') + '</summary><div class="tbl-wrap"><table class="tbl"><thead><tr><th>' + t('dimension') + '</th><th>Android</th><th>iOS</th></tr></thead><tbody>' + Object.entries(b.coverage || {}).map(([k, v]) => '<tr><th>' + esc(k) + '</th>' + ['android', 'ios'].map(p => '<td>' + (v[p] ? esc(v[p].passed + ' / ' + v[p].denominator + ' · ' + v[p].percent.toFixed(4) + '%') : '—') + '</td>').join('') + '</tr>').join('') + '</tbody></table></div><p>' + esc(b.coverageNote) + '</p></details>';
  }
  function mount(host) {
    const owner = {};
    mounts.set(host, owner);
    const alive = () => host.isConnected && mounts.get(host) === owner;
    host.innerHTML = '<section class="card qa-review"><h2>' + t('title') + '</h2><p role="status">' + t('loading') + '</p></section>';
    let batches = [], active, comments = new Map(), results = new Map(), generation = 0, render = 0;
    async function load() {
      const ticket = ++generation;
      // A publication between comment pages must not mix snapshots or skip history.
      for (let attempt = 0; attempt < 3; attempt++) {
        let cursor = '0', all = [], answer, signature, changed = false;
        const seen = new Set([cursor]);
        do {
          try { answer = await request(API + '?after=' + encodeURIComponent(cursor)); }
          catch (err) { if (!alive() || ticket !== generation) return; throw err; }
          if (!alive() || ticket !== generation) return;
          const snapshot = JSON.stringify([answer.batch, answer.batches, answer.activeBatchId]);
          if (signature !== undefined && signature !== snapshot) { changed = true; break; }
          signature = snapshot;
          all = all.concat(answer.comments);
          cursor = String(answer.nextCursor);
          if (answer.hasMore && seen.has(cursor)) throw new Error('QA_CURSOR_STALLED');
          seen.add(cursor);
        } while (answer.hasMore);
        if (changed) continue;
        batches = answer.batches || (answer.batch ? [answer.batch] : []);
        const activeId = answer.activeBatchId === undefined ? (answer.batch && answer.batch.reviewState !== 'archived' ? answer.batch.id : null) : answer.activeBatchId;
        active = batches.find(b => b.id === activeId && b.reviewState !== 'archived');
        comments = groupRows(all); results = groupRows(answer.results);
        paint();
        return true;
      }
      throw new Error('QA_SNAPSHOT_CHANGED');
    }
    function item(b, i, editable) {
      const cs = comments.get(keyFor(b.id, i.id)) || [];
      const rs = results.get(keyFor(b.id, i.id)) || [];
      const timeline = cs.map(c => ({ at: c.created_at, title: t('comment') + ' #' + c.id + ' · ' + t(c.decision), body: c.body, revision: c.revision })).concat(rs.map(r => ({ at: r.created_at, title: t('result') + (r.comment_id ? ' · #' + r.comment_id : ''), body: r.body, revision: r.revision }))).sort((a, b) => new Date(a.at) - new Date(b.at));
      const id = 'qa-' + encodeURIComponent(b.id) + '-' + encodeURIComponent(i.id);
      const attrs = ' data-qa-batch="' + esc(b.id) + '" data-qa-item="' + esc(i.id) + '" data-qa-revision="' + esc(i.revision) + '"';
      return '<article class="qa-item' + (editable ? '' : ' qa-archived') + '" id="' + esc(id) + '"><h3>' + esc(i.id + ' · ' + i.title) + '</h3><p class="qa-state">' + esc(i.status) + '</p><dl><dt>' + t('before') + '</dt><dd>' + esc(i.before) + '</dd><dt>' + t('after') + '</dt><dd>' + esc(i.after) + '</dd></dl><div class="qa-media"><button type="button" class="btn" data-qa-play="' + esc(i.id) + '"' + attrs + '>' + t('play') + '</button><span role="status"></span></div><p class="hint">' + esc(i.releaseStatus) + '</p>' + (cs.some(c => c.revision === i.revision) ? '' : '<p class="qa-feedback-note">' + t('noFeedback') + '</p>') + '<details' + (timeline.length ? ' open' : '') + '><summary>' + t('history') + ' (' + timeline.length + ')</summary><ol class="qa-history">' + timeline.map(c => '<li><b>' + esc(c.title) + '</b><time>' + esc(stamp(c.at)) + (c.revision ? ' · ' + esc(c.revision) : '') + '</time><p>' + esc(c.body) + '</p></li>').join('') + '</ol></details>' + (editable ? '<form' + attrs + '><label for="' + esc(id) + '-decision">' + t('decision') + '</label><select id="' + esc(id) + '-decision" name="decision"><option value="comment">' + t('comment') + '</option><option value="changes">' + t('changes') + '</option><option value="approve">' + t('approve') + '</option></select><label for="' + esc(id) + '-body">' + t('write') + '</label><textarea id="' + esc(id) + '-body" name="body" maxlength="4000" rows="3" required></textarea><div class="qa-submit"><button type="submit" class="btn is-primary">' + t('submit') + '</button><span role="status" aria-live="polite"></span></div></form>' : '') + '</article>';
    }
    function progress(b) {
      return '<p>' + esc(b.phaseSummary) + '</p>' + coverage(b) + '<p class="hint">' + t('updated') + ' ' + esc(stamp(b.updatedAt)) + ' · ' + t('hourly') + '</p>';
    }
    function batchContent(b, editable) {
      return progress(b) + '<p>' + esc(b.releasePolicy) + '</p><div class="qa-items">' + b.items.map(i => item(b, i, editable)).join('') + '</div>';
    }
    function paint() {
      const view = ++render;
      if (!batches.length) { host.innerHTML = '<section class="card qa-review"><h2>' + t('title') + '</h2><p>' + t('empty') + '</p></section>'; return; }
      const history = batches.filter(b => b !== active);
      host.innerHTML = '<section class="card qa-review"><header class="card-h"><div><h2>' + t(active ? 'title' : 'nextTitle') + '</h2><p>' + t(active ? 'activeIntro' : 'historyIntro') + '</p></div></header><p class="note">' + t('pending') + '</p>' + (active ? '<section class="qa-active" data-qa-batch="' + esc(active.id) + '"><h3>' + esc(active.id) + '</h3>' + batchContent(active, true) + '</section>' : '<p>' + t('noNewReview') + '</p><section class="qa-progress">' + progress(batches[0]) + '</section><p>' + t('replyToAlert') + '</p>') + history.map(b => '<details class="qa-completed" data-qa-batch="' + esc(b.id) + '"><summary>' + t('archivedBatch') + ' · ' + esc(b.id) + ' (' + b.items.length + ')</summary>' + batchContent(b, false) + '</details>').join('') + '</section>';
      host.querySelectorAll('form[data-qa-item]').forEach(form => {
        const batchId = form.dataset.qaBatch, id = form.dataset.qaItem, revision = form.dataset.qaRevision;
        const key = keyFor(batchId, id, revision), saved = drafts.get(key);
        const current = () => alive() && render === view && form.isConnected;
        const button = form.querySelector('button'), status = form.querySelector('[role="status"]');
        if (saved) { form.elements.body.value = saved.body; form.elements.decision.value = saved.decision; }
        if (pending.has(key)) {
          button.disabled = true;
          // A refreshed form follows only the lock, never the old response/status.
          pending.get(key).then(() => { if (current()) button.disabled = false; });
        }
        const remember = () => {
          const old = drafts.get(key), body = form.elements.body.value, decision = form.elements.decision.value;
          if (!old || old.body !== body || old.decision !== decision) drafts.set(key, { body, decision, requestId: crypto.randomUUID() });
        };
        form.oninput = () => { if (current()) { remember(); status.textContent = ''; } };
        form.onchange = form.oninput;
        form.onsubmit = async e => {
          e.preventDefault();
          if (!current() || pending.has(key)) return;
          remember();
          const d = drafts.get(key);
          if (!d.body.trim()) { status.textContent = t('required'); return; }
          button.disabled = true; status.textContent = t('sending');
          const send = request(API + '/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batch: batchId, item: id, revision, ...d }) });
          // Resolve this lock on either outcome; submit handles errors below.
          const lock = send.then(() => {}, () => {});
          pending.set(key, lock);
          lock.then(() => { if (pending.get(key) === lock) pending.delete(key); });
          try {
            await send;
            if (!current()) return;
            if (drafts.get(key) === d) drafts.delete(key);
            const unchanged = !drafts.has(key);
            status.textContent = unchanged ? t('saved') : '';
            let loaded;
            try { loaded = await load(); }
            catch (err) { if (current()) status.textContent = t('loadFailed'); return; }
            if (!loaded || !alive() || !unchanged || drafts.has(key)) return;
            const next = Array.from(host.querySelectorAll('form[data-qa-item]')).find(f => keyFor(f.dataset.qaBatch, f.dataset.qaItem, f.dataset.qaRevision) === key);
            if (next) next.querySelector('[role="status"]').textContent = t('saved');
          } catch (err) {
            if (current()) status.textContent = t(err.status === 409 ? 'stale' : 'failed');
          } finally {
            if (pending.get(key) === lock) pending.delete(key);
            if (current()) button.disabled = pending.has(key);
          }
        };
      });
      host.querySelectorAll('[data-qa-play]').forEach(button => {
        const b = batches.find(b => b.id === button.dataset.qaBatch);
        const i = b.items.find(i => i.id === button.dataset.qaPlay && i.revision === button.dataset.qaRevision);
        button.onclick = () => {
          if (!alive() || render !== view || !button.isConnected || button.hidden) return;
          const box = button.parentElement, image = document.createElement('img');
          image.alt = i.id + ' · ' + i.title + ' · ' + t('before') + ' / ' + t('after'); image.loading = 'lazy';
          const status = box.querySelector('[role="status"]');
          status.textContent = t('loading');
          image.onload = () => { if (alive() && render === view) status.textContent = ''; };
          image.onerror = () => { if (alive() && render === view) { status.textContent = t('mediaFailed'); image.remove(); button.hidden = false; } };
          image.src = API + '/media/' + encodeURIComponent(i.id) + '?batch=' + encodeURIComponent(b.id) + '&v=' + encodeURIComponent(i.sha256);
          button.hidden = true; box.appendChild(image);
        };
      });
    }
    const refresh = async () => {
      const ticket = generation + 1;
      try { await load(); }
      catch (err) {
        if (alive() && ticket === generation) host.innerHTML = '<section class="card qa-review"><h2>' + t('title') + '</h2><p role="alert">' + t('loadFailed') + '</p></section>';
      }
    };
    refresh();
  }
  window.HubQa = { mount };
})();
