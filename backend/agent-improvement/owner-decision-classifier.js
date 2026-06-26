// Owner-decision classifier — decides whether a piece of work is genuinely
// OWNER-ONLY (only Hank can decide) versus bot-resolvable, so the kanban
// move-hook only auto-surfaces real owner decisions into the "需要你"
// (action-request) inbox instead of flooding it.
//
// Pure functions, NO deps (mirrors agent-improvement/classifier.js so both the
// kanban hook and tests can import it without a circular dependency). Keyword
// matching is case-insensitive and covers EN + 繁體中文.
//
// DEFAULT is ownerOnly=false: a card is bot-resolvable unless it trips one of
// the owner-only category keyword sets OR carries an explicit owner flag.

'use strict';

// ── Owner-only categories ──
// Each entry: { category, kws: [substring matches], res: [optional RegExp] }.
// A category fires if ANY of its keywords is a (case-insensitive) substring of
// the text, or any of its regexes matches.
const OWNER_ONLY_CATEGORIES = Object.freeze([
    {
        category: 'irreversible_data',
        // Multi-word EN phrases + CJK are unambiguous → safe as substrings.
        kws: ['drop table', 'delete account', 'irreversible',
            '刪除帳號', '不可逆', '清庫', '抹除'],
        // Short ambiguous EN words need word boundaries so they don't match inside
        // larger words (audit card_c6731c2f): 'wipe'→'swipe', 'truncate'→
        // 'truncated', and 'purge' inside the bot-resolvable 'auto-purge done
        // cards' doneRetention flow (excluded via the auto- lookbehind).
        res: [/\btruncate\b/i, /\bwipe\b/i, /(?<!auto[-\s])\bpurge\b/i],
    },
    {
        category: 'spend_cost',
        kws: ['provision', 'paid plan', 'budget', 'quota raise', 'subscription',
            'billing', '付費', '訂閱', '花錢', '加預算'],
        // 'spend' as a substring matched 'suspend'/'suspended', and a bare '$'
        // matched EVERY dev card carrying a dollar sign (shell $1/$PATH, template
        // ${foo}, jQuery $) — flooding the very inbox this feature keeps short
        // (audit card_c6731c2f). Word-boundary 'spend' + a real price shape (a
        // digit then >=1 more digit/sep) for '$' excludes single-digit shell
        // params and ${...}/$WORD while still catching $200 / $1,000 / $9.99.
        res: [/\bspend(?:ing|s)?\b/i, /\$\s?\d[\d,.]+/],
    },
    {
        category: 'product_direction',
        kws: ['product direction', 'roadmap', '要不要做', '產品方向', '策略方向'],
        res: [/prioriti[sz]e\s+roadmap/i],
    },
    {
        category: 'legal_pii',
        kws: ['legal', '法務', 'pii', '個資', 'retention policy', 'gdpr', '隱私', '保留期', '合規'],
        res: [],
    },
    {
        category: 'security_policy',
        kws: ['security policy', 'auth policy', 'permission policy', 'secret rotation',
            '資安政策', '權限政策', '金鑰輪換'],
        res: [],
    },
    {
        category: 'strategic_tradeoff',
        kws: ['tradeoff', 'trade-off', '取捨', '權衡', '兩難', 'ambiguous strategic'],
        res: [],
    },
]);

// Explicit owner flag — an author/gate that literally marks the work as
// owner-only / un-authorizable / legal-hold. Always forces ownerOnly.
// NB: bare 需要你 was too loose — it is an everyday Chinese phrase (這個需要你確認 /
// 需要你幫忙) AND literally the inbox's own display name, so ordinary commander
// comments tripped it (audit card_c6731c2f). Require a deliberate decision verb
// after 需要你 (決策/核可/裁示/拍板/定奪/授權) so only an explicit owner-decision
// marker fires, not casual usage.
const EXPLICIT_FLAG_RE = /owner[-_ ]?only|un-?authoriz|不可授權|legal-hold|需要你\s*(?:決策|核可|裁示|拍板|定奪|授權)/i;

