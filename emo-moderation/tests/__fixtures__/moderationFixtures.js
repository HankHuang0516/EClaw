'use strict';

/**
 * Canned moderation responses covering every branch in categoryMap.js.
 *
 * IMPORTANT: input texts are SAFE placeholders that describe what the vector
 * targets. We never inline real crisis language, slurs, or explicit content —
 * the moderation categories field is what drives the mapping, not the text.
 */

function baseCats(overrides = {}) {
  const zero = {
    sexual: false,
    'sexual/minors': false,
    hate: false,
    'hate/threatening': false,
    harassment: false,
    'harassment/threatening': false,
    'self-harm': false,
    'self-harm/intent': false,
    'self-harm/instructions': false,
    violence: false,
    'violence/graphic': false,
  };
  return { ...zero, ...overrides };
}

function baseScores(overrides = {}) {
  const zero = {
    sexual: 0.001,
    'sexual/minors': 0.001,
    hate: 0.001,
    'hate/threatening': 0.001,
    harassment: 0.001,
    'harassment/threatening': 0.001,
    'self-harm': 0.001,
    'self-harm/intent': 0.001,
    'self-harm/instructions': 0.001,
    violence: 0.001,
    'violence/graphic': 0.001,
  };
  return { ...zero, ...overrides };
}

