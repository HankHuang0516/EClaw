/**
 * Level-up celebration — 情緒價值 #3 (card_91c97a12a385cac144ad223e).
 *
 * Watches the entity list the dashboard already polls (10s interval) and
 * fires a 1.5s full-screen celebration when an entity's level increases
 * during the session. Pure logic (diff + guards) is separated from the DOM
 * bits so Jest can drive it without a browser:
 *
 *   check(entities, storage)  — returns [{entityId, name, level}] to celebrate
 *   celebrate(hit, opts)      — renders the overlay (auto-removes ~1.5s)
 *
 * Guards:
 *   - first sighting of an entity in a session only primes the baseline
 *     (no celebration on page load)
 *   - localStorage `eclaw_lvlup_<entityId>` keeps the highest celebrated
 *     level so the same level never celebrates twice across reloads
 *   - prefers-reduced-motion → static banner, no confetti / scale
 *
 * First-achievement celebrations (tasks_done 0→1) intentionally NOT here —
 * they wait on card_8ca's achievements API per the card's dependency note.
 */
(function (global) {
    'use strict';

    var PRAISE_KEYS = [
        'levelup_praise_1', 'levelup_praise_2', 'levelup_praise_3',
        'levelup_praise_4', 'levelup_praise_5'
    ];
    var GUARD_PREFIX = 'eclaw_lvlup_';

    // session baseline: entityId -> last seen level
    var _seen = {};

    function _guardKey(entityId) { return GUARD_PREFIX + String(entityId); }

    function _celebratedLevel(storage, entityId) {
        try {
            var v = storage.getItem(_guardKey(entityId));
            return v === null ? 0 : (parseInt(v, 10) || 0);
        } catch (_e) { return 0; }
    }

    function _markCelebrated(storage, entityId, level) {
        try { storage.setItem(_guardKey(entityId), String(level)); } catch (_e) { /* quota */ }
    }

    /**
     * Diff the fresh entity list against the session baseline.
     * Returns the entities whose level rose AND that haven't celebrated
     * this level before (localStorage guard). Always advances the baseline.
     */
    function check(entities, storage) {
        storage = storage || global.localStorage;
        var hits = [];
        (entities || []).forEach(function (e) {
            if (!e || e.entityId === undefined || e.entityId === null) return;
            var id = e.entityId;
            var level = e.level || 1;
            var prev = _seen[id];
            _seen[id] = level;
            if (prev === undefined) return;            // baseline priming, not a level-up
            if (level <= prev) return;                 // no increase
            if (level <= _celebratedLevel(storage, id)) return; // already celebrated
            _markCelebrated(storage, id, level);
            hits.push({ entityId: id, name: e.name || ('#' + id), level: level });
        });
        return hits;
    }

    /** Test hook: reset the session baseline. */
    function _resetSession() { _seen = {}; }

    function _prefersReducedMotion() {
        try {
            return global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
        } catch (_e) { return false; }
    }

    function _pickPraise(t) {
        var key = PRAISE_KEYS[Math.floor(Math.random() * PRAISE_KEYS.length)];
        var v = (typeof t === 'function') ? t(key) : null;
        return (v && v !== key) ? v : 'Great work!';
    }

    /**
     * Render the celebration overlay. opts: { t (i18n fn), doc, duration }.
     * Returns the overlay element (mostly for tests).
     */
    function celebrate(hit, opts) {
        opts = opts || {};
        var doc = opts.doc || global.document;
        var t = opts.t;
        var duration = opts.duration || 1500;
        var reduced = _prefersReducedMotion();

        var prev = doc.getElementById('lvlupOverlay');
        if (prev && prev.parentNode) prev.parentNode.removeChild(prev);

        var overlay = doc.createElement('div');
        overlay.id = 'lvlupOverlay';
        overlay.className = 'lvlup-overlay' + (reduced ? ' lvlup-reduced' : '');
        overlay.setAttribute('role', 'status');
        overlay.setAttribute('aria-live', 'polite');

        var titleTpl = (typeof t === 'function' && t('levelup_title') !== 'levelup_title' && t('levelup_title'))
            ? t('levelup_title') : 'Level {n}!';
        var card = doc.createElement('div');
        card.className = 'lvlup-card';
        var badge = doc.createElement('div');
        badge.className = 'lvlup-badge';
        badge.textContent = '⭐';
        var title = doc.createElement('div');
        title.className = 'lvlup-title';
        title.textContent = titleTpl.replace('{n}', String(hit.level));
        var who = doc.createElement('div');
        who.className = 'lvlup-name';
        who.textContent = hit.name;
        var praise = doc.createElement('div');
        praise.className = 'lvlup-praise';
        praise.textContent = _pickPraise(t);
        card.appendChild(badge); card.appendChild(title);
        card.appendChild(who); card.appendChild(praise);
        overlay.appendChild(card);

        if (!reduced) {
            for (var i = 0; i < 24; i++) {
                var c = doc.createElement('span');
                c.className = 'lvlup-confetti';
                c.style.left = (Math.random() * 100) + '%';
                c.style.animationDelay = (Math.random() * 0.4) + 's';
                c.style.background = ['#6c63ff', '#4ade80', '#fbbf24', '#f472b6', '#38bdf8'][i % 5];
                overlay.appendChild(c);
            }
        }

        doc.body.appendChild(overlay);
        setTimeout(function () {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }, duration);
        return overlay;
    }

    /** Convenience: diff + celebrate each hit (stagger if multiple). */
    function onEntitiesUpdated(entities, opts) {
        opts = opts || {};
        var hits = check(entities, opts.storage);
        hits.forEach(function (hit, idx) {
            setTimeout(function () { celebrate(hit, opts); }, idx * 1700);
        });
        return hits;
    }

    var api = {
        check: check,
        celebrate: celebrate,
        onEntitiesUpdated: onEntitiesUpdated,
        _resetSession: _resetSession,
        PRAISE_KEYS: PRAISE_KEYS,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else if (global) {
        global.EclawLevelUp = api;
    }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
