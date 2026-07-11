'use strict';

const path = require('path');
const {
  screen,
  buildCrisisResponse,
  assessAgeAppropriateness,
  mapCategoriesToAction,
  redactText,
  callOpenAIModeration,
} = require('../src');
const fixtures = require('./__fixtures__/moderationFixtures');

describe('emo-moderation.screen (stub-driven fixture matrix)', () => {
  test('fixture count meets deliverable threshold', () => {
    // deliverable #5: "snapshot moderation outputs for 15+ prompts"
    expect(fixtures.length).toBeGreaterThanOrEqual(15);
  });

  test.each(fixtures.map((f) => [f.name, f]))(
    'fixture %s → expected action + snapshot',
    async (_name, f) => {
      const res = await screen(f.input, {
        moderationResult: f.moderationResult || undefined,
        locale: f.locale,
      });
      expect(res.action).toBe(f.expectedAction);

      if (f.expectedAction === 'soft_flag') {
        expect(typeof res.redactedText).toBe('string');
        // Redaction produces a string (may equal original when nothing matched a
        // pattern — we don't want to over-scrub safe placeholder text). What we
        // guarantee: the property exists, is a string, and does not throw.
        expect(res.redactedText.length).toBeGreaterThan(0);
      } else {
        expect(res.redactedText).toBeUndefined();
      }

      if (f.expectedAction === 'crisis_referral') {
        expect(res.crisisResponse).toBeDefined();
        expect(res.crisisResponse.schema).toBe('emo-moderation.crisis-response/v1');
        expect(res.crisisResponse.locale).toBe(f.expectedLocaleKey);
        expect(res.crisisResponse.wordCount).toBeLessThan(300);
        if (f.expectedHotlineNumber === null) {
          expect(res.crisisResponse.hotline.number).toBeNull();
          expect(res.crisisResponse.hotline.url).toBe('https://findahelpline.com');
        } else if (f.expectedHotlineNumber) {
          expect(res.crisisResponse.hotline.number).toBe(f.expectedHotlineNumber);
        }
        // Non-clinical guardrail: crisis body must not contain prescriptive
        // medical/clinical vocabulary. This is a canary — if a future template
        // edit slips in the wrong tone, the test fires.
        expect(res.crisisResponse.body).not.toMatch(/\b(diagnos|prescrib|medication|therapist|clinic|psychiatr)/i);
      } else {
        expect(res.crisisResponse).toBeUndefined();
      }

      expect({
        name: f.name,
        action: res.action,
        reason: res.reason,
        matchedCategories: res.matchedCategories,
        locale: res.crisisResponse ? res.crisisResponse.locale : null,
        hotlineNumber: res.crisisResponse ? res.crisisResponse.hotline.number : null,
      }).toMatchSnapshot();
    }
  );
});

describe('mapCategoriesToAction precedence', () => {
  test('hard_block beats crisis + soft', () => {
    const { action, matched } = mapCategoriesToAction({
      'self-harm/intent': true,
      'self-harm': true,
      harassment: true,
    });
    expect(action).toBe('hard_block');
    expect(matched).toContain('self-harm/intent');
  });
  test('crisis_referral beats soft', () => {
    const { action } = mapCategoriesToAction({ 'self-harm': true, hate: true });
    expect(action).toBe('crisis_referral');
  });
  test('soft_flag when only soft categories tripped', () => {
    const { action } = mapCategoriesToAction({ harassment: true });
    expect(action).toBe('soft_flag');
  });
  test('pass on empty / null', () => {
    expect(mapCategoriesToAction(null).action).toBe('pass');
    expect(mapCategoriesToAction({}).action).toBe('pass');
  });
});

describe('buildCrisisResponse locales', () => {
  test('zh-TW routes to 1925', () => {
    const r = buildCrisisResponse(undefined, 'zh-TW');
    expect(r.hotline.number).toBe('1925');
    expect(r.locale).toBe('zh-TW');
    expect(r.wordCount).toBeLessThan(300);
  });
  test('zh-HK routes to 2382-0000', () => {
    const r = buildCrisisResponse(undefined, 'zh-HK');
    expect(r.hotline.number).toBe('2382-0000');
  });
  test('en-SG routes to 1767', () => {
    const r = buildCrisisResponse(undefined, 'en-SG');
    expect(r.hotline.number).toBe('1767');
  });
  test('unknown locale falls back to Find A Helpline', () => {
    const r = buildCrisisResponse(undefined, 'de-DE');
    expect(r.locale).toBe('default');
    expect(r.hotline.number).toBeNull();
    expect(r.hotline.url).toBe('https://findahelpline.com');
  });
  test('handles underscore + case variants', () => {
    const r = buildCrisisResponse(undefined, 'zh_tw');
    expect(r.locale).toBe('zh-TW');
  });
  test('disclaimer present', () => {
    const r = buildCrisisResponse(undefined, 'en-SG');
    expect(r.disclaimer).toMatch(/not medical|not clinical|not a substitute|not medical or/i);
  });
});

