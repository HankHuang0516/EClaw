/**
 * Static invariant + behavioural test for the chat quote-reply smart
 * receiver auto-select feature.
 *
 * Card: card_5ff6515064f18e25295a5a14.
 * Spec: when the user quote-replies in chat.html, receiver checkbox(es)
 * are auto-prefilled based on the source of the quoted context:
 *   - Quote from a kanban card → assignedBots are toggled on
 *   - Quote from a chat msg sent by an entity → sender entity toggled on
 *   - Quote from a system / web_chat msg → no auto-toggle
 *   - Multi-source: chat-entity wins over card
 *   - Auto-toggled chips show a 「auto」 hint badge; manual uncheck removes
 *     the badge for the receiver that was unchecked
 *
 * jest.config.js uses testEnvironment: 'node' with no jsdom, so we mirror
 * the pattern used in filter-summary-invariant.test.js: lock the surface
 * with regex contracts against the live source, and exercise the auto-
 * toggle logic by extracting its body and running it against a hand-rolled
 * DOM stub. Any future edit that drifts away from the contract leaves a
 * regression fingerprint here.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const chatHtml = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'portal', 'chat.html'),
    'utf8'
);
const kanbanHtml = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'portal', 'kanban.html'),
    'utf8'
);
const i18nJs = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'shared', 'i18n.js'),
    'utf8'
);

describe('chat quote-reply smart receiver — chat.html surface', () => {
    test('quoteToChat accepts a 4th meta arg', () => {
        expect(chatHtml).toMatch(
            /function\s+quoteToChat\s*\(\s*source\s*,\s*title\s*,\s*excerpt\s*,\s*meta\s*\)/
        );
    });

    test('entityIdsFromMeta dispatches on meta.kind for card / chat-entity', () => {
        // Multi-quote refactor: the single-state applyAutoToggleReceivers(meta)
        // was split into the pure dispatcher entityIdsFromMeta(meta) +
        // recomputeAutoReceivers() which unions over replyContexts[].
        expect(chatHtml).toMatch(/function\s+entityIdsFromMeta\s*\(\s*meta\s*\)/);
        expect(chatHtml).toMatch(/function\s+recomputeAutoReceivers\s*\(\s*\)/);
        // Both code paths must be present so neither rule silently drops
        // (a regex match keeps both branches honest).
        expect(chatHtml).toMatch(/meta\.kind\s*===\s*['"]chat-entity['"]/);
        expect(chatHtml).toMatch(/meta\.kind\s*===\s*['"]card['"]/);
        expect(chatHtml).toMatch(/meta\.cardAssignedBots/);
    });

    test('hint badge is rendered with .receiver-hint-auto + data-i18n="chat_receiver_hint_auto"', () => {
        expect(chatHtml).toMatch(/badge\.className\s*=\s*['"]receiver-hint-auto['"]/);
        expect(chatHtml).toMatch(/badge\.setAttribute\(\s*['"]data-i18n['"]\s*,\s*['"]chat_receiver_hint_auto['"]\s*\)/);
        // The badge must hang off the entity checkbox container so it
        // travels with the chip when the target bar re-renders.
        expect(chatHtml).toMatch(/label\.appendChild\(\s*badge\s*\)/);
    });

    test('reply button on chat bubbles carries data-receiver-kind + data-receiver-entity-id', () => {
        expect(chatHtml).toMatch(/data-receiver-kind="\$\{receiverKind\}"/);
        expect(chatHtml).toMatch(/data-receiver-entity-id="\$\{msg\.entity_id\}"/);
        // The kind must split sent / platform / entity so self+system
        // messages cannot accidentally toggle a receiver.
        expect(chatHtml).toMatch(/isSent\s*\?\s*['"]self['"]/);
        expect(chatHtml).toMatch(/isPlatform\s*\?\s*['"]system['"]/);
    });

    test('handleReplyBtn forwards receiver-kind/receiver-entity-id into meta', () => {
        expect(chatHtml).toMatch(/btn\.dataset\.receiverKind/);
        expect(chatHtml).toMatch(/btn\.dataset\.receiverEntityId/);
        expect(chatHtml).toMatch(
            /kind\s*===\s*['"]entity['"]\s*&&\s*Number\.isFinite\(\s*entityId\s*\)/
        );
        // chat-entity is what applyAutoToggleReceivers branches on, so the
        // mapping reply-btn-kind:'entity' → meta.kind:'chat-entity' is the
        // load-bearing contract.
        expect(chatHtml).toMatch(/kind:\s*['"]chat-entity['"]/);
        expect(chatHtml).toMatch(/kind:\s*['"]chat-system['"]/);
    });

    test('localStorage and cross-iframe pickup forward the meta param', () => {
        // pending_quote pickup at first-load — prefillInput intentionally dropped per PR #3263 smart-quote sink fix
        expect(chatHtml).toMatch(
            /const\s*\{\s*source,\s*title,\s*excerpt,\s*messageId,\s*meta,\s*ts\s*\}\s*=\s*JSON\.parse\(pq\)/
        );
        // meta is forwarded; when the producer omits it we derive the sender
        // from the deep-linked message (card_3462... fix).
        expect(chatHtml).toMatch(/quoteToChat\(\s*source,\s*title,\s*excerpt\s*\|\|\s*['"]['"]\s*,\s*meta\s*\|\|\s*receiverMetaFromMessageId\(messageId\)\s*\)/);
        // workspace.html postMessage relay — same intentional drop
        expect(chatHtml).toMatch(
            /const\s*\{\s*source,\s*title,\s*excerpt,\s*messageId,\s*meta\s*\}\s*=\s*e\.data/
        );
        // Regression guard: prefillInput must NOT reappear in either destructure
        expect(chatHtml).not.toMatch(/prefillInput,\s*messageId,\s*meta,\s*ts\s*\}\s*=\s*JSON\.parse\(pq\)/);
        expect(chatHtml).not.toMatch(/prefillInput,\s*messageId,\s*meta\s*\}\s*=\s*e\.data/);
    });

    // card_3462117951fa588df9ff8a95 — the canvas/native nav-intent quote path
    // dropped the receiver meta, so a quote of #6 fell back to the residual
    // selection (#1). It must now derive the sender from the deep-linked msg.
    test('native nav-intent quote derives receiver meta from the deep-linked message', () => {
        // helper resolves a bot sender → { kind:'chat-entity', entityId }
        expect(chatHtml).toMatch(/function\s+receiverMetaFromMessageId\s*\(\s*messageId\s*\)/);
        expect(chatHtml).toMatch(/m\.is_from_bot\s*===\s*true/);
        expect(chatHtml).toMatch(/return\s*\{\s*kind:\s*['"]chat-entity['"]\s*,\s*entityId:\s*Number\(m\.entity_id\)\s*\}/);
        // eclawHandleNativeNavigateIntent wires it in (was bare quoteToChat w/o meta)
        expect(chatHtml).toMatch(/const\s+qMeta\s*=\s*quote\.meta\s*\|\|\s*receiverMetaFromMessageId\(msgId\)/);
        expect(chatHtml).toMatch(/quoteToChat\(\s*quote\.source\s*\|\|\s*['"]引用['"]\s*,\s*quote\.title\s*\|\|\s*['"]['"]\s*,\s*quote\.excerpt\s*\|\|\s*['"]['"]\s*,\s*qMeta\s*\)/);
    });

    // The auto-select must be EXCLUSIVE — clearing the residual/default
    // selection — otherwise a quote of #6 still leaks to whoever was already
    // checked (#1). This is the load-bearing assertion for card_3462...
    test('recomputeAutoReceivers clears every entity + contact checkbox before checking the sender', () => {
        const m = chatHtml.match(/function\s+recomputeAutoReceivers\s*\(\s*\)\s*\{/);
        expect(m).not.toBeNull();
        // brace-balance walk to capture the whole body
        let depth = 1;
        let i = m.index + m[0].length;
        while (i < chatHtml.length && depth > 0) {
            const ch = chatHtml[i];
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
            i++;
        }
        const body = chatHtml.slice(m.index, i);
        // unions entityIdsFromMeta over every current quote (multi-quote routes
        // to EVERY quoted sender, not just the last)
        expect(body).toMatch(/replyContexts\.forEach\([\s\S]*?entityIdsFromMeta\(\s*rc\.meta\s*\)/);
        // resets all entity checkboxes to (wanted.has) and all contacts to false
        expect(body).toMatch(/\.target-entity-check input\[type="checkbox"\][\s\S]*?cb\.checked\s*=\s*wanted\.has\(Number\(cb\.dataset\.entity\)\)/);
        expect(body).toMatch(/\.target-contact-check input\[type="checkbox"\][\s\S]*?cb\.checked\s*=\s*false/);
        // bails out (leaves selection untouched) when no quoted sender is bound here
        expect(body).toMatch(/if\s*\(\s*wanted\.size\s*===\s*0\s*\)\s*return/);
    });

    test('manual uncheck revokes the hint via updateTargetAll', () => {
        // updateTargetAll loops checkboxes and clears the hint of any
        // entity that became unchecked. skipHintClear is honoured so the
        // initial render doesn't strip its own freshly-rendered badge.
        expect(chatHtml).toMatch(/function\s+updateTargetAll\s*\(\s*opts\s*\)/);
        expect(chatHtml).toMatch(/opts\s*&&\s*opts\.skipHintClear/);
        expect(chatHtml).toMatch(/clearReceiverHintForEntity\(\s*eid\s*\)/);
    });

    test('clearReplyContext also clears all hints (no orphan badges after Cancel)', () => {
        const m = chatHtml.match(/function\s+clearReplyContext\s*\(\)\s*\{[\s\S]{0,400}?\}/);
        expect(m).not.toBeNull();
        expect(m[0]).toMatch(/clearAllReceiverHints\(\)/);
    });
});

describe('chat quote-reply smart receiver — kanban.html senders', () => {
    test('quoteToChat relays opts.meta into the postMessage / localStorage payload', () => {
        expect(kanbanHtml).toMatch(/if\s*\(\s*opts\.meta\s*&&\s*typeof\s+opts\.meta\s*===\s*['"]object['"]\s*\)\s*quote\.meta\s*=\s*opts\.meta/);
    });

    test('quoteKanbanCardToChat passes kind:"card" + cardAssignedBots from card.assignedBots', () => {
        // Must read card.assignedBots (not card.assignedEntityIds — see
        // memory kanban_post_card_shape) and pass them as cardAssignedBots.
        expect(kanbanHtml).toMatch(/card\.assignedBots/);
        expect(kanbanHtml).toMatch(/kind:\s*['"]card['"]/);
        expect(kanbanHtml).toMatch(/cardAssignedBots:\s*assignedBots/);
    });

    test('quoteCommentToChat: chat-entity wins over surrounding card (multi-source rule)', () => {
        // The function must check senderEntityId FIRST, then fall back to
        // card.assignedBots. The order is the test — if it ever flips, the
        // multi-source rule silently regresses.
        const fnMatch = kanbanHtml.match(
            /function\s+quoteCommentToChat\([\s\S]*?\}\s*\n\s*\n/
        );
        expect(fnMatch).not.toBeNull();
        const body = fnMatch[0];
        const entityIdx = body.search(/kind:\s*['"]chat-entity['"]/);
        const cardIdx = body.search(/kind:\s*['"]card['"]/);
        expect(entityIdx).toBeGreaterThan(-1);
        expect(cardIdx).toBeGreaterThan(-1);
        expect(entityIdx).toBeLessThan(cardIdx);
    });
});

describe('chat_receiver_hint_auto — i18n key parity across 12 locales', () => {
    // Italian (it) is intentionally out of scope: i18n.js does not have an
    // it-locale block yet. en/zh-TW/zh/ja/ko/es/pt/fr/de/vi/th/id are the
    // 12 locales the dispatch covers minus it.
    const EXPECTED = {
        en: 'auto',
        zh: '自動',
        'zh-TW': '自動',
        ja: '自動',
        ko: '자동',
        th: 'อัตโนมัติ',
        vi: 'tự động',
        id: 'otomatis',
        fr: 'auto',
        es: 'auto',
        de: 'auto',
        pt: 'auto',
    };

    // Build locale-block index by locating each `<name>:` opener and using
    // the next opener (or EOF) as the upper bound. We then scan only the
    // slice that belongs to the locale for its translation.
    const LOCALE_RE = /^(\s*)("?(en|zh|zh-TW|ja|ko|th|vi|id|fr|es|de|pt|ms|hi|ar)"?):\s*\{\s*$/gm;
    const matches = [];
    let m;
    while ((m = LOCALE_RE.exec(i18nJs)) !== null) {
        matches.push({ name: m[3], start: m.index });
    }
    matches.sort((a, b) => a.start - b.start);
    const blocks = {};
    matches.forEach((entry, i) => {
        const end = i + 1 < matches.length ? matches[i + 1].start : i18nJs.length;
        blocks[entry.name] = i18nJs.slice(entry.start, end);
    });

    Object.entries(EXPECTED).forEach(([locale, expected]) => {
        test(`${locale} → "${expected}"`, () => {
            const block = blocks[locale];
            expect(block).toBeDefined();
            const re = new RegExp(
                '"chat_receiver_hint_auto"\\s*:\\s*"' +
                    expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
                    '"'
            );
            expect(block).toMatch(re);
        });
    });
});

describe('recomputeAutoReceivers — behaviour against a hand-rolled DOM stub', () => {
    // jest.config.js uses testEnvironment:'node' with no jsdom. We extract
    // the function bodies from chat.html, evaluate them inside a tiny
    // document-like shim, and exercise the spec cases. This gives us a
    // behavioural assertion without pulling in a new dep.
    //
    // Multi-quote refactor: the old single-state applyAutoToggleReceivers(meta)
    // is gone. Auto-select is now driven by recomputeAutoReceivers() which
    // unions entityIdsFromMeta(rc.meta) over a replyContexts[] array. The
    // sandbox seeds that array (one entry per quoted meta) and then invokes
    // recomputeAutoReceivers() — exactly how addReplyContext/removeReplyContextAt
    // drive it in production.
    function makeStubDocument(entityIds) {
        const labels = entityIds.map(eid => {
            const cb = {
                type: 'checkbox',
                checked: false,
                dataset: { entity: String(eid) },
            };
            const label = {
                dataset: { entityId: String(eid) },
                _children: [],
                _classNames: ['target-check', 'target-entity-check'],
                className: 'target-check target-entity-check',
                _input: cb,
                appendChild(node) {
                    node._parent = this;
                    this._children.push(node);
                },
                querySelector(sel) {
                    if (sel.includes('receiver-hint-auto')) {
                        return this._children.find(c => c.className === 'receiver-hint-auto') || null;
                    }
                    return null;
                },
                closest(sel) {
                    if (
                        sel === '.target-entity-check' ||
                        sel === '.target-check'
                    ) {
                        return this;
                    }
                    return null;
                },
            };
            cb.closest = (sel) => label.closest(sel);
            return label;
        });

        const all = labels.map(l => l._input);
        return {
            labels,
            querySelector(sel) {
                const m = sel.match(/\[data-entity="(\d+)"\]/);
                if (m) {
                    const cb = all.find(c => c.dataset.entity === m[1]);
                    return cb || null;
                }
                const m2 = sel.match(/\[data-entity-id="(\d+)"\]/);
                if (m2) {
                    return labels.find(l => l.dataset.entityId === m2[1]) || null;
                }
                return null;
            },
            querySelectorAll(sel) {
                if (sel.includes('receiver-hint-auto')) {
                    const out = [];
                    labels.forEach(l => {
                        l._children
                            .filter(c => c.className === 'receiver-hint-auto')
                            .forEach(c => out.push(c));
                    });
                    return out;
                }
                if (sel.includes('target-entity-check') && sel.includes('input')) {
                    return all;
                }
                return [];
            },
            createElement(tag) {
                const node = {
                    tagName: tag.toUpperCase(),
                    className: '',
                    textContent: '',
                    _attrs: {},
                    _parent: null,
                    setAttribute(k, v) { this._attrs[k] = v; },
                    remove() {
                        if (this._parent && Array.isArray(this._parent._children)) {
                            const idx = this._parent._children.indexOf(this);
                            if (idx >= 0) this._parent._children.splice(idx, 1);
                        }
                    },
                };
                return node;
            },
        };
    }

    function extractFunction(name) {
        const re = new RegExp(
            `function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`,
            'g'
        );
        const m = re.exec(chatHtml);
        if (!m) throw new Error(`function ${name} not found`);
        // Walk braces from the opening `{` until they balance.
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

    // Build a sandbox with the functions we need + a stub document.
    function makeSandbox(entityIds) {
        const stubDoc = makeStubDocument(entityIds);
        const replyContexts = []; // seeded per-test, then recompute unions over it
        const sandbox = {
            document: stubDoc,
            autoToggledReceiverEntities: new Set(),
            i18n: { t: (k) => (k === 'chat_receiver_hint_auto' ? 'auto' : null) },
            persistTargetSelection: () => {},
            updateTargetAll: () => {},
            replyContexts,
        };
        // recomputeAutoReceivers reads the replyContexts array + writes
        // autoToggledReceiverEntities, calls entityIdsFromMeta, i18n.t,
        // document.querySelector, etc. clearAllReceiverHints is invoked at the
        // top, clearReceiverHintForEntity is the companion. Extract all four.
        const body =
            extractFunction('recomputeAutoReceivers') +
            '\n' +
            extractFunction('entityIdsFromMeta') +
            '\n' +
            extractFunction('clearAllReceiverHints') +
            '\n' +
            extractFunction('clearReceiverHintForEntity');
        // Wrap so the sandbox keys behave like free variables. replyContexts is
        // passed by reference; seed it via `quote(meta)` then call recompute()
        // exactly like addReplyContext does in production.
        const fn = new Function(
            'document',
            'autoToggledReceiverEntities',
            'i18n',
            'persistTargetSelection',
            'updateTargetAll',
            'replyContexts',
            `${body}\nreturn { recomputeAutoReceivers, entityIdsFromMeta, clearAllReceiverHints, clearReceiverHintForEntity };`
        );
        const inner = fn(
            sandbox.document,
            sandbox.autoToggledReceiverEntities,
            sandbox.i18n,
            sandbox.persistTargetSelection,
            sandbox.updateTargetAll,
            replyContexts
        );
        // `auto(meta)` mimics quoting a single message with `meta`, then
        // recomputing — the production path through addReplyContext.
        const api = {
            ...inner,
            auto(meta) {
                replyContexts.push({ meta: meta || null });
                inner.recomputeAutoReceivers();
            },
        };
        return { sandbox, api };
    }

    test('card source → each entity in cardAssignedBots is toggled on + badged', () => {
        const { sandbox, api } = makeSandbox([1, 2, 3]);
        api.auto({ kind: 'card', cardAssignedBots: [1, 3] });
        const cb1 = sandbox.document.querySelector('[data-entity="1"]');
        const cb2 = sandbox.document.querySelector('[data-entity="2"]');
        const cb3 = sandbox.document.querySelector('[data-entity="3"]');
        expect(cb1.checked).toBe(true);
        expect(cb2.checked).toBe(false);
        expect(cb3.checked).toBe(true);
        const badges = sandbox.document.querySelectorAll('.receiver-hint-auto');
        expect(badges.length).toBe(2);
    });

    test('chat-entity source → only the sender entity is toggled', () => {
        const { sandbox, api } = makeSandbox([1, 5, 7]);
        api.auto({ kind: 'chat-entity', entityId: 5 });
        expect(sandbox.document.querySelector('[data-entity="1"]').checked).toBe(false);
        expect(sandbox.document.querySelector('[data-entity="5"]').checked).toBe(true);
        expect(sandbox.document.querySelector('[data-entity="7"]').checked).toBe(false);
        const badges = sandbox.document.querySelectorAll('.receiver-hint-auto');
        expect(badges.length).toBe(1);
    });

    // card_3462... regression: a residual/default recipient (#1) must be
    // UNCHECKED when a quote of #5 auto-selects, so the reply routes to #5 only.
    test('chat-entity source clears a pre-checked residual recipient (#1 → off)', () => {
        const { sandbox, api } = makeSandbox([1, 5, 7]);
        // simulate the default "all checked" / last-sent residual state
        sandbox.document.querySelector('[data-entity="1"]').checked = true;
        sandbox.document.querySelector('[data-entity="7"]').checked = true;
        api.auto({ kind: 'chat-entity', entityId: 5 });
        expect(sandbox.document.querySelector('[data-entity="1"]').checked).toBe(false);
        expect(sandbox.document.querySelector('[data-entity="5"]').checked).toBe(true);
        expect(sandbox.document.querySelector('[data-entity="7"]').checked).toBe(false);
        expect(sandbox.document.querySelectorAll('.receiver-hint-auto').length).toBe(1);
    });

    // If the quoted sender isn't a bound target here, leave the selection
    // untouched rather than wiping the bar blank (no recipient = unsendable).
    test('unbound sender → existing selection preserved (no exclusive wipe)', () => {
        const { sandbox, api } = makeSandbox([1, 2]);
        sandbox.document.querySelector('[data-entity="1"]').checked = true;
        api.auto({ kind: 'chat-entity', entityId: 9 }); // 9 not bound
        expect(sandbox.document.querySelector('[data-entity="1"]').checked).toBe(true);
        expect(sandbox.document.querySelectorAll('.receiver-hint-auto').length).toBe(0);
    });

    test('chat-system source → no toggle, no badge', () => {
        const { sandbox, api } = makeSandbox([1, 2]);
        api.auto({ kind: 'chat-system' });
        expect(sandbox.document.querySelector('[data-entity="1"]').checked).toBe(false);
        expect(sandbox.document.querySelector('[data-entity="2"]').checked).toBe(false);
        const badges = sandbox.document.querySelectorAll('.receiver-hint-auto');
        expect(badges.length).toBe(0);
    });

    test('empty / undefined meta → no-op', () => {
        const { sandbox, api } = makeSandbox([1, 2]);
        api.auto(undefined);
        api.auto({});
        api.auto({ kind: 'card' }); // missing cardAssignedBots
        expect(sandbox.document.querySelector('[data-entity="1"]').checked).toBe(false);
        expect(sandbox.document.querySelector('[data-entity="2"]').checked).toBe(false);
        expect(sandbox.document.querySelectorAll('.receiver-hint-auto').length).toBe(0);
    });

    test('clearReceiverHintForEntity removes the badge for that entity', () => {
        const { sandbox, api } = makeSandbox([1, 2]);
        api.auto({ kind: 'card', cardAssignedBots: [1, 2] });
        expect(sandbox.document.querySelectorAll('.receiver-hint-auto').length).toBe(2);
        api.clearReceiverHintForEntity(1);
        expect(sandbox.document.querySelectorAll('.receiver-hint-auto').length).toBe(1);
    });
});
