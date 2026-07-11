'use strict';

/**
 * Category → action mapping for OpenAI Moderation categories.
 *
 * Actions
 *  - hard_block:      refuse the message outright; caller should show a "cannot help
 *                     with this" surface and log for review.
 *  - crisis_referral: the user appears to be in distress but is NOT giving actionable
 *                     self-harm intent/instructions. Route through buildCrisisResponse
 *                     so we validate feelings + surface a local hotline.
 *  - soft_flag:       borderline content. Deliver, but redact high-risk phrases and
 *                     let the caller decide whether to warn or throttle.
 *  - pass:            no action.
 *
 * Precedence (highest first): hard_block > crisis_referral > soft_flag > pass.
 * The OpenAI Moderation category keys map to one bucket each; an input can trip
 * several categories and the highest-precedence bucket wins.
 */

const HARD_BLOCK_CATEGORIES = new Set([
  'sexual/minors',
  'self-harm/intent',
  'self-harm/instructions',
  'violence/graphic',
  'hate/threatening',
]);

const CRISIS_REFERRAL_CATEGORIES = new Set([
  // Broad self-harm signal without intent/instructions specifics. This is the
  // "someone is hurting and we should support them" bucket, distinct from
  // self-harm/intent (which is hard_block: we don't produce a response, we refuse).
  'self-harm',
]);

const SOFT_FLAG_CATEGORIES = new Set([
  'hate',
  'harassment',
  'harassment/threatening',
  'sexual',
  'violence',
]);

const ACTION_PRECEDENCE = ['hard_block', 'crisis_referral', 'soft_flag', 'pass'];

/**
 * Given an OpenAI Moderation "categories" object (or equivalent boolean map),
 * decide the action bucket + which category tripped it.
 *
 * @param {Record<string, boolean>} categories
 * @returns {{ action: 'pass' | 'soft_flag' | 'hard_block' | 'crisis_referral', matched: string[] }}
 */
function mapCategoriesToAction(categories) {
  if (!categories || typeof categories !== 'object') {
    return { action: 'pass', matched: [] };
  }

  const tripped = Object.entries(categories)
    .filter(([, v]) => v === true)
    .map(([k]) => k);

  const buckets = { hard_block: [], crisis_referral: [], soft_flag: [] };

  for (const cat of tripped) {
    if (HARD_BLOCK_CATEGORIES.has(cat)) buckets.hard_block.push(cat);
    else if (CRISIS_REFERRAL_CATEGORIES.has(cat)) buckets.crisis_referral.push(cat);
    else if (SOFT_FLAG_CATEGORIES.has(cat)) buckets.soft_flag.push(cat);
  }

  for (const action of ACTION_PRECEDENCE) {
    if (action === 'pass') return { action: 'pass', matched: [] };
    if (buckets[action].length > 0) {
      return { action, matched: buckets[action] };
    }
  }
  return { action: 'pass', matched: [] };
}

module.exports = {
  HARD_BLOCK_CATEGORIES,
  CRISIS_REFERRAL_CATEGORIES,
  SOFT_FLAG_CATEGORIES,
  ACTION_PRECEDENCE,
  mapCategoriesToAction,
};
