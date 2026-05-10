'use strict';

/**
 * Petdx renderer module tests — pure unit coverage.
 *
 * The renderer ships as a UMD module (browser global + CommonJS export);
 * Jest can require it directly. Canvas-runner branches that need
 * requestAnimationFrame are NOT exercised here; we cover the deterministic
 * helpers (validation, state resolution, fps/loop lookup, drawer registry).
 */

const path = require('path');

const MODULE_PATH = path.resolve(__dirname, '../../public/shared/petdx-renderer.js');
const PetdxRenderer = require(MODULE_PATH);

const VALID_DESCRIPTOR = Object.freeze({
    id: 'petdx-test',
    name: 'Test',
    assetType: 'procedural',
    asset: { renderer: 'lobster-procedural', params: { bodyColor: '#fff' } },
    supportedStates: ['IDLE', 'BUSY', 'SLEEPING'],
    stateAssets: {
        IDLE:     { loop: true,  fps: 4 },
        BUSY:     { loop: true,  fps: 6 },
        SLEEPING: { loop: true,  fps: 2 },
    },
});

describe('validateDescriptor', () => {
    test('returns null for valid descriptor', () => {
        expect(PetdxRenderer.validateDescriptor(VALID_DESCRIPTOR)).toBeNull();
    });

    test('rejects missing descriptor', () => {
        expect(PetdxRenderer.validateDescriptor(null)).toBe('descriptor_required');
        expect(PetdxRenderer.validateDescriptor(undefined)).toBe('descriptor_required');
    });

    test('rejects missing id', () => {
        const d = { ...VALID_DESCRIPTOR, id: '' };
        expect(PetdxRenderer.validateDescriptor(d)).toBe('descriptor_missing_id');
    });

    test('rejects missing assetType', () => {
        const d = { ...VALID_DESCRIPTOR, assetType: undefined };
        expect(PetdxRenderer.validateDescriptor(d)).toBe('descriptor_missing_asset_type');
    });

    test('rejects empty supportedStates', () => {
        const d = { ...VALID_DESCRIPTOR, supportedStates: [] };
        expect(PetdxRenderer.validateDescriptor(d)).toBe('descriptor_missing_supported_states');
    });

    test('rejects descriptor without IDLE in supportedStates', () => {
        const d = { ...VALID_DESCRIPTOR, supportedStates: ['BUSY'] };
        expect(PetdxRenderer.validateDescriptor(d)).toBe('descriptor_must_support_idle');
    });
});

describe('resolveState (silent fallback to IDLE per spec §2.3)', () => {
    test('preserves supported state', () => {
        const r = PetdxRenderer.resolveState(VALID_DESCRIPTOR, 'BUSY');
        expect(r).toMatchObject({ resolved: 'BUSY', didFallback: false });
    });

    test('falls back to IDLE for unsupported state', () => {
        const r = PetdxRenderer.resolveState(VALID_DESCRIPTOR, 'SAD');
        expect(r).toMatchObject({ resolved: 'IDLE', didFallback: true });
    });

    test('falls back when descriptor has no supportedStates list', () => {
        const r = PetdxRenderer.resolveState({}, 'IDLE');
        expect(r.resolved).toBe('IDLE');
        expect(r.didFallback).toBe(true);
    });

    test('default fallback policy is silent_to_idle', () => {
        const r = PetdxRenderer.resolveState(VALID_DESCRIPTOR, 'NOPE');
        expect(r.policy).toBe('silent_to_idle');
    });
});

describe('getStateFps', () => {
    test('returns descriptor fps when valid', () => {
        expect(PetdxRenderer.getStateFps(VALID_DESCRIPTOR, 'BUSY')).toBe(6);
    });

    test('falls back to default 4 when state missing', () => {
        expect(PetdxRenderer.getStateFps(VALID_DESCRIPTOR, 'WHATEVER')).toBe(4);
    });

    test('falls back to default when fps is non-positive', () => {
        const d = { ...VALID_DESCRIPTOR, stateAssets: { IDLE: { fps: 0 } } };
        expect(PetdxRenderer.getStateFps(d, 'IDLE')).toBe(4);
    });
});

