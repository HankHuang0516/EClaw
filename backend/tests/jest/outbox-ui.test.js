/**
 * Outbox UI helpers — banner + bubble state classes + tap handlers.
 *
 * Card: card_751775f0435f3a17e669d12a.
 * Spec: docs/offline-delivery-queue-spec.md (acceptance #4 + #5).
 *
 * jest.config.js uses testEnvironment:'node' with no jsdom, so we hand-roll a
 * minimal DOM stub that covers the surface outbox-ui.js touches: classList,
 * setAttribute, querySelector('[data-outbox-key=...]'), appendChild,
 * removeChild, addEventListener('click', ...), .hidden, .textContent. The
 * stub is deliberately small — enough to drive the helpers, not a general
 * DOM emulator. If outbox-ui.js grows to need more APIs, extend the stub
 * before reaching for the real jsdom dep.
 */
'use strict';

const path = require('path');

// ── Minimal DOM stub ──────────────────────────────────────────────────────
function makeStub() {
    const allElements = [];

    function ClassList(el) {
        this._el = el;
    }
    ClassList.prototype.contains = function (c) {
        const cn = this._el.className || '';
        return cn.split(/\s+/).indexOf(c) !== -1;
    };
    ClassList.prototype.add = function (c) {
        const set = new Set((this._el.className || '').split(/\s+/).filter(Boolean));
        set.add(c);
        this._el.className = Array.from(set).join(' ');
    };
    ClassList.prototype.remove = function (c) {
        const set = new Set((this._el.className || '').split(/\s+/).filter(Boolean));
        set.delete(c);
        this._el.className = Array.from(set).join(' ');
    };

    function Element(tag) {
        this.tagName = String(tag || '').toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.attrs = {};
        this.className = '';
        this.hidden = false;
        this.textContent = '';
        this._listeners = {};
        this.classList = new ClassList(this);
        this.ownerDocument = doc;
        allElements.push(this);
    }
    Element.prototype.appendChild = function (child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
    };
    Element.prototype.removeChild = function (child) {
        const idx = this.children.indexOf(child);
        if (idx >= 0) {
            this.children.splice(idx, 1);
            child.parentNode = null;
        }
        return child;
    };
    Element.prototype.setAttribute = function (k, v) {
        this.attrs[k] = String(v);
    };
    Element.prototype.getAttribute = function (k) {
        return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
    };
    Element.prototype.addEventListener = function (evt, cb) {
        if (!this._listeners[evt]) this._listeners[evt] = [];
        this._listeners[evt].push(cb);
    };
    Element.prototype.removeEventListener = function (evt, cb) {
        const arr = this._listeners[evt] || [];
        const idx = arr.indexOf(cb);
        if (idx >= 0) arr.splice(idx, 1);
    };
    Element.prototype.dispatchEvent = function (evt) {
        const arr = this._listeners[evt.type] || [];
        for (const cb of arr.slice()) cb(evt);
    };
    Element.prototype.querySelector = function (selector) {
        // Only [data-outbox-key="..."] is exercised by outbox-ui.js.
        const m = selector.match(/^\[data-outbox-key="([^"]+)"\]$/);
        if (!m) return null;
        const key = m[1].replace(/\\(.)/g, '$1');
        // Walk every element we have created and check attr (depth-first via allElements is fine).
        for (const el of allElements) {
            if (el.attrs && el.attrs['data-outbox-key'] === key) return el;
        }
        return null;
    };

    const doc = {
        createElement: function (tag) { return new Element(tag); },
    };
    return { doc, Element };
}

// ── Load outbox-ui.js fresh per test ──────────────────────────────────────
function loadOutboxUI() {
    const p = path.join(__dirname, '..', '..', 'public', 'portal', 'shared', 'outbox-ui.js');
    delete require.cache[require.resolve(p)];
    return require(p);
}