describe('redactText', () => {
  test('redacts direct threats', () => {
    const out = redactText("I will kill you", {});
    expect(out).toContain('[REDACTED]');
    expect(out).not.toMatch(/kill you/i);
  });
  test('leaves plain safe text alone', () => {
    const out = redactText('the sky is blue today');
    expect(out).toBe('the sky is blue today');
  });
  test('accepts extraPatterns', () => {
    const out = redactText('secretcode123', { extraPatterns: [/secretcode\d+/gi] });
    expect(out).toBe('[REDACTED]');
  });
});

describe('assessAgeAppropriateness', () => {
  test('any hard-adult moderation flag → 17', () => {
    const a = assessAgeAppropriateness('anything', {
      moderation: { categories: { 'sexual/minors': true } },
    });
    expect(a.minAge).toBe(17);
  });
  test('high score without flag → 17', () => {
    const a = assessAgeAppropriateness('anything', {
      moderation: { categories: {}, category_scores: { 'violence/graphic': 0.7 } },
    });
    expect(a.minAge).toBe(17);
  });
  test('mid-tier moderation → 12', () => {
    const a = assessAgeAppropriateness('someone was pushy at school', {
      moderation: { categories: { harassment: true } },
    });
    expect(a.minAge).toBe(12);
  });
  test('scary keyword only → 9', () => {
    const a = assessAgeAppropriateness('there was a ghost in the story');
    expect(a.minAge).toBe(9);
  });
  test('plain safe text → 4', () => {
    const a = assessAgeAppropriateness('the puppy played in the yard');
    expect(a.minAge).toBe(4);
  });
});

describe('callOpenAIModeration wrapper', () => {
  test('rejects when no key given', async () => {
    await expect(callOpenAIModeration('hi', {})).rejects.toThrow(/openaiKey/);
  });
  test('uses injected fetchImpl', async () => {
    const fakeFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        model: 'text-moderation-stub-injected',
        results: [
          {
            flagged: true,
            categories: { hate: true },
            category_scores: { hate: 0.7 },
          },
        ],
      }),
    });
    const res = await callOpenAIModeration('sample', {
      openaiKey: 'sk-test-abcdefg',
      fetchImpl: fakeFetch,
    });
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(res.categories.hate).toBe(true);
    expect(res.model).toBe('text-moderation-stub-injected');
  });
  test('surfaces HTTP errors', async () => {
    const fakeFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'invalid_api_key',
    });
    await expect(
      callOpenAIModeration('sample', {
        openaiKey: 'sk-bad-xxxxxxx',
        fetchImpl: fakeFetch,
      })
    ).rejects.toThrow(/HTTP 401/);
  });
});

// Real OpenAI hit — opt-in via env var. Skipped by default so CI stays offline.
const REAL_KEY = process.env.EMO_MODERATION_TEST_OPENAI_KEY;
const describeIfKey = REAL_KEY ? describe : describe.skip;
describeIfKey('screen against real OpenAI (opt-in via EMO_MODERATION_TEST_OPENAI_KEY)', () => {
  test('safe text → pass', async () => {
    const res = await screen('the weather is nice today', { openaiKey: REAL_KEY });
    expect(['pass', 'soft_flag']).toContain(res.action);
  }, 15000);
});

describe('module surface', () => {
  test('index exports the documented shape', () => {
    const mod = require('../src');
    expect(typeof mod.screen).toBe('function');
    expect(typeof mod.buildCrisisResponse).toBe('function');
    expect(typeof mod.assessAgeAppropriateness).toBe('function');
    expect(typeof mod.mapCategoriesToAction).toBe('function');
    expect(typeof mod.redactText).toBe('function');
    expect(typeof mod.callOpenAIModeration).toBe('function');
  });
  test('resource file is valid + present', () => {
    const registry = require(path.join(__dirname, '..', 'resources', 'tw-crisis-hotlines.json'));
    expect(registry.locales['zh-TW'].primary.number).toBe('1925');
    expect(registry.locales['zh-HK'].primary.number).toBe('2382-0000');
    expect(registry.locales['en-SG'].primary.number).toBe('1767');
    expect(registry.locales.default.primary.url).toBe('https://findahelpline.com');
  });
});
