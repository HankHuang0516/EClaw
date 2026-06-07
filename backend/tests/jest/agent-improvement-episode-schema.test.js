/**
 * Phase 0 #1 — episode schema + redaction + taxonomy coverage.
 * Card: card_e9de7607cd9a838462148328
 * Parent: card_be59aa034883fe36d3645a27
 *
 * jest.config.js uses testEnvironment: 'node'. No JSDOM needed — schema is
 * a pure data contract.
 */
'use strict';

const {
  PAIN_TAXONOMY,
  SEVERITY_LEVELS,
  findSecret,
  assertNoSecrets,
  validateEpisode,
} = require('../../agent-improvement/episode-schema');

const FIXTURES = require('../../agent-improvement/__tests__/fixtures/episodes');

describe('PAIN_TAXONOMY', () => {
  test('has exactly the 8 closed-set tags the roadmap commits to', () => {
    expect(PAIN_TAXONOMY).toEqual([
      'delivery_reliability',
      'auth_session',
      'redirect_deeplink',
      'ux_feedback',
      'agent_ownership',
      'task_context',
      'test_coverage',
      'scope_completeness',
    ]);
  });

  test('is frozen so downstream consumers cannot silently extend it', () => {
    expect(Object.isFrozen(PAIN_TAXONOMY)).toBe(true);
  });
});

describe('validateEpisode()', () => {
  test('accepts every fixture as valid', () => {
    for (const ep of FIXTURES) {
      const errs = validateEpisode(ep);
      expect(errs).toEqual([]);
    }
  });

  test('rejects missing required fields', () => {
    const errs = validateEpisode({});
    expect(errs).toContain('missing required field: cardId');
    expect(errs).toContain('missing required field: entityId');
    expect(errs).toContain('missing required field: painTags');
    expect(errs).toContain('missing required field: severity');
  });

  test('rejects unknown painTag', () => {
    const ep = { ...FIXTURES[0], painTags: ['something_made_up'] };
    const errs = validateEpisode(ep);
    expect(errs.some(e => e.includes('unknown tag: something_made_up'))).toBe(true);
  });

  test('rejects empty painTags array', () => {
    const ep = { ...FIXTURES[0], painTags: [] };
    const errs = validateEpisode(ep);
    expect(errs).toContain('painTags must be non-empty');
  });

  test('rejects severity outside closed set', () => {
    const ep = { ...FIXTURES[0], severity: 'P9' };
    const errs = validateEpisode(ep);
    expect(errs.some(e => e.startsWith('severity must be one of'))).toBe(true);
  });

  test('rejects non-ISO occurredAt', () => {
    const ep = { ...FIXTURES[0], occurredAt: 'last Tuesday' };
    const errs = validateEpisode(ep);
    expect(errs).toContain('occurredAt must be ISO-8601 parseable');
  });

  test('rejects evidence entries missing kind/ref', () => {
    const ep = { ...FIXTURES[0], evidence: [{ kind: 'pr' }] };
    const errs = validateEpisode(ep);
    expect(errs.some(e => e.startsWith('evidence[0].ref'))).toBe(true);
  });

  test('returns non-object error for null input', () => {
    expect(validateEpisode(null)).toEqual(['episode is not an object']);
  });
});

describe('findSecret() / assertNoSecrets()', () => {
  test('flags bot_secret label', () => {
    expect(findSecret('see bot_secret value below')).not.toBeNull();
  });

  test('flags Bearer token shape', () => {
    expect(findSecret('Authorization: Bearer abc.def.ghi')).not.toBeNull();
  });

  test('flags hex-32+ run', () => {
    expect(findSecret('token=' + 'a'.repeat(32))).not.toBeNull();
  });

  test('flags RAILWAY_ env reference with assignment', () => {
    expect(findSecret('RAILWAY_TOKEN=abc123')).not.toBeNull();
  });

  test('flags password assignment', () => {
    expect(findSecret('password = hunter2')).not.toBeNull();
  });

  test('passes clean strings', () => {
    expect(findSecret('PR#3221 ticked counter for entityId=1')).toBeNull();
    expect(findSecret('card_e9de7607cd9a838462148328')).toBeNull();
  });

  test('every fixture passes assertNoSecrets', () => {
    for (const ep of FIXTURES) {
      expect(() => assertNoSecrets(ep)).not.toThrow();
    }
  });

  test('assertNoSecrets throws when a nested evidence note contains a secret', () => {
    const ep = {
      ...FIXTURES[0],
      evidence: [{ kind: 'log', ref: 'logs/x.log', note: 'bot_secret=oops' }],
    };
    expect(() => assertNoSecrets(ep)).toThrow(/secret-shaped/);
  });
});

describe('taxonomy coverage by fixtures', () => {
  test('every PAIN_TAXONOMY tag has at least one fixture', () => {
    const covered = new Set();
    for (const ep of FIXTURES) {
      for (const t of ep.painTags) covered.add(t);
    }
    const missing = PAIN_TAXONOMY.filter(t => !covered.has(t));
    expect(missing).toEqual([]);
  });

  test('every fixture severity is in the closed set', () => {
    for (const ep of FIXTURES) {
      expect(SEVERITY_LEVELS).toContain(ep.severity);
    }
  });
});