describe('getStateLoop', () => {
    test('defaults to true when not specified', () => {
        const d = { ...VALID_DESCRIPTOR, stateAssets: { IDLE: { fps: 4 } } };
        expect(PetdxRenderer.getStateLoop(d, 'IDLE')).toBe(true);
    });

    test('returns false when explicit', () => {
        const d = { ...VALID_DESCRIPTOR, stateAssets: { IDLE: { fps: 4, loop: false } } };
        expect(PetdxRenderer.getStateLoop(d, 'IDLE')).toBe(false);
    });
});

describe('procedural drawer registry', () => {
    test('registerProceduralDrawer stores fn retrievable by key', () => {
        PetdxRenderer.registerProceduralDrawer('test-cat', () => {});
        expect(typeof PetdxRenderer.getProceduralDrawer('test-cat')).toBe('function');
    });

    test('rejects empty key', () => {
        expect(() => PetdxRenderer.registerProceduralDrawer('', () => {}))
            .toThrow(/non-empty/);
    });

    test('rejects non-function drawer', () => {
        expect(() => PetdxRenderer.registerProceduralDrawer('bad', 'nope'))
            .toThrow(/function/);
    });

    test('built-in lobster-procedural is registered', () => {
        expect(typeof PetdxRenderer.getProceduralDrawer('lobster-procedural')).toBe('function');
    });

    test('built-in fallback-blob is registered', () => {
        expect(typeof PetdxRenderer.getProceduralDrawer('fallback-blob')).toBe('function');
    });

    test('returns null for unknown renderer key', () => {
        expect(PetdxRenderer.getProceduralDrawer('does-not-exist')).toBeNull();
    });
});

describe('createRenderer factory contract', () => {
    function makeMockCanvas() {
        const ctx = {
            calls: [],
            clearRect: jest.fn(),
            save: jest.fn(), restore: jest.fn(),
            fillRect: jest.fn(), fillText: jest.fn(),
            beginPath: jest.fn(), arc: jest.fn(), ellipse: jest.fn(),
            quadraticCurveTo: jest.fn(), moveTo: jest.fn(), stroke: jest.fn(), fill: jest.fn(),
            set fillStyle(_) {}, get fillStyle() { return ''; },
            set strokeStyle(_) {}, get strokeStyle() { return ''; },
            set lineWidth(_) {}, get lineWidth() { return 1; },
            set lineCap(_) {}, get lineCap() { return 'butt'; },
            set font(_) {}, get font() { return ''; },
            set textAlign(_) {}, get textAlign() { return 'start'; },
        };
        return {
            width: 320, height: 320,
            getContext: () => ctx,
        };
    }

    test('throws when canvas missing', () => {
        expect(() => PetdxRenderer.createRenderer({ descriptor: VALID_DESCRIPTOR }))
            .toThrow(/canvas/);
    });

    test('throws when descriptor invalid', () => {
        expect(() => PetdxRenderer.createRenderer({
            canvas: makeMockCanvas(),
            descriptor: { id: 'x', assetType: 'procedural', supportedStates: [] },
        })).toThrow();
    });

    test('controller exposes setState/setDescriptor/getState/start/stop', () => {
        const r = PetdxRenderer.createRenderer({
            canvas: makeMockCanvas(),
            descriptor: VALID_DESCRIPTOR,
            state: 'BUSY',
        });
        expect(r.getState()).toBe('BUSY');

        const change = r.setState('SLEEPING');
        expect(change.resolved).toBe('SLEEPING');
        expect(change.didFallback).toBe(false);

        const fallback = r.setState('EATING');
        expect(fallback).toMatchObject({ resolved: 'IDLE', didFallback: true });
        expect(r.getState()).toBe('IDLE');

        const newDescriptor = { ...VALID_DESCRIPTOR, id: 'petdx-other' };
        r.setDescriptor(newDescriptor);
        expect(r.getDescriptor().id).toBe('petdx-other');
    });

    test('controller defaults to IDLE when initial state unsupported', () => {
        const r = PetdxRenderer.createRenderer({
            canvas: makeMockCanvas(),
            descriptor: VALID_DESCRIPTOR,
            state: 'NEVERHEARDOFIT',
        });
        expect(r.getState()).toBe('IDLE');
    });
});