// painTags (OODA-R taxonomy) that represent pure front-end / appearance work.
// A screenshot-review card whose pain is ONLY these is a UI vision-check (a
// separate concern routed to the UI reviewer), not an owner decision.
const UI_ONLY_TAGS = Object.freeze(new Set(['ux_feedback', 'redirect_deeplink']));

/**
 * Classify free-form text for owner-only signals.
 * @param {string} text
 * @returns {{ ownerOnly: boolean, categories: string[], reasons: string[] }}
 */
function classifyOwnerDecision(text) {
    const raw = typeof text === 'string' ? text : '';
    const hay = raw.toLowerCase();
    const categories = [];
    const reasons = [];

    for (const { category, kws, res } of OWNER_ONLY_CATEGORIES) {
        let hit = null;
        for (const kw of kws) {
            if (hay.includes(kw.toLowerCase())) { hit = kw; break; }
        }
        if (!hit && res && res.length) {
            for (const re of res) {
                if (re.test(raw)) { hit = re.source; break; }
            }
        }
        if (hit) {
            categories.push(category);
            reasons.push(`${category}: matched "${hit}"`);
        }
    }

    if (EXPLICIT_FLAG_RE.test(raw) && !categories.includes('explicit_flag')) {
        categories.push('explicit_flag');
        reasons.push('explicit_flag: text carries an owner-only / 需要你 / legal-hold marker');
    }

    return { ownerOnly: categories.length > 0, categories, reasons };
}

/**
 * Card-level helper: decide whether a kanban card is an owner-only decision.
 *
 * Short-circuits to ownerOnly=false for a pure UI vision-check card
 * (requiresScreenshotReview === true and the card's painTags are all UI-only) —
 * that is a separate front-end-review concern, not an owner decision.
 *
 * Otherwise runs classifyOwnerDecision on the concatenated
 * title+description+latestComment+gateReason and ORs an explicit-flag check on
 * gateReason (so an auto-block / gate reason that itself names an owner flag
 * still surfaces).
 *
 * @param {object} args
 * @param {string} [args.title]
 * @param {string} [args.description]
 * @param {string} [args.latestComment]
 * @param {string} [args.gateReason]
 * @param {boolean} [args.requiresScreenshotReview]
 * @param {string[]} [args.painTags]
 * @returns {{ ownerOnly: boolean, categories: string[], reasons: string[] }}
 */
function classifyCardOwnerDecision({ title, description, latestComment, gateReason, requiresScreenshotReview, painTags } = {}) {
    const tags = Array.isArray(painTags) ? painTags : [];
    const onlyUi = tags.length > 0 && tags.every(t => UI_ONLY_TAGS.has(t));
    if (requiresScreenshotReview === true && onlyUi) {
        return {
            ownerOnly: false,
            categories: [],
            reasons: ['short_circuit: UI vision-check card (requiresScreenshotReview + UI-only painTags) is not an owner decision'],
        };
    }

    const text = [title, description, latestComment, gateReason].filter(Boolean).join('\n\n');
    const result = classifyOwnerDecision(text);

    // OR the gateReason explicit-flag check (defensive — gateReason is already in
    // `text`, but state the intent: a gate/auto-block reason naming an owner flag
    // is itself an owner decision).
    if (typeof gateReason === 'string' && EXPLICIT_FLAG_RE.test(gateReason) && !result.categories.includes('explicit_flag')) {
        result.categories.push('explicit_flag');
        result.reasons.push('explicit_flag: gateReason names an owner-only / legal-hold marker');
        result.ownerOnly = true;
    }

    return result;
}

module.exports = {
    OWNER_ONLY_CATEGORIES,
    EXPLICIT_FLAG_RE,
    UI_ONLY_TAGS,
    classifyOwnerDecision,
    classifyCardOwnerDecision,
};
