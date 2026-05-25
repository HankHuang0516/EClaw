(function () {
    'use strict';

    const root = document.getElementById('sc-root');
    const params = new URLSearchParams(window.location.search);
    let slug = (params.get('slug') || '').trim();

    if (!slug) {
        const m = window.location.pathname.match(/\/portal\/stories\/([a-z0-9][a-z0-9-]*[a-z0-9])\/?$/i);
        if (m) slug = m[1].toLowerCase();
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    function renderError(msg) {
        root.innerHTML = `<div class="sc-error">${esc(msg)}</div>`;
    }

    if (!slug) {
        renderError('No case study selected. See the index at /portal/stories/.');
        return;
    }

    function sectionParas(s) {
        if (!s || !Array.isArray(s.body) || s.body.length === 0) return '';
        return `<section class="sc-section"><h2>${esc(s.title || '')}</h2>${
            s.body.map(p => `<p>${esc(p)}</p>`).join('')
        }</section>`;
    }
    function sectionList(s) {
        if (!s || !Array.isArray(s.items) || s.items.length === 0) return '';
        return `<section class="sc-section"><h2>${esc(s.title || '')}</h2><ul>${
            s.items.map(it => {
                if (typeof it === 'string') return `<li>${esc(it)}</li>`;
                return `<li><b>${esc(it.label || '')}</b>${it.body ? ` — ${esc(it.body)}` : ''}</li>`;
            }).join('')
        }</ul></section>`;
    }
    function sectionStack(s) {
        if (!s || !Array.isArray(s.agents) || s.agents.length === 0) return '';
        return `<section class="sc-section"><h2>${esc(s.title || 'The stack')}</h2><div class="sc-stack">${
            s.agents.map(a => `
                <div class="sc-stack-item">
                    <div class="sc-stack-name">${esc(a.name || '')}</div>
                    <div class="sc-stack-role">${esc(a.role || '')}</div>
                </div>
            `).join('')
        }</div></section>`;
    }
    function sectionMetrics(s) {
        if (!s || !Array.isArray(s.items) || s.items.length === 0) return '';
        return `<section class="sc-section"><h2>${esc(s.title || 'By the numbers')}</h2><div class="sc-metrics">${
            s.items.map(m => `
                <div class="sc-metric">
                    <div class="sc-metric-num">${esc(m.value || '')}</div>
                    <div class="sc-metric-lab">${esc(m.label || '')}</div>
                </div>
            `).join('')
        }</div></section>`;
    }
    function sectionQuote(s) {
        if (!s || !s.text) return '';
        return `<section class="sc-section"><h2>${esc(s.title || 'In their words')}</h2><div class="sc-quote">${esc(s.text)}</div>${
            s.attribution ? `<div style="color:var(--text-dim);font-size:13px;">— ${esc(s.attribution)}</div>` : ''
        }</section>`;
    }

    function render(c) {
        const meta = [];
        if (c.persona) meta.push(c.persona);
        if (c.location) meta.push(c.location);
        if (c.publishedAt) meta.push(c.publishedAt);
        const linksHtml = c.links ? `<div class="sc-cta">${
            Object.entries(c.links).map(([label, url], i) => `<a class="${i === 0 ? 'primary' : ''}" href="${esc(url)}">${esc(label)}</a>`).join('')
        }</div>` : '';

        document.title = `${c.title || 'Case Study'} — EClawbot`;
        root.innerHTML = `
            ${c.tag ? `<div class="sc-eyebrow">${esc(c.tag)}</div>` : ''}
            <h1 class="sc-title">${esc(c.title || slug)}</h1>
            ${c.summary ? `<p class="sc-sub">${esc(c.summary)}</p>` : ''}
            ${meta.length ? `<div class="sc-meta">${meta.map(x => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
            ${sectionParas(c.background)}
            ${sectionStack(c.stack)}
            ${sectionParas(c.workflow)}
            ${sectionList(c.wins)}
            ${sectionMetrics(c.metrics)}
            ${sectionQuote(c.quote)}
            ${sectionList(c.lessons)}
            ${linksHtml}
        `;
    }

    (async () => {
        try {
            const r = await fetch(`/portal/stories/cases/${encodeURIComponent(slug)}.json`, { credentials: 'omit' });
            if (!r.ok) {
                renderError(`No case study found for "${slug}". See the index at /portal/stories/.`);
                return;
            }
            const data = await r.json();
            render(data);
        } catch (e) {
            renderError(`Failed to load: ${e.message}`);
        }
    })();
})();
