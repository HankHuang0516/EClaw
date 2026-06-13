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

        container.innerHTML =
            // ── Capabilities (read-only Arena badges) ──
            '<div class="ace-field">' +
                '<label>' + t('dash_capabilities', 'Capabilities') +
                ' <span style="font-size:10px;color:var(--text-secondary);font-weight:400;">(' +
                t('dash_caps_arena_only', 'verified by Arena test — read-only') + ')</span></label>' +
                '<div class="ace-caps" id="aceCaps' + uid + '"></div>' +
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
