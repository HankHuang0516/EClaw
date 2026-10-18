/* Page-local proposal state; same UMD contract as the existing prototype model. */
((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FraudT04Model = api;
})(globalThis, () => {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const tracks = ['buyer', 'service', 'record'];
  function create(session) {
    if (typeof session !== 'string' || !session) throw new TypeError('session required');
    return { schemaVersion: 1, module: 'T04', candidate: 'MG-P03', proposal: true,
      session, revision: 0, processed: [], view: 'intro', started: false, viewed: [],
      selected: null, playhead: 'before', positions: { buyer: null, service: null, record: null },
      marked: [], location: null, pendingBranch: null, branch: null,
      handedOff: false, followupRead: false, archived: false, resultCount: 0,
      awardedReward: 0, gameMinutes: 0, durationStatus: 'unconfirmed', clockPaused: true };
  }
  function missing(s) {
    const gaps = [];
    if (!s.started) gaps.push('start');
    if (!tracks.every(t => s.viewed.includes(t))) gaps.push('view');
    if (s.playhead !== 'before' || !tracks.every(t => s.positions[t] === 'before')) gaps.push('align');
    if (!['buyer', 'service'].every(t => s.marked.includes(t))) gaps.push('contradiction');
    if (s.location !== 'seller') gaps.push('location');
    return gaps;
  }
  function result(s) {
    if (!s.archived) return null;
    return { module: 'T04', candidate: 'MG-P03', session: s.session, resultId: s.session + ':T04-preview',
      previewOnly: true, approval: 'proposal', outcome: s.branch, followupAttached: true,
      sources: copy(s.positions), location: s.location, awardedReward: 0, persist: false,
      gameMinutes: 0, durationStatus: 'unconfirmed' };
  }
  function apply(s, command) {
    const reject = message => ({ state: s, accepted: false, message, result: null });
    if (!command || command.session !== s.session || command.revision !== s.revision ||
        typeof command.id !== 'string' || !command.id || s.processed.includes(command.id)) return reject('stale');
    const n = copy(s), c = command; let message = 'updated';
    const read = ['navigate', 'read', 'preview_followup', 'cancel'].includes(c.type);
    if (s.handedOff && !read && !['read_followup', 'archive'].includes(c.type)) return reject('readonly');
    if (!s.started && !['start', 'navigate'].includes(c.type)) return reject('startFirst');
    switch (c.type) {
    case 'start':
      if (s.started) return reject('already');
      n.started = true; n.view = 'work'; message = 'started'; break;
    case 'navigate':
      if (!['intro', 'work', 'summary'].includes(c.view) || (c.view !== 'intro' && !s.started)) return reject('startFirst');
      n.view = c.view; message = 'reading'; break;
    case 'read':
      if (!tracks.includes(c.track)) return reject('source');
      if (!n.viewed.includes(c.track)) n.viewed.push(c.track);
      message = 'read_' + c.track; break;
    case 'select':
      if (!tracks.includes(c.track) || !s.viewed.includes(c.track)) return reject('readFirst');
      n.selected = c.track; message = 'selected'; break;
    case 'cancel': n.selected = null; n.pendingBranch = null; message = 'cancelled'; break;
    case 'place':
      if (!s.selected) return reject('selectFirst');
      if (!['before', 'later'].includes(c.time)) return reject('time');
      n.positions[s.selected] = c.time; n.selected = null; n.marked = []; n.location = null; n.pendingBranch = null;
      message = c.time === 'before' ? 'placed' : 'wrongTime'; break;
    case 'remove':
      if (!tracks.includes(c.track) || !s.positions[c.track]) return reject('empty');
      n.positions[c.track] = null; n.marked = []; n.location = null; n.pendingBranch = null; message = 'removed'; break;
    case 'seek':
      if (!['before', 'later'].includes(c.time)) return reject('time');
      n.playhead = c.time; n.marked = []; n.location = null; n.pendingBranch = null; message = 'reading'; break;
    case 'mark':
      if (s.playhead !== 'before' || !tracks.every(t => s.positions[t] === 'before')) return reject('alignFirst');
      if (!['buyer', 'service'].includes(c.track)) return reject('claimOnly');
      n.marked = s.marked.includes(c.track) ? s.marked.filter(t => t !== c.track) : s.marked.concat(c.track);
      n.pendingBranch = null; message = 'marked'; break;
    case 'locate':
      if (s.playhead !== 'before' || !tracks.every(t => s.positions[t] === 'before')) return reject('alignFirst');
      if (c.owner !== 'seller') return reject('wrongOwner');
      n.location = 'seller'; message = 'located'; break;
    case 'choose':
      if (missing(s).length) return reject('incomplete');
      if (!['stop', 'dispute'].includes(c.branch)) return reject('branch');
      n.pendingBranch = c.branch; message = 'confirmBranch'; break;
    case 'handoff':
      if (missing(s).length || !s.pendingBranch) return reject('incomplete');
      n.branch = s.pendingBranch; n.pendingBranch = null; n.handedOff = true; n.selected = null;
      n.view = 'summary'; message = 'handedOff'; break;
    case 'preview_followup':
      if (!s.handedOff || !['stop', 'dispute'].includes(c.branch)) return reject('incomplete');
      message = 'preview_' + c.branch; break;
    case 'read_followup':
      if (!s.handedOff) return reject('incomplete');
      n.followupRead = true; message = 'followup_' + s.branch; break;
    case 'archive':
      if (!s.handedOff || !s.followupRead) return reject('followupFirst');
      if (s.archived) return reject('readonly');
      n.archived = true; n.resultCount = 1; message = 'archived'; break;
    default: return reject('unknown');
    }
    n.processed.push(c.id); n.revision += 1;
    return { state: n, accepted: true, message, result: !s.archived && n.archived ? result(n) : null };
  }
  return { create, apply, missing, result };
});