describe('outbox-ui — banner visibility', () => {
    let ui, doc;
    beforeEach(() => {
        ui = loadOutboxUI();
        ({ doc } = makeStub());
    });

    test('hidden + empty text when 0 queued + 0 retrying', () => {
        const banner = doc.createElement('div');
        const text = doc.createElement('span');
        banner.hidden = false;
        text.textContent = 'stale';
        ui.updateBanner(banner, text, { by: { queued: 0, retrying: 0, sent: 5, failed: 1 } });
        expect(banner.hidden).toBe(true);
        expect(text.textContent).toBe('');
    });

    test('shown with "N queued" when only queued > 0', () => {
        const banner = doc.createElement('div');
        const text = doc.createElement('span');
        banner.hidden = true;
        ui.updateBanner(banner, text, { by: { queued: 3, retrying: 0 } });
        expect(banner.hidden).toBe(false);
        expect(text.textContent).toBe('3 queued');
    });

    test('shown with both segments joined by · when both > 0', () => {
        const banner = doc.createElement('div');
        const text = doc.createElement('span');
        ui.updateBanner(banner, text, { by: { queued: 2, retrying: 1 } });
        expect(banner.hidden).toBe(false);
        expect(text.textContent).toBe('2 queued · 1 retrying');
    });

    test('falls through to i18n callback when provided', () => {
        const banner = doc.createElement('div');
        const text = doc.createElement('span');
        const t = (key) => {
            if (key === 'chat_outbox_queued_n') return '{n} 排隊中';
            if (key === 'chat_outbox_retrying_n') return '{n} 重試中';
            return key;
        };
        ui.updateBanner(banner, text, { by: { queued: 4, retrying: 2 } }, t);
        expect(text.textContent).toBe('4 排隊中 · 2 重試中');
    });

    test('null banner is a no-op (does not throw)', () => {
        expect(() => ui.updateBanner(null, null, { by: { queued: 1, retrying: 0 } })).not.toThrow();
    });
});

describe('outbox-ui — bubble lifecycle + state classes', () => {
    let ui, doc, container;
    beforeEach(() => {
        ui = loadOutboxUI();
        ({ doc } = makeStub());
        container = doc.createElement('div');
    });

    test('renderQueuedBubble appends bubble with queued class + data-outbox-key + text', () => {
        const el = ui.renderQueuedBubble(container, { idempotencyKey: 'k-1', text: 'hello' });
        expect(el).not.toBeNull();
        expect(container.children).toContain(el);
        expect(el.getAttribute('data-outbox-key')).toBe('k-1');
        expect(el.classList.contains('msg-outbox')).toBe(true);
        expect(el.classList.contains('msg-outbox-queued')).toBe(true);
        // bubble child + spinner + warn (3 children)
        expect(el.children.length).toBe(3);
        expect(el.children[0].className).toBe('chat-bubble');
        expect(el.children[0].textContent).toBe('hello');
    });

    test('renderQueuedBubble is idempotent — second call with same key does not double-append', () => {
        const first = ui.renderQueuedBubble(container, { idempotencyKey: 'k-2', text: 'x' });
        const second = ui.renderQueuedBubble(container, { idempotencyKey: 'k-2', text: 'x' });
        expect(second).toBe(first);
        expect(container.children.length).toBe(1);
    });

    test('setBubbleState flips queued → retrying → failed (4-state transition)', () => {
        ui.renderQueuedBubble(container, { idempotencyKey: 'k-3', text: 't' });
        ui.setBubbleState(container, 'k-3', 'retrying');
        const el = ui.findBubble(container, 'k-3');
        expect(el.classList.contains('msg-outbox-queued')).toBe(false);
        expect(el.classList.contains('msg-outbox-retrying')).toBe(true);

        ui.setBubbleState(container, 'k-3', 'failed');
        expect(el.classList.contains('msg-outbox-retrying')).toBe(false);
        expect(el.classList.contains('msg-outbox-failed')).toBe(true);

        ui.setBubbleState(container, 'k-3', 'sent');
        expect(el.classList.contains('msg-outbox-failed')).toBe(false);
        expect(el.classList.contains('msg-outbox-sent')).toBe(true);
    });

    test('setBubbleState supports sending state (online optimistic)', () => {
        ui.renderQueuedBubble(container, { idempotencyKey: 'k-snd', text: 't' });
        ui.setBubbleState(container, 'k-snd', 'sending');
        const el = ui.findBubble(container, 'k-snd');
        expect(el.classList.contains('msg-outbox-queued')).toBe(false);
        expect(el.classList.contains('msg-outbox-sending')).toBe(true);
        // first-attempt failure path: sending → failed
        ui.setBubbleState(container, 'k-snd', 'failed');
        expect(el.classList.contains('msg-outbox-sending')).toBe(false);
        expect(el.classList.contains('msg-outbox-failed')).toBe(true);
    });

    test('setBubbleState ignores unknown state', () => {
        ui.renderQueuedBubble(container, { idempotencyKey: 'k-4', text: 't' });
        ui.setBubbleState(container, 'k-4', 'nonsense');
        const el = ui.findBubble(container, 'k-4');
        expect(el.classList.contains('msg-outbox-queued')).toBe(true);
        expect(el.classList.contains('msg-outbox-nonsense')).toBe(false);
    });

    test('removeBubble drops the element from the container', () => {
        ui.renderQueuedBubble(container, { idempotencyKey: 'k-5', text: 't' });
        expect(container.children.length).toBe(1);
        const ok = ui.removeBubble(container, 'k-5');
        expect(ok).toBe(true);
        expect(container.children.length).toBe(0);
    });

    test('removeBubble returns false when key not found', () => {
        expect(ui.removeBubble(container, 'no-such-key')).toBe(false);
    });
});

