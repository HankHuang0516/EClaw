/**
 * Entity Link Render — unified client-side module to detect entity references
 * in chat messages and render them as colour-coded clickable chips.
 *
 * Supported patterns (all case-insensitive, with optional colon/space):
 *   Card / 卡號 / 卡片 / 任務 + id     → blue chip,  opens kanban card modal
 *   Skill / 技能 + id                  → purple chip, opens skill modal
 *   Rule / 規則 + id                   → red chip,    opens rule modal
 *   Listing / 掛牌 / 上架 + id         → orange chip, opens listing modal
 *   Exam / 考試 / 測驗 + id            → teal chip,   opens exam modal
 *   Contract / 合約 + id               → green chip,  opens contract modal
 *
 * IDs can be full UUIDs (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx) or 8-char short
 * prefixes; optional ":", "：" or "#" separator between keyword and id.
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
        contract: { color: '#4ade80', bg: 'rgba(74,222,128,0.2)',  icon: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8' },
        mindmap:  { color: '#a78bfa', bg: 'rgba(167,139,250,0.2)', icon: 'M12 2a3 3 0 0 1 3 3v2a3 3 0 0 1-3 3 3 3 0 0 1-3-3V5a3 3 0 0 1 3-3zM5 14a3 3 0 0 1 3 3v2a3 3 0 0 1-3 3 3 3 0 0 1-3-3v-2a3 3 0 0 1 3-3zm14 0a3 3 0 0 1 3 3v2a3 3 0 0 1-3 3 3 3 0 0 1-3-3v-2a3 3 0 0 1 3-3zM12 10v3M9 16l3-3 3 3' }
    };

    // Keyword → entity type. ASCII keys are matched case-insensitively (regex 'i').
    // CJK keys are matched verbatim; both traditional and simplified forms are listed.
    const KEYWORD_TO_TYPE = {
        'card': 'card', 'cards': 'card',
        '卡號': 'card', '卡号': 'card', '卡片': 'card', '任務': 'card', '任务': 'card',
        'skill': 'skill', 'skills': 'skill',
        '技能': 'skill',
        'rule': 'rule', 'rules': 'rule',
        '規則': 'rule', '规则': 'rule',
        'listing': 'listing', 'listings': 'listing',
        '掛牌': 'listing', '挂牌': 'listing', '上架': 'listing',
        'exam': 'exam', 'exams': 'exam',
        '考試': 'exam', '考试': 'exam', '測驗': 'exam', '测验': 'exam',
        'contract': 'contract', 'contracts': 'contract',
        '合約': 'contract', '合约': 'contract',
        'mindmap': 'mindmap', 'mindmaps': 'mindmap',
        '心智圖': 'mindmap', '心智图': 'mindmap', '節點': 'mindmap', '节点': 'mindmap'
    };

    const ASCII_KEYWORDS = Object.keys(KEYWORD_TO_TYPE).filter(k => /^[a-z]+$/i.test(k));
    const CJK_KEYWORDS = Object.keys(KEYWORD_TO_TYPE).filter(k => !/^[a-z]+$/i.test(k));

    // Keyword alternation: ASCII keywords get \b boundary; CJK keywords don't need one.
    // Two capture groups — exactly one is non-empty per match.
    const KW = '(?:\\b(' + ASCII_KEYWORDS.join('|') + ')|(' + CJK_KEYWORDS.join('|') + '))';

    function resolveKeyword(asciiKw, cjkKw) {
        const raw = (asciiKw || cjkKw || '').toLowerCase();
        return KEYWORD_TO_TYPE[raw] || 'card';
    }

    // Full UUID after keyword
    const FULL_RE = new RegExp(
        KW + '\\s*[:：#＃]?\\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\b', 'gi'
    );

    // Short 8-char hex after keyword
    const SHORT_RE = new RegExp(
        KW + '\\s*[:：#＃]?\\s*([0-9a-f]{8})\\b', 'gi'
    );

    // Markdown renders `backtick-wrapped` IDs as <code>ID</code>, and the code-segment
    // skip in renderEntityLinks() hides them from the patterns above. Match
    // "<type> <code>ID</code>" explicitly before the split.
    const CODE_FULL_RE = new RegExp(
        KW + '\\s*[:：#＃]?\\s*<code[^>]*>\\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\s*</code>', 'gi'
    );
    const CODE_SHORT_RE = new RegExp(
        KW + '\\s*[:：#＃]?\\s*<code[^>]*>\\s*([0-9a-f]{8})\\s*</code>', 'gi'
    );

    // Prefixed IDs like "card_7b7dd9e3a4c2..." — self-identifying, no keyword needed.
    // The prefix itself tells us the entity type, so the chip can route directly.
    // Accepted hex forms after the prefix:
    //   - 8 hex   (short prefix, resolved by backend LIKE lookup): card_7b7dd9e3
    //   - 24 hex  (legacy full-suffix form):                      card_d3cdda1455152e3caee8d4ac
    //   - UUID    (8-4-4-4-12):                                    card_7b7dd9e3-55e1-4074-b101-40c47161d8de
    const PREFIXED_HEX = '[a-f0-9]{8}(?:[a-f0-9]{16}|-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?';
    const PREFIXED_RE = new RegExp('\\b(card|skill|rule|listing|exam|contract|mindmap)_(' + PREFIXED_HEX + ')\\b', 'gi');
    // Code-wrapped variant: <code>card_xxx</code> (e.g. backtick-quoted in markdown).
    const CODE_PREFIXED_RE = new RegExp('<code[^>]*>\\s*(card|skill|rule|listing|exam|contract|mindmap)_(' + PREFIXED_HEX + ')\\s*</code>', 'gi');

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

        // For cards, add dependency navigation buttons
        if (type === 'card') {
            return `<span class="entity-link entity-link-${type} entity-link-with-nav" data-entity-type="${type}" data-entity-id="${entityId}" ` +
                   `onclick="openEntityModal('${type}','${entityId}')" title="${label} ${displayId}" ` +
                   `style="background:${t.bg};color:${t.color};">` +
                   `<button class="entity-nav-btn entity-nav-prev" onclick="event.stopPropagation(); navigateCardDependency('${entityId}', -1)" title="Previous dependency">←</button>` +
                   `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
                   `style="vertical-align:-1px;margin:0 3px;"><path d="${t.icon}"/></svg>${displayId}` +
                   `<button class="entity-nav-btn entity-nav-next" onclick="event.stopPropagation(); navigateCardDependency('${entityId}', 1)" title="Next dependency">→</button>` +
                   `</span>`;
        }

        // For other entity types, use the original simple chip
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

        // Phase -1: "<code>type_hex</code>" → chip placeholder (consumes the <code> wrapper).
        // Runs before Phase 0 so the prefix-form isn't shadowed by the keyword code regex.
        escapedHtml = escapedHtml.replace(CODE_PREFIXED_RE, (match, type, hex) => {
            const fullId = `${type.toLowerCase()}_${hex.toLowerCase()}`;
            return queueChip(type.toLowerCase(), fullId, fullId);
        });

        // Phase 0: "<type> <code>fullUUID</code>" → chip placeholder (consumes the <code> wrapper)
        escapedHtml = escapedHtml.replace(CODE_FULL_RE, (match, asciiKw, cjkKw, uuid) => {
            const short = uuid.substring(0, 8);
            return queueChip(resolveKeyword(asciiKw, cjkKw), uuid, short);
        });
        // Phase 0b: "<type> <code>shortId</code>" → chip placeholder
        escapedHtml = escapedHtml.replace(CODE_SHORT_RE, (match, asciiKw, cjkKw, shortId) => {
            return queueChip(resolveKeyword(asciiKw, cjkKw), shortId, shortId);
        });

        // Split by code/pre to skip code blocks
        const parts = escapedHtml.split(/(<code[\s>][\s\S]*?<\/code>|<pre[\s>][\s\S]*?<\/pre>)/gi);

        for (let i = 0; i < parts.length; i++) {
            if (i % 2 === 1) continue; // skip code blocks

            // Phase 0c: bare prefixed IDs like "card_7b7dd9e3a4c2..." — self-identifying,
            // no keyword needed. Runs before keyword phases; keyword phases require a
            // keyword prefix so they wouldn't accidentally double-match anyway.
            parts[i] = parts[i].replace(PREFIXED_RE, (match, type, hex) => {
                const fullId = `${type.toLowerCase()}_${hex.toLowerCase()}`;
                return queueChip(type.toLowerCase(), fullId, fullId);
            });

            // Phase 1: full UUID patterns
            parts[i] = parts[i].replace(FULL_RE, (match, asciiKw, cjkKw, uuid) => {
                const short = uuid.substring(0, 8);
                return queueChip(resolveKeyword(asciiKw, cjkKw), uuid, short);
            });

            // Phase 2: short 8-char hex patterns
            parts[i] = parts[i].replace(SHORT_RE, (match, asciiKw, cjkKw, shortId) => {
                return queueChip(resolveKeyword(asciiKw, cjkKw), shortId, shortId);
            });
        }

        return flushChips(parts.join(''));
    }

    // ── Dependency Navigation Functions ──
    async function navigateCardDependency(cardId, direction) {
        try {
            // Fetch dependency data for the card
            // deviceSecret travels in the X-Device-Secret header (not the URL
            // query) to keep it out of browser history / access logs / Referer.
            const response = await fetch(`/api/mission/card/${cardId}/dependencies?deviceId=${encodeURIComponent(currentUser.deviceId)}`, {
                headers: { 'X-Device-Secret': currentUser.deviceSecret },
            });
            const data = await response.json();

            if (!data.success || !data.dependencies || data.dependencies.length === 0) {
                // "DAG dependencies" = blocked_by/dependents from /api/mission/card/:id/dependencies.
                // The Prev/Next workflow chain is a separate mechanism — see docs/specs/card-link-system.md.
                showToast('No DAG dependencies (use Prev/Next chip for workflow chain)', 'warning');
                return;
            }

            // For simplicity, navigate to the first dependency (index -1)
            // or next dependent (index +1) - this can be enhanced later
            if (direction === -1 && data.dependencies.length > 0) {
                // Navigate to what this card depends on
                const targetCard = data.dependencies[0];
                openEntityModal('card', targetCard.cardId);
            } else if (direction === 1) {
                // Fetch dependents (what depends on this card)
                // deviceSecret travels in the X-Device-Secret header (see above).
                const depResponse = await fetch(`/api/mission/card/${cardId}/dependents?deviceId=${encodeURIComponent(currentUser.deviceId)}`, {
                    headers: { 'X-Device-Secret': currentUser.deviceSecret },
                });
                const depData = await depResponse.json();

                if (depData.success && depData.dependents && depData.dependents.length > 0) {
                    const targetCard = depData.dependents[0];
                    openEntityModal('card', targetCard.cardId);
                } else {
                    showToast('No dependent cards found', 'warning');
                }
            }
        } catch (error) {
            console.warn('[EntityLink] Navigation error:', error);
            showToast('Failed to navigate dependency', 'error');
        }
    }

    function showToast(message, type = 'info') {
        // Simple toast notification - can be enhanced
        const toast = document.createElement('div');
        toast.style.cssText = `
            position: fixed; top: 20px; right: 20px; z-index: 10000;
            background: ${type === 'error' ? '#ef4444' : type === 'warning' ? '#fbbf24' : '#4ade80'};
            color: white; padding: 12px 20px; border-radius: 8px;
            font-size: 14px; font-weight: 500; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            transition: opacity 0.3s;
        `;
        toast.textContent = message;
        document.body.appendChild(toast);

        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => document.body.removeChild(toast), 300);
        }, 3000);
    }

    // Add CSS styles for dependency navigation
    const styleSheet = document.createElement('style');
    styleSheet.textContent = `
        .entity-link-with-nav {
            display: inline-flex !important;
            align-items: center;
            gap: 2px;
            padding: 4px 6px !important;
        }

        .entity-nav-btn {
            background: none;
            border: none;
            color: inherit;
            font-size: 12px;
            font-weight: bold;
            cursor: pointer;
            padding: 2px 4px;
            border-radius: 3px;
            transition: background 0.2s;
            line-height: 1;
        }

        .entity-nav-btn:hover {
            background: rgba(255, 255, 255, 0.2);
        }

        .entity-link-with-nav .entity-nav-btn {
            opacity: 0.7;
        }

        .entity-link-with-nav:hover .entity-nav-btn {
            opacity: 1;
        }
    `;
    document.head.appendChild(styleSheet);

    global.EntityLinkRender = {
        renderEntityLinks,
        ENTITY_TYPES,
        navigateCardDependency
    };

    // Export navigation function globally for onclick handlers
    global.navigateCardDependency = navigateCardDependency;
})(window);
