(function () {
    'use strict';

    const root = document.getElementById('ba-root');
    const params = new URLSearchParams(window.location.search);
    let entityId = parseInt(params.get('entityId'), 10);
    const publicCode = params.get('publicCode');

    // Pretty URL fallback: /portal/bot/:entityId/about → infer entityId from path
    if (!entityId) {
        const m = window.location.pathname.match(/\/portal\/bot\/(\d+)\/about\/?$/);
        if (m) entityId = parseInt(m[1], 10);
    }

    if (!entityId && !publicCode) {
        renderEmpty('No bot selected. Try ?entityId=2 or ?publicCode=3xa3h4.');
        return;
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    function renderEmpty(msg) {
        root.innerHTML = `<div class="ba-empty">${esc(msg)}<br><br><a href="/portal/community.html">← Browse the Bot Plaza</a></div>`;
    }

    function renderError(msg) {
        root.innerHTML = `<div class="ba-error">${esc(msg)}</div><div class="ba-empty"><a href="/portal/community.html">← Browse the Bot Plaza</a></div>`;
    }

    async function loadBackstory(eid) {
        if (!eid) return null;
        try {
            const r = await fetch(`/portal/bot/backstories/${eid}.json`, { credentials: 'omit' });
            if (!r.ok) return null;
            return await r.json();
        } catch (e) {
            return null;
        }
    }

    async function loadPlazaCard(code) {
        if (!code) return null;
        try {
            const r = await fetch(`/api/community/card/${encodeURIComponent(code)}`, { credentials: 'omit' });
            if (!r.ok) return null;
            const j = await r.json();
            return j && j.success ? j.card : null;
        } catch (e) {
            return null;
        }
    }

    function render(backstory, plaza) {
        if (!backstory && !plaza) {
            renderEmpty(`Bot ${entityId || publicCode} has no published backstory yet.`);
            return;
        }
        const b = backstory || {};
        const p = plaza || {};
        const name = b.displayName || p.name || `Bot ${entityId || ''}`;
        const callsign = b.callsign || p.character || '';
        const avatarUrl = p.avatar || '';
        const initial = (callsign || name || '?').slice(0, 2).toUpperCase();
        const tagline = b.tagline || p.description || '';

        const statsHtml = p && (p.level || p.xp || p.messageCount)
            ? `<div class="ba-stats">
                ${p.level ? `<div class="ba-stat">Lv <b>${p.level}</b></div>` : ''}
                ${p.xp ? `<div class="ba-stat">XP <b>${Number(p.xp).toLocaleString()}</b></div>` : ''}
                ${p.messageCount ? `<div class="ba-stat">Msgs <b>${p.messageCount}</b></div>` : ''}
                ${p.avgRating > 0 ? `<div class="ba-stat">★ <b>${p.avgRating.toFixed(1)}</b> (${p.ratingCount || 0})</div>` : ''}
            </div>`
            : '';

        function sectionList(s) {
            if (!s || !s.items || !s.items.length) return '';
            return `<section class="ba-section"><h2>${esc(s.title || '')}</h2><ul>${
                s.items.map(it => {
                    if (typeof it === 'string') return `<li>${esc(it)}</li>`;
                    return `<li><b>${esc(it.label || '')}</b> — ${esc(it.body || '')}</li>`;
                }).join('')
            }</ul></section>`;
        }
        function sectionTraits(s) {
            if (!s || !s.traits || !s.traits.length) return '';
            return `<section class="ba-section"><h2>${esc(s.title || '')}</h2>${
                s.traits.map(t => `<div class="ba-trait"><b>${esc(t.label || '')}</b><span class="ba-trait-body">${esc(t.body || '')}</span></div>`).join('')
            }</section>`;
        }
        function sectionScenarios(s) {
            if (!s || !s.scenarios || !s.scenarios.length) return '';
            return `<section class="ba-section"><h2>${esc(s.title || '')}</h2><ul>${
                s.scenarios.map(x => `<li>${esc(x)}</li>`).join('')
            }</ul></section>`;
        }
        function sectionBody(s) {
            if (!s || !s.body) return '';
            return `<section class="ba-section"><h2>${esc(s.title || '')}</h2><p>${esc(s.body)}</p></section>`;
        }
        function sectionGrowth(s) {
            if (!s || !s.arcs || !s.arcs.length) return '';
            return `<section class="ba-section"><h2>${esc(s.title || '')}</h2>${
                s.note ? `<p style="color:var(--text-dim);font-size:13px;">${esc(s.note)}</p>` : ''
            }${
                s.arcs.map(a => `
                    <div class="ba-arc">
                        <div class="ba-arc-head">
                            <span class="ba-arc-title">${esc(a.arc || '')}</span>
                            <span class="ba-arc-date">${esc(a.date || '')}</span>
                        </div>
                        <div class="ba-arc-body">${esc(a.body || '')}</div>
                    </div>
                `).join('')
            }</section>`;
        }

        const linksHtml = b.links ? `<div class="ba-links">${
            Object.entries(b.links).map(([label, url]) => `<a class="ba-link" href="${esc(url)}">${esc(label)}</a>`).join('')
        }</div>` : '';

        root.innerHTML = `
            <div class="ba-header">
                <div class="ba-avatar">${avatarUrl ? `<img src="${esc(avatarUrl)}" alt="">` : esc(initial)}</div>
                <div>
                    <h1 class="ba-name">${esc(name)}</h1>
                    ${callsign ? `<div class="ba-callsign">${esc(callsign)}${entityId ? ` · #${entityId}` : ''}</div>` : (entityId ? `<div class="ba-callsign">#${entityId}</div>` : '')}
                </div>
            </div>
            ${tagline ? `<p class="ba-tagline">${esc(tagline)}</p>` : ''}
            ${statsHtml}
            ${sectionBody(b.rationale)}
            ${sectionTraits(b.personality)}
            ${sectionScenarios(b.bestFit)}
            ${sectionList(b.relationships)}
            ${sectionGrowth(b.growthLog)}
            ${sectionList(b.boundaries)}
            ${linksHtml}
        `;
    }

    (async () => {
        try {
            const [backstory, plaza] = await Promise.all([
                loadBackstory(entityId),
                loadPlazaCard(publicCode || (await (async () => null)()))
            ]);
            // If we have a backstory with a publicCode and didn't fetch plaza yet, try again
            let plazaFinal = plaza;
            if (!plazaFinal && backstory && backstory.publicCode) {
                plazaFinal = await loadPlazaCard(backstory.publicCode);
            }
            render(backstory, plazaFinal);
        } catch (e) {
            renderError(`Failed to load: ${e.message}`);
        }
    })();
})();
