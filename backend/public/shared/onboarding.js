/**
 * onboarding.js — Tutorial step logic, template showcase, and progress tracking
 * Used by onboarding.html for the new user onboarding flow (card_a3ec2d95fa9448729239b086)
 *
 * Exports:
 *   TutorialManager  — step-by-step tutorial flow (1→2→3→success)
 *   TemplateShowcase — 3-scenario showcase (code review / translation / creative)
 *   QuickWinDemo     — 30-second interactive demo
 *   ProgressTracker  — 1-2-3-success visual progress bar
 */

(function (root, factory) {
  'use strict';
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Onboarding = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ─── Constants ───────────────────────────────────────────────────────────────

  const TUTORIAL_STEPS = 4; // 0=start, 1=step1, 2=step2, 3=step3, 4=success
  const QUICK_WIN_DURATION_MS = 30_000;

  // ─── ProgressTracker ─────────────────────────────────────────────────────────

  /**
   * Visual progress bar: 1 ─ 2 ─ 3 ─ ✓ (success)
   * Renders into a container element and updates on step changes.
   */
  function ProgressTracker(containerEl) {
    this.el = containerEl;
    this.currentStep = 0;
    this._render();
  }

  ProgressTracker.prototype._render = function () {
    if (!this.el) return;
    this.el.innerHTML = '';
    this.el.className = 'onboarding-progress';

    const steps = ['1', '2', '3', '✓'];
    const labels = [
      null, // step 0 = start (no label shown)
      'Start',
      'Try',
      'Done'
    ];

    for (let i = 0; i < steps.length; i++) {
      const node = document.createElement('div');
      node.className = 'ob-progress-step';
      if (i < this.currentStep) node.classList.add('ob-progress-done');
      if (i === this.currentStep) node.classList.add('ob-progress-active');

      const circle = document.createElement('div');
      circle.className = 'ob-progress-circle';
      circle.textContent = steps[i];

      const label = document.createElement('div');
      label.className = 'ob-progress-label';
      if (labels[i]) label.textContent = labels[i];

      node.appendChild(circle);
      node.appendChild(label);

      // Connector line (not before first)
      if (i > 0) {
        const line = document.createElement('div');
        line.className = 'ob-progress-line';
        if (i <= this.currentStep) line.classList.add('ob-progress-line-done');
        this.el.appendChild(line);
      }

      this.el.appendChild(node);
    }
  };

  ProgressTracker.prototype.setStep = function (step) {
    this.currentStep = Math.max(0, Math.min(step, TUTORIAL_STEPS));
    this._render();
    this.el.dispatchEvent(new CustomEvent('step-change', { detail: { step: this.currentStep } }));
  };

  ProgressTracker.prototype.reset = function () {
    this.setStep(0);
  };

  // ─── TemplateShowcase ────────────────────────────────────────────────────────

  /**
   * 3 main usage scenarios displayed as interactive cards.
   * Scenarios:
   *   1. Code Review — 程序審查
   *   2. Translation — 翻譯
   *   3. Creative   — 創作
   */
  var TEMPLATES = [
    {
      id: 'code-review',
      icon: '🔍',
      titleKey: 'onboarding_template_code_review_title',
      descKey:  'onboarding_template_code_review_desc',
      hintKey:  'onboarding_template_code_review_hint',
      example: 'Paste your code → Get instant review with suggestions'
    },
    {
      id: 'translation',
      icon: '🌐',
      titleKey: 'onboarding_template_translation_title',
      descKey:  'onboarding_template_translation_desc',
      hintKey:  'onboarding_template_translation_hint',
      example: 'Enter text → Choose language → Get polished translation'
    },
    {
      id: 'creative',
      icon: '✨',
      titleKey: 'onboarding_template_creative_title',
      descKey:  'onboarding_template_creative_desc',
      hintKey:  'onboarding_template_creative_hint',
      example: 'Describe idea → Generate content → Refine with feedback'
    }
  ];

  function TemplateShowcase(containerEl) {
    this.el = containerEl;
    this.templates = TEMPLATES;
    this._render();
    this._bindEvents();
  }

  TemplateShowcase.prototype._render = function () {
    if (!this.el) return;
    this.el.innerHTML = '';
    this.el.className = 'ob-template-showcase';

    var sectionTitle = document.createElement('h3');
    sectionTitle.className = 'ob-section-title';
    sectionTitle.setAttribute('data-i18n', 'onboarding_templates_heading');
    sectionTitle.textContent = sectionTitle.getAttribute('data-i18n') || 'Try a scenario';
    this.el.appendChild(sectionTitle);

    var grid = document.createElement('div');
    grid.className = 'ob-template-grid';

    this.templates.forEach(function (tpl) {
      var card = document.createElement('div');
      card.className = 'ob-template-card';
      card.dataset.templateId = tpl.id;

      var icon = document.createElement('div');
      icon.className = 'ob-template-icon';
      icon.textContent = tpl.icon;

      var title = document.createElement('div');
      title.className = 'ob-template-title';
      title.setAttribute('data-i18n', tpl.titleKey);
      title.textContent = title.getAttribute('data-i18n') || tpl.id;

      var desc = document.createElement('div');
      desc.className = 'ob-template-desc';
      desc.setAttribute('data-i18n', tpl.descKey);
      desc.textContent = desc.getAttribute('data-i18n') || '';

      var hint = document.createElement('div');
      hint.className = 'ob-template-hint';
      hint.setAttribute('data-i18n', tpl.hintKey);
      hint.textContent = hint.getAttribute('data-i18n') || '';

      card.appendChild(icon);
      card.appendChild(title);
      card.appendChild(desc);
      card.appendChild(hint);
      grid.appendChild(card);
    }, this);

    this.el.appendChild(grid);
  };

  TemplateShowcase.prototype._bindEvents = function () {
    var self = this;
    this.el.addEventListener('click', function (e) {
      var card = e.target.closest('.ob-template-card');
      if (!card) return;
      var templateId = card.dataset.templateId;
      self.el.dispatchEvent(new CustomEvent('template-select', {
        detail: { templateId: templateId },
        bubbles: true
      }));
    });
  };

  TemplateShowcase.prototype.getTemplate = function (id) {
    return this.templates.find(function (t) { return t.id === id; }) || null;
  };

  // ─── QuickWinDemo ────────────────────────────────────────────────────────────

  /**
   * A 30-second interactive demo shown to new users.
   * Uses a simulated typing effect and timer to create a "Quick Win" feeling.
   */
  function QuickWinDemo(options) {
    options = options || {};
    this.containerEl = options.containerEl || null;
    this.onComplete = options.onComplete || null; // callback when demo finishes
    this._timer = null;
    this._tickInterval = null;
    this._secondsLeft = 0;
    this._isRunning = false;
    this._step = 0;
  }

  QuickWinDemo.prototype.start = function () {
    if (this._isRunning) return;
    this._isRunning = true;
    this._secondsLeft = QUICK_WIN_DURATION_MS / 1000;
    this._step = 0;
    this._render();

    var self = this;
    this._timer = setTimeout(function () {
      self._finish();
    }, QUICK_WIN_DURATION_MS);

    this._tickInterval = setInterval(function () {
      self._secondsLeft--;
      self._updateTimerDisplay();
      if (self._secondsLeft <= 0) {
        clearInterval(self._tickInterval);
      }
    }, 1000);
  };

  QuickWinDemo.prototype._render = function () {
    if (!this.containerEl) return;
    this.containerEl.innerHTML = '';
    this.containerEl.className = 'ob-quickwin';

    var header = document.createElement('div');
    header.className = 'ob-quickwin-header';

    var title = document.createElement('div');
    title.className = 'ob-quickwin-title';
    title.setAttribute('data-i18n', 'onboarding_quickwin_title');
    title.textContent = title.getAttribute('data-i18n') || '⚡ Quick Win — 30 seconds';

    this._timerDisplay = document.createElement('div');
    this._timerDisplay.className = 'ob-quickwin-timer';
    this._timerDisplay.textContent = this._secondsLeft + 's';

    header.appendChild(title);
    header.appendChild(this._timerDisplay);

    this._contentArea = document.createElement('div');
    this._contentArea.className = 'ob-quickwin-content';

    var steps = [
      { labelKey: 'onboarding_quickwin_step1', text: 'Choose a template...' },
      { labelKey: 'onboarding_quickwin_step2', text: 'Paste your content...' },
      { labelKey: 'onboarding_quickwin_step3', text: 'Get instant results!' }
    ];

    var list = document.createElement('ul');
    list.className = 'ob-quickwin-steps';
    this._stepEls = [];

    steps.forEach(function (step, i) {
      var li = document.createElement('li');
      li.className = 'ob-quickwin-step';
      if (i === 0) li.classList.add('ob-quickwin-step-active');
      var label = document.createElement('span');
      label.setAttribute('data-i18n', step.labelKey);
      label.textContent = label.getAttribute('data-i18n') || step.text;
      li.appendChild(label);
      list.appendChild(li);
      self._stepEls.push(li);
    });

    this._contentArea.appendChild(list);
    this.containerEl.appendChild(header);
    this.containerEl.appendChild(this._contentArea);

    // Advance steps every 10 seconds
    var self = this;
    [10, 20].forEach(function (delaySec) {
      setTimeout(function () {
        self._advanceStep();
      }, delaySec * 1000);
    });
  };

  QuickWinDemo.prototype._advanceStep = function () {
    if (this._step < this._stepEls.length - 1) {
      this._stepEls[this._step].classList.remove('ob-quickwin-step-active');
      this._step++;
      this._stepEls[this._step].classList.add('ob-quickwin-step-active');
    }
  };

  QuickWinDemo.prototype._updateTimerDisplay = function () {
    if (this._timerDisplay) {
      this._timerDisplay.textContent = this._secondsLeft + 's';
    }
  };

  QuickWinDemo.prototype._finish = function () {
    this._cleanup();
    this._isRunning = false;
    if (this.containerEl) {
      this.containerEl.classList.add('ob-quickwin-done');
      var doneMsg = document.createElement('div');
      doneMsg.className = 'ob-quickwin-complete';
      doneMsg.setAttribute('data-i18n', 'onboarding_quickwin_complete');
      doneMsg.textContent = doneMsg.getAttribute('data-i18n') || '✅ Quick Win complete!';
      this.containerEl.appendChild(doneMsg);
    }
    if (typeof this.onComplete === 'function') {
      this.onComplete();
    }
    this.containerEl.dispatchEvent(new CustomEvent('quickwin-complete', { bubbles: false }));
  };

  QuickWinDemo.prototype.stop = function () {
    this._cleanup();
    this._isRunning = false;
  };

  QuickWinDemo.prototype._cleanup = function () {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._tickInterval) {
      clearInterval(this._tickInterval);
      this._tickInterval = null;
    }
  };

  // ─── TutorialManager ────────────────────────────────────────────────────────

  /**
   * Orchestrates the full onboarding tutorial:
   *   - Tracks which steps the user has completed
   *   - Shows/hides tutorial overlays
   *   - Fires events for HTML/UI to react to
   *
   * Usage:
   *   var tm = new TutorialManager({ containerEl: document.getElementById('tutorial-root') });
   *   tm.start();           // Begin tutorial
   *   tm.nextStep();        // Advance to next step
   *   tm.complete();       // Mark tutorial complete
   *   tm.getState();        // Returns { step, completed, dismissed }
   */
  function TutorialManager(options) {
    options = options || {};
    this.containerEl = options.containerEl || null;
    this._currentStep = 0;
    this._completed = false;
    this._dismissed = false;
    this._progressTracker = null;
    this._templateShowcase = null;
    this._quickWinDemo = null;
    this._boundHandlers = [];

    // Load persisted state
    this._loadState();
  }

  TutorialManager.prototype._loadState = function () {
    try {
      var raw = localStorage.getItem('eclaw_tutorial_state');
      if (raw) {
        var state = JSON.parse(raw);
        this._currentStep = state.step || 0;
        this._completed = state.completed || false;
        this._dismissed = state.dismissed || false;
      }
    } catch (_) {
      // Ignore — fresh start
    }
  };

  TutorialManager.prototype._saveState = function () {
    try {
      localStorage.setItem('eclaw_tutorial_state', JSON.stringify({
        step: this._currentStep,
        completed: this._completed,
        dismissed: this._dismissed
      }));
    } catch (_) {}
  };

  TutorialManager.prototype.getState = function () {
    return {
      step: this._currentStep,
      completed: this._completed,
      dismissed: this._dismissed,
      totalSteps: TUTORIAL_STEPS
    };
  };

  TutorialManager.prototype.start = function () {
    if (this._completed || this._dismissed) return;
    this._currentStep = 1;
    this._saveState();
    this._emit('tutorial:start', { step: this._currentStep });
    this._render();
  };

  TutorialManager.prototype.nextStep = function () {
    if (this._currentStep >= TUTORIAL_STEPS) {
      this.complete();
      return;
    }
    this._currentStep++;
    this._saveState();
    this._emit('tutorial:step', { step: this._currentStep });
    this._render();
  };

  TutorialManager.prototype.prevStep = function () {
    if (this._currentStep <= 1) return;
    this._currentStep--;
    this._saveState();
    this._emit('tutorial:step', { step: this._currentStep });
    this._render();
  };

  TutorialManager.prototype.skip = function () {
    this._dismissed = true;
    this._saveState();
    this._emit('tutorial:skip', this.getState());
  };

  TutorialManager.prototype.complete = function () {
    this._completed = true;
    this._currentStep = TUTORIAL_STEPS; // success state
    this._saveState();
    this._emit('tutorial:complete', this.getState());
    this._render();
  };

  TutorialManager.prototype.reset = function () {
    this._currentStep = 0;
    this._completed = false;
    this._dismissed = false;
    this._saveState();
    this._emit('tutorial:reset', this.getState());
  };

  TutorialManager.prototype._render = function () {
    if (!this.containerEl) return;
    var self = this;

    // Update progress tracker if present
    if (this._progressTracker) {
      this._progressTracker.setStep(this._currentStep);
    }

    // Update template showcase visibility based on step
    if (this._templateShowcase) {
      var showcase = this.containerEl.querySelector('.ob-template-showcase');
      if (showcase) {
        showcase.style.display = (this._currentStep >= 2) ? '' : 'none';
      }
    }
  };

  TutorialManager.prototype._emit = function (eventName, data) {
    if (this.containerEl) {
      this.containerEl.dispatchEvent(new CustomEvent(eventName, { detail: data, bubbles: false }));
    }
    // Also emit on document for global listeners
    document.dispatchEvent(new CustomEvent(eventName, { detail: data, bubbles: true }));
  };

  // ─── Auto-init hook ─────────────────────────────────────────────────────────

  /**
   * Called by onboarding.html when DOM is ready.
   * Bootstraps all components and wires them together.
   */
  function autoInit(rootEl) {
    rootEl = rootEl || document;
    var tutorialRoot = rootEl.querySelector('[data-onboarding="tutorial"]');
    var progressEl   = rootEl.querySelector('[data-onboarding="progress"]');
    var showcaseEl   = rootEl.querySelector('[data-onboarding="showcase"]');
    var quickwinEl   = rootEl.querySelector('[data-onboarding="quickwin"]');

    var tm;
    if (tutorialRoot) {
      tm = new TutorialManager({ containerEl: tutorialRoot });
    }

    if (progressEl && tm) {
      var pt = new ProgressTracker(progressEl);
      tm._progressTracker = pt;
      pt.setStep(tm._currentStep);
    }

    if (showcaseEl) {
      var ts = new TemplateShowcase(showcaseEl);
      showcaseEl.addEventListener('template-select', function (e) {
        document.dispatchEvent(new CustomEvent('onboarding:template-selected', {
          detail: e.detail,
          bubbles: true
        }));
      });
    }

    if (quickwinEl) {
      var qw = new QuickWinDemo({
        containerEl: quickwinEl,
        onComplete: function () {
          document.dispatchEvent(new CustomEvent('onboarding:quickwin-complete', { bubbles: true }));
        }
      });
    }

    // Wire tutorial step buttons
    rootEl.querySelectorAll('[data-onboarding-action]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var action = btn.getAttribute('data-onboarding-action');
        if (!tm) return;
        if (action === 'next') tm.nextStep();
        else if (action === 'prev') tm.prevStep();
        else if (action === 'skip') tm.skip();
        else if (action === 'complete') tm.complete();
        else if (action === 'start') tm.start();
        else if (action === 'reset') tm.reset();
      });
    });

    return { tm: tm };
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  return {
    TutorialManager: TutorialManager,
    ProgressTracker: ProgressTracker,
    TemplateShowcase: TemplateShowcase,
    QuickWinDemo: QuickWinDemo,
    autoInit: autoInit,
    TEMPLATES: TEMPLATES,
    TUTORIAL_STEPS: TUTORIAL_STEPS,
    QUICK_WIN_DURATION_MS: QUICK_WIN_DURATION_MS
  };

}));
