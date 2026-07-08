/**
 * sendto-picker-avatar-click — regression for card_1ee3bd9f.
 *
 * The shared delegated handler attachAvatarClickHandler() (entity-utils.js)
 * opens the EntityStatusPanel drawer whenever an element carrying
 * `data-entity-id` is clicked. The newer "Select recipients" picker
 * (.sendto-picker-overlay) renders each row as <label data-entity-id>
 * wrapping a checkbox. Before this fix the picker was NOT in the handler's
 * exclusion list (only the legacy .target-entity-check row was), so a click
 * inside the picker (a) opened the status drawer over the dialog and
 * (b) preventDefault()'d the checkbox toggle — the row never selected.
 * Reported by Hank: "選擇傳送對象 點實體名稱 → 轉導狀態列表 / 按錯".
 *
 * jest.config.js is testEnvironment:'node' (no jsdom), so we eval
 * entity-utils.js in a sandbox to obtain attachAvatarClickHandler and drive
 * it with a tiny DOM shim that implements the closest()/matches()/contains()
 * surface the handler relies on.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const euPath = path.join(__dirname, '..', '..', 'public', 'portal', 'shared', 'entity-utils.js');
const euSrc = fs.readFileSync(euPath, 'utf8');

// entity-utils.js is a browser-global script (top-level function declarations,
// window-guarded init at the bottom). Eval it inside a Function scope with a
// node-safe global shim and hand back the function under test.
function loadAttachHandler() {
    // eslint-disable-next-line no-new-func
    const factory = new Function(
        'window', 'document', 'localStorage',
        `${euSrc}\n;return typeof attachAvatarClickHandler === 'function' ? attachAvatarClickHandler : null;`
    );
    return factory(undefined, undefined, undefined);
}

// ── Minimal DOM shim ──────────────────────────────────────────────────────
function el(spec = {}) {
    const node = {
        tag: (spec.tag || 'div').toUpperCase(),
        classes: new Set(spec.classes || []),
        id: spec.id || '',
        attrs: Object.assign({}, spec.attrs || {}),
        dataset: Object.assign({}, spec.dataset || {}),
        parent: null,
        children: [],
    };
    // mirror data-* into attrs so [attr] selectors see them
    if (node.dataset.entityId !== undefined) node.attrs['data-entity-id'] = String(node.dataset.entityId);
    if (spec.attrs && 'data-no-avatar-click' in spec.attrs) node.attrs['data-no-avatar-click'] = '';
    node.append = (child) => { child.parent = node; node.children.push(child); return child; };
    node.matches = (sel) => sel.split(',').some((s) => matchOne(node, s.trim()));
    node.closest = (sel) => {
        let cur = node;
        while (cur) { if (sel.split(',').some((s) => matchOne(cur, s.trim()))) return cur; cur = cur.parent; }
        return null;
    };
    node.contains = (other) => {
        let cur = other;
        while (cur) { if (cur === node) return true; cur = cur.parent; }
        return false;
    };
    return node;
}

function matchOne(node, sel) {
    // tag[attr="val"]  (e.g. input[type="checkbox"])
    const tagAttr = sel.match(/^([a-z]+)\[([a-z-]+)="([^"]+)"\]$/i);
    if (tagAttr) {
        return node.tag === tagAttr[1].toUpperCase() && node.attrs[tagAttr[2]] === tagAttr[3];
    }
    if (sel.startsWith('.')) return node.classes.has(sel.slice(1));
    if (sel.startsWith('#')) return node.id === sel.slice(1);
    const attr = sel.match(/^\[([a-z-]+)\]$/i);
    if (attr) return Object.prototype.hasOwnProperty.call(node.attrs, attr[1]);
    return node.tag === sel.toUpperCase();
}

function fireClick(container, handler, target) {
    let prevented = false; let stopped = false;
    const evt = {
        target,
        preventDefault() { prevented = true; },
        stopPropagation() { stopped = true; },
    };
    handler(evt);
    return { prevented, stopped };
}

describe('attachAvatarClickHandler — sendto picker exclusion (card_1ee3bd9f)', () => {
    let attachAvatarClickHandler;
    beforeAll(() => { attachAvatarClickHandler = loadAttachHandler(); });

    test('loads the function from entity-utils.js', () => {
        expect(typeof attachAvatarClickHandler).toBe('function');
    });

    test('click on a plain avatar (data-entity-id) DOES open the status drawer', () => {
        const body = el({ tag: 'body' });
        const avatar = el({ tag: 'span', classes: ['entity-avatar-img'], dataset: { entityId: '5' } });
        body.append(avatar);

        const opened = [];
        let captured;
        body.addEventListener = (_t, fn) => { captured = fn; };
        attachAvatarClickHandler(body, (eid) => opened.push(eid));

        const r = fireClick(body, captured, avatar);
        expect(opened).toEqual([5]);          // drawer opened for entity 5
        expect(r.prevented).toBe(true);
    });

    test('click inside .sendto-picker-overlay does NOT open the drawer (selection wins)', () => {
        const body = el({ tag: 'body' });
        const overlay = el({ tag: 'div', classes: ['sendto-picker-overlay'] });
        const row = el({ tag: 'label', classes: ['sendto-picker-row-item'], dataset: { entityId: '6' } });
        const rowAvatar = el({ tag: 'div', classes: ['entity-avatar-img'], dataset: { entityId: '6' } });
        body.append(overlay); overlay.append(row); row.append(rowAvatar);

        const opened = [];
        let captured;
        body.addEventListener = (_t, fn) => { captured = fn; };
        attachAvatarClickHandler(body, (eid) => opened.push(eid));

        const r = fireClick(body, captured, rowAvatar);
        expect(opened).toEqual([]);           // drawer NOT opened
        expect(r.prevented).toBe(false);      // checkbox toggle preserved
    });

    test('legacy .target-entity-check row stays excluded (no regression)', () => {
        const body = el({ tag: 'body' });
        const check = el({ tag: 'label', classes: ['target-entity-check'], dataset: { entityId: '1' } });
        const avatar = el({ tag: 'span', classes: ['entity-avatar-img'], dataset: { entityId: '1' } });
        body.append(check); check.append(avatar);

        const opened = [];
        let captured;
        body.addEventListener = (_t, fn) => { captured = fn; };
        attachAvatarClickHandler(body, (eid) => opened.push(eid));

        fireClick(body, captured, avatar);
        expect(opened).toEqual([]);
    });
});

describe('chat.html static contracts (card_1ee3bd9f)', () => {
    const chatHtml = fs.readFileSync(
        path.join(__dirname, '..', '..', 'public', 'portal', 'chat.html'), 'utf8');

    test('picker overlay opts out of avatar-click via data-no-avatar-click', () => {
        // belt-and-suspenders alongside the entity-utils.js exclusion
        expect(chatHtml).toMatch(/id="sendtoPickerOverlay"[\s\S]{0,120}data-no-avatar-click/);
    });

    test('picker row passes entityId (3rd arg) to renderAvatarHtml', () => {
        // so a live Pet/Dex companion descriptor renders, matching the button
        expect(chatHtml).toMatch(/renderAvatarHtml\(avatar,\s*28,\s*eid\)/);
    });

    test('entity-utils.js exclusion list includes the sendto picker', () => {
        expect(euSrc).toMatch(/closest\('\.sendto-picker-overlay'\)/);
    });
});
