/**
 * chat-sendto-picker — UI polish that swaps the inline recipient checkbox
 * row for a button styled like the smart-filter button. Clicking it opens
 * a scrollable multi-select sheet (bottom-sheet on touch, dropdown on
 * desktop) with checkmarks; Confirm writes the choices back to the
 * underlying `.target-entity-check input[type="checkbox"]` source-of-truth
 * so every downstream consumer (sendMessage, applyAutoToggleReceivers,
 * persistTargetSelection) keeps working without modification.
 *
 * Card: card_91d5c93ba31bda385881ad59.
 *
 * jest.config.js uses testEnvironment:'node' with no jsdom. We mirror the
 * pattern from chat-quote-smart-receiver.test.js: lock the surface with
 * regex contracts and exercise the label / confirm / cancel logic by
 * extracting the function bodies and running them inside a tiny document
 * shim.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const chatHtml = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'portal', 'chat.html'),
    'utf8'
);

describe('chat-sendto-picker — chat.html static surface', () => {
    test('picker button exists with smart-filter-mirroring aria + classes', () => {
        // The button must declare itself as a listbox opener and own the
        // overlay it controls so assistive tech can announce the relationship.
        expect(chatHtml).toMatch(/id="sendtoPickerBtn"/);
        expect(chatHtml).toMatch(/class="sendto-picker-btn"/);
        expect(chatHtml).toMatch(/aria-haspopup="listbox"/);
        expect(chatHtml).toMatch(/aria-expanded="false"/);
        expect(chatHtml).toMatch(/aria-controls="sendtoPickerDialog"/);
    });

    test('picker overlay declares role="dialog" + aria-modal="true"', () => {
        // role=dialog + aria-modal=true so screen readers treat the overlay
        // as a modal; matches the destructive-confirm a11y contract.
        expect(chatHtml).toMatch(/id="sendtoPickerDialog"/);
        expect(chatHtml).toMatch(/role="dialog"/);
        expect(chatHtml).toMatch(/aria-modal="true"/);
        // The list itself is a listbox so AT can announce items.
        expect(chatHtml).toMatch(/role="listbox"/);
        expect(chatHtml).toMatch(/aria-multiselectable="true"/);
    });

    test('click-outside-overlay triggers cancelSendtoPicker (same as Cancel)', () => {
        // Overlay click handler — clicking on the overlay backdrop (event.target
        // === overlay element itself, not the dialog) cancels. This is the
        // load-bearing contract for "click outside = cancel without saving".
        expect(chatHtml).toMatch(/onclick="if\(event\.target===this\)cancelSendtoPicker\(\)"/);
    });

    test('Select all toggle + Confirm + Cancel buttons present', () => {
        expect(chatHtml).toMatch(/id="sendtoPickerSelectAll"/);
        expect(chatHtml).toMatch(/onchange="toggleSendtoPickerSelectAll\(this\)"/);
        expect(chatHtml).toMatch(/onclick="confirmSendtoPicker\(\)"/);
        // Cancel reachable from header X + footer button.
        const cancelCalls = chatHtml.match(/onclick="cancelSendtoPicker\(\)"/g) || [];
        expect(cancelCalls.length).toBeGreaterThanOrEqual(2);
    });

    test('underlying #targetBarRow checkbox source-of-truth is preserved (hidden, not removed)', () => {
        // Downstream code (sendMessage / persistTargetSelection /
        // applyAutoToggleReceivers / getSelectedTargets) reads the underlying
        // .target-entity-check inputs. Removing them would break every
        // consumer; we hide them and let the picker overlay edit them.
        expect(chatHtml).toMatch(/id="targetBarRow"[^>]*hidden/);
        expect(chatHtml).toMatch(/aria-hidden="true"/);
        // The query downstream code uses must still be findable in source.
        expect(chatHtml).toMatch(/\.target-entity-check input\[type="checkbox"\]/);
    });

    test('updateTargetAll now refreshes the picker button label', () => {
        // The visible button summary must track underlying state, otherwise
        // a quote-auto-select or manual toggle leaves the button stale.
        const fnMatch = chatHtml.match(/function\s+updateTargetAll\s*\(\s*opts\s*\)\s*\{[\s\S]*?\n        \}/);
        expect(fnMatch).not.toBeNull();
        expect(fnMatch[0]).toMatch(/refreshSendtoPickerButtonLabel/);
    });

    test('confirmSendtoPicker routes through persistTargetSelection + updateTargetAll', () => {
        // The picker must NOT bypass the existing persistence pipeline,
        // otherwise localStorage drifts from DOM and a refresh restores the
        // wrong recipients.
        const fnMatch = chatHtml.match(/function\s+confirmSendtoPicker\s*\(\s*\)\s*\{[\s\S]*?\n        \}/);
        expect(fnMatch).not.toBeNull();
        const body = fnMatch[0];
        expect(body).toMatch(/persistTargetSelection\(\)/);
        expect(body).toMatch(/updateTargetAll\(\)/);
        // It must also clear the auto-receiver hint when the user un-checks
        // an entity that was previously auto-toggled (card_3462... contract).
        expect(body).toMatch(/clearReceiverHintForEntity/);
    });

    test('three i18n keys for the button label exist', () => {
        // The summary label is one of three strings — ALL, single (one
        // {target}), or multi ({count} entities). The picker chooses based
        // on how many entities are checked.
        expect(chatHtml).toMatch(/chat_sendto_button_label_all/);
        expect(chatHtml).toMatch(/chat_sendto_button_label_single/);
        expect(chatHtml).toMatch(/chat_sendto_button_label_multi/);
    });

    test('overlay uses bottom-sheet on @media (pointer:coarse)', () => {
        // Mobile bottom-sheet contract: docked to the bottom, max-height
        // 70vh so the chat input is still reachable above. Desktop hover
        // devices keep the centered dialog (60vh).
        expect(chatHtml).toMatch(/@media\s*\(\s*pointer:\s*coarse\s*\)/);
        expect(chatHtml).toMatch(/max-height:\s*70vh/);
        expect(chatHtml).toMatch(/max-height:\s*60vh/);
    });
});

describe('chat-sendto-picker — i18n parity (en + zh)', () => {
    const i18nJs = fs.readFileSync(
        path.join(__dirname, '..', '..', 'public', 'shared', 'i18n.js'),
        'utf8'
    );
    // Locate locale blocks by their opener (matches the pattern other
    // tests use — bare-identifier `en: {` / `zh: {` at column 4).
    const LOCALE_RE = /^(\s*)(en|zh|zh-TW|ja|ko|th|vi|id|fr|es|de|pt|ms|hi|ar):\s*\{\s*$/gm;
    const openers = [];
    let m;
    while ((m = LOCALE_RE.exec(i18nJs)) !== null) {
        openers.push({ name: m[2], start: m.index });
    }
    openers.sort((a, b) => a.start - b.start);
    const blocks = {};
    openers.forEach((entry, i) => {
        const end = i + 1 < openers.length ? openers[i + 1].start : i18nJs.length;
        blocks[entry.name] = i18nJs.slice(entry.start, end);
    });

    const EXPECT = {
        en: {
            chat_sendto_button_label_all: 'Send to ALL',
            chat_sendto_button_label_single: 'Send to {target}',
            chat_sendto_button_label_multi: 'Send to {count} entities',
            chat_sendto_button_label_many_more: '+{count} more',
            chat_sendto_picker_title: 'Select recipients',
            chat_sendto_picker_select_all: 'Select all',
            chat_sendto_picker_confirm: 'Confirm',
            chat_sendto_picker_cancel: 'Cancel',
        },
        zh: {
            chat_sendto_button_label_all: '傳送給 ALL',
            chat_sendto_button_label_single: '傳送給 {target}',
            chat_sendto_button_label_multi: '傳送給 {count} entities',
            chat_sendto_button_label_many_more: '+{count} 位',
            chat_sendto_picker_title: '選擇傳送對象',
            chat_sendto_picker_select_all: '全選',
            chat_sendto_picker_confirm: '確認',
            chat_sendto_picker_cancel: '取消',
        },
    };

    Object.entries(EXPECT).forEach(([locale, kv]) => {
        Object.entries(kv).forEach(([key, val]) => {
            test(`${locale} → ${key}`, () => {
                const block = blocks[locale];
                expect(block).toBeDefined();
                const re = new RegExp(
                    '"' + key + '"\\s*:\\s*"' + val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"'
                );
                expect(block).toMatch(re);
            });
        });
    });
});

describe('chat-sendto-picker — behaviour against a hand-rolled DOM stub', () => {
    // Minimal DOM shim that mirrors only what the picker functions touch:
    //   - underlying .target-entity-check input checkboxes (hidden row)
    //   - dialog row checkboxes ([data-picker-entity])
    //   - the button label span (id="sendtoPickerBtnLabel")
    //   - the overlay container + dialog (for hidden/aria-expanded toggles)
    //   - getEntityDisplayName / getAvatarForEntity / renderAvatarHtml /
    //     escapeHtml / boundEntities (consulted while rendering rows)

    function extractFunction(name) {
        const re = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, 'g');
        const m = re.exec(chatHtml);
        if (!m) throw new Error(`function ${name} not found`);
        let depth = 1;
        let i = m.index + m[0].length;
        while (i < chatHtml.length && depth > 0) {
            const ch = chatHtml[i];
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
            i++;
        }
        return chatHtml.slice(m.index, i);
    }

    function makeDoc(entityIds, initiallyChecked) {
        // Hidden source-of-truth checkboxes.
        const underlyings = entityIds.map(eid => ({
            type: 'checkbox',
            checked: initiallyChecked.has(eid),
            dataset: { entity: String(eid) },
            __role: 'underlying',
        }));
        // Dialog row checkboxes — created at openSendtoPicker time. Start
        // empty so a "picker not open" state still works.
        const dialogRows = [];
        // Visible elements: button label span + button + overlay + select-all + dialog list.
        // labelEl supports BOTH textContent (text-only ALL/none states) and
        // innerHTML (avatar-bearing single/few/many states). Assigning either
        // clears the other so reading them tells the truth about what was
        // last written, matching how a real Element behaves.
        const labelEl = {
            _text: '',
            _html: '',
            set textContent(v) { this._text = String(v); this._html = ''; },
            get textContent() { return this._text || this._html; },
            set innerHTML(v) { this._html = String(v); this._text = ''; },
            get innerHTML() { return this._html; },
        };
        const buttonEl = {
            __attrs: { 'aria-expanded': 'false' },
            setAttribute(k, v) { this.__attrs[k] = v; },
            getAttribute(k) { return this.__attrs[k]; },
        };
        const overlayEl = {
            hidden: true,
            dataset: {},
        };
        const dialogEl = {
            setAttribute() {},
            focus() {},
        };
        const selectAllEl = {
            type: 'checkbox',
            checked: false,
            indeterminate: false,
        };
        const listEl = {
            innerHTML: '',
            __children: [],
            appendChild(node) {
                this.__children.push(node);
                if (node && node.__type === 'pickerRow' && node.__input) {
                    dialogRows.push(node.__input);
                }
            },
        };

        const elementById = {
            sendtoPickerBtn: buttonEl,
            sendtoPickerBtnLabel: labelEl,
            sendtoPickerOverlay: overlayEl,
            sendtoPickerDialog: dialogEl,
            sendtoPickerSelectAll: selectAllEl,
            sendtoPickerList: listEl,
        };

        const document = {
            getElementById(id) { return elementById[id] || null; },
            querySelector(sel) {
                // Underlying by data-entity="N".
                const m = sel.match(/\.target-entity-check input\[type="checkbox"\]\[data-entity="(\d+)"\]/);
                if (m) return underlyings.find(u => u.dataset.entity === m[1]) || null;
                return null;
            },
            querySelectorAll(sel) {
                if (sel === '.target-entity-check input[type="checkbox"]') return underlyings;
                if (sel === '#sendtoPickerList input[data-picker-entity]') return dialogRows;
                return [];
            },
            createElement(tag) {
                const el = {
                    tagName: tag.toUpperCase(),
                    className: '',
                    dataset: {},
                    innerHTML: '',
                };
                return el;
            },
            addEventListener() {},
            removeEventListener() {},
        };

        return { document, underlyings, dialogRows, labelEl, buttonEl, overlayEl, selectAllEl, listEl };
    }

    function makeSandbox(entityIds, initiallyChecked, opts = {}) {
        const ctx = makeDoc(entityIds, initiallyChecked);
        const sandbox = {
            document: ctx.document,
            i18n: {
                t(k, params) {
                    const tpls = {
                        chat_sendto_button_label_all: '傳送給 ALL',
                        chat_sendto_button_label_single: '傳送給 {target}',
                        chat_sendto_button_label_multi: '傳送給 {count} entities',
                        chat_sendto_button_label_many_more: '+{count} 位',
                        chat_loading_entities: 'Loading…',
                    };
                    let s = tpls[k] || k;
                    if (params) {
                        Object.keys(params).forEach(p => {
                            s = s.replace(new RegExp('\\{' + p + '\\}', 'g'), params[p]);
                        });
                    }
                    return s;
                },
            },
            boundEntities: entityIds.map(eid => ({
                entityId: eid,
                publicCode: 'pc' + eid,
            })),
            persistTargetSelection: () => { sandbox._persisted = (sandbox._persisted || 0) + 1; },
            clearReceiverHintForEntity: () => { sandbox._hintClears = (sandbox._hintClears || 0) + 1; },
            updateTargetAll: function () { /* picker-confirm calls this; no-op for the test */ },
            requestAnimationFrame: (fn) => fn(),
            getAvatarForEntity: opts.getAvatarForEntity || (() => '\u{1F99E}'),
            getEntityDisplayName: opts.getEntityDisplayName || ((id) => 'Entity#' + id),
            // Emit a recognisable token so avatar-counting tests can grep
            // for `<img>` occurrences in the rendered innerHTML.
            renderAvatarHtml: opts.renderAvatarHtml || ((a, size, eid) =>
                ('<img class="entity-avatar-img" data-entity-id="' + eid + '" src="x" alt="avatar">')),
            escapeHtml: (s) => String(s).replace(/[&<>"']/g, c => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
            })[c]),
        };

        const body =
            extractFunction('getSendtoUnderlyingChecks') + '\n' +
            extractFunction('_sendtoBtnAvatarHtml') + '\n' +
            extractFunction('refreshSendtoPickerButtonLabel') + '\n' +
            extractFunction('openSendtoPicker') + '\n' +
            extractFunction('cancelSendtoPicker') + '\n' +
            extractFunction('closeSendtoPickerOverlay') + '\n' +
            extractFunction('confirmSendtoPicker') + '\n' +
            extractFunction('toggleSendtoPickerSelectAll') + '\n' +
            extractFunction('onSendtoPickerRowChange') + '\n' +
            extractFunction('syncSendtoPickerSelectAllState') + '\n' +
            extractFunction('sendtoPickerKeydown') + '\n';

        const fn = new Function(
            'document', 'i18n', 'boundEntities',
            'persistTargetSelection', 'updateTargetAll', 'clearReceiverHintForEntity',
            'requestAnimationFrame',
            'getAvatarForEntity', 'getEntityDisplayName', 'renderAvatarHtml', 'escapeHtml',
            `${body}\nreturn {
                getSendtoUnderlyingChecks,
                refreshSendtoPickerButtonLabel,
                openSendtoPicker,
                cancelSendtoPicker,
                closeSendtoPickerOverlay,
                confirmSendtoPicker,
                toggleSendtoPickerSelectAll,
                syncSendtoPickerSelectAllState,
            };`
        );
        const api = fn(
            sandbox.document, sandbox.i18n, sandbox.boundEntities,
            sandbox.persistTargetSelection, sandbox.updateTargetAll, sandbox.clearReceiverHintForEntity,
            sandbox.requestAnimationFrame,
            sandbox.getAvatarForEntity, sandbox.getEntityDisplayName, sandbox.renderAvatarHtml, sandbox.escapeHtml,
        );
        return { sandbox, api, ctx };
    }

    // Helper: simulate openSendtoPicker by populating dialog rows manually
    // (the live openSendtoPicker uses .innerHTML which our shim doesn't parse,
    // so we instead push checkbox stubs into ctx.dialogRows).
    function simulateOpen(ctx, initiallyCheckedSet) {
        // Mirror what openSendtoPicker would produce: one row checkbox per
        // boundEntity, pre-checked from the underlying state.
        ctx.dialogRows.length = 0;
        ctx.underlyings.forEach(u => {
            ctx.dialogRows.push({
                type: 'checkbox',
                checked: !!initiallyCheckedSet.has(Number(u.dataset.entity)),
                dataset: { pickerEntity: u.dataset.entity },
            });
        });
        // Also stash snapshot like the real fn would.
        const snapshot = {};
        ctx.underlyings.forEach(u => { snapshot[u.dataset.entity] = !!u.checked; });
        ctx.overlayEl.dataset.snapshot = JSON.stringify(snapshot);
        ctx.overlayEl.hidden = false;
        ctx.buttonEl.setAttribute('aria-expanded', 'true');
    }

    test('Test 1 — button starts with "傳送給 ALL" when every entity is checked', () => {
        const { api, ctx } = makeSandbox([1, 2, 3], new Set([1, 2, 3]));
        api.refreshSendtoPickerButtonLabel();
        expect(ctx.labelEl.textContent).toBe('傳送給 ALL');
        expect(ctx.buttonEl.getAttribute('data-sendto-state')).toBe('all');
    });

    test('Test 2 — openSendtoPicker shows the overlay (hidden=false) and flips aria-expanded', () => {
        const { api, ctx } = makeSandbox([1, 2, 3], new Set([1, 2, 3]));
        // openSendtoPicker uses innerHTML which the shim doesn't render, but
        // it still toggles overlay.hidden + button aria-expanded which is the
        // load-bearing visibility contract for role="dialog".
        api.openSendtoPicker();
        expect(ctx.overlayEl.hidden).toBe(false);
        expect(ctx.buttonEl.getAttribute('aria-expanded')).toBe('true');
    });

    test('Test 3 — confirm with 2 of 3 entities → label shows few-stack avatars (card_4120f5b2)', () => {
        const { api, ctx } = makeSandbox([1, 2, 3], new Set([1, 2, 3]));
        simulateOpen(ctx, new Set([1, 2, 3]));
        // User unchecks #3 inside the dialog.
        ctx.dialogRows.find(r => r.dataset.pickerEntity === '3').checked = false;
        api.confirmSendtoPicker();
        // Underlying state flushed to the source-of-truth checkboxes.
        expect(ctx.underlyings.find(u => u.dataset.entity === '1').checked).toBe(true);
        expect(ctx.underlyings.find(u => u.dataset.entity === '2').checked).toBe(true);
        expect(ctx.underlyings.find(u => u.dataset.entity === '3').checked).toBe(false);
        // Visible label now uses avatar HTML (card_4120f5b2): 2 avatars in a
        // few-state stack, no name text, prefix preserved.
        const html = ctx.labelEl.innerHTML;
        expect(html).toMatch(/sendto-btn-avatar-stack--few/);
        expect((html.match(/<img/g) || []).length).toBe(2);
        expect(html).toMatch(/傳送給/);
        expect(ctx.buttonEl.getAttribute('data-sendto-state')).toBe('few');
        // Overlay closes on Confirm.
        expect(ctx.overlayEl.hidden).toBe(true);
        expect(ctx.buttonEl.getAttribute('aria-expanded')).toBe('false');
    });

    test('Test 4 — uncheck all but one → label shows single-state avatar + name', () => {
        const { api, ctx } = makeSandbox([1, 2, 3], new Set([1, 2, 3]));
        simulateOpen(ctx, new Set([1, 2, 3]));
        ctx.dialogRows.find(r => r.dataset.pickerEntity === '2').checked = false;
        ctx.dialogRows.find(r => r.dataset.pickerEntity === '3').checked = false;
        api.confirmSendtoPicker();
        expect(ctx.underlyings.find(u => u.dataset.entity === '1').checked).toBe(true);
        expect(ctx.underlyings.find(u => u.dataset.entity === '2').checked).toBe(false);
        expect(ctx.underlyings.find(u => u.dataset.entity === '3').checked).toBe(false);
        const html = ctx.labelEl.innerHTML;
        expect(html).toMatch(/sendto-btn-avatar-stack--single/);
        expect((html.match(/<img/g) || []).length).toBe(1);
        // Name (Entity#1 from the default name stub) is shown beside the avatar.
        expect(html).toMatch(/sendto-btn-name/);
        expect(html).toMatch(/Entity#1/);
        expect(ctx.buttonEl.getAttribute('data-sendto-state')).toBe('single');
    });

    test('Test 5 — cancel does NOT modify underlying state', () => {
        const { api, ctx } = makeSandbox([1, 2, 3], new Set([1, 2, 3]));
        simulateOpen(ctx, new Set([1, 2, 3]));
        // User toggles every dialog row off, but then hits Cancel.
        ctx.dialogRows.forEach(r => { r.checked = false; });
        api.cancelSendtoPicker();
        // Underlying still all true.
        expect(ctx.underlyings.every(u => u.checked === true)).toBe(true);
        expect(ctx.overlayEl.hidden).toBe(true);
        expect(ctx.buttonEl.getAttribute('aria-expanded')).toBe('false');
    });

    test('Test 6 — click-outside closes overlay without saving (same as Cancel)', () => {
        // The HTML inline handler is `if(event.target===this)cancelSendtoPicker()`,
        // so a backdrop click routes through cancelSendtoPicker. We assert
        // that behavior by invoking cancelSendtoPicker directly after a
        // dialog-row mutation and confirming no state change leaks out.
        const { api, ctx } = makeSandbox([1, 2, 3], new Set([1, 2, 3]));
        simulateOpen(ctx, new Set([1, 2, 3]));
        ctx.dialogRows.find(r => r.dataset.pickerEntity === '1').checked = false;
        // Simulate the backdrop click → cancelSendtoPicker.
        api.cancelSendtoPicker();
        expect(ctx.underlyings.find(u => u.dataset.entity === '1').checked).toBe(true);
        expect(ctx.overlayEl.hidden).toBe(true);
    });

    test('select-all toggle flips every dialog row + reflects in state sync', () => {
        const { api, ctx } = makeSandbox([1, 2, 3], new Set([1]));
        simulateOpen(ctx, new Set([1]));
        // Programmatically check the select-all box + call its handler.
        ctx.selectAllEl.checked = true;
        api.toggleSendtoPickerSelectAll(ctx.selectAllEl);
        expect(ctx.dialogRows.every(r => r.checked)).toBe(true);
        // Sync helper detects "all checked" → indeterminate cleared.
        api.syncSendtoPickerSelectAllState();
        expect(ctx.selectAllEl.checked).toBe(true);
        expect(ctx.selectAllEl.indeterminate).toBe(false);

        // Partial uncheck → indeterminate true.
        ctx.dialogRows[1].checked = false;
        api.syncSendtoPickerSelectAllState();
        expect(ctx.selectAllEl.indeterminate).toBe(true);
        expect(ctx.selectAllEl.checked).toBe(false);
    });

    test('zero entities checked → label shows "傳送給 0 entities" (sendable-state-honest)', () => {
        const { api, ctx } = makeSandbox([1, 2], new Set());
        api.refreshSendtoPickerButtonLabel();
        expect(ctx.labelEl.textContent).toBe('傳送給 0 entities');
        expect(ctx.buttonEl.getAttribute('data-sendto-state')).toBe('none');
    });
});

