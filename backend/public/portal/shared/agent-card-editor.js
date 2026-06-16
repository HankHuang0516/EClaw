/**
 * Shared Agent Card Editor Component
 *
 * Single source of truth for the Agent Card edit form used in:
 *   - dashboard.html (entity detail panel)
 *   - card-holder.html (my card detail modal)
 *
 * Capabilities are READ-ONLY — they come from Arena test results only.
 * Users can edit: description, protocols, tags, version, website, email.
 *
 * Usage:
 *   const editor = new AgentCardEditor(containerId, {
 *       entityId, deviceId, publicCode, identity, agentCard, isOwner
 *   });
 *   editor.render();
 *   editor.save();  // called by save button
 *
 * @brm-crossref: ④⑥ Bot Interview + Capability Assessment
 * If this module is updated, also update the roadmap page status.
 */

/* global apiCall, i18n, showToast */

window.AgentCardEditor = (function() {
    'use strict';

    function t(key, fallback) {
        return (typeof i18n !== 'undefined' && i18n.t) ? i18n.t(key) : fallback;
    }
    function esc(s) {
        var d = document.createElement('div');
        d.textContent = s || '';
        return d.innerHTML;
    }

    /**
     * @param {string} containerId — DOM element ID to render into
     * @param {Object} opts
     * @param {number} opts.entityId
     * @param {string} opts.deviceId
     * @param {string} opts.publicCode
     * @param {Object} opts.identity — full identity JSONB (may have interviewCapabilities)
     * @param {Object} opts.agentCard — identity.public or agentCard object
     * @param {boolean} opts.isOwner — true if editing own entity
     * @param {Function} [opts.onSave] — callback after successful save
     */
    function AgentCardEditor(containerId, opts) {
        this.containerId = containerId;
        this.entityId = opts.entityId;
        this.deviceId = opts.deviceId;
        this.publicCode = opts.publicCode;
        this.identity = opts.identity || {};
        this.ac = opts.agentCard || {};
        this.isOwner = opts.isOwner !== false;
        this.onSave = opts.onSave || function() {};
        this._tagData = { protocols: [], tags: [] };
        // Cleanup handle for the 1-second arena retest countdown tick
        // (card_959). Re-rendering replaces the DOM node, so we must
        // explicitly stop the prior interval before each render.
        this._stopRetestCountdown = null;
    }

    AgentCardEditor.prototype.render = function() {
        var container = document.getElementById(this.containerId);
        if (!container) return;

        var ac = this.ac;
        var self = this;
        var uid = this.entityId || Math.random().toString(36).slice(2, 6);

        // Determine Arena capabilities (read-only)
        var arenaCaps = this.identity.interviewCapabilities
            || ac.interviewCapabilities
            || (ac.capabilities && !Array.isArray(ac.capabilities) ? ac.capabilities : null);

        // Arena verified-score binding (card_ad404375). interviewCapabilities
        // here is the IDENTITY-level numeric score block written by the
        // /api/arena/leaderboard POST entity-binding path — distinct from
        // arenaCaps (which is the per-capability supported/unsupported map).
        // Falls back to identity.lastInterviewAt when score is unset.
        var arenaScore = (this.identity && this.identity.interviewCapabilities
            && typeof this.identity.interviewCapabilities.score === 'number')
            ? this.identity.interviewCapabilities
            : null;

        container.innerHTML =
            // ── Arena verified score (card_ad404375) ──
            '<div class="ace-field" data-arena-score-section="1">' +
                '<label>' + t('dash_arena_score', 'Arena Verified Score') +
                ' <span class="ace-help-tip" data-arena-help="1" tabindex="0" role="button" aria-label="' +
                    esc(t('dash_arena_score_help_aria', 'How to get a verified Arena score')) + '" ' +
                    'style="cursor:help;font-size:11px;color:var(--text-secondary);border:1px solid var(--card-border);border-radius:50%;padding:0 5px;margin-left:4px;">?</span></label>' +
                '<div class="ace-arena-score" id="aceArenaScore' + uid + '" aria-live="polite"></div>' +
            '</div>' +
            // ── Capabilities (read-only Arena badges) ──
            '<div class="ace-field">' +
                '<label>' + t('dash_capabilities', 'Capabilities') +
                ' <span style="font-size:10px;color:var(--text-secondary);font-weight:400;">(' +
                t('dash_caps_arena_only', 'verified by Arena test — read-only') + ')</span></label>' +
                '<div class="ace-caps" id="aceCaps' + uid + '"></div>' +
                // Arena retest countdown chip (card_959). Hidden until
                // _renderRetestCountdown() finds a lastInterviewAt.
                '<div class="ace-retest-slot" id="aceRetest' + uid + '"></div>' +
                (this.isOwner ? '<div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap;">' +
                    '<button class="btn btn-sm" id="aceInterviewBtn' + uid + '" style="font-size:12px;background:#10b981;color:#fff;border:none;">🧪 ' + t('dash_run_interview', 'Run Interview') + '</button>' +
                    '<button class="btn btn-sm btn-outline" id="aceRentalBtn' + uid + '" style="font-size:12px;" title="' + t('dash_list_rental', 'List for Rental') + t('dash_list_rental_paid_suffix', ' (paid rental)') + '">💴 ' + t('dash_list_rental', 'List for Rental') + t('dash_list_rental_paid_suffix', ' (paid rental)') + '</button>' +
                    '<button class="btn btn-sm btn-outline" id="aceArenaBtn' + uid + '" style="font-size:12px;opacity:0.7;">' + t('dash_run_arena', '📝 Eval Center') + '</button>' +
                '</div>' +
                '<div id="aceInterviewStatus' + uid + '" style="margin-top:8px;font-size:12px;"></div>' : '') +
            '</div>' +
            // ── Description ──
            '<div class="ace-field">' +
                '<label>' + t('dash_id_public_desc', 'Description') + '</label>' +
                '<textarea id="aceDesc' + uid + '" maxlength="500" rows="2" placeholder="' + t('dash_id_public_desc_hint', 'Description...') + '">' + esc(ac.description) + '</textarea>' +
            '</div>' +
            // ── Protocols ──
            '<div class="ace-field">' +
                '<label>' + t('dash_protocols', 'Protocols') + '</label>' +
                '<div class="ac-tags" id="aceProtos' + uid + '"></div>' +
                '<div class="ac-tag-input"><input type="text" id="aceProtoIn' + uid + '" placeholder="e.g. A2A, REST" maxlength="64"><button class="btn btn-sm btn-outline" id="aceProtoAdd' + uid + '">+</button></div>' +
            '</div>' +
            // ── Tags ──
            '<div class="ace-field">' +
                '<label>' + t('dash_tags', 'Tags') + '</label>' +
                '<div class="ac-tags" id="aceTags' + uid + '"></div>' +
                '<div class="ac-tag-input"><input type="text" id="aceTagIn' + uid + '" placeholder="e.g. chat, IoT" maxlength="64"><button class="btn btn-sm btn-outline" id="aceTagAdd' + uid + '">+</button></div>' +
            '</div>' +
            // ── Version ──
            '<div class="ace-field">' +
                '<label>' + t('dash_version', 'Version') + '</label>' +
                '<input type="text" id="aceVersion' + uid + '" maxlength="32" placeholder="1.0.0" value="' + esc(ac.version) + '">' +
            '</div>' +
            // ── Website ──
            '<div class="ace-field">' +
                '<label>' + t('dash_website', 'Website') + '</label>' +
                '<input type="text" id="aceWebsite' + uid + '" maxlength="500" placeholder="https://..." value="' + esc(ac.website) + '">' +
            '</div>' +
            // ── Email ──
            '<div class="ace-field">' +
                '<label>' + t('cardholder_email_label', 'Email') + '</label>' +
                '<input type="text" id="aceEmail' + uid + '" maxlength="255" placeholder="contact@example.com" value="' + esc(ac.contactEmail) + '">' +
            '</div>';

        this._uid = uid;

        // Render Arena verified score badge (card_ad404375)
        this._renderArenaScore(arenaScore);

        // Wire ? icon help tooltip — click/hover/focus reveals what + needs +
        // concrete next step (Globe-user setup-conditions UX rule).
        var helpTip = container.querySelector('.ace-help-tip[data-arena-help="1"]');
        if (helpTip) {
            var self2 = this;
            var helpToggle = function() { self2._showArenaScoreHelp(helpTip); };
            helpTip.addEventListener('click', helpToggle);
            helpTip.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); helpToggle(); }
            });
        }

        // Render Arena capability badges
        this._renderCaps(arenaCaps);

        // Render tags
        this._renderTags('aceProtos' + uid, ac.protocols || []);
        this._renderTags('aceTags' + uid, ac.tags || []);
        this._tagData.protocols = ac.protocols || [];
        this._tagData.tags = ac.tags || [];

        // Wire tag add buttons
        var protoAdd = document.getElementById('aceProtoAdd' + uid);
        if (protoAdd) protoAdd.onclick = function() { self._addTag('aceProtos', 'aceProtoIn', 'protocols', 10); };
        var tagAdd = document.getElementById('aceTagAdd' + uid);
        if (tagAdd) tagAdd.onclick = function() { self._addTag('aceTags', 'aceTagIn', 'tags', 20); };

        // Wire buttons
        if (this.isOwner) {
            var interviewBtn = document.getElementById('aceInterviewBtn' + uid);
            if (interviewBtn) interviewBtn.onclick = function() { self._runInterview(); };
            var rentalBtn = document.getElementById('aceRentalBtn' + uid);
            if (rentalBtn) rentalBtn.onclick = function() { self._listForRental(); };
            var arenaBtn = document.getElementById('aceArenaBtn' + uid);
            if (arenaBtn) arenaBtn.onclick = function() { self._openArena(); };
        }

        // Stop any prior tick before render(), then render + attach the
        // arena retest countdown.
        if (typeof this._stopRetestCountdown === 'function') {
            this._stopRetestCountdown();
            this._stopRetestCountdown = null;
        }
        this._renderRetestCountdown();
    };

    /**
     * Render the arena retest countdown chip below Capabilities.
     *
     * The ONLY source of truth for `last_interview_at` is the server —
     * specifically the `bot_listings.last_interview_at` column, exposed via
     * GET /api/rental/my-listings. We never trust `identity.lastInterviewAt`
     * even if a caller passes it in: identity JSONB is owner-writable via
     * PUT /api/entity/identity, so honoring it would let an owner reset
     * their own Arena retest cooldown to "fresh" instantly. Card scope
     * explicitly forbids client-side cooldown spoofing.
     *
     * The chip is also gated on `isOwner` — public viewers of an agent
     * card don't need (and aren't entitled to) cooldown timing for someone
     * else's bot, and skipping the fetch saves an unauthenticated 401 per
     * card render on the marketplace browse path.
     */
    AgentCardEditor.prototype._renderRetestCountdown = function() {
        var self = this;
        var slot = document.getElementById('aceRetest' + this._uid);
        if (!slot) return;
        slot.innerHTML = '';

        var helpers = (typeof window !== 'undefined' && window.EntityRetestCountdown) || null;
        if (!helpers) return;

        // Owner-only: see comment block above.
        if (!this.isOwner) return;
        if (typeof apiCall !== 'function') return;

        function mount(deadlineMs) {
            if (!Number.isFinite(deadlineMs)) return;
            slot.innerHTML = helpers.renderRetestCountdownHtml(deadlineMs);
            var node = slot.querySelector('.retest-countdown');
            if (node) self._stopRetestCountdown = helpers.attachRetestCountdown(node);
        }

        // Server-authoritative source: /api/rental/my-listings returns
        // `last_interview_at` from `bot_listings`, written ONLY by the
        // Arena exam-complete handler (interview-arena.js:1533). The owner
        // can't PUT this field. Skip silently on any error — the chip
        // just stays hidden, which is the correct UX for "no listing yet."
        apiCall('GET', '/api/rental/my-listings', null, { skip401Redirect: true })
            .then(function(res) {
                if (!res || !Array.isArray(res.listings)) return;
                var match = res.listings.find(function(l) {
                    return String(l.owner_entity_id) === String(self.entityId);
                });
                if (!match || !match.last_interview_at) return;
                var dl = helpers.computeRetestDeadlineMs(match.last_interview_at);
                if (Number.isFinite(dl)) mount(dl);
            })
            .catch(function() { /* hide chip on any error */ });
    };

    /**
     * Stop the countdown interval. Pages that destroy the editor before the
     * DOM node is removed should call this to prevent the tick from running
     * against a detached node.
     */
    AgentCardEditor.prototype.destroy = function() {
        if (typeof this._stopRetestCountdown === 'function') {
            this._stopRetestCountdown();
            this._stopRetestCountdown = null;
        }
    };

    AgentCardEditor.prototype._renderCaps = function(caps) {
        var container = document.getElementById('aceCaps' + this._uid);
        if (!container) return;
        container.innerHTML = '';
        if (!caps || typeof caps !== 'object' || Object.keys(caps).length === 0) {
            container.innerHTML = '<div style="font-size:12px;color:var(--text-secondary);padding:8px 0;">' +
                t('dash_caps_none', 'No Arena test results yet. Run an Arena test to verify capabilities.') + '</div>';
            return;
        }
        Object.entries(caps).forEach(function(entry) {
            var key = entry[0], val = entry[1];
            var supported = val && val.supported;
            var badge = document.createElement('span');
            badge.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:12px;font-size:11px;font-weight:600;margin:2px 4px 2px 0;' +
                (supported
                    ? 'background:rgba(16,185,129,0.15);color:#10b981;border:1px solid rgba(16,185,129,0.3);'
                    : 'background:var(--input-bg);color:var(--text-secondary);border:1px solid var(--card-border);');
            var pctStr = '';
            if (val.probes && val.probes[0] && val.probes[0].maxScore > 0) {
                pctStr = ' (' + Math.round(val.probes[0].score / val.probes[0].maxScore * 100) + '%)';
            }
            badge.textContent = (supported ? '✅ ' : '❌ ') + key + pctStr;
            container.appendChild(badge);
        });
    };

    /**
     * Render the Arena verified numeric score on the namecard.
     * Empty state shows a "尚未面試 / No interview yet" placeholder with
     * a `?` icon explaining how to get a score (Globe-user setup UX rule).
     */
    AgentCardEditor.prototype._renderArenaScore = function(score) {
        var container = document.getElementById('aceArenaScore' + this._uid);
        if (!container) return;
        container.innerHTML = '';
        if (!score || typeof score.score !== 'number' || typeof score.maxScore !== 'number' || score.maxScore <= 0) {
            // Empty state — no interview recorded yet.
            var empty = document.createElement('div');
            empty.style.cssText = 'font-size:12px;color:var(--text-secondary);padding:8px 0;';
            empty.textContent = t('dash_arena_score_empty', '尚未面試 — 點擊「Run Interview」開始驗證 / No interview yet — click Run Interview to start');
            container.appendChild(empty);
            return;
        }
        var pct = (typeof score.normalized === 'number')
            ? score.normalized
            : Math.round((score.score / score.maxScore) * 100);
        var passed = !!score.passed;
        var badge = document.createElement('div');
        badge.style.cssText = 'display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border-radius:14px;font-size:13px;font-weight:600;' +
            (passed
                ? 'background:rgba(16,185,129,0.15);color:#10b981;border:1px solid rgba(16,185,129,0.3);'
                : 'background:rgba(245,158,11,0.12);color:#f59e0b;border:1px solid rgba(245,158,11,0.3);');
        // Use textContent to keep score data XSS-safe. Owner-controlled strings
        // (model) are escaped via esc() before going into HTML; numeric fields
        // come from server enrichment and are always Number-coerced upstream.
        badge.setAttribute('aria-label',
            (passed ? t('dash_arena_score_passed_aria', 'Arena verified: passed') : t('dash_arena_score_attempt_aria', 'Arena verified: attempt')) +
            ' ' + score.score + ' / ' + score.maxScore + ' (' + pct + '%)');
        badge.textContent = (passed ? '✓ ' : '• ') +
            t('dash_arena_score_label', 'Arena') + ' ' +
            score.score + '/' + score.maxScore + ' (' + pct + '%)';
        container.appendChild(badge);

        // Sub-line: model + completedAt
        if (score.completedAt) {
            var date = new Date(score.completedAt);
            var sub = document.createElement('div');
            sub.style.cssText = 'font-size:11px;color:var(--text-secondary);margin-top:4px;';
            var dateStr;
            try { dateStr = date.toISOString().slice(0, 10); } catch (e) { dateStr = ''; }
            var modelPart = score.model ? (' • ' + esc(String(score.model).slice(0, 32))) : '';
            sub.innerHTML = (passed
                ? t('dash_arena_score_passed', 'Passed')
                : t('dash_arena_score_attempt', 'Attempt')) +
                ' ' + dateStr + modelPart;
            container.appendChild(sub);
        }
    };

    /**
     * Show the ? icon help — fires inline popover or alert as fallback.
     * Spec content: what (verified score) + needs (run an Arena exam) +
     * concrete next step (click Run Interview). Globe-user copy.
     */
    AgentCardEditor.prototype._showArenaScoreHelp = function(anchor) {
        var msg = t('dash_arena_score_help_body',
            'The verified score is recorded after your bot completes an Arena interview.\n\nTo get a score:\n1. Click "Run Interview" above\n2. Your bot runs 12 challenges (≤3 min)\n3. Score binds to this namecard and appears on the plaza');
        // Lightweight popover: append a tooltip div next to the anchor that
        // auto-dismisses on outside click. Falls back to alert() if DOM is
        // weird (e.g. anchor detached).
        try {
            var existing = document.querySelector('.ace-help-popover');
            if (existing) existing.remove();
            var pop = document.createElement('div');
            pop.className = 'ace-help-popover';
            pop.setAttribute('role', 'tooltip');
            pop.style.cssText = 'position:absolute;z-index:9999;max-width:280px;background:var(--card-bg,#1e1e2e);color:var(--text-primary,#fff);border:1px solid var(--card-border,#333);padding:10px 12px;border-radius:8px;font-size:12px;line-height:1.5;white-space:pre-line;box-shadow:0 4px 12px rgba(0,0,0,0.3);';
            pop.textContent = msg;
            // Position relative to anchor
            var r = anchor.getBoundingClientRect();
            pop.style.left = (window.scrollX + r.left) + 'px';
            pop.style.top = (window.scrollY + r.bottom + 6) + 'px';
            document.body.appendChild(pop);
            var cleanup = function() {
                if (pop && pop.parentNode) pop.remove();
                document.removeEventListener('click', dismiss, true);
                document.removeEventListener('keydown', onKey, true);
                // Restore focus to the trigger so keyboard users don't lose place.
                try { if (anchor && typeof anchor.focus === 'function') anchor.focus(); } catch (_) {}
            };
            var dismiss = function(ev) {
                if (ev && pop.contains(ev.target)) return;
                cleanup();
            };
            // Escape-key dismiss for keyboard-only users (a11y).
            var onKey = function(ev) {
                if (ev.key === 'Escape' || ev.key === 'Esc') {
                    ev.preventDefault();
                    cleanup();
                }
            };
            // Defer so the click that opened the tip doesn't close it
            setTimeout(function() {
                document.addEventListener('click', dismiss, true);
                document.addEventListener('keydown', onKey, true);
            }, 0);
        } catch (e) {
            alert(msg);
        }
    };

    AgentCardEditor.prototype._renderTags = function(containerId, tags) {
        var container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = '';
        var self = this;
        tags.forEach(function(tag) {
            var span = document.createElement('span');
            span.className = 'ac-tag';
            span.innerHTML = esc(tag) + ' <button class="ac-tag-remove">&times;</button>';
            span.querySelector('.ac-tag-remove').onclick = function() {
                span.remove();
                // Update internal data
                var key = containerId.includes('Proto') ? 'protocols' : 'tags';
                self._tagData[key] = self._tagData[key].filter(function(t) { return t !== tag; });
            };
            container.appendChild(span);
        });
    };

    AgentCardEditor.prototype._addTag = function(containerPrefix, inputPrefix, dataKey, max) {
        var uid = this._uid;
        var input = document.getElementById(inputPrefix + uid);
        var val = (input.value || '').trim();
        if (!val) return;
        if (this._tagData[dataKey].length >= max) {
            if (typeof showToast === 'function') showToast('Max ' + max + ' items', 'warning');
            return;
        }
        this._tagData[dataKey].push(val);
        this._renderTags(containerPrefix + uid, this._tagData[dataKey]);
        input.value = '';
    };

    /** Collect form values (capabilities excluded — locked by Arena) */
    AgentCardEditor.prototype.collect = function() {
        var uid = this._uid;
        var el = function(id) { return document.getElementById(id); };
        return {
            description: (el('aceDesc' + uid)?.value || '').trim(),
            // capabilities: intentionally omitted — Arena-locked
            protocols: this._tagData.protocols.slice(),
            tags: this._tagData.tags.slice(),
            version: (el('aceVersion' + uid)?.value || '').trim(),
            website: (el('aceWebsite' + uid)?.value || '').trim(),
            contactEmail: (el('aceEmail' + uid)?.value || '').trim(),
        };
    };

    /** Save via PUT /api/entity/agent-card */
    AgentCardEditor.prototype.save = async function() {
        var data = this.collect();
        try {
            var res = await apiCall('PUT', '/api/entity/agent-card', {
                deviceId: this.deviceId,
                entityId: this.entityId,
                agentCard: data,
            });
            if (res && res.success) {
                if (typeof showToast === 'function') showToast(t('dash_id_saved', 'Saved'), 'success');
                this.onSave(data);
            } else {
                if (typeof showToast === 'function') showToast(res?.error || 'Failed', 'error');
            }
        } catch (err) {
            if (typeof showToast === 'function') showToast(err.message || 'Failed', 'error');
        }
    };

    /**
     * Run the automated webhook-based interview.
     * Pushes 8 text probes to the bot's webhook → bot responds via /api/transform
     * → server scores responses → capabilities auto-synced to Agent Card.
     * No human intervention needed.
     */
    AgentCardEditor.prototype._runInterview = async function() {
        var uid = this._uid;
        var statusEl = document.getElementById('aceInterviewStatus' + uid);
        var btn = document.getElementById('aceInterviewBtn' + uid);

        try {
            // Ensure a listing exists for this entity
            var listings = await apiCall('GET', '/api/rental/my-listings', null, { skip401Redirect: true });
            var existing = (listings.listings || []).find(function(l) {
                return String(l.owner_entity_id) === String(this.entityId);
            }.bind(this));
            var listingId = existing ? existing.id : null;

            if (!listingId) {
                var createRes = await apiCall('POST', '/api/rental/listing', {
                    ownerDeviceId: this.deviceId,
                    ownerEntityId: this.entityId,
                    title: 'My Bot',
                    rateMliPerKtoken: 5000,
                });
                if (createRes.success) listingId = createRes.listing.id;
            }

            if (!listingId) {
                if (statusEl) statusEl.innerHTML = '<span style="color:#ef4444;">❌ ' + t('dash_interview_no_listing', 'Failed to create listing') + '</span>';
                return;
            }

            // Create Arena exam linked to listing, then redirect
            btn.disabled = true;
            btn.textContent = '⏳ ' + t('dash_interview_running', 'Running...');
            if (statusEl) statusEl.innerHTML = '<span style="color:#f59e0b;">⏳ ' +
                t('dash_interview_creating', 'Creating evaluation...') + '</span>';

            var examRes = await apiCall('POST', '/api/arena/exam', { listingId: listingId });

            btn.disabled = false;
            btn.textContent = '🧪 ' + t('dash_run_interview', 'Run Interview');

            if (examRes.success && examRes.exam) {
                var returnUrl = encodeURIComponent(window.location.href);
                var examUrl = examRes.exam.examUrl || ('/arena/exam/' + examRes.exam.id);
                window.open(examUrl + '?returnUrl=' + returnUrl, '_blank');
                if (statusEl) statusEl.innerHTML = '<span style="color:#10b981;">✅ ' +
                    t('dash_interview_opened', 'Evaluation opened in new tab') +
                    ' <a href="' + examUrl + '?returnUrl=' + returnUrl + '" target="_blank" style="color:var(--primary);">' +
                    t('dash_interview_view_results', 'View Results →') + '</a></span>';
            } else {
                // SI stream D card_7fc8e7ab: friendly message + error_id for
                // support reference instead of leaking the raw server token.
                this._renderInterviewError(statusEl, examRes.error || null);
            }
        } catch (err) {
            btn.disabled = false;
            btn.textContent = '🧪 ' + t('dash_run_interview', 'Run Interview');
            this._renderInterviewError(statusEl, err && err.message);
        }
    };

    /**
     * SI stream D - card_7fc8e7ab: replace raw server error codes with a
     * localized friendly message plus an error_id the user can quote to
     * support. Raw code is logged via console.error so technical users can
     * still find it in DevTools - only the user-visible surface is sanitized.
     */
    AgentCardEditor.prototype._renderInterviewError = function(statusEl, rawError) {
        if (!statusEl) return;
        var errorId = (Math.random().toString(16).slice(2, 6) + Math.random().toString(16).slice(2, 6));
        var friendly = t('dash_interview_failed_retry',
            'Interview could not start - please try again. Reference code: %s');
        var withCode = friendly.indexOf('%s') >= 0
            ? friendly.replace('%s', errorId)
            : (friendly + ' (' + errorId + ')');
        statusEl.textContent = '';
        var sp = document.createElement('span');
        sp.style.color = '#ef4444';
        sp.textContent = '\u274c ' + withCode;
        statusEl.appendChild(sp);
        try { console.error('[interview] error_id=' + errorId + ' raw=' + (rawError || 'unknown')); } catch (_) {}
    };

    AgentCardEditor.prototype._openArena = async function() {
        try {
            var listings = await apiCall('GET', '/api/rental/my-listings', null, { skip401Redirect: true });
            var existing = (listings.listings || []).find(function(l) {
                return String(l.owner_entity_id) === String(this.entityId);
            }.bind(this));
            var listingId = existing ? existing.id : null;
            if (!listingId) {
                var res = await apiCall('POST', '/api/rental/listing', {
                    ownerDeviceId: this.deviceId,
                    ownerEntityId: this.entityId,
                    title: 'My Bot',
                    rateMliPerKtoken: 5000,
                });
                if (res.success) listingId = res.listing.id;
            }
            window.open('/arena' + (listingId ? '?listingId=' + listingId : ''), '_blank');
        } catch (err) {
            window.open('/arena', '_blank');
        }
    };

    AgentCardEditor.prototype._listForRental = async function() {
        try {
            var listings = await apiCall('GET', '/api/rental/my-listings', null, { skip401Redirect: true });
            var existing = (listings.listings || []).find(function(l) {
                return String(l.owner_entity_id) === String(this.entityId);
            }.bind(this));
            // Interview gate (Hank 2026-04-24): you cannot set a rate or list
            // for rent until the listing has passed an interview.
            if (!existing) {
                if (typeof showToast === 'function') showToast(
                    t('dash_interview_required_first', 'Please run the interview first before listing for rent.'),
                    'warning'
                );
                return;
            }
            if (!existing.interview_passed) {
                if (typeof showToast === 'function') showToast(
                    t('dash_interview_not_passed_yet', 'Interview not passed yet — finish the interview before setting a price.'),
                    'warning'
                );
                return;
            }
            if (existing.status === 'listed') {
                if (typeof showToast === 'function') showToast(t('dash_listing_exists', 'Listing already exists'), 'info');
                return;
            }
            var rate = prompt(t('dash_listing_rate_prompt', 'Set rate (e-coin per 1K tokens):'), '5');
            if (!rate) return;
            var patchRes = await apiCall('PATCH', '/api/rental/listing/' + existing.id, {
                rateMliPerKtoken: parseInt(rate, 10) * 1000,
            });
            if (!patchRes || !patchRes.success) {
                if (typeof showToast === 'function') showToast((patchRes && patchRes.error) || 'Failed', 'error');
                return;
            }
            var pubRes = await apiCall('POST', '/api/rental/listing/' + existing.id + '/publish', {});
            if (pubRes && pubRes.success) {
                if (typeof showToast === 'function') showToast(t('dash_listing_published', 'Listed for rent!'), 'success');
            } else {
                if (typeof showToast === 'function') showToast((pubRes && pubRes.error) || 'Failed', 'error');
            }
        } catch (err) {
            if (typeof showToast === 'function') showToast(err.message || 'Failed', 'error');
        }
    };

    return AgentCardEditor;
})();