describe('outbox-ui — tap handlers', () => {
    let ui, doc, container;
    beforeEach(() => {
        ui = loadOutboxUI();
        ({ doc } = makeStub());
        container = doc.createElement('div');
    });

    function fireClick(target) {
        let prevented = false, stopped = false;
        const evt = {
            type: 'click',
            target,
            preventDefault() { prevented = true; },
            stopPropagation() { stopped = true; },
        };
        container.dispatchEvent(evt);
        return { prevented, stopped };
    }

    test('clicking queued bubble triggers onCancel with the idempotencyKey', () => {
        const onCancel = jest.fn();
        const onFailedMenu = jest.fn();
        ui.attachTapHandlers(container, { onCancel, onFailedMenu });
        const el = ui.renderQueuedBubble(container, { idempotencyKey: 'kq', text: 'q' });
        fireClick(el);
        expect(onCancel).toHaveBeenCalledWith('kq', el);
        expect(onFailedMenu).not.toHaveBeenCalled();
    });

    test('clicking retrying bubble triggers onCancel', () => {
        const onCancel = jest.fn();
        const onFailedMenu = jest.fn();
        ui.attachTapHandlers(container, { onCancel, onFailedMenu });
        ui.renderQueuedBubble(container, { idempotencyKey: 'kr', text: 'r' });
        ui.setBubbleState(container, 'kr', 'retrying');
        const el = ui.findBubble(container, 'kr');
        fireClick(el);
        expect(onCancel).toHaveBeenCalledWith('kr', el);
    });

    test('clicking failed bubble triggers onFailedMenu, not onCancel', () => {
        const onCancel = jest.fn();
        const onFailedMenu = jest.fn();
        ui.attachTapHandlers(container, { onCancel, onFailedMenu });
        ui.renderQueuedBubble(container, { idempotencyKey: 'kf', text: 'f' });
        ui.setBubbleState(container, 'kf', 'failed');
        const el = ui.findBubble(container, 'kf');
        fireClick(el);
        expect(onFailedMenu).toHaveBeenCalledWith('kf', el);
        expect(onCancel).not.toHaveBeenCalled();
    });

    test('clicking sending bubble triggers neither handler (POST already in flight)', () => {
        const onCancel = jest.fn();
        const onFailedMenu = jest.fn();
        ui.attachTapHandlers(container, { onCancel, onFailedMenu });
        ui.renderQueuedBubble(container, { idempotencyKey: 'ksnd2', text: 's' });
        ui.setBubbleState(container, 'ksnd2', 'sending');
        const el = ui.findBubble(container, 'ksnd2');
        fireClick(el);
        expect(onCancel).not.toHaveBeenCalled();
        expect(onFailedMenu).not.toHaveBeenCalled();
    });

    test('clicking sent bubble triggers neither handler', () => {
        const onCancel = jest.fn();
        const onFailedMenu = jest.fn();
        ui.attachTapHandlers(container, { onCancel, onFailedMenu });
        ui.renderQueuedBubble(container, { idempotencyKey: 'ks', text: 's' });
        ui.setBubbleState(container, 'ks', 'sent');
        const el = ui.findBubble(container, 'ks');
        fireClick(el);
        expect(onCancel).not.toHaveBeenCalled();
        expect(onFailedMenu).not.toHaveBeenCalled();
    });

    test('clicking a child of the bubble walks up to the outbox container', () => {
        const onCancel = jest.fn();
        ui.attachTapHandlers(container, { onCancel });
        const el = ui.renderQueuedBubble(container, { idempotencyKey: 'kc', text: 'c' });
        // Click the inner chat-bubble — handler must walk up to outbox parent.
        fireClick(el.children[0]);
        expect(onCancel).toHaveBeenCalledWith('kc', el);
    });

    test('detach function unbinds the click listener', () => {
        const onCancel = jest.fn();
        const detach = ui.attachTapHandlers(container, { onCancel });
        const el = ui.renderQueuedBubble(container, { idempotencyKey: 'kd', text: 'd' });
        detach();
        fireClick(el);
        expect(onCancel).not.toHaveBeenCalled();
    });
});