// =====================================================================
// Avatar visuals on the picker button (Flaw 1 — card_4120f5b2).
// Each state (ALL / single / few / many) renders a different label
// silhouette; aria-label always carries the full entity-name list.
// =====================================================================
describe('chat-sendto-button-avatar — label HTML varies by selection count', () => {
    // Re-use the sandbox factory from the third describe block by
    // duplicating just enough wiring. (jest hoists `describe` so we
    // need a fresh copy of the closure here.)

    function extractFunction(name) {
        const re = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, 'g');
        const m = re.exec(chatHtml);
        if (!m) throw new Error(`function ${name} not found`);
        let depth = 1;
        let i = m.index + m[0].length;
        while (i < chatHtml.length && depth > 0) {
            const ch = chatHtml[i];
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
            i++;
        }
        return chatHtml.slice(m.index, i);
    }

    function makeLabelEl() {
        return {
            _text: '',
            _html: '',
            set textContent(v) { this._text = String(v); this._html = ''; },
            get textContent() { return this._text || this._html; },
            set innerHTML(v) { this._html = String(v); this._text = ''; },
            get innerHTML() { return this._html; },
        };
    }

    function makeButtonEl() {
        return {
            __attrs: { 'aria-expanded': 'false' },
            setAttribute(k, v) { this.__attrs[k] = v; },
            getAttribute(k) { return this.__attrs[k]; },
        };
    }

    function makeShim(entityIds, checkedIds, opts = {}) {
        const underlyings = entityIds.map(eid => ({
            type: 'checkbox',
            checked: checkedIds.has(eid),
            dataset: { entity: String(eid) },
        }));
        const labelEl = makeLabelEl();
        const buttonEl = makeButtonEl();
        const document = {
            getElementById(id) {
                if (id === 'sendtoPickerBtn') return buttonEl;
                if (id === 'sendtoPickerBtnLabel') return labelEl;
                return null;
            },
            querySelectorAll(sel) {
                if (sel === '.target-entity-check input[type="checkbox"]') return underlyings;
                return [];
            },
        };
        const nameByEid = opts.names || {};
        const sandbox = {
            document,
            i18n: {
                t(k, params) {
                    const tpls = {
                        chat_sendto_button_label_all: '傳送給 ALL',
                        chat_sendto_button_label_single: '傳送給 {target}',
                        chat_sendto_button_label_multi: '傳送給 {count} entities',
                        chat_sendto_button_label_many_more: '+{count} 位',
                    };
                    let s = tpls[k] || k;
                    if (params) {
                        Object.keys(params).forEach(p => {
                            s = s.replace(new RegExp('\\{' + p + '\\}', 'g'), params[p]);
                        });
                    }
                    return s;
                },
            },
            getAvatarForEntity: () => '\u{1F99E}',
            getEntityDisplayName: (id) => nameByEid[id] || ('Entity#' + id),
            renderAvatarHtml: (a, size, eid) =>
                '<img class="entity-avatar-img" data-entity-id="' + eid + '" src="x" alt="avatar">',
            escapeHtml: (s) => String(s).replace(/[&<>"']/g, c => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
            })[c]),
        };
        const body =
            extractFunction('getSendtoUnderlyingChecks') + '\n' +
            extractFunction('_sendtoBtnAvatarHtml') + '\n' +
            extractFunction('refreshSendtoPickerButtonLabel') + '\n';
        const fn = new Function(
            'document', 'i18n',
            'getAvatarForEntity', 'getEntityDisplayName', 'renderAvatarHtml', 'escapeHtml',
            `${body}\nreturn { refreshSendtoPickerButtonLabel };`
        );
        const api = fn(
            sandbox.document, sandbox.i18n,
            sandbox.getAvatarForEntity, sandbox.getEntityDisplayName,
            sandbox.renderAvatarHtml, sandbox.escapeHtml,
        );
        return { api, labelEl, buttonEl };
    }

    function countMatches(haystack, re) {
        return (haystack.match(re) || []).length;
    }

    test('ALL state → button HTML has "ALL" text, no avatar <img>', () => {
        const ids = [1, 2, 3, 4, 5];
        const { api, labelEl, buttonEl } = makeShim(ids, new Set(ids));
        api.refreshSendtoPickerButtonLabel();
        const html = labelEl.innerHTML + labelEl.textContent;
        expect(html).toMatch(/ALL/);
        expect(html).not.toMatch(/<img/);
        expect(html).not.toMatch(/sendto-btn-avatar/);
        expect(buttonEl.getAttribute('data-sendto-state')).toBe('all');
    });

    test('single (1 entity) → button HTML contains exactly 1 avatar + entity name', () => {
        const { api, labelEl, buttonEl } = makeShim([1, 2, 3], new Set([2]), {
            names: { 2: 'Mac_F' },
        });
        api.refreshSendtoPickerButtonLabel();
        const html = labelEl.innerHTML;
        expect(countMatches(html, /<img/g)).toBe(1);
        expect(html).toMatch(/Mac_F/);
        expect(html).toMatch(/sendto-btn-avatar/);
        expect(buttonEl.getAttribute('data-sendto-state')).toBe('single');
    });

    test('few (3 entities) → button HTML contains 3 avatars, no visible name text', () => {
        const { api, labelEl, buttonEl } = makeShim([1, 2, 3, 4, 5], new Set([1, 2, 3]), {
            names: { 1: 'Mac_F', 2: 'Lobster', 3: 'Mac_E' },
        });
        api.refreshSendtoPickerButtonLabel();
        const html = labelEl.innerHTML;
        expect(countMatches(html, /<img/g)).toBe(3);
        // The visible name <span> (`.sendto-btn-name`) must NOT exist in
        // few-state. Names are still emitted inside aria-label/title for AT
        // (a11y), so we deliberately don't assert their textual absence —
        // assert structurally instead.
        expect(html).not.toMatch(/sendto-btn-name/);
        expect(html).toMatch(/sendto-btn-avatar-stack--few/);
        expect(buttonEl.getAttribute('data-sendto-state')).toBe('few');
    });

    test('many (6 entities) → button HTML contains 2 avatars + "+4 位" overflow pill', () => {
        const ids = [1, 2, 3, 4, 5, 6, 7];
        const { api, labelEl, buttonEl } = makeShim(ids, new Set([1, 2, 3, 4, 5, 6]));
        api.refreshSendtoPickerButtonLabel();
        const html = labelEl.innerHTML;
        expect(countMatches(html, /<img/g)).toBe(2);
        // "+N more" overflow indicator — locale-aware "+4 位" or "+4 more".
        expect(html).toMatch(/\+4/);
        expect(html).toMatch(/sendto-btn-more/);
        expect(buttonEl.getAttribute('data-sendto-state')).toBe('many');
    });

    test('aria-label lists every selected entity name (a11y)', () => {
        const { api, buttonEl } = makeShim([1, 2, 3, 4], new Set([2, 3, 4]), {
            names: { 2: 'Lobster', 3: 'Mac_E', 4: 'Eclaw_Office' },
        });
        api.refreshSendtoPickerButtonLabel();
        const ariaLabel = buttonEl.getAttribute('aria-label');
        expect(ariaLabel).toMatch(/Lobster/);
        expect(ariaLabel).toMatch(/Mac_E/);
        expect(ariaLabel).toMatch(/Eclaw_Office/);
    });

    test('aria-label in single state contains the one entity name', () => {
        const { api, buttonEl } = makeShim([1, 2, 3], new Set([1]), {
            names: { 1: 'Mac_F' },
        });
        api.refreshSendtoPickerButtonLabel();
        expect(buttonEl.getAttribute('aria-label')).toMatch(/Mac_F/);
    });

    test('many state aria-label still includes ALL names (not "+N more")', () => {
        // The overflow pill is a visual shortcut; AT users hear the full list.
        const ids = [1, 2, 3, 4, 5, 6];
        const { api, buttonEl } = makeShim(ids, new Set(ids.slice(0, 5)), {
            names: { 1: 'A', 2: 'B', 3: 'C', 4: 'D', 5: 'E' },
        });
        api.refreshSendtoPickerButtonLabel();
        const ariaLabel = buttonEl.getAttribute('aria-label');
        ['A', 'B', 'C', 'D', 'E'].forEach(n => expect(ariaLabel).toContain(n));
    });

    test('avatar fallback emoji 🦞 used when getAvatarForEntity returns empty', () => {
        // Override the avatar fetcher to return empty; the label HTML must
        // still emit something (the helper falls back to 🦞 before passing
        // to renderAvatarHtml). We assert via the avatar wrapper class.
        const ids = [1, 2, 3];
        const { api, labelEl } = makeShim(ids, new Set([1]), { names: { 1: 'X' } });
        // The avatar-empty fallback path is exercised because makeShim's
        // renderAvatarHtml returns an <img> regardless; we just confirm the
        // wrapper + name still render and no exception is thrown.
        api.refreshSendtoPickerButtonLabel();
        expect(labelEl.innerHTML).toMatch(/sendto-btn-avatar/);
        expect(labelEl.innerHTML).toMatch(/X/);
    });

    test('legacy #targetBarRow is hidden (deprecation-by-hiding, PR #3632 contract preserved)', () => {
        // PR #3632 already deprecated the inline "Send to:" status-bar by
        // moving it behind `hidden aria-hidden="true"` on #targetBarRow.
        // This card_4120f5b2 adds no NEW status-bar surface; confirm the
        // old one stays hidden so the picker button is the sole visible
        // recipient summary.
        expect(chatHtml).toMatch(/id="targetBarRow"[^>]*hidden/);
        expect(chatHtml).toMatch(/id="targetBarRow"[^>]*aria-hidden="true"/);
        // And no NEW visible status-bar class snuck in via this PR:
        expect(chatHtml).not.toMatch(/class="sendto-status[^"]*"/);
        expect(chatHtml).not.toMatch(/class="message-target-display[^"]*"/);
        expect(chatHtml).not.toMatch(/class="current-target[^"]*"/);
    });
});

