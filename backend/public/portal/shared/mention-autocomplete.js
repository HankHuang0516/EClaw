/**
 * Mention Autocomplete — @ tag dropdown for chat-style inputs.
 *
 * Mirrors the backend mention-parser token format:
 *   - <@xxxxxx>  inserted into the textarea when a suggestion is picked
 *   - @all       inserted verbatim for the broadcast keyword
 *
 * Usage:
 *   MentionAutocomplete.attach(textarea, {
 *       getEntries: () => [{ code, name, avatar, isCrossDevice, entityId? }, ...],
 *       onPick: (entry) => {},        // optional
 *       i18n: { allLabel, allWarning, notFound }
 *   });
 *
 * Features:
 *   - Triggers when user types "@" at word boundary
 *   - Fuzzy match: substring + subsequence (e.g. "sk" matches "Stock Keeper")
 *   - Keyboard nav: ↑/↓ to move, Enter/Tab to select, Esc to close
 *   - IME-safe: ignores composition events (CJK input)
 *   - `@all` shown first with a warning badge; others follow fuzzy rank
 *   - Tracks picked mentions on textarea._activeMentions for sendMessage()
 */
(function (global) {
    'use strict';

    const ALL_TOKEN = '@all';
    const MAX_RESULTS = 8;

    function fuzzyScore(query, target) {
        if (!query) return 1;
        const q = query.toLowerCase();
        const t = (target || '').toLowerCase();
        if (!t) return 0;
        // Exact prefix
        if (t.startsWith(q)) return 100 - (t.length - q.length);
        // Substring
        const sub = t.indexOf(q);
        if (sub >= 0) return 50 - sub;
        // Subsequence: every char of q appears in t in order
        let i = 0, j = 0;
        while (i < q.length && j < t.length) {
            if (q[i] === t[j]) i++;
            j++;
        }
        return i === q.length ? 10 - (t.length - q.length) * 0.1 : 0;
    }

    function escapeHtml(s) {
        const div = document.createElement('div');
        div.textContent = s == null ? '' : String(s);
        return div.innerHTML;
    }

    function renderMentionAvatar(entry) {
        if (entry.isAll) {
            return '<span class="mention-avatar">📢</span>';
        }

        const avatar = entry.avatar || '🤖';
        const entityId = entry.entityId != null ? entry.entityId : undefined;

        // Keep @mention suggestions visually aligned with the rest of Chat.
        // The shared renderer emits AvatarPetdx canvas placeholders for local
        // entities that have a selected companion, and falls back to image/emoji
        // avatars for older pages or cross-device contacts.
        if (typeof global.renderAvatarHtml === 'function') {
            return '<span class="mention-avatar mention-avatar-shared">'
                + global.renderAvatarHtml(avatar, 20, entityId)
                + '</span>';
        }

        if (avatar && /^https?:/.test(avatar)) {
            return `<img class="mention-avatar mention-avatar-img" src="${escapeHtml(avatar)}" alt="">`;
        }
        return `<span class="mention-avatar">${escapeHtml(avatar)}</span>`;
    }

    /**
     * Attach autocomplete to a textarea.
     * @param {HTMLTextAreaElement} textarea
     * @param {object} opts
     * @param {function(): Array} opts.getEntries - returns current mention pool
     * @param {function(object): void} [opts.onPick]
     * @param {object} [opts.i18n] - translation strings
     */
    function attach(textarea, opts) {
        if (!textarea || textarea._mentionAutocompleteAttached) return;
        textarea._mentionAutocompleteAttached = true;
        textarea._activeMentions = []; // [{ code, name, isCrossDevice }]

        const getEntries = opts.getEntries || (() => []);
        const onPick = opts.onPick || (() => {});
        const i18n = opts.i18n || {};

        // Build dropdown container (reused across triggers)
        const dropdown = document.createElement('div');
        dropdown.className = 'mention-dropdown';
        dropdown.style.display = 'none';
        dropdown.setAttribute('role', 'listbox');
        document.body.appendChild(dropdown);

        let state = {
            open: false,
            triggerIndex: -1,      // position of "@" in textarea value
            query: '',
            items: [],
            activeIndex: 0,
            isComposing: false
        };

        function close() {
            state.open = false;
            dropdown.style.display = 'none';
        }

        function positionDropdown() {
            const rect = textarea.getBoundingClientRect();
            // Position above the textarea (chat inputs are at page bottom)
            dropdown.style.position = 'fixed';
            dropdown.style.left = rect.left + 'px';
            dropdown.style.width = Math.min(rect.width, 320) + 'px';
            dropdown.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
            dropdown.style.zIndex = '10000';
        }

        function render() {
            if (state.items.length === 0) {
                dropdown.innerHTML = `<div class="mention-empty">${escapeHtml(i18n.notFound || 'No matching entity')}</div>`;
                return;
            }
            const html = state.items.map((it, idx) => {
                if (it.isAll) {
                    return `<div class="mention-item mention-all ${idx === state.activeIndex ? 'active' : ''}" data-idx="${idx}" role="option">
                        ${renderMentionAvatar(it)}
                        <span class="mention-name">${escapeHtml(i18n.allLabel || 'Broadcast to all')}</span>
                        <span class="mention-badge mention-warn">${escapeHtml(i18n.allWarning || '@all')}</span>
                    </div>`;
                }
                const avatar = renderMentionAvatar(it);
                const crossBadge = it.isCrossDevice ? '<span class="mention-badge">🔗</span>' : '';
                return `<div class="mention-item ${idx === state.activeIndex ? 'active' : ''}" data-idx="${idx}" role="option">
                    ${avatar}
                    <span class="mention-name">${escapeHtml(it.name)}</span>
                    <span class="mention-code">#${escapeHtml(it.code)}</span>
                    ${crossBadge}
                </div>`;
            }).join('');
            dropdown.innerHTML = html;
            if (global.AvatarPetdx && typeof global.AvatarPetdx.mount === 'function') {
                global.AvatarPetdx.mount(dropdown);
            }
            // Wire click handlers
            dropdown.querySelectorAll('.mention-item').forEach(el => {
                el.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    const idx = parseInt(el.dataset.idx, 10);
                    pick(state.items[idx]);
                });
            });
        }

        function buildItems(query) {
            const pool = getEntries() || [];
            const q = (query || '').trim();
            const scored = pool
                .map(e => ({ entry: e, score: fuzzyScore(q, e.name) + (q ? fuzzyScore(q, e.code) * 0.3 : 0) }))
                .filter(x => !q || x.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, MAX_RESULTS)
                .map(x => x.entry);

            // @all always first (unless it doesn't match an explicit query)
            const allEntry = { isAll: true, code: 'all', name: 'all' };
            const showAll = !q || 'all'.startsWith(q.toLowerCase());
            return showAll ? [allEntry, ...scored] : scored;
        }

        function findTriggerIndex() {
            // Find the most recent "@" before the caret that is at a word boundary
            const caret = textarea.selectionStart;
            const value = textarea.value;
            for (let i = caret - 1; i >= 0; i--) {
                const ch = value[i];
                if (ch === '@') {
                    const prev = i > 0 ? value[i - 1] : ' ';
                    if (/\s/.test(prev) || i === 0) return i;
                    return -1;
                }
                // Stop scanning at whitespace/newline — @ must be at start of a word
                if (/\s/.test(ch)) return -1;
            }
            return -1;
        }

        function update() {
            if (state.isComposing) return;
            const triggerIdx = findTriggerIndex();
            if (triggerIdx < 0) {
                close();
                return;
            }
            const caret = textarea.selectionStart;
            const query = textarea.value.substring(triggerIdx + 1, caret);
            // Abort if query contains whitespace (user typed past the @word)
            if (/\s/.test(query)) {
                close();
                return;
            }
            state.triggerIndex = triggerIdx;
            state.query = query;
            state.items = buildItems(query);
            state.activeIndex = 0;
            state.open = true;
            positionDropdown();
            render();
            dropdown.style.display = 'block';
        }

        function pick(entry) {
            if (!entry) return;
            const before = textarea.value.substring(0, state.triggerIndex);
            const after = textarea.value.substring(textarea.selectionStart);
            let insertion;
            if (entry.isAll) {
                // Broadcast confirmation
                const ok = confirm(i18n.allConfirm || 'Send this message to ALL entities?');
                if (!ok) {
                    close();
                    return;
                }
                insertion = '@all ';
            } else {
                insertion = `<@${entry.code}> `;
                // Track for sendMessage() to know cross-device targets
                if (!textarea._activeMentions.some(m => m.code === entry.code)) {
                    textarea._activeMentions.push({
                        code: entry.code,
                        name: entry.name,
                        isCrossDevice: !!entry.isCrossDevice,
                        entityId: entry.entityId != null ? entry.entityId : null
                    });
                }
            }
            textarea.value = before + insertion + after;
            const newPos = before.length + insertion.length;
            textarea.setSelectionRange(newPos, newPos);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            onPick(entry);
            close();
            textarea.focus();
        }

        // Input handler
        textarea.addEventListener('input', () => {
            update();
            // Prune _activeMentions: drop any whose token no longer exists in text
            if (textarea._activeMentions.length > 0) {
                const val = textarea.value;
                textarea._activeMentions = textarea._activeMentions.filter(m => val.includes(`<@${m.code}>`));
            }
        });

        // Composition events for CJK IME
        textarea.addEventListener('compositionstart', () => { state.isComposing = true; });
        textarea.addEventListener('compositionend', () => {
            state.isComposing = false;
            update();
        });

        // Keyboard navigation
        textarea.addEventListener('keydown', (e) => {
            if (!state.open) return;
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                state.activeIndex = (state.activeIndex + 1) % state.items.length;
                render();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                state.activeIndex = (state.activeIndex - 1 + state.items.length) % state.items.length;
                render();
            } else if (e.key === 'Enter' || e.key === 'Tab') {
                if (state.items.length > 0) {
                    e.preventDefault();
                    e.stopPropagation();
                    pick(state.items[state.activeIndex]);
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                close();
            }
        }, true); // capture so Enter fires before the "send on Enter" handler

        // Close on blur / outside click
        textarea.addEventListener('blur', () => {
            // Delay so mousedown on an item can fire first
            setTimeout(() => close(), 150);
        });
        window.addEventListener('resize', () => { if (state.open) positionDropdown(); });
    }

    global.MentionAutocomplete = { attach };
})(window);
