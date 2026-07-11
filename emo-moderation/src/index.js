'use strict';

const { callOpenAIModeration } = require('./openaiClient');
const { mapCategoriesToAction } = require('./categoryMap');
const { redactText } = require('./redact');
const { buildCrisisResponse } = require('./crisisResponse');
const { assessAgeAppropriateness } = require('./ageGate');

/**
 * Screen a piece of user text through OpenAI Moderation and reduce the result
 * to one action bucket.
 *
 * @param {string} text
 * @param {{
 *   openaiKey?: string,
 *   model?: string,
 *   fetchImpl?: typeof fetch,
 *   moderationResult?: {
 *     flagged?: boolean,
 *     categories: Record<string, boolean>,
 *     category_scores?: Record<string, number>,
 *     model?: string,
 *   },
 *   locale?: string,
 *   redactExtraPatterns?: RegExp[],
 * }} [options]
 *
 * If `moderationResult` is provided the module uses it directly (stub mode /
 * batch mode / test mode) and never calls OpenAI. Otherwise `openaiKey` is
 * required and the OpenAI Moderation endpoint is called.
 *
 * @returns {Promise<{
 *   action: 'pass' | 'soft_flag' | 'hard_block' | 'crisis_referral',
 *   reason: string,
 *   matchedCategories: string[],
 *   redactedText?: string,
 *   crisisResponse?: object,
 *   model?: string,
 * }>}
 */
async function screen(text, options = {}) {
  if (typeof text !== 'string') {
    throw new TypeError('emo-moderation.screen(text): text must be a string.');
  }
  if (text.length === 0) {
    return { action: 'pass', reason: 'empty_input', matchedCategories: [] };
  }

  let moderation;
  if (options.moderationResult) {
    moderation = normalizeStub(options.moderationResult);
  } else {
    moderation = await callOpenAIModeration(text, {
      openaiKey: options.openaiKey,
      model: options.model,
      fetchImpl: options.fetchImpl,
    });
  }

  const { action, matched } = mapCategoriesToAction(moderation.categories);

  const out = {
    action,
    reason: action === 'pass'
      ? (moderation.flagged ? 'flagged_but_unmapped' : 'not_flagged')
      : `matched:${matched.join(',')}`,
    matchedCategories: matched,
    model: moderation.model,
  };

  if (action === 'soft_flag') {
    out.redactedText = redactText(text, {
      extraPatterns: options.redactExtraPatterns,
    });
  }

  if (action === 'crisis_referral') {
    out.crisisResponse = buildCrisisResponse(text, options.locale);
  }

  return out;
}

function normalizeStub(stub) {
  return {
    flagged: stub.flagged === true,
    categories: stub.categories || {},
    category_scores: stub.category_scores || {},
    model: stub.model || 'stub',
  };
}

module.exports = {
  screen,
  buildCrisisResponse,
  assessAgeAppropriateness,
  // Re-exports for advanced callers / tests
  mapCategoriesToAction,
  redactText,
  callOpenAIModeration,
};