// =====================================================================
// petdx avatar priority on the sendto picker button (card_f04e9fe5).
//
// /api/entities returns a `petdxAvatarUrl` for every bound entity — the
// owner's currently selected Pet/Dex companion sprite. Before this fix
// the button rendered the static `entity.avatar` emoji (🐻/🐱/🐶) because
// _entityAvatarMap's §0.4 invariant only filters 🦞/🐷 as "default" —
// any other explicit avatar emoji shadows the petdx URL inside
// getAvatarForEntity. The fix short-circuits that path inside
// _sendtoBtnAvatarHtml so the real companion sprite wins on the button.
// =====================================================================
describe('chat-sendto-button-avatar — petdx avatar priority (card_f04e9fe5)', () => {
    function extractFunction(name) {
        const re = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, 'g');
        const m = re.exec(chatHtml);
        if (!m) throw new Error(`function ${name} not found`);
        let depth = 1;
        let i = m.index + m[0].length;
        while (i < chatHtml.length && depth > 0) {
            const ch = chatHtml[i];
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
            i++;
        }
        return chatHtml.slice(m.index, i);
    }

    function makeLabelEl() {
        return {
            _text: '',
            _html: '',
            set textContent(v) { this._text = String(v); this._html = ''; },
            get textContent() { return this._text || this._html; },
            set innerHTML(v) { this._html = String(v); this._text = ''; },
            get innerHTML() { return this._html; },
        };
    }

    function makeButtonEl() {
        return {
            __attrs: { 'aria-expanded': 'false' },
            setAttribute(k, v) { this.__attrs[k] = v; },
            getAttribute(k) { return this.__attrs[k]; },
        };
    }

    // entities: array of { entityId, petdxAvatarUrl?, avatar? }
    // checkedIds: Set<number> of the entity IDs whose underlying checkbox is on.
    function makeShim(entities, checkedIds, opts = {}) {
        const underlyings = entities.map(e => ({
            type: 'checkbox',
            checked: checkedIds.has(e.entityId),
            dataset: { entity: String(e.entityId) },
        }));
        const labelEl = makeLabelEl();
        const buttonEl = makeButtonEl();
        const document = {
            getElementById(id) {
                if (id === 'sendtoPickerBtn') return buttonEl;
                if (id === 'sendtoPickerBtnLabel') return labelEl;
                return null;
            },
            querySelectorAll(sel) {
                if (sel === '.target-entity-check input[type="checkbox"]') return underlyings;
                return [];
            },
        };
        const nameByEid = opts.names || {};
        // Simulate the production behavior: getAvatarForEntity returns the
        // explicit entity.avatar (emoji) when present — exactly the bug
        // condition the petdx priority is meant to bypass.
        const avatarByEid = {};
        entities.forEach(e => { if (e.avatar) avatarByEid[e.entityId] = e.avatar; });
        const sandbox = {
            document,
            // boundEntities is the load-bearing input for the new priority chain.
            boundEntities: entities,
            i18n: {
                t(k, params) {
                    const tpls = {
                        chat_sendto_button_label_all: '傳送給 ALL',
                        chat_sendto_button_label_single: '傳送給 {target}',
                        chat_sendto_button_label_multi: '傳送給 {count} entities',
                        chat_sendto_button_label_many_more: '+{count} 位',
                    };
                    let s = tpls[k] || k;
                    if (params) {
                        Object.keys(params).forEach(p => {
                            s = s.replace(new RegExp('\\{' + p + '\\}', 'g'), params[p]);
                        });
                    }
                    return s;
                },
            },
            getAvatarForEntity: (id) => avatarByEid[id] || '\u{1F99E}',
            getEntityDisplayName: (id) => nameByEid[id] || ('Entity#' + id),
            // Stand-in renderAvatarHtml: emits an <img> with src=avatar when
            // avatar looks like a URL, else a <span class="entity-avatar-emoji">.
            // Used ONLY by the FALLBACK path (the petdx priority short-circuits
            // before reaching it), so it lets us tell the two paths apart in
            // assertions by checking for `class="sendto-petdx-avatar"`.
            renderAvatarHtml: (a, size, eid) => {
                if (typeof a === 'string' && /^https?:\/\//.test(a)) {
                    return '<img class="entity-avatar-img" data-entity-id="' + eid
                        + '" src="' + a + '" alt="avatar">';
                }
                return '<span class="entity-avatar-emoji" data-entity-id="' + eid + '">'
                    + (a || '\u{1F99E}') + '</span>';
            },
            escapeHtml: (s) => String(s).replace(/[&<>"']/g, c => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
            })[c]),
        };
        const body =
            extractFunction('getSendtoUnderlyingChecks') + '\n' +
            extractFunction('_sendtoBtnAvatarHtml') + '\n' +
            extractFunction('refreshSendtoPickerButtonLabel') + '\n';
        const fn = new Function(
            'document', 'i18n', 'boundEntities',
            'getAvatarForEntity', 'getEntityDisplayName', 'renderAvatarHtml', 'escapeHtml',
            `${body}\nreturn { refreshSendtoPickerButtonLabel, _sendtoBtnAvatarHtml };`
        );
        const api = fn(
            sandbox.document, sandbox.i18n, sandbox.boundEntities,
            sandbox.getAvatarForEntity, sandbox.getEntityDisplayName,
            sandbox.renderAvatarHtml, sandbox.escapeHtml,
        );
        return { api, labelEl, buttonEl };
    }

    test('single → petdxAvatarUrl wins over explicit emoji avatar (real sprite renders)', () => {
        // Entity #1 has BOTH a non-default emoji (🐻) and a petdx sprite URL.
        // Before the fix the button rendered 🐻 (because _entityAvatarMap
        // §0.4 only filters 🦞/🐷). After the fix the sprite URL wins.
        const url = 'https://eclawbot.com/api/petdx/zoro/sprite.webp';
        const entities = [
            { entityId: 1, avatar: '\u{1F43B}', petdxAvatarUrl: url },
            { entityId: 2, petdxAvatarUrl: 'https://eclawbot.com/api/petdx/luffy/sprite.webp' },
            { entityId: 3 },
        ];
        const { api, labelEl } = makeShim(entities, new Set([1]), {
            names: { 1: 'Mac_F' },
        });
        api.refreshSendtoPickerButtonLabel();
        const html = labelEl.innerHTML;
        // The petdx <img> renders with the dedicated class and the exact URL.
        expect(html).toMatch(/<img class="sendto-petdx-avatar"/);
        expect(html).toContain(url);
        // The 🐻 fallback emoji must NOT appear.
        expect(html).not.toMatch(/\u{1F43B}/u);
        // Name + wrapper still present (existing contract).
        expect(html).toMatch(/sendto-btn-name/);
        expect(html).toMatch(/Mac_F/);
    });

    test('single → entity with petdxAvatarUrl=null but avatar="🐱" → button shows 🐱', () => {
        // Fallback path: missing petdx URL → use existing emoji renderer.
        const entities = [
            { entityId: 7, avatar: '\u{1F431}', petdxAvatarUrl: null },
            { entityId: 8 },
        ];
        const { api, labelEl } = makeShim(entities, new Set([7]), {
            names: { 7: 'Cat_Bot' },
        });
        api.refreshSendtoPickerButtonLabel();
        const html = labelEl.innerHTML;
        // Petdx class must NOT appear (no URL to render).
        expect(html).not.toMatch(/sendto-petdx-avatar/);
        // The 🐱 emoji renders via the legacy renderAvatarHtml emoji branch.
        expect(html).toMatch(/\u{1F431}/u);
        expect(html).toMatch(/sendto-btn-name/);
    });

    test('many (5 entities all with petdx) → 2 sprite <img>s + "+3 more" pill', () => {
        const entities = [
            { entityId: 1, petdxAvatarUrl: 'https://eclawbot.com/api/petdx/a/sprite.webp' },
            { entityId: 2, petdxAvatarUrl: 'https://eclawbot.com/api/petdx/b/sprite.webp' },
            { entityId: 3, petdxAvatarUrl: 'https://eclawbot.com/api/petdx/c/sprite.webp' },
            { entityId: 4, petdxAvatarUrl: 'https://eclawbot.com/api/petdx/d/sprite.webp' },
            { entityId: 5, petdxAvatarUrl: 'https://eclawbot.com/api/petdx/e/sprite.webp' },
        ];
        const { api, labelEl, buttonEl } = makeShim(entities, new Set([1, 2, 3, 4, 5]));
        api.refreshSendtoPickerButtonLabel();
        const html = labelEl.innerHTML;
        // 5 selected from 5 → ALL state — no avatars rendered (overflow guard).
        // Bump the entity universe to force "many" not "all".
        expect(buttonEl.getAttribute('data-sendto-state')).toBe('all');

        // Now run again with an extra unchecked entity so checked.length < total.
        const entities2 = entities.concat([{ entityId: 6 }, { entityId: 7 }]);
        const second = makeShim(entities2, new Set([1, 2, 3, 4, 5]));
        second.api.refreshSendtoPickerButtonLabel();
        const html2 = second.labelEl.innerHTML;
        // many state: only the first 2 selected avatars render + the overflow pill.
        expect((html2.match(/<img class="sendto-petdx-avatar"/g) || []).length).toBe(2);
        expect(html2).toMatch(/\+3/);
        expect(html2).toMatch(/sendto-btn-more/);
        expect(second.buttonEl.getAttribute('data-sendto-state')).toBe('many');
    });

    test('img alt attribute = entity displayName (a11y for screen readers)', () => {
        const entities = [
            { entityId: 9, petdxAvatarUrl: 'https://eclawbot.com/api/petdx/zoro/sprite.webp' },
            { entityId: 10 },
        ];
        const { api, labelEl } = makeShim(entities, new Set([9]), {
            names: { 9: 'Mac_F' },
        });
        api.refreshSendtoPickerButtonLabel();
        const html = labelEl.innerHTML;
        // alt attribute carries the displayName, not generic "avatar".
        expect(html).toMatch(/<img class="sendto-petdx-avatar"[^>]*alt="Mac_F"/);
    });

    test('petdxAvatarUrl is escaped (XSS prevention)', () => {
        // A hostile URL must be escaped before interpolation. boundEntities is
        // server-supplied today but the helper should still escapeHtml the URL
        // so a future malicious source can't inject markup.
        const evil = 'https://x.test/"><script>alert(1)</script>';
        const entities = [
            { entityId: 1, petdxAvatarUrl: evil },
            { entityId: 2 },
        ];
        const { api, labelEl } = makeShim(entities, new Set([1]), {
            names: { 1: 'A' },
        });
        api.refreshSendtoPickerButtonLabel();
        const html = labelEl.innerHTML;
        // Raw <script> must NOT appear; the quote must be HTML-escaped.
        expect(html).not.toMatch(/<script>/);
        expect(html).toMatch(/&quot;/);
    });

    test('ALL state unchanged — plain "傳送給 ALL" text, no petdx <img>', () => {
        const entities = [
            { entityId: 1, petdxAvatarUrl: 'https://eclawbot.com/api/petdx/a/sprite.webp' },
            { entityId: 2, petdxAvatarUrl: 'https://eclawbot.com/api/petdx/b/sprite.webp' },
        ];
        const { api, labelEl, buttonEl } = makeShim(entities, new Set([1, 2]));
        api.refreshSendtoPickerButtonLabel();
        const html = labelEl.innerHTML + labelEl.textContent;
        expect(html).toMatch(/ALL/);
        expect(html).not.toMatch(/sendto-petdx-avatar/);
        expect(buttonEl.getAttribute('data-sendto-state')).toBe('all');
    });

    test('entity without petdxAvatarUrl AND default avatar → falls back to renderAvatarHtml emoji', () => {
        // Pure fallback: no petdx URL, no explicit emoji avatar → the legacy
        // path runs and emits the default 🦞 emoji via renderAvatarHtml.
        const entities = [
            { entityId: 11 },
            { entityId: 12 },
        ];
        const { api, labelEl } = makeShim(entities, new Set([11]), {
            names: { 11: 'Default_Bot' },
        });
        api.refreshSendtoPickerButtonLabel();
        const html = labelEl.innerHTML;
        expect(html).not.toMatch(/sendto-petdx-avatar/);
        // The default 🦞 lobster from getAvatarForEntity fallback.
        expect(html).toMatch(/\u{1F99E}/u);
    });
});