describe('outbox-ui — chat.html integration contract', () => {
    // The bubble lifecycle is wired into chat.html at the enqueue/markRetrying
    // /markSent/markFailed call sites. Lock the surface so a future drift
    // (someone removes the UI calls but keeps the outbox.js calls) leaves a
    // regression fingerprint.
    const fs = require('fs');
    const chatHtml = fs.readFileSync(
        path.join(__dirname, '..', '..', 'public', 'portal', 'chat.html'),
        'utf8'
    );

    test('outbox-ui.js is loaded as a portal script', () => {
        expect(chatHtml).toMatch(/<script src="shared\/outbox-ui\.js"><\/script>/);
    });

    test('outbox banner element + text span are present', () => {
        expect(chatHtml).toMatch(/id="outboxBanner"/);
        expect(chatHtml).toMatch(/id="outboxBannerText"/);
    });

    test('enqueue path calls renderQueuedBubble + setBubbleState sending (online optimistic, 情緒價值 #2)', () => {
        expect(chatHtml).toMatch(/EclawOutboxUI\.renderQueuedBubble\(/);
        expect(chatHtml).toMatch(/EclawOutboxUI\.setBubbleState\([^,]+,\s*__idempotencyKey,\s*['"]sending['"]\)/);
    });

    test('sending bubble carries a localized aria-label', () => {
        expect(chatHtml).toMatch(/setAttribute\('aria-label',\s*i18n\.t\('chat_sending'\)/);
    });

    test('success path removes the inline bubble', () => {
        expect(chatHtml).toMatch(/EclawOutboxUI\.removeBubble\([^,]+,\s*__idempotencyKey\)/);
    });

    test('failure path flips bubble to failed', () => {
        expect(chatHtml).toMatch(/EclawOutboxUI\.setBubbleState\([^,]+,\s*__idempotencyKey,\s*['"]failed['"]\)/);
    });

    test('tap handlers are attached on init', () => {
        expect(chatHtml).toMatch(/EclawOutboxUI\.attachTapHandlers\(\s*c\s*,\s*\{\s*onCancel:\s*_onOutboxCancel\s*,\s*onFailedMenu:\s*_onOutboxFailedMenu\s*\}\)/);
    });

    test('banner updater uses EclawOutboxUI.updateBanner with i18n callback', () => {
        expect(chatHtml).toMatch(/EclawOutboxUI\.updateBanner\(/);
        expect(chatHtml).toMatch(/i18n\.t\(k\)/);
    });

    test('cancel handler removes outbox entry + bubble + refreshes banner', () => {
        expect(chatHtml).toMatch(/EclawOutbox\.remove\(key\)/);
        expect(chatHtml).toMatch(/EclawOutboxUI\.removeBubble\(c,\s*key\)/);
        expect(chatHtml).toMatch(/_updateOutboxBanner\(\)/);
    });

    test('failed retry path re-enqueues with fresh idempotencyKey (snapshot lookup)', () => {
        expect(chatHtml).toMatch(/EclawOutbox\.snapshot\(\)/);
        expect(chatHtml).toMatch(/EclawOutbox\.enqueue\(entry\.payload\)/);
    });
});

describe('outbox-ui — i18n keys exist in EN locale', () => {
    const fs = require('fs');
    const i18nJs = fs.readFileSync(
        path.join(__dirname, '..', '..', 'public', 'shared', 'i18n.js'),
        'utf8'
    );
    const NEEDED = [
        'chat_outbox_queued_n',
        'chat_outbox_retrying_n',
        'chat_outbox_cancel_confirm',
        'chat_outbox_failed_retry_q',
        'chat_outbox_failed_delete_q',
        // 情緒價值 #2 (card_c575aacae639721dbc8cfaa3)
        'chat_sending',
        'kb_toast_moved',
        'kb_toast_archived',
        'kb_undo',
        'kb_undo_done',
        'kb_undo_failed',
        'kb_err_move',
    ];
    test.each(NEEDED)('%s is declared in i18n.js', (key) => {
        expect(i18nJs).toMatch(new RegExp('"' + key + '":'));
    });
});
