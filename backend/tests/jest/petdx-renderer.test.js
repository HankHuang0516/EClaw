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

describe('spritesheet helpers (Petdex bridge)', () => {
    const SPRITESHEET_DESCRIPTOR = Object.freeze({
        id: 'petdex-boba',
        name: 'Boba',
        assetType: 'spritesheet',
        asset: {
            url: 'https://example/boba.webp',
            cols: 8, rows: 9, frameWidth: 192, frameHeight: 208,
            animations: {
                idle: { row: 0, frames: [280, 110, 110, 140, 140, 320] },
                running: { row: 7, count: 6, dur: 120, last: 220 },
                waving: { row: 3, count: 4, dur: 140, last: 280 },
            },
        },
        supportedStates: ['IDLE', 'BUSY', 'HAPPY'],
        stateAssets: {
            IDLE: { animation: 'idle', loop: true },
            BUSY: { animation: 'running', loop: true },
            HAPPY: { animation: 'waving', loop: false },
        },
    });

    test('pickAnimationName routes state to animation name, fallback to idle', () => {
        expect(PetdxRenderer.pickAnimationName(SPRITESHEET_DESCRIPTOR, 'IDLE')).toBe('idle');
        expect(PetdxRenderer.pickAnimationName(SPRITESHEET_DESCRIPTOR, 'BUSY')).toBe('running');
        expect(PetdxRenderer.pickAnimationName(SPRITESHEET_DESCRIPTOR, 'NOPE')).toBe('idle');
        expect(PetdxRenderer.pickAnimationName({}, 'IDLE')).toBe('idle');
    });

    test('computeFrameIndex over a frames[] table walks per-frame durations', () => {
        const idle = SPRITESHEET_DESCRIPTOR.asset.animations.idle;
        // frames: [280, 110, 110, 140, 140, 320] — cumulative 280/390/500/640/780/1100
        expect(PetdxRenderer.computeFrameIndex(idle, 0, true)).toBe(0);
        expect(PetdxRenderer.computeFrameIndex(idle, 279, true)).toBe(0);
        expect(PetdxRenderer.computeFrameIndex(idle, 280, true)).toBe(1);
        expect(PetdxRenderer.computeFrameIndex(idle, 399, true)).toBe(2);
        expect(PetdxRenderer.computeFrameIndex(idle, 781, true)).toBe(5);
        // looping wraps at total=1100
        expect(PetdxRenderer.computeFrameIndex(idle, 1100, true)).toBe(0);
        expect(PetdxRenderer.computeFrameIndex(idle, 1100 + 281, true)).toBe(1);
    });

    test('computeFrameIndex over a uniform count/dur table honours last-frame override', () => {
        const running = SPRITESHEET_DESCRIPTOR.asset.animations.running;
        // 6 frames; first 5 are 120ms, last is 220ms → cumulative 120/240/360/480/600/820
        expect(PetdxRenderer.computeFrameIndex(running, 0, true)).toBe(0);
        expect(PetdxRenderer.computeFrameIndex(running, 119, true)).toBe(0);
        expect(PetdxRenderer.computeFrameIndex(running, 120, true)).toBe(1);
        expect(PetdxRenderer.computeFrameIndex(running, 599, true)).toBe(4);
        expect(PetdxRenderer.computeFrameIndex(running, 600, true)).toBe(5);
        expect(PetdxRenderer.computeFrameIndex(running, 819, true)).toBe(5);
        // wraps at 820
        expect(PetdxRenderer.computeFrameIndex(running, 820, true)).toBe(0);
    });

    test('computeFrameIndex non-looping clamps to last frame past total', () => {
        const waving = SPRITESHEET_DESCRIPTOR.asset.animations.waving;
        // count=4, dur=140, last=280 → 140/280/420/700
        expect(PetdxRenderer.computeFrameIndex(waving, 700, false)).toBe(3);
        expect(PetdxRenderer.computeFrameIndex(waving, 9999, false)).toBe(3);
        expect(PetdxRenderer.computeFrameIndex(waving, 140, false)).toBe(1);
    });
});
