'use strict';

/**
 * Age-appropriateness helper. Play Store & App Store IARC review need a
 * per-message hint of "what age bucket is this content suitable for?"
 *
 * Buckets are the four IARC-adjacent buckets we use across the pipeline:
 *   4  — universally appropriate (kids-safe)
 *   9  — mild themes okay (very light violence/scares)
 *   12 — pre-teen (some mild profanity, cartoon violence, mild suggestive)
 *   17 — mature audiences (explicit, graphic, or otherwise adult-only)
 *
 * We combine (a) OpenAI moderation category scores when provided and (b) a
 * lightweight keyword heuristic so the helper still returns a bucket even
 * when the caller does not pass moderation data (e.g. offline batch labeling).
 */

const HEURISTIC_17 = [
  /\b(?:sex|porn|xxx|nsfw|orgasm|explicit)\b/i,
  /\bkill|murder|behead|gore|blood\b/i,
  /\bsuicide|self-harm|overdose\b/i,
];

const HEURISTIC_12 = [
  /\b(?:hell|damn|crap|stupid|idiot)\b/i,
  /\b(?:fight|punch|weapon|gun|knife)\b/i,
];

const HEURISTIC_9 = [/\b(?:scary|monster|ghost|zombie|nightmare)\b/i];

/**
 * @param {string} text
 * @param {{ moderation?: { categories?: Record<string, boolean>, category_scores?: Record<string, number> } }} [options]
 * @returns {{ minAge: 4 | 9 | 12 | 17, reasons: string[] }}
 */
function assessAgeAppropriateness(text, options = {}) {
  const reasons = [];
  const scores = (options.moderation && options.moderation.category_scores) || {};
  const cats = (options.moderation && options.moderation.categories) || {};

  // Any hard-adult moderation flag → 17
  const adultCats = ['sexual', 'sexual/minors', 'violence/graphic', 'self-harm', 'self-harm/intent', 'self-harm/instructions', 'hate/threatening'];
  for (const c of adultCats) {
    if (cats[c]) {
      reasons.push(`moderation:${c}`);
      return { minAge: 17, reasons };
    }
  }

  // High score without a hard flag → still 17
  for (const c of adultCats) {
    if (typeof scores[c] === 'number' && scores[c] >= 0.5) {
      reasons.push(`score:${c}>=0.5`);
      return { minAge: 17, reasons };
    }
  }

  // Heuristic keyword sweep on the raw text
  if (typeof text === 'string' && text.length > 0) {
    for (const p of HEURISTIC_17) {
      if (p.test(text)) {
        reasons.push(`keyword:17:${p.source}`);
        return { minAge: 17, reasons };
      }
    }
    // Medium-tier moderation (hate/harassment/violence broad) → 12
    if (cats.hate || cats.harassment || cats.violence) {
      reasons.push('moderation:medium-tier');
      return { minAge: 12, reasons };
    }
    for (const p of HEURISTIC_12) {
      if (p.test(text)) {
        reasons.push(`keyword:12:${p.source}`);
        return { minAge: 12, reasons };
      }
    }
    for (const p of HEURISTIC_9) {
      if (p.test(text)) {
        reasons.push(`keyword:9:${p.source}`);
        return { minAge: 9, reasons };
      }
    }
  }

  return { minAge: 4, reasons: ['default'] };
}

module.exports = { assessAgeAppropriateness };
