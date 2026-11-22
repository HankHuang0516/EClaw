/* global test, expect, jest */
'use strict';
require('./helpers/mock-setup');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const PAGE = path.join(__dirname, '../../aihankapps-hub');
const source = fs.readFileSync(path.join(PAGE, 'hub-qa.js'), 'utf8');
const i18nSource = fs.readFileSync(path.join(PAGE, 'hub-qa-i18n.js'), 'utf8');
const API = '/api/aihankapps/hub/qa/timehut';
const decode = s => s.replace(/&(?:amp|lt|gt|quot|#39);/g, e => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[e]));

// Only the DOM surface used by this IIFE: HTML containers, selectors, delegated
// events, focus and scrolling. Parse real emitted markup so assertions observe
// replacements/clears, rather than returning permanently pre-populated nodes.
function fakeDom() {
    const document = { hidden: false, activeElement: null };
    const VOID = new Set(['input', 'img', 'br', 'hr', 'meta', 'link']);
    class Element {
        constructor(tag = 'div', opening = '<div>') {
            this.tagName = tag;
            this.opening = opening;
            this.parts = [];
            this.attrs = {};
            this.parentElement = null;
            this.listeners = new Map();
            for (const m of opening.replace(/^<[^\s>]+/, '').matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
                this.attrs[m[1]] = decode(m[2] ?? m[3] ?? m[4] ?? '');
            }
            this.dataset = Object.fromEntries(Object.entries(this.attrs).filter(([k]) => k.startsWith('data-'))
                .map(([k, v]) => [k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v]));
            this.checked = Object.hasOwn(this.attrs, 'checked');
            this.disabled = Object.hasOwn(this.attrs, 'disabled');
            this.scrollIntoView = jest.fn();
        }
        get isConnected() { return this.parentElement ? this.parentElement.isConnected : this.connected === true; }
        get elements() { return Object.fromEntries(this.querySelectorAll('[name]').map(e => [e.attrs.name, e])); }
        get value() { return this.inputValue ?? (this.tagName === 'select' ? this.querySelector('option')?.attrs.value || '' : this.attrs.value || ''); }
        set value(value) { this.inputValue = value; }
        get children() { return this.parts.filter(p => p instanceof Element); }
        get innerHTML() { return this.parts.map(p => typeof p === 'string' ? p : p.outerHTML).join(''); }
        get outerHTML() { return this.opening + (VOID.has(this.tagName) ? '' : this.innerHTML + '</' + this.tagName + '>'); }
        get textContent() { return this.parts.map(p => typeof p === 'string' ? decode(p) : p.textContent).join(''); }
        set textContent(text) { this.innerHTML = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
        appendChild(child) { child.parentElement = this; this.parts.push(child); }
        remove() { if (this.parentElement) this.parentElement.parts = this.parentElement.parts.filter(p => p !== this); this.parentElement = null; }
        set innerHTML(html) {
            this.replaceChildren();
            const stack = [this];
            for (const token of String(html).match(/<!--[\s\S]*?-->|<\/?[a-z][^>]*>|[^<]+|</gi) || []) {
                if (token.startsWith('<!--')) continue;
                if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
                const start = /^<([a-z][\w-]*)/i.exec(token);
                if (!start) { stack.at(-1).parts.push(token); continue; }
                const child = new Element(start[1].toLowerCase(), token);
                child.parentElement = stack.at(-1);
                child.parentElement.parts.push(child);
                if (!VOID.has(child.tagName)) stack.push(child);
            }
        }
        replaceChildren() { this.children.forEach(c => { c.parentElement = null; }); this.parts = []; }
        insertAdjacentHTML(where, html) {
            if (where !== 'beforeend') throw new Error('Unsupported insertion: ' + where);
            const holder = new Element(); holder.innerHTML = html;
            holder.children.forEach(c => { c.parentElement = this; });
            this.parts.push(...holder.parts);
        }
        matches(selector) {
            const tag = /^[a-z][\w-]*/.exec(selector);
            if (tag) { if (this.tagName !== tag[0]) return false; selector = selector.slice(tag[0].length); if (!selector) return true; }
            if (selector.startsWith('.')) return (this.attrs.class || '').split(/\s+/).includes(selector.slice(1));
            if (selector.startsWith('#')) return this.attrs.id === selector.slice(1);
            if (selector.startsWith('[')) return [...selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)]
                .every(([, key, value]) => Object.hasOwn(this.attrs, key) && (value === undefined || this.attrs[key] === value));
            return this.tagName === selector;
        }
        querySelectorAll(selector) {
            const all = [], selectors = selector.split(',').map(s => s.trim().split(/\s+/));
            const visit = node => node.children.forEach(child => {
                if (selectors.some(parts => {
                    if (!child.matches(parts.at(-1))) return false;
                    let ancestor = child.parentElement;
                    for (let i = parts.length - 2; i >= 0; i--) {
                        while (ancestor && !ancestor.matches(parts[i])) ancestor = ancestor.parentElement;
                        if (!ancestor) return false;
                        ancestor = ancestor.parentElement;
                    }
                    return true;
                })) all.push(child);
                visit(child);
            });
            visit(this); return all;
        }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
        closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
        contains(node) { return !!node && (node === this || this.children.some(c => c.contains(node))); }
        addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
        removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
        emit(type, target = this) { for (const fn of this.listeners.get(type) || []) fn({ type, target }); }
        focus() { document.activeElement = this; }
    }
    document.documentElement = { lang: 'en' };
    document.createElement = tag => new Element(tag, '<' + tag + '>');
    const root = new Element(); root.connected = true;
    return { root, document };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function batch(id = 'timehut-batch02', reviewState = 'active', revision = 'same-revision') {
    return { id, reviewState, updatedAt: '2026-11-23T00:00:00Z', phaseSummary: 'Phase ' + id,
        coverage: { C1: { android: { passed: 2, denominator: 10, percent: 20 } } }, coverageNote: 'Incomplete coverage', releasePolicy: 'Not a native release',
        items: Array.from({ length: 10 }, (_, n) => ({ id: String(n + 1).padStart(2, '0'), revision,
            title: id + ' item ' + (n + 1), before: 'Before ' + id, after: 'After ' + id, status: 'Original approved status', releaseStatus: 'Pending native integration', sha256: 'a'.repeat(64) })) };
}
function page(batches = [batch()], comments = [], results = [], activeBatchId = batches.find(b => b.reviewState === 'active')?.id || null) {
    return { success: true, batch: batches.find(b => b.id === activeBatchId) || batches[0] || null, batches, activeBatchId, comments, results, nextCursor: '0', hasMore: false };
}
function comment(body, extra = {}) {
    return { id: '1', batch: 'timehut-batch02', item: '01', revision: 'same-revision', decision: 'comment', body, created_at: '2026-11-23T01:00:00Z', ...extra };
}
function boot(initial = page(), responder) {
    const dom = fakeDom(), window = {};
    let uuid = 0;
    const storage = { getItem: jest.fn(() => { throw new Error('Private data must not use storage'); }), setItem: jest.fn(() => { throw new Error('Private data must not use storage'); }) };
    const r = { ...dom, data: initial, storage, window };
    const fetch = jest.fn(async (url, options) => {
        if (!url.startsWith(API)) throw new Error('Unexpected network path');
        return responder ? responder(url, options, r) : reply(structuredClone(r.data));
    });
    const context = { window, document: dom.document, fetch, crypto: { randomUUID: () => '00000000-0000-4000-8000-' + String(++uuid).padStart(12, '0') }, localStorage: storage, sessionStorage: storage };
    vm.runInNewContext(i18nSource, context);
    vm.runInNewContext(source, context);
    r.fetch = fetch;
    r.mount = () => window.HubQa.mount(r.root);
    r.mount(); return r;
}
const forms = r => r.root.querySelectorAll('form[data-qa-item]');
const form = (r, id = '01') => r.root.querySelector('form[data-qa-item="' + id + '"]');
function draft(f, body, decision = 'comment') { f.elements.body.value = body; f.elements.decision.value = decision; f.oninput(); }
const submit = f => f.onsubmit({ preventDefault: jest.fn() });
const posts = r => r.fetch.mock.calls.filter(([, opts]) => opts.method === 'POST');

test('active ten editable cards coexist with all collapsed complete immutable history, safely escaped', async () => {
    const old = batch('timehut-batch01', 'archived'), older = batch('timehut-batch00', 'archived'), active = batch();
    old.items[0].before = '<script>unsafe</script>'; old.items[0].title = '<img src=x onerror=alert(1)>';
    const r = boot(page([active, old, older], [comment('Active only'), comment('Old only', { batch: old.id, revision: 'old-revision', decision: 'approve' })], [comment('Old result', { batch: old.id, comment_id: '1' })]));
    await settle();
    expect(forms(r)).toHaveLength(10);
    const archives = r.root.querySelectorAll('.qa-completed'); expect(archives).toHaveLength(2);
    for (const archive of archives) {
        expect(archive.attrs).not.toHaveProperty('open');
        expect(archive.querySelectorAll('.qa-item')).toHaveLength(10);
        expect(archive.querySelectorAll('[data-qa-play]')).toHaveLength(10);
        for (const tag of ['form', 'textarea', 'select']) expect(archive.querySelectorAll(tag)).toHaveLength(0);
        expect(archive.textContent).toContain('Pending native integration');
        expect(archive.textContent).toContain('2 / 10');
    }
    const activeNode = r.root.querySelector('.qa-active');
    expect(activeNode.textContent).toContain('Active only'); expect(activeNode.textContent).not.toContain('Old only');
    expect(archives[0].textContent).toContain('Old only'); expect(archives[0].textContent).toContain('Old result');
    expect(archives[0].textContent).toContain('old-revision'); expect(archives[0].textContent).not.toContain('Active only');
    expect(r.root.querySelectorAll('script')).toHaveLength(0); expect(r.root.querySelectorAll('img')).toHaveLength(0);
    expect(r.root.innerHTML).toContain('&lt;script&gt;unsafe&lt;/script&gt;');
    expect(r.root.querySelectorAll('[id]').map(e => e.attrs.id).length).toBe(new Set(r.root.querySelectorAll('[id]').map(e => e.attrs.id)).size);
});

test('archived-only and explicit no-active snapshots never expose forms or reopen old batches', async () => {
    const r = boot(page([batch('timehut-batch01', 'archived')])); await settle();
    expect(forms(r)).toHaveLength(0); expect(r.root.querySelectorAll('.qa-item')).toHaveLength(10);
    expect(r.root.textContent).toContain('Next E2E stage'); expect(r.root.textContent).toContain('No new GIF batch');
    const progress = r.root.querySelector('.qa-progress');
    expect(progress.textContent).toContain('Phase timehut-batch01');
    expect(progress.textContent).toContain('2 / 10');
    expect(progress.closest('.qa-completed')).toBeNull();
    r.data = page([batch()], [], [], null); r.mount(); await settle();
    expect(forms(r)).toHaveLength(0); expect(r.root.querySelectorAll('.qa-completed')).toHaveLength(1);
});

test('legacy single-batch contract works and untagged comments/results belong only to batch01', async () => {
    const legacy = batch('timehut-batch01'), c = comment('Legacy feedback'); delete c.batch;
    const result = { item: '01', body: 'Legacy result', created_at: c.created_at };
    const r = boot({ success: true, batch: legacy, comments: [c], results: [result], nextCursor: '0', hasMore: false }); await settle();
    expect(forms(r)).toHaveLength(10); expect(r.root.textContent).toContain('Legacy feedback');
    r.data = page([batch(), { ...legacy, reviewState: 'archived' }], [c], [result]); r.mount(); await settle();
    expect(r.root.querySelector('.qa-active').textContent).not.toContain('Legacy feedback');
    expect(r.root.querySelector('.qa-active').textContent).not.toContain('Legacy result');
    expect(r.root.querySelector('.qa-completed').textContent).toContain('Legacy result');
});

test('missing current revision feedback stays distinct from original approved status and old approvals', async () => {
    const r = boot(page([batch()], [comment('Old approval', { revision: 'previous-revision', decision: 'approve' })])); await settle();
    let first = r.root.querySelector('.qa-item');
    expect(first.textContent).toContain('Original approved status'); expect(first.textContent).toContain('missing feedback is not approval');
    expect(first.querySelector('.qa-history').textContent).toContain('previous-revision');
    r.data.comments.push(comment('Plain comment')); r.mount(); await settle(); first = r.root.querySelector('.qa-item');
    expect(first.querySelector('.qa-feedback-note')).toBeNull();
    expect(first.querySelector('.qa-history').textContent).toContain('Comment');
});

test('global pagination retains every batch comment without a batch filter and preserves request privacy options', async () => {
    const batches = [batch(), batch('timehut-batch01', 'archived')];
    const r = boot(null, url => reply(url.endsWith('after=0') ? { ...page(batches, [comment('Page one', { batch: 'timehut-batch01' })]), nextCursor: '9007199254740993', hasMore: true } : { ...page(batches, [comment('Page two')]), nextCursor: '9007199254740994' }));
    await settle();
    expect(r.fetch.mock.calls.map(([url]) => url)).toEqual([API + '?after=0', API + '?after=9007199254740993']);
    expect(r.root.querySelector('.qa-completed').textContent).toContain('Page one'); expect(r.root.querySelector('.qa-active').textContent).toContain('Page two');
    for (const [, opts] of r.fetch.mock.calls) expect(opts).toMatchObject({ credentials: 'same-origin', cache: 'no-store' });
    expect(r.storage.getItem).not.toHaveBeenCalled(); expect(r.storage.setItem).not.toHaveBeenCalled();
});

test('publication during pagination restarts from zero instead of mixing snapshots', async () => {
    const a = page([batch()]), b = page([batch('timehut-batch03')], [comment('New history', { batch: 'timehut-batch03' })]);
    let call = 0;
    const r = boot(null, () => reply(++call === 1 ? { ...a, comments: [comment('Discard me')], hasMore: true, nextCursor: '1' } : b)); await settle();
    expect(r.fetch.mock.calls.map(([url]) => url)).toEqual([API + '?after=0', API + '?after=1', API + '?after=0']);
    expect(form(r).dataset.qaBatch).toBe('timehut-batch03'); expect(r.root.textContent).not.toContain('Discard me'); expect(r.root.textContent).toContain('New history');
});

test.each(['stalled', 'cycle', 'changing'])('invalid or unstable pagination fails closed: %s', async kind => {
    let call = 0;
    const r = boot(null, () => { call++; return reply({ ...page([batch(kind === 'changing' ? 'timehut-batch' + call : undefined)]), hasMore: true, nextCursor: kind === 'stalled' ? '0' : kind === 'cycle' && call % 2 === 0 ? '0' : String(call) }); });
    await settle(); expect(r.root.querySelector('[role="alert"]').textContent).toContain('Could not load reviews'); expect(forms(r)).toHaveLength(0); expect(call).toBeLessThanOrEqual(6);
});

test('lazy media uses the selected archived batch, handles failure/retry, and never fetches eagerly', async () => {
    const r = boot(page([batch(), batch('timehut-batch01', 'archived')])); await settle();
    const play = r.root.querySelector('.qa-completed').querySelector('[data-qa-play]');
    expect(r.root.querySelectorAll('img')).toHaveLength(0); expect(r.fetch).toHaveBeenCalledTimes(1);
    play.onclick(); const image = play.parentElement.querySelector('img');
    expect(image.src).toBe(API + '/media/01?batch=timehut-batch01&v=' + 'a'.repeat(64)); expect(play.hidden).toBe(true);
    play.onclick(); expect(play.parentElement.querySelectorAll('img')).toHaveLength(1);
    image.onerror(); expect(play.hidden).toBe(false); expect(play.parentElement.querySelector('img')).toBeNull();
    expect(play.parentElement.textContent).toContain('Could not load GIF');
    play.onclick(); const retry = play.parentElement.querySelector('img'); retry.onload();
    expect(play.parentElement.querySelector('[role="status"]').textContent).toBe('');
    r.mount(); await settle(); const html = r.root.innerHTML; retry.onerror(); expect(r.root.innerHTML).toBe(html);
});

test.each([401, 403, 503])('initial access/load failure renders no private cards: %i', async status => {
    const r = boot(null, () => reply({ success: false, error: 'QA_UNAVAILABLE' }, status)); await settle();
    expect(r.root.querySelector('[role="alert"]')).not.toBeNull(); expect(forms(r)).toHaveLength(0); expect(r.root.querySelectorAll('[data-qa-play]')).toHaveLength(0);
});

test('empty state has no cards', async () => { const r = boot(page([])); await settle(); expect(r.root.textContent).toContain('No review batch'); expect(forms(r)).toHaveLength(0); });

test.each([false, true])('old mount success/error cannot overwrite a newer mount on the same connected host: %s', async fail => {
    const old = deferred(); let call = 0;
    const r = boot(null, () => ++call === 1 ? old.promise : reply(page([batch('timehut-batch03')])));
    r.mount(); await settle(); const html = r.root.innerHTML;
    if (fail) old.reject(new Error('late error')); else old.resolve(reply(page()));
    await settle(); expect(r.root.innerHTML).toBe(html); expect(form(r).dataset.qaBatch).toBe('timehut-batch03');
});

test('detached host ignores a late load', async () => {
    const slow = deferred(), r = boot(null, () => slow.promise); r.root.connected = false;
    const html = r.root.innerHTML; slow.resolve(reply(page())); await settle(); expect(r.root.innerHTML).toBe(html);
});

test('drafts and UUID retries are scoped to batch, item and revision across remounts', async () => {
    const r = boot(page(), (url, opts, runtime) => opts.method === 'POST' ? reply({ success: false, error: 'QA_UNAVAILABLE' }, 503) : reply(runtime.data)); await settle();
    draft(form(r), 'Batch two'); await submit(form(r)); const first = JSON.parse(posts(r)[0][1].body);
    expect(first).toMatchObject({ batch: 'timehut-batch02', item: '01', revision: 'same-revision', body: 'Batch two', decision: 'comment' });
    r.mount(); await settle(); expect(form(r).elements.body.value).toBe('Batch two'); expect(form(r, '02').elements.body.value).toBe('');
    await submit(form(r)); expect(JSON.parse(posts(r)[1][1].body).requestId).toBe(first.requestId);
    r.data = page([batch('timehut-batch03')]); r.mount(); await settle(); expect(form(r).elements.body.value).toBe('');
    draft(form(r), 'Batch three'); await submit(form(r)); expect(JSON.parse(posts(r)[2][1].body).requestId).not.toBe(first.requestId);
    r.data = page([batch('timehut-batch02', 'active', 'revision-two')]); r.mount(); await settle(); expect(form(r).elements.body.value).toBe('');
    r.data = page(); r.mount(); await settle(); expect(form(r).elements.body.value).toBe('Batch two');
    draft(form(r), 'Changed text'); await submit(form(r)); expect(JSON.parse(posts(r)[3][1].body).requestId).not.toBe(first.requestId);
    expect(r.storage.setItem).not.toHaveBeenCalled();
});

test('blank feedback does not send or imply approval', async () => {
    const r = boot(); await settle(); draft(form(r), '  ', 'approve'); await submit(form(r));
    expect(posts(r)).toHaveLength(0); expect(form(r).querySelector('[role="status"]').textContent).toBe('Please enter feedback.');
});

test.each([409, 503])('submission failure retains draft and retry UUID and restores button: %i', async code => {
    const r = boot(page(), (url, opts, runtime) => opts.method === 'POST' ? reply({ success: false, error: code === 409 ? 'QA_BATCH_ARCHIVED' : 'QA_UNAVAILABLE' }, code) : reply(runtime.data)); await settle();
    draft(form(r), 'Keep this', 'changes'); await submit(form(r));
    expect(form(r).querySelector('[role="status"]').textContent).toContain(code === 409 ? 'revision or request changed' : 'Could not save');
    expect(form(r).querySelector('button').disabled).toBe(false);
    r.mount(); await settle(); expect(form(r).elements.body.value).toBe('Keep this'); expect(form(r).elements.decision.value).toBe('changes');
});

test('duplicate submits are locked across remounts and detached forms cannot submit', async () => {
    const slow = deferred(), r = boot(page(), (url, opts, runtime) => opts.method === 'POST' ? slow.promise : reply(runtime.data)); await settle();
    const old = form(r); draft(old, 'Once'); const sent = submit(old); await submit(old); expect(posts(r)).toHaveLength(1);
    r.mount(); await settle(); expect(form(r).querySelector('button').disabled).toBe(true);
    await submit(form(r)); await submit(old); expect(posts(r)).toHaveLength(1);
    slow.resolve(reply({ success: false, error: 'QA_UNAVAILABLE' }, 503)); await sent; await settle();
    expect(form(r).querySelector('button').disabled).toBe(false); expect(form(r).querySelector('[role="status"]').textContent).toBe('');
});

test('a successful send reloads history, preserves other drafts and shows saved only for the exact tuple', async () => {
    const r = boot(page(), (url, opts, runtime) => {
        if (opts.method === 'POST') { runtime.data.comments.push(comment('Saved feedback')); return reply({ success: true }); }
        return reply(runtime.data);
    }); await settle(); draft(form(r, '02'), 'Other item'); draft(form(r), 'Saved feedback'); await submit(form(r));
    expect(form(r).elements.body.value).toBe(''); expect(form(r, '02').elements.body.value).toBe('Other item');
    expect(form(r).querySelector('[role="status"]').textContent).toContain('Feedback saved');
    expect(r.root.querySelector('.qa-history').textContent).toContain('Saved feedback');
    expect(form(r, '02').querySelector('[role="status"]').textContent).toBe('');
});

test('typing during a pending send preserves the newer draft and does not claim it was saved', async () => {
    const slow = deferred(), read = deferred(); let reads = 0;
    const r = boot(page(), (url, opts, runtime) => opts.method === 'POST' ? slow.promise : ++reads === 1 ? reply(runtime.data) : read.promise); await settle();
    draft(form(r), 'Sent text'); const sent = submit(form(r)); draft(form(r), 'New unsent text');
    slow.resolve(reply({ success: true })); await settle();
    expect(form(r).querySelector('[role="status"]').textContent).toBe('');
    read.resolve(reply(page())); await sent;
    expect(form(r).elements.body.value).toBe('New unsent text'); expect(form(r).querySelector('[role="status"]').textContent).toBe('');
    expect(form(r).querySelector('button').disabled).toBe(false);
});

test.each(['batch', 'revision', 'archive'])('success refresh never places saved status on a changed %s', async change => {
    const r = boot(page(), (url, opts, runtime) => {
        if (opts.method === 'POST') {
            runtime.data = page([batch(change === 'batch' ? 'timehut-batch03' : 'timehut-batch02', change === 'archive' ? 'archived' : 'active', change === 'revision' ? 'new-revision' : 'same-revision')]);
            return reply({ success: true });
        }
        return reply(runtime.data);
    }); await settle(); draft(form(r), 'Send'); await submit(form(r));
    expect(r.root.textContent).not.toContain('Feedback saved');
    expect(forms(r)).toHaveLength(change === 'archive' ? 0 : 10);
});

test('late submission success after batch switch never clears another batch draft or starts an old refresh', async () => {
    const slow = deferred(), r = boot(page(), (url, opts, runtime) => opts.method === 'POST' ? slow.promise : reply(runtime.data)); await settle();
    draft(form(r), 'Old batch send'); const sent = submit(form(r));
    r.data = page([batch('timehut-batch03')]); r.mount(); await settle(); draft(form(r), 'New batch draft');
    const calls = r.fetch.mock.calls.length; slow.resolve(reply({ success: true })); await sent;
    expect(r.fetch).toHaveBeenCalledTimes(calls); expect(form(r).elements.body.value).toBe('New batch draft'); expect(form(r).querySelector('[role="status"]').textContent).toBe('');
});

test('new UI strings resolve explicitly in every current locale, including locale aliases', () => {
    const strings = JSON.parse(/const strings = (\{[\s\S]*?\});/.exec(i18nSource)[1]);
    const keys = [...source.matchAll(/\bt\('([^']+)'\)/g)].map(m => m[1]).concat(['activeIntro', 'historyIntro', 'archivedBatch', 'noFeedback', 'before', 'after']);
    for (const [lang, values] of Object.entries(strings)) {
        const context = { window: {}, document: { documentElement: { lang } } }; vm.runInNewContext(i18nSource, context);
        for (const key of keys) { expect(values[key]).toEqual(expect.any(String)); expect(values[key].length).toBeGreaterThan(0); expect(context.window.HubQaText.t(key)).toBe(values[key]); }
    }
    for (const [lang, expected] of [['zh-Hant', 'zh-TW'], ['zh-Hans', 'zh-CN'], ['unknown', 'en']]) {
        const context = { window: {}, document: { documentElement: { lang } } }; vm.runInNewContext(i18nSource, context);
        expect(context.window.HubQaText.t('noFeedback')).toBe(strings[expected].noFeedback);
    }
});

test('failed post-save refresh reports a load failure and a later mount keeps the saved draft cleared', async () => {
    let saved = false, refreshFails = true;
    const r = boot(page(), (url, opts, runtime) => {
        if (opts.method === 'POST') { saved = true; return reply({ success: true }); }
        if (saved && refreshFails) return reply({ success: false, error: 'QA_UNAVAILABLE' }, 503);
        return reply(runtime.data);
    }); await settle(); draft(form(r), 'Already saved'); await submit(form(r));
    expect(form(r).querySelector('[role="status"]').textContent).toContain('Could not load reviews');
    expect(form(r).querySelector('[role="status"]').textContent).not.toContain('Could not save');
    expect(form(r).querySelector('button').disabled).toBe(false);
    refreshFails = false; r.mount(); await settle(); expect(form(r).elements.body.value).toBe('');
});

test.each([false, true])('overlapping post-save reads ignore superseded success/error: %s', async fail => {
    const oldRead = deferred(); let reads = 0;
    const r = boot(page(), (url, opts, runtime) => {
        if (opts.method === 'POST') return reply({ success: true });
        reads++;
        if (reads === 2) return oldRead.promise;
        return reply(reads > 2 ? page([batch('timehut-batch03')]) : runtime.data);
    }); await settle(); draft(form(r), 'First send'); draft(form(r, '02'), 'Second send');
    const first = submit(form(r)); await settle(); const second = submit(form(r, '02')); await second;
    const html = r.root.innerHTML;
    if (fail) oldRead.reject(new Error('Old read failed')); else oldRead.resolve(reply(page()));
    await first; expect(r.root.innerHTML).toBe(html); expect(form(r).dataset.qaBatch).toBe('timehut-batch03');
    expect(form(r).querySelector('[role="status"]').textContent).toBe('');
});

test('edits made while the save refresh is pending survive the refreshed form', async () => {
    const read = deferred(); let reads = 0;
    const r = boot(page(), (url, opts, runtime) => opts.method === 'POST' ? reply({ success: true }) : ++reads === 1 ? reply(runtime.data) : read.promise);
    await settle(); draft(form(r), 'Saved text'); const sent = submit(form(r)); await settle();
    draft(form(r), 'Typed during refresh');
    expect(form(r).querySelector('[role="status"]').textContent).toBe('');
    read.resolve(reply(page())); await sent;
    expect(form(r).elements.body.value).toBe('Typed during refresh'); expect(form(r).querySelector('[role="status"]').textContent).toBe('');
    expect(form(r).querySelector('button').disabled).toBe(false);
});

test('late success on a remounted identical tuple retains the exact retry UUID rather than generating a duplicate', async () => {
    const slow = deferred(); let sends = 0;
    const r = boot(page(), (url, opts, runtime) => opts.method === 'POST' ? ++sends === 1 ? slow.promise : reply({ success: false, error: 'QA_UNAVAILABLE' }, 503) : reply(runtime.data));
    await settle(); draft(form(r), 'Same tuple'); const sent = submit(form(r));
    r.mount(); await settle(); slow.resolve(reply({ success: true })); await sent;
    expect(form(r).elements.body.value).toBe('Same tuple'); expect(form(r).querySelector('[role="status"]').textContent).toBe('');
    await submit(form(r)); expect(JSON.parse(posts(r)[0][1].body).requestId).toBe(JSON.parse(posts(r)[1][1].body).requestId);
});

test('late failed submission does not mark a new revision stale or alter its draft', async () => {
    const slow = deferred(), r = boot(page(), (url, opts, runtime) => opts.method === 'POST' ? slow.promise : reply(runtime.data));
    await settle(); draft(form(r), 'Old revision'); const sent = submit(form(r));
    r.data = page([batch('timehut-batch02', 'active', 'new-revision')]); r.mount(); await settle(); draft(form(r), 'New revision');
    slow.resolve(reply({ success: false, error: 'QA_REVISION_CONFLICT' }, 409)); await sent;
    expect(form(r).elements.body.value).toBe('New revision'); expect(form(r).querySelector('[role="status"]').textContent).toBe('');
});

test('comments and results cannot inject markup through the shared card timeline', async () => {
    const attack = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const r = boot(page([batch()], [comment(attack)], [{ batch: 'timehut-batch02', item: '01', body: attack, comment_id: '\"><script>bad</script>', created_at: '2026-11-23T02:00:00Z' }]));
    await settle(); expect(r.root.querySelectorAll('script')).toHaveLength(0); expect(r.root.querySelectorAll('img')).toHaveLength(0);
    expect(r.root.querySelector('.qa-history').textContent).toContain(attack); expect(r.root.innerHTML).toContain('&lt;script&gt;');
});
