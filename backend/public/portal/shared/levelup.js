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

    // ── First-achievement toast (card_d355616434834b0737d6380f) ──
    // Watches the card_8ca achievements API for any axis count crossing
    // 0 → ≥1 during the session. Small toast, NOT the full-screen level-up
    // overlay. Same guard philosophy: first sighting primes the baseline,
    // localStorage keeps each (entity, axis) to a single celebration ever.
    var FIRSTACH_PREFIX = 'eclaw_firstach_';
    var _achSeen = {};          // 'eid:axis' -> last seen count
    var _achLastPollMs = 0;
    var ACH_POLL_MIN_MS = 60000; // piggyback on the 10s entity poll, act every ~60s

    function _achGuarded(storage, eid, axis) {
        try { return storage.getItem(FIRSTACH_PREFIX + eid + '_' + axis) === '1'; }
        catch (_e) { return false; }
    }
    function _achMarc(storage, eid, axis) {
        try { storage.setItem(FIRSTACH_PREFIX + eid + '_' + axis, '1'); } catch (_e) { /* quota */ }
    }

    /** Pure diff: returns [{entityId, axis}] crossing 0→≥1, baseline-primed + guarded. */
    function checkFirstAchievements(entityId, achievements, storage) {
        storage = storage || global.localStorage;
        var hits = [];
        (achievements || []).forEach(function (a) {
            if (!a || !a.axis) return;
            var key = entityId + ':' + a.axis;
            var count = Number(a.count) || 0;
            var prev = _achSeen[key];
            _achSeen[key] = count;
            if (prev === undefined) return;        // baseline priming
            if (!(prev === 0 && count >= 1)) return;
            if (_achGuarded(storage, entityId, a.axis)) return;
            _achMarc(storage, entityId, a.axis);
            hits.push({ entityId: entityId, axis: a.axis });
        });
        return hits;
    }

    /** Test hook. */
    function _resetAchSession() { _achSeen = {}; _achLastPollMs = 0; }

    function _axisLabel(axis, t) {
        var key = 'entity_status_achievement_' + axis;
        var v = (typeof t === 'function') ? t(key) : null;
        return (v && v !== key) ? v : axis;
    }

    /** Small toast — distinct from the full-screen level-up overlay. */
    function celebrateFirstAchievement(hit, opts) {
        opts = opts || {};
        var doc = opts.doc || global.document;
        var t = opts.t;
        var duration = opts.duration || 2500;
        var reduced = _prefersReducedMotion();
        var prev = doc.getElementById('firstachToast');
        if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
        var el = doc.createElement('div');
        el.id = 'firstachToast';
        el.className = 'firstach-toast' + (reduced ? ' firstach-reduced' : '');
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        var tpl = (typeof t === 'function' && t('firstach_title') !== 'firstach_title' && t('firstach_title'))
            ? t('firstach_title') : 'First achievement: {label}!';
        el.textContent = '🏅 ' + tpl.replace('{label}', _axisLabel(hit.axis, t));
        doc.body.appendChild(el);
        setTimeout(function () {
            if (el.parentNode) el.parentNode.removeChild(el);
        }, duration);
        return el;
    }

    /**
     * Throttled poll driver — call from the dashboard's entity-poll hook.
     * opts.fetcher(entityId) must resolve to the /achievements payload
     * ({achievements:[...]}) and is injected so tests need no network.
     */
    function pollFirstAchievements(entities, opts) {
        opts = opts || {};
        var nowMs = (typeof opts.nowMs === 'number') ? opts.nowMs : Date.now();
        if (nowMs - _achLastPollMs < ACH_POLL_MIN_MS) return Promise.resolve([]);
        _achLastPollMs = nowMs;
        var fetcher = opts.fetcher;
        if (typeof fetcher !== 'function') return Promise.resolve([]);
        var ids = (entities || []).map(function (e) { return e && e.entityId; })
            .filter(function (id) { return id !== undefined && id !== null; });
        return Promise.all(ids.map(function (eid) {
            return Promise.resolve(fetcher(eid)).then(function (data) {
                return checkFirstAchievements(eid, (data && data.achievements) || [], opts.storage);
            }).catch(function () { return []; });
        })).then(function (lists) {
            var hits = [].concat.apply([], lists);
            hits.forEach(function (hit, idx) {
                setTimeout(function () { celebrateFirstAchievement(hit, opts); }, idx * 2700);
            });
            return hits;
        });
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
        checkFirstAchievements: checkFirstAchievements,
        celebrateFirstAchievement: celebrateFirstAchievement,
        pollFirstAchievements: pollFirstAchievements,
        _resetSession: _resetSession,
        _resetAchSession: _resetAchSession,
        PRAISE_KEYS: PRAISE_KEYS,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else if (global) {
        global.EclawLevelUp = api;
    }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
