/**
 * Arena Pool Validator — regression coverage.
 *
 * Motivation: a malformed question landed in arena-questions.json and caused
 * `GET /arena/test/:examId` to 500 for every user. The validator runs every
 * generator + scorer in-process; this test guards that the validator itself
 * still catches the classes of failure we care about.
 */

'use strict';

// The validator requires interview-arena which requires db.js which requires pg.
// Reuse the same in-memory pg mock as interview-arena.test.js.
jest.mock('pg', () => ({
    Pool: jest.fn(() => ({
        query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
        connect: jest.fn(),
        end: jest.fn(),
        on: jest.fn(),
    })),
}));

const validator = require('../../arena-pool-validator');

describe('arena-pool-validator — static validation', () => {
    test('current in-tree pool passes (no blocking issues)', () => {
        const result = validator.validateStatic({ repeats: 3 });
        expect(result.ok).toBe(true);
        expect(result.issues).toEqual([]);
        expect(result.trials).toBe(3 * 12); // 12 test types × 3 repeats
    });

    test('warnings do not cause failure', () => {
        const result = validator.validateStatic({ repeats: 2 });
        expect(result.ok).toBe(true);
        // warnings may or may not exist; key invariant is that ok=true despite them
        expect(Array.isArray(result.warnings)).toBe(true);
    });
});

describe('arena-pool-validator — validateCandidatePools (bad inputs)', () => {
    afterEach(() => {
        // Reset to original on-disk pools between tests in case a previous
        // test's restore didn't fire cleanly.
        // (validateCandidatePools has its own finally, but belt + suspenders.)
    });

    test('rejects a pool whose coding problems have no testCases', () => {
        const broken = {
            arena_coding: [{ title: 'Bad', description: 'No tests' }],
        };
        const result = validator.validateCandidatePools(broken, { log: () => {} });
        expect(result.ok).toBe(false);
        expect(result.issues.some(i => i.includes('testCases'))).toBe(true);
    });

    test('rejects a pool whose vision entries have no keywords', () => {
        const broken = {
            arena_vision: [{ file: null, description: 'Just a scene', keywords: [] }],
        };
        const result = validator.validateCandidatePools(broken, { log: () => {} });
        // Vision shape check flags missing expectedKeywords-equivalent or scorer returns 0
        expect(result.ok).toBe(false);
    });

    test('rejects a pool whose response-time questions have no expectedKeywords', () => {
        const broken = {
            arena_response_time: [{ question: 'What is 2+2?' }],
        };
        const result = validator.validateCandidatePools(broken, { log: () => {} });
        expect(result.ok).toBe(false);
        expect(result.issues.some(i => i.includes('expectedKeywords'))).toBe(true);
    });

    test('rejects a pool whose TTS entries have empty keywords', () => {
        const broken = {
            arena_tts: [{ text: 'Hello world' }], // missing keywords
        };
        const result = validator.validateCandidatePools(broken, { log: () => {} });
        expect(result.ok).toBe(false);
        expect(result.issues.some(i => i.includes('keywords'))).toBe(true);
    });

    test('accepts a minimal but well-formed pool', () => {
        const good = {
            arena_vision:        [{ file: null, description: 'A red square on white', keywords: ['red', 'square'] }],
            arena_coding:        [{ title: 'Sum', description: 'Write solve(a,b) returning a+b', testCases: [{ input: '1,2', expected: '3' }] }],
            arena_response_time: [{ question: 'What is 2+2?', expectedKeywords: ['4'] }],
            arena_tts:           [{ text: 'Hello world', keywords: ['hello', 'world'] }],
        };
        const result = validator.validateCandidatePools(good, { repeats: 2, log: () => {} });
        expect(result.ok).toBe(true);
    });
});

describe('arena factory return exports contract (regression: GET /arena/test/:examId 500)', () => {
    test('factory return exposes stripSecretsForBot (used by index.js GET /arena/test/:examId)', () => {
        const factory = require('../../interview-arena');
        const arenaModule = factory({ serverLog: () => {}, io: null });
        expect(typeof arenaModule.stripSecretsForBot).toBe('function');
    });

    test('factory return exposes reloadPools and getCurrentPools (used by pool updater cron)', () => {
        const factory = require('../../interview-arena');
        const arenaModule = factory({ serverLog: () => {}, io: null });
        expect(typeof arenaModule.reloadPools).toBe('function');
        expect(typeof arenaModule.getCurrentPools).toBe('function');
    });
});

describe('arena-pool-validator — PERFECT_ACTIONS coverage', () => {
    test('every TEST_TYPE has a synthetic-perfect action builder', () => {
        const arena = require('../../interview-arena');
        for (const tt of arena.TEST_TYPES) {
            expect(validator.PERFECT_ACTIONS).toHaveProperty(tt.id);
            expect(typeof validator.PERFECT_ACTIONS[tt.id]).toBe('function');
        }
    });

    test('every TEST_TYPE has required-field declarations', () => {
        const arena = require('../../interview-arena');
        for (const tt of arena.TEST_TYPES) {
            expect(validator.CONFIG_REQUIRED_FIELDS).toHaveProperty(tt.id);
            expect(Array.isArray(validator.CONFIG_REQUIRED_FIELDS[tt.id])).toBe(true);
        }
    });
});
