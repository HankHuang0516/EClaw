// Settings deep-link section filter.
// Lets the APP open settings.html with ?focus=<key> and only render the
// matching card so the user doesn't have to scroll past unrelated sections.
// Falls back to full page if key is unknown or absent.

(function () {
    const FOCUS_MAP = {
        'channel-api': {
            cardId: 'channelApiCard',
            expand: null,
        },
        'kanban-nudge': {
            cardId: 'kanban-nudge-card',
            expand: function () {
                const content = document.getElementById('kanbanNudgeContent');
                const arrow = document.getElementById('kanbanNudgeArrow');
                const header = document.getElementById('kanbanNudgeHeader');
                if (content) content.classList.add('visible');
                if (arrow) arrow.classList.add('expanded');
                if (header) header.setAttribute('aria-expanded', 'true');
            },
        },
        'action_requests': {
            cardId: 'actionRequestSettingsCard',
            expand: null,
        },
        'action-requests': {
            cardId: 'actionRequestSettingsCard',
            expand: null,
        },
    };

    function readFocusKey() {
        try {
            const params = new URLSearchParams(window.location.search);
            const q = params.get('focus');
            if (q) return q;
        } catch (_) { }
        const hash = (window.location.hash || '').replace(/^#/, '');
        return hash || null;
    }

    function applyDeepLinkFocus() {
        const key = readFocusKey();
        if (!key) return false;
        const target = FOCUS_MAP[key];
        if (!target) return false;
        const targetEl = document.getElementById(target.cardId);
        if (!targetEl) return false;

        const cards = document.querySelectorAll('.card');
        cards.forEach(function (el) {
            if (el !== targetEl) el.style.display = 'none';
        });

        // Hide bottom actions (logout / delete-account) — they belong to the
        // full settings page, not a focused single-card view. Leaving them
        // visible turns the focused page into a small card on top of two
        // dangerous red buttons that the user could mis-tap.
        const actions = document.querySelectorAll('.actions-section');
        actions.forEach(function (el) { el.style.display = 'none'; });

        if (typeof target.expand === 'function') {
            try { target.expand(); } catch (_) { }
        }

        try {
            targetEl.scrollIntoView({ block: 'start', behavior: 'auto' });
        } catch (_) { }

        document.body.setAttribute('data-deep-link-focus', key);
        return true;
    }

    window.applyDeepLinkFocus = applyDeepLinkFocus;
    window.SETTINGS_DEEP_LINK_KEYS = Object.keys(FOCUS_MAP);
})();
