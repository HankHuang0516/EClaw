/**
 * Unit tests for exam-stage-mapper — pure function maps arena socket
 * events to companion-avatar emotion ids.
 *
 * Card: card_eda0e8f889c677f8d468a8b5
 */
const mapper = require('../../public/arena/exam-stage-mapper');

describe('arena exam stage mapper', () => {
    test('exposes the 5 emotion ids referenced by the CSS keyframes', () => {
        expect(mapper.EMOTIONS).toEqual(['ready', 'focused', 'celebrate', 'concerned', 'proud']);
    });

    test('initial state is "ready" when exam has not started', () => {
        expect(mapper.initialState()).toBe('ready');
        expect(mapper.initialState({ status: 'waiting' })).toBe('ready');
        expect(mapper.initialState({ status: 'active' })).toBe('ready');
    });

    test('initial state is "proud" when exam loads already completed', () => {
        expect(mapper.initialState({ status: 'completed' })).toBe('proud');
    });

    test('exam_complete always maps to "proud"', () => {
        expect(mapper.mapEvent({ event: 'exam_complete', totalScore: 0 }, { emotion: 'concerned' })).toBe('proud');
        expect(mapper.mapEvent({ event: 'exam_complete', totalScore: 147 }, { emotion: 'celebrate' })).toBe('proud');
    });

    test('session_complete with score > 0 → "celebrate"', () => {
        expect(mapper.mapEvent({ event: 'session_complete', testIndex: 0, score: 15, maxScore: 15 }, {})).toBe('celebrate');
        expect(mapper.mapEvent({ event: 'session_complete', testIndex: 5, score: 1, maxScore: 10 }, {})).toBe('celebrate');
    });

    test('session_complete with score == 0 → "concerned"', () => {
        expect(mapper.mapEvent({ event: 'session_complete', testIndex: 2, score: 0, maxScore: 15 }, {})).toBe('concerned');
    });

    test('session_complete with malformed score → "concerned" (no stale state)', () => {
        expect(mapper.mapEvent({ event: 'session_complete', testIndex: 4 }, {})).toBe('concerned');
        expect(mapper.mapEvent({ event: 'session_complete', testIndex: 4, score: 'abc' }, {})).toBe('concerned');
    });

    test('mid-test action → "focused"', () => {
        expect(mapper.mapEvent({ event: 'action', testIndex: 7 }, { emotion: 'ready' })).toBe('focused');
    });

    test('action without testIndex is ignored (no transition)', () => {
        expect(mapper.mapEvent({ event: 'action' }, { emotion: 'ready' })).toBeNull();
    });

    test('timer_started lifts "ready" → "focused"', () => {
        expect(mapper.mapEvent({ event: 'timer_started', expiresAt: '2026-06-16T10:00:00Z' }, { emotion: 'ready' })).toBe('focused');
    });

    test('model_set lifts "ready" → "focused"', () => {
        expect(mapper.mapEvent({ event: 'model_set', model: 'opus-4-7' }, { emotion: 'ready' })).toBe('focused');
    });

    test('late timer_started does NOT downgrade celebrate / concerned / proud', () => {
        expect(mapper.mapEvent({ event: 'timer_started' }, { emotion: 'celebrate' })).toBeNull();
        expect(mapper.mapEvent({ event: 'timer_started' }, { emotion: 'concerned' })).toBeNull();
        expect(mapper.mapEvent({ event: 'model_set' }, { emotion: 'proud' })).toBeNull();
    });

    test('unrecognized events return null (no transition)', () => {
        expect(mapper.mapEvent({ event: 'something_else' }, { emotion: 'focused' })).toBeNull();
        expect(mapper.mapEvent({}, { emotion: 'focused' })).toBeNull();
        expect(mapper.mapEvent(null, { emotion: 'focused' })).toBeNull();
        expect(mapper.mapEvent(undefined, { emotion: 'focused' })).toBeNull();
    });

    test('full happy-path 12-test flow ends at "proud"', () => {
        let state = { emotion: mapper.initialState() };
        expect(state.emotion).toBe('ready');

        // First action received
        state.emotion = mapper.mapEvent({ event: 'action', testIndex: 0 }, state) || state.emotion;
        expect(state.emotion).toBe('focused');

        // Pass tests 0..10
        for (let i = 0; i < 11; i++) {
            const e = mapper.mapEvent({ event: 'session_complete', testIndex: i, score: 10, maxScore: 15 }, state);
            state.emotion = e || state.emotion;
            expect(state.emotion).toBe('celebrate');
            state.emotion = mapper.mapEvent({ event: 'action', testIndex: i + 1 }, state) || state.emotion;
        }
        // Fail final test
        state.emotion = mapper.mapEvent({ event: 'session_complete', testIndex: 11, score: 0, maxScore: 10 }, state) || state.emotion;
        expect(state.emotion).toBe('concerned');

        // Exam completes
        state.emotion = mapper.mapEvent({ event: 'exam_complete', totalScore: 110, maxScore: 147 }, state) || state.emotion;
        expect(state.emotion).toBe('proud');
    });
});