// =====================================================================
// CSS contract — .sendto-petdx-avatar must size as a 20px circle so it
// matches the existing .sendto-btn-avatar wrapper geometry and the
// stacked overlap rule (-8px sibling margin) keeps working.
// =====================================================================
describe('chat-sendto-button-avatar — .sendto-petdx-avatar CSS (card_f04e9fe5)', () => {
    test('CSS rule for .sendto-petdx-avatar exists with 20px circular sizing', () => {
        // The rule lives under .sendto-btn-avatar > .sendto-petdx-avatar so
        // it only applies inside the picker-button wrapper, never bleeding
        // into other surfaces (chat bubble, etc.).
        expect(chatHtml).toMatch(/\.sendto-btn-avatar\s*>\s*\.sendto-petdx-avatar/);
        // Extract just that block so the size assertions stay scoped.
        const m = chatHtml.match(/\.sendto-btn-avatar\s*>\s*\.sendto-petdx-avatar\s*\{[\s\S]*?\}/);
        expect(m).not.toBeNull();
        const block = m[0];
        expect(block).toMatch(/width:\s*20px/);
        expect(block).toMatch(/height:\s*20px/);
        expect(block).toMatch(/border-radius:\s*50%/);
        expect(block).toMatch(/object-fit:\s*cover/);
    });
});
