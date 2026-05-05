/**
 * tutorial.js — EClawbot quick-start tutorial logic
 *
 * Drives the 4-step interactive tutorial:
 *   Step 1: Scenario card selection (creation / coding / translation)
 *   Step 2: Live demo tailored to the chosen scenario
 *   Step 3: Copy-able example prompt
 *   Step 4: Success screen with next-step links
 *
 * Each scenario carries its own demo query, response snippet, and
 * starter prompt so the user sees immediately relevant content.
 */
(function () {
    'use strict';

    // ── Scenario definitions ──────────────────────────────────────────────
    var SCENARIOS = {
        creation: {
            avatar: 'C',
            query:   'Write a 500-word blog post about the benefits of remote work',
            response:
                '<strong>Remote work</strong> is no longer a perk — it\'s the ' +
                'default for millions of knowledge workers worldwide.<br><br>' +
                'Here\'s a suggested outline:<br>' +
                '• <strong>Flexibility &amp; work-life balance</strong><br>' +
                '• <strong>Cost savings</strong> — no commute, less office spend<br>' +
                '• <strong>Access to global talent</strong><br>' +
                '• <strong>Challenges</strong> and how to overcome them<br><br>' +
                'Want me to draft the full post?',
            prompt:
                'Write a 300-word LinkedIn post announcing our new product launch. ' +
                'Make it enthusiastic and include a call-to-action.',
            nextHref: '/portal/chat.html'
        },
        coding: {
            avatar: 'C',
            query:  'Explain what this function does: const foo = (a, b) => a?.b ?? null',
            response:
                'This is an <strong>optional chaining</strong> expression using ' +
                '<strong>nullish coalescing</strong>.<br><br>' +
                'Step by step:<br>' +
                '1. <code>a?.b</code> — if <code>a</code> is not <code>null/undefined</code>, ' +
                'return <code>a.b</code>; otherwise return <code>undefined</code><br>' +
                '2. <code>?? null</code> — if the result is <code>null</code> or ' +
                '<code>undefined</code>, return <code>null</code><br><br>' +
                '<strong>Result:</strong> safely navigate <code>a.b</code>, ' +
                'returning <code>null</code> on any failure path.',
            prompt:
                'Write a JavaScript function that debounces another function with a 300ms delay. ' +
                'Include JSDoc comments and handle edge cases.',
            nextHref: '/portal/chat.html'
        },
        translation: {
            avatar: 'C',
            query:  'Translate this paragraph into Japanese: The quarterly report is ready for review.',
            response:
                '<strong>Japanese translation:</strong><br><br>' +
                '<code>四半期のレポートがレビュー準備できました。</code><br><br>' +
                '<em>Shihanki no rēpo ga rebjū junbi dekimashita.</em><br><br>' +
                '<strong>Alternative (more natural):</strong><br>' +
                '<code>四半期レポートの作成が完了しましたので、ご確認ください。</code>',
            prompt:
                'Translate the following app UI strings into Traditional Chinese. ' +
                'Keep the tone friendly and professional: "Your session has expired. Please log in again."',
            nextHref: '/portal/chat.html'
        }
    };

    // ── State ───────────────────────────────────────────────────────────────
    var currentStep  = 1;
    var chosenScenario = null;

    // ── DOM refs ─────────────────────────────────────────────────────────────
    function getEl(id) { return document.getElementById(id); }

    var $progress     = getEl('tutProgress');
    var $panel1      = getEl('tutPanel1');
    var $panel2      = getEl('tutPanel2');
    var $panel3      = getEl('tutPanel3');
    var $panel4      = getEl('tutPanel4');
    var $next1       = getEl('tutNext1');
    var $next2       = getEl('tutNext2');
    var $next3       = getEl('tutNext3');
    var $back2       = getEl('tutBack2');
    var $back3       = getEl('tutBack3');
    var $scenarios   = getEl('tutScenarios');
    var $demoAvatar  = getEl('tutDemoAvatar');
    var $demoQuery   = getEl('tutDemoQuery');
    var $demoResp    = getEl('tutDemoResponse');
    var $promptEx    = getEl('tutPromptExample');
    var $goChat      = getEl('tutGoChat');

    // ── Progress dots ───────────────────────────────────────────────────────
    function setStep(step) {
        currentStep = step;

        var dots = $progress.querySelectorAll('.tut-step-dot');
        dots.forEach(function (dot) {
            var n = parseInt(dot.dataset.step, 10);
            dot.classList.remove('active', 'done');
            if (n < step)  dot.classList.add('done');
            if (n === step) dot.classList.add('active');
            if (n === step) dot.setAttribute('aria-current', 'step');
            else            dot.removeAttribute('aria-current');
        });

        // Show correct panel
        [$panel1, $panel2, $panel3, $panel4].forEach(function (p) {
            p.classList.remove('active');
        });
        var panelMap = { 1: $panel1, 2: $panel2, 3: $panel3, 4: $panel4 };
        if (panelMap[step]) panelMap[step].classList.add('active');

        // Populate step 2 & 3 once scenario is chosen
        if (step >= 2 && chosenScenario) {
            var s = SCENARIOS[chosenScenario];
            if ($demoAvatar) $demoAvatar.textContent = s.avatar;
            if ($demoQuery)  $demoQuery.textContent  = s.query;
            if ($demoResp)   $demoResp.innerHTML     = s.response;
            if ($promptEx)   $promptEx.textContent   = s.prompt;
            if ($goChat)     $goChat.href             = s.nextHref;
        }
    }

    // ── Scenario card selection ─────────────────────────────────────────────
    function selectScenario(scenario) {
        chosenScenario = scenario;

        var cards = $scenarios.querySelectorAll('.tut-card');
        cards.forEach(function (card) {
            var selected = card.dataset.scenario === scenario;
            card.classList.toggle('selected', selected);
            card.setAttribute('aria-pressed', String(selected));
        });

        if ($next1) $next1.disabled = false;
    }

    // ── Event listeners ─────────────────────────────────────────────────────
    if ($scenarios) {
        $scenarios.addEventListener('click', function (e) {
            var card = e.target.closest('.tut-card');
            if (card) selectScenario(card.dataset.scenario);
        });
        $scenarios.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') {
                var card = e.target.closest('.tut-card');
                if (card) {
                    e.preventDefault();
                    selectScenario(card.dataset.scenario);
                }
            }
        });
    }

    if ($next1) {
        $next1.addEventListener('click', function () {
            if (chosenScenario) setStep(2);
        });
    }

    if ($back2) {
        $back2.addEventListener('click', function () { setStep(1); });
    }

    if ($next2) {
        $next2.addEventListener('click', function () { setStep(3); });
    }

    if ($back3) {
        $back3.addEventListener('click', function () { setStep(2); });
    }

    if ($next3) {
        $next3.addEventListener('click', function () {
            markComplete();
            setStep(4);
        });
    }

    // ── Copy-to-clipboard on prompt example ─────────────────────────────────
    if ($promptEx) {
        $promptEx.addEventListener('click', function () {
            var text = $promptEx.textContent || '';
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(function () {
                    var orig = $promptEx.textContent;
                    $promptEx.textContent = '✓ Copied!';
                    $promptEx.style.borderLeftColor = 'var(--tut-success)';
                    setTimeout(function () {
                        $promptEx.textContent = orig;
                        $promptEx.style.borderLeftColor = '';
                    }, 1500);
                }).catch(function () { fallBackCopy(text); });
            } else {
                fallBackCopy(text);
            }
        });
    }

    function fallBackCopy(text) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity  = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        try { document.execCommand('copy'); } catch (_) { /* ignore */ }
        document.body.removeChild(ta);
    }

    // ── Persist tutorial completion ─────────────────────────────────────────
    function markComplete() {
        try { localStorage.setItem('eclaw_tutorial_done', '1'); } catch (_) { /* blocked */ }
    }

    // ── i18n hook (called by i18n.js when locale is applied) ────────────────
    if (global.applyTutorialI18n && typeof global.applyTutorialI18n === 'function') {
        global.applyTutorialI18n();
    }

})();
