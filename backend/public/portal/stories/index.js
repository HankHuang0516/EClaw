(function () {
    'use strict';

    const grid = document.getElementById('st-grid');

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    function renderEmpty(msg) {
        grid.innerHTML = `<div class="st-empty">${esc(msg)}</div>`;
    }

    function renderCases(cases) {
        if (!Array.isArray(cases) || cases.length === 0) {
            renderEmpty('No published case studies yet — be the first.');
            return;
        }
        grid.innerHTML = cases.map(c => `
            <a class="st-card" href="/portal/stories/${esc(c.slug)}">
                ${c.tag ? `<div class="st-card-tag">${esc(c.tag)}</div>` : ''}
                <h2 class="st-card-title">${esc(c.title || c.slug)}</h2>
                ${c.summary ? `<p class="st-card-sub">${esc(c.summary)}</p>` : ''}
                <div class="st-card-foot">
                    <span>${esc(c.persona || '')}</span>
                    <span>${esc(c.publishedAt || '')}</span>
                </div>
            </a>
        `).join('');
    }

    (async () => {
        try {
            const r = await fetch('/portal/stories/cases/index.json', { credentials: 'omit' });
            if (!r.ok) {
                renderEmpty('Could not load story index.');
                return;
            }
            const data = await r.json();
            renderCases(data.cases || []);
        } catch (e) {
            renderEmpty(`Failed to load: ${e.message}`);
        }
    })();
})();
