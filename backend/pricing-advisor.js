/**
 * Pricing Advisor — suggests rate ranges for bot rental listings.
 *
 * Owner-set rates are completely free (design decision #25), but users
 * get a warning badge when they drift >2× outside the advisor's
 * suggested range. The advisor computes suggestions from:
 *
 *   - Base rate by model family (hard-coded sensible defaults)
 *   - Capability multipliers (+30% per detected tool)
 *   - Market percentile from `pricing_market_snapshots`
 *
 * This module is pure: no DB writes, only reads. The snapshot table is
 * populated by the hourly rental market snapshot cron.
 */
/* @brm-crossref: ⑤ Pricing Advisor
 * Design doc: docs/plans/2026-04-10-bot-rental-marketplace-design.md
 * Roadmap:    /portal/roadmap.html
 * If this module is updated, also update the roadmap page status and the design doc §10 delivery tracker. */

const ECOIN_TO_MLI = 1000;

/**
 * Base rate (in mli per 1K tokens) per detected model family.
 * These are advisory anchors — actual rates are set by owners.
 * Derived from market observation, not API cost (owners monetize
 * idle OpenClaw quota, so marginal cost to them is near-zero).
 */
const BASE_RATE_MLI_PER_KTOKEN = Object.freeze({
    'opus': 10 * ECOIN_TO_MLI,        // 10 e幣/1K
    'sonnet': 5 * ECOIN_TO_MLI,       // 5 e幣/1K
    'haiku': 2 * ECOIN_TO_MLI,        // 2 e幣/1K
    'gpt-4': 10 * ECOIN_TO_MLI,
    'gpt-4o': 6 * ECOIN_TO_MLI,
    'gpt-4o-mini': 2 * ECOIN_TO_MLI,
    'gemini-pro': 5 * ECOIN_TO_MLI,
    'gemini-flash': 2 * ECOIN_TO_MLI,
    'unknown': 3 * ECOIN_TO_MLI,      // fallback when model detection fails
});

/** Per-capability multiplier added on top of the base rate. */
const CAPABILITY_MULTIPLIER = 0.3;   // +30% per supported capability

/** Warning threshold: rates farther than this factor from suggestion are flagged. */
const WARN_BAND = 2.0;

/**
 * Detect a model family from a free-form model name string.
 * Returns a key from `BASE_RATE_MLI_PER_KTOKEN`, or `'unknown'`.
 */
function detectFamily(modelName) {
    if (!modelName || typeof modelName !== 'string') return 'unknown';
    const m = modelName.toLowerCase();
    if (/opus/.test(m)) return 'opus';
    if (/sonnet/.test(m)) return 'sonnet';
    if (/haiku/.test(m)) return 'haiku';
    if (/gpt-?4o-?mini/.test(m)) return 'gpt-4o-mini';
    if (/gpt-?4o/.test(m)) return 'gpt-4o';
    if (/gpt-?4/.test(m)) return 'gpt-4';
    if (/gemini.*flash/.test(m)) return 'gemini-flash';
    if (/gemini/.test(m)) return 'gemini-pro';
    return 'unknown';
}

/**
 * Count supported capabilities from the interview output JSON.
 * Only counts categories explicitly marked `supported: true`.
 */
function countCapabilities(capabilities) {
    if (!capabilities || typeof capabilities !== 'object') return 0;
    let n = 0;
    for (const key of Object.keys(capabilities)) {
        if (capabilities[key] && capabilities[key].supported === true) n++;
    }
    return n;
}

/**
 * Compute a suggested rate range for a listing.
 *
 * Returns `{ family, suggestedMli, minMli, maxMli, confidence, reasoning }`.
 * `confidence` is 'high' when the model was detected and the interview
 * passed, otherwise 'low'.
 */
function suggestRate({ modelName, capabilities = {}, interviewPassed = false }) {
    const family = detectFamily(modelName);
    const base = BASE_RATE_MLI_PER_KTOKEN[family];
    const capCount = countCapabilities(capabilities);
    const multiplier = 1 + capCount * CAPABILITY_MULTIPLIER;
    const suggestedMli = Math.round(base * multiplier);

    // Range is ±40% of suggestion for high-confidence, ±60% otherwise.
    const band = interviewPassed && family !== 'unknown' ? 0.4 : 0.6;
    const minMli = Math.round(suggestedMli * (1 - band));
    const maxMli = Math.round(suggestedMli * (1 + band));

    return {
        family,
        baseMli: base,
        capabilityCount: capCount,
        suggestedMli,
        minMli,
        maxMli,
        confidence: interviewPassed && family !== 'unknown' ? 'high' : 'low',
        reasoning: family === 'unknown'
            ? 'Model family could not be detected; using conservative default.'
            : `${family} base rate × (1 + ${capCount} capability bonus)`,
    };
}

/**
 * Classify an owner-chosen rate against the suggestion.
 * Returns 'below' / 'in_range' / 'above' / 'way_above' / 'way_below'.
 */
function classifyRate(rateMli, suggestion) {
    if (!suggestion || !suggestion.suggestedMli) return 'in_range';
    if (rateMli < suggestion.suggestedMli / WARN_BAND) return 'way_below';
    if (rateMli < suggestion.minMli) return 'below';
    if (rateMli > suggestion.suggestedMli * WARN_BAND) return 'way_above';
    if (rateMli > suggestion.maxMli) return 'above';
    return 'in_range';
}

module.exports = {
    BASE_RATE_MLI_PER_KTOKEN,
    CAPABILITY_MULTIPLIER,
    WARN_BAND,
    detectFamily,
    countCapabilities,
    suggestRate,
    classifyRate,
};