module.exports = [
  // ---------- pass ----------
  {
    name: 'pass_neutral',
    input: 'Today the sky was clear and I enjoyed a walk in the park.',
    locale: 'en',
    moderationResult: {
      flagged: false,
      categories: baseCats(),
      category_scores: baseScores(),
      model: 'text-moderation-stub',
    },
    expectedAction: 'pass',
  },
  {
    name: 'pass_emotional_but_safe',
    input: '[test:mild_sadness] I feel a bit tired after a long week.',
    locale: 'zh-TW',
    moderationResult: {
      flagged: false,
      categories: baseCats(),
      category_scores: baseScores(),
      model: 'text-moderation-stub',
    },
    expectedAction: 'pass',
  },
  {
    name: 'pass_empty',
    input: '',
    locale: 'en',
    moderationResult: null,
    expectedAction: 'pass',
    skipModerationCall: true,
  },

  // ---------- soft_flag: hate ----------
  {
    name: 'soft_flag_hate',
    input: '[test:hate_generic] some hateful remark placeholder',
    locale: 'en',
    moderationResult: {
      flagged: true,
      categories: baseCats({ hate: true }),
      category_scores: baseScores({ hate: 0.72 }),
      model: 'text-moderation-stub',
    },
    expectedAction: 'soft_flag',
  },
  // ---------- soft_flag: harassment ----------
  {
    name: 'soft_flag_harassment',
    input: '[test:harassment_generic] rude remarks aimed at someone',
    locale: 'en',
    moderationResult: {
      flagged: true,
      categories: baseCats({ harassment: true }),
      category_scores: baseScores({ harassment: 0.65 }),
      model: 'text-moderation-stub',
    },
    expectedAction: 'soft_flag',
  },
  // ---------- soft_flag: sexual (adult, not minors) ----------
  {
    name: 'soft_flag_sexual',
    input: '[test:sexual_adult_broad] adult-only allusion placeholder',
    locale: 'en-SG',
    moderationResult: {
      flagged: true,
      categories: baseCats({ sexual: true }),
      category_scores: baseScores({ sexual: 0.6 }),
      model: 'text-moderation-stub',
    },
    expectedAction: 'soft_flag',
  },
  // ---------- soft_flag: violence (non-graphic) ----------
  {
    name: 'soft_flag_violence',
    input: '[test:violence_broad] a video game fight scene reference',
    locale: 'en',
    moderationResult: {
      flagged: true,
      categories: baseCats({ violence: true }),
      category_scores: baseScores({ violence: 0.55 }),
      model: 'text-moderation-stub',
    },
    expectedAction: 'soft_flag',
  },

  // ---------- hard_block: sexual/minors ----------
  {
    name: 'hard_block_sexual_minors',
    input: '[test:sexual_minors]',
    locale: 'en',
    moderationResult: {
      flagged: true,
      categories: baseCats({ 'sexual/minors': true, sexual: true }),
      category_scores: baseScores({ 'sexual/minors': 0.95, sexual: 0.9 }),
      model: 'text-moderation-stub',
    },
    expectedAction: 'hard_block',
  },
  // ---------- hard_block: self-harm/intent ----------
  {
    name: 'hard_block_selfharm_intent',
    input: '[test:selfharm_intent_high]',
    locale: 'zh-TW',
    moderationResult: {
      flagged: true,
      categories: baseCats({ 'self-harm/intent': true, 'self-harm': true }),
      category_scores: baseScores({ 'self-harm/intent': 0.88, 'self-harm': 0.85 }),
      model: 'text-moderation-stub',
    },
    expectedAction: 'hard_block',
  },
  // ---------- hard_block: self-harm/instructions ----------
  {
    name: 'hard_block_selfharm_instructions',
    input: '[test:selfharm_instructions]',
    locale: 'zh-HK',
    moderationResult: {
      flagged: true,
      categories: baseCats({ 'self-harm/instructions': true, 'self-harm': true }),
      category_scores: baseScores({ 'self-harm/instructions': 0.9, 'self-harm': 0.82 }),
      model: 'text-moderation-stub',
    },
    expectedAction: 'hard_block',
  },
  // ---------- hard_block: violence/graphic ----------
  {
    name: 'hard_block_violence_graphic',
    input: '[test:violence_graphic]',
    locale: 'en',
    moderationResult: {
      flagged: true,
      categories: baseCats({ 'violence/graphic': true, violence: true }),
      category_scores: baseScores({ 'violence/graphic': 0.92, violence: 0.9 }),
      model: 'text-moderation-stub',
    },
    expectedAction: 'hard_block',
  },
  // ---------- hard_block: hate/threatening ----------
  {
    name: 'hard_block_hate_threatening',
    input: '[test:hate_threatening]',
    locale: 'en',
    moderationResult: {
      flagged: true,
      categories: baseCats({ 'hate/threatening': true, hate: true }),
      category_scores: baseScores({ 'hate/threatening': 0.9, hate: 0.85 }),
      model: 'text-moderation-stub',
    },
    expectedAction: 'hard_block',
  },

  // ---------- crisis_referral: broad self-harm (TW) ----------
  {
    name: 'crisis_selfharm_broad_zhTW',
    input: '[test:selfharm_intent_low] I have been very tired for weeks.',
    locale: 'zh-TW',
    moderationResult: {
      flagged: true,
      categories: baseCats({ 'self-harm': true }),
      category_scores: baseScores({ 'self-harm': 0.6 }),
      model: 'text-moderation-stub',
    },
    expectedAction: 'crisis_referral',
    expectedLocaleKey: 'zh-TW',
    expectedHotlineNumber: '1925',
  },
  // ---------- crisis_referral: HK ----------
  {
    name: 'crisis_selfharm_broad_zhHK',
    input: '[test:selfharm_intent_low]',
    locale: 'zh-HK',
    moderationResult: {
      flagged: true,
      categories: baseCats({ 'self-harm': true }),
      category_scores: baseScores({ 'self-harm': 0.58 }),
      model: 'text-moderation-stub',
    },
    expectedAction: 'crisis_referral',
    expectedLocaleKey: 'zh-HK',
    expectedHotlineNumber: '2382-0000',
  },
  // ---------- crisis_referral: SG ----------
  {
    name: 'crisis_selfharm_broad_enSG',
    input: '[test:selfharm_intent_low]',
    locale: 'en-SG',
    moderationResult: {
      flagged: true,
      categories: baseCats({ 'self-harm': true }),
      category_scores: baseScores({ 'self-harm': 0.62 }),
      model: 'text-moderation-stub',
    },
    expectedAction: 'crisis_referral',
    expectedLocaleKey: 'en-SG',
    expectedHotlineNumber: '1767',
  },
  // ---------- crisis_referral: default fallback ----------
  {
    name: 'crisis_selfharm_broad_unknownLocale',
    input: '[test:selfharm_intent_low]',
    locale: 'de-DE',
    moderationResult: {
      flagged: true,
      categories: baseCats({ 'self-harm': true }),
      category_scores: baseScores({ 'self-harm': 0.6 }),
      model: 'text-moderation-stub',
    },
    expectedAction: 'crisis_referral',
    expectedLocaleKey: 'default',
    expectedHotlineNumber: null,
  },

  // ---------- precedence: hard_block wins over crisis + soft ----------
  {
    name: 'precedence_hardblock_over_crisis',
    input: '[test:selfharm_intent_high] mixed signals',
    locale: 'zh-TW',
    moderationResult: {
      flagged: true,
      categories: baseCats({
        'self-harm/intent': true,
        'self-harm': true,
        harassment: true,
      }),
      category_scores: baseScores({
        'self-harm/intent': 0.9,
        'self-harm': 0.85,
        harassment: 0.4,
      }),
      model: 'text-moderation-stub',
    },
    expectedAction: 'hard_block',
  },
  // ---------- precedence: crisis wins over soft ----------
  {
    name: 'precedence_crisis_over_soft',
    input: '[test:selfharm_intent_low] with mild hostility',
    locale: 'zh-TW',
    moderationResult: {
      flagged: true,
      categories: baseCats({ 'self-harm': true, harassment: true }),
      category_scores: baseScores({ 'self-harm': 0.55, harassment: 0.5 }),
      model: 'text-moderation-stub',
    },
    expectedAction: 'crisis_referral',
    expectedLocaleKey: 'zh-TW',
  },
];
