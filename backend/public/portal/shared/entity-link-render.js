/**
 * Entity Link Render — unified client-side module to detect entity references
 * in chat messages and render them as colour-coded clickable chips.
 *
 * Supported patterns (all case-insensitive, with optional colon/space):
 *   Card xxxxxxxx[-...]     → blue chip,  opens kanban card modal
 *   Skill xxxxxxxx[-...]    → purple chip, opens skill modal
 *   Rule xxxxxxxx[-...]     → red chip,    opens rule modal
 *   Listing xxxxxxxx[-...]  → orange chip, opens listing modal
 *   Exam xxxxxxxx[-...]     → teal chip,   opens exam modal
 *   Contract xxxxxxxx[-...] → green chip,  opens contract modal
 *
 * All render functions expect already-escaped HTML (post-DOMPurify / post-escapeHtml).
 */
(function (global) {
    'use strict';

    // ── Entity type definitions ──
    const ENTITY_TYPES = {
        card:     { color: '#60a5fa', bg: 'rgba(96,165,250,0.2)',  icon: 'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2' },
        skill:    { color: '#c084fc', bg: 'rgba(192,132,252,0.2)', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
        rule:     { color: '#f87171', bg: 'rgba(248,113,113,0.2)', icon: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' },
        listing:  { color: '#fb923c', bg: 'rgba(251,146,60,0.2)',  icon: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' },
        exam:     { color: '#2dd4bf', bg: 'rgba(45,212,191,0.2)',  icon: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11' },
        contract: { color: '#4ade80', bg: 'rgba(74,222,128,0.2)',  icon: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8' }
    };

    // Build a combined regex: (card|skill|rule|listing|exam|contract) + optional colon + UUID or 8-char hex
    const TYPE_NAMES = Object.keys(ENTITY_TYPES).join('|');

    // Full UUID after keyword
    const FULL_RE = new RegExp(
        '\\b(' + TYPE_NAMES + ')\\s*[:：]?\\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\b', 'gi'
    );

    // Short 8-char hex after keyword
    const SHORT_RE = new RegExp(
        '\\b(' + TYPE_NAMES + ')\\s*[:：]?\\s*([0-9a-f]{8})\\b', 'gi'
    );

    // Placeholder system (same approach as note-link-render)
    const pendingChips = [];

    function queueChip(type, entityId, displayId) {
        const idx = pendingChips.length;
        pendingChips.push({ type, entityId, displayId });
        return `\x00ENTITYCHIP[${idx}]\x00`;
    }

    function flushChips(html) {
        const result = html.replace(/\x00ENTITYCHIP\[(\d+)\]\x00/g, (m, idx) => {
            const c = pendingChips[parseInt(idx)];
            return buildChipHtml(c.type, c.entityId, c.displayId);
        });
        pendingChips.length = 0;
        return result;
    }

    function buildChipHtml(type, entityId, displayId) {
        const t = ENTITY_TYPES[type] || ENTITY_TYPES.card;
        const label = type.charAt(0).toUpperCase() + type.slice(1);
        return `<span class="entity-link entity-link-${type}" data-entity-type="${type}" data-entity-id="${entityId}" ` +
               `onclick="openEntityModal('${type}','${entityId}')" title="${label} ${displayId}" ` +
               `style="background:${t.bg};color:${t.color};">` +
               `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
               `style="vertical-align:-1px;margin-right:3px;"><path d="${t.icon}"/></svg>${displayId}</span>`;
    }

    /**
     * Replace entity reference patterns in escaped HTML with clickable chips.
     */
    function renderEntityLinks(escapedHtml) {
        if (!escapedHtml) return escapedHtml;

        // Split by code/pre to skip code blocks
        const parts = escapedHtml.split(/(<code[\s>][\s\S]*?<\/code>|<pre[\s>][\s\S]*?<\/pre>)/gi);

        for (let i = 0; i < parts.length; i++) {
            if (i % 2 === 1) continue; // skip code blocks

            // Phase 1: full UUID patterns
            parts[i] = parts[i].replace(FULL_RE, (match, type, uuid) => {
                const short = uuid.substring(0, 8);
                return queueChip(type.toLowerCase(), uuid, short);
            });

            // Phase 2: short 8-char hex patterns
            parts[i] = parts[i].replace(SHORT_RE, (match, type, shortId) => {
                return queueChip(type.toLowerCase(), shortId, shortId);
            });
        }

        return flushChips(parts.join(''));
    }

    global.EntityLinkRender = {
        renderEntityLinks,
        ENTITY_TYPES
    };
})(window);
