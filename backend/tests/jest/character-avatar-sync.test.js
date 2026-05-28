/**
 * Jest test: Character → avatar sync on rebind and transform.
 *
 * Covers the P0 bug where entity.avatar drifted from entity.character after:
 *   - /api/official-borrow/bind-free      (default avatar wasn't seeded)
 *   - /api/official-borrow/bind-personal  (same)
 *   - /api/transform body { character }   (character changed, avatar didn't)
 *
 * Acceptance:
 *   1. After rebind, kanban-side avatar resolves to the new character's default
 *   2. A user-customized avatar is preserved across rebind / character change
 *   3. createDefaultEntity returns avatar matching its character
 */

jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        connect: jest.fn().mockResolvedValue({
            query: jest.fn().mockResolvedValue({ rows: [] }),
            release: jest.fn(),
        }),
        end: jest.fn().mockResolvedValue(undefined),
    })),
}));

jest.mock('../../db', () => ({
    initDatabase: jest.fn().mockResolvedValue(true),
    saveDeviceData: jest.fn().mockResolvedValue(true),
    saveAllDevices: jest.fn().mockResolvedValue(true),
    loadAllDevices: jest.fn().mockResolvedValue({}),
    deleteDevice: jest.fn().mockResolvedValue(true),
    getStats: jest.fn().mockResolvedValue({}),
    closeDatabase: jest.fn().mockResolvedValue(undefined),
    saveOfficialBot: jest.fn().mockResolvedValue(true),
    loadOfficialBots: jest.fn().mockResolvedValue({}),
    deleteOfficialBot: jest.fn().mockResolvedValue(true),
    saveOfficialBinding: jest.fn().mockResolvedValue(true),
    removeOfficialBinding: jest.fn().mockResolvedValue(true),
    getOfficialBinding: jest.fn().mockResolvedValue(null),
    getDeviceOfficialBindings: jest.fn().mockResolvedValue([]),
    updateSubscriptionVerified: jest.fn().mockResolvedValue(true),
    loadAllOfficialBindings: jest.fn().mockResolvedValue([]),
    getExpiredPersonalBindings: jest.fn().mockResolvedValue([]),
    getPaidBorrowSlots: jest.fn().mockResolvedValue(0),
    incrementPaidBorrowSlots: jest.fn().mockResolvedValue(true),
    saveFeedback: jest.fn().mockResolvedValue({ id: 1 }),
}));

jest.mock('../../flickr', () => ({
    initFlickr: jest.fn(),
    uploadPhoto: jest.fn().mockResolvedValue({ success: true, url: 'https://x', photoId: '1' }),
    isAvailable: jest.fn().mockReturnValue(true),
}));

jest.mock('../../scheduler', () => ({
    init: jest.fn(),
    createSchedule: jest.fn().mockResolvedValue({ id: 1 }),
    updateSchedule: jest.fn().mockResolvedValue(true),
    deleteSchedule: jest.fn().mockResolvedValue(true),
    getSchedules: jest.fn().mockResolvedValue([]),
    getSchedule: jest.fn().mockResolvedValue(null),
    getSchedulesForBot: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../device-telemetry', () => ({
    initTelemetryTable: jest.fn().mockResolvedValue(undefined),
    appendEntries: jest.fn().mockResolvedValue(undefined),
    captureApiCall: jest.fn().mockResolvedValue(undefined),
    getEntries: jest.fn().mockResolvedValue([]),
    getSummary: jest.fn().mockResolvedValue({}),
    clearEntries: jest.fn().mockResolvedValue(undefined),
    createMiddleware: jest.fn().mockReturnValue((_req, _res, next) => next()),
    sanitize: jest.fn().mockImplementation((v) => v),
    MAX_BUFFER_BYTES: 1024 * 1024,
    MAX_ENTRIES: 500,
}));

jest.mock('../../device-feedback', () => ({
    initFeedbackTable: jest.fn().mockResolvedValue(undefined),
    initFeedbackPhotosTable: jest.fn().mockResolvedValue(undefined),
    captureLogSnapshot: jest.fn().mockResolvedValue([]),
    captureDeviceState: jest.fn().mockResolvedValue({}),
    autoTriage: jest.fn().mockResolvedValue('low'),
    generateAiPrompt: jest.fn().mockReturnValue(''),
    saveFeedback: jest.fn().mockResolvedValue({ id: 1 }),
    getFeedbackList: jest.fn().mockResolvedValue([]),
    getFeedbackById: jest.fn().mockResolvedValue(null),
    updateFeedback: jest.fn().mockResolvedValue(true),
    createGithubIssue: jest.fn().mockResolvedValue(null),
    getPendingDebugFeedback: jest.fn().mockResolvedValue([]),
    saveDebugResult: jest.fn().mockResolvedValue(true),
    setMark: jest.fn().mockResolvedValue(undefined),
    getMark: jest.fn().mockResolvedValue(null),
    clearMark: jest.fn().mockResolvedValue(undefined),
    LOG_WINDOW_MS: 60000,
    MAX_PHOTOS_PER_FEEDBACK: 10,
    MAX_PHOTO_SIZE: 5 * 1024 * 1024,
    saveFeedbackPhoto: jest.fn().mockResolvedValue({ id: 1 }),
    getFeedbackPhotos: jest.fn().mockResolvedValue([]),
    getFeedbackPhoto: jest.fn().mockResolvedValue(null),
    deleteFeedbackPhotos: jest.fn().mockResolvedValue(undefined),
    cleanupResolvedFeedbackPhotos: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../gatekeeper', () => ({
    detectMaliciousMessage: jest.fn().mockReturnValue({ isMalicious: false }),
    detectAndMaskLeaks: jest.fn().mockImplementation((text) => text),
    initGatekeeperTable: jest.fn().mockResolvedValue(undefined),
    loadBlockedDevices: jest.fn().mockResolvedValue(undefined),
    recordViolation: jest.fn().mockResolvedValue(undefined),
    isDeviceBlocked: jest.fn().mockReturnValue(false),
    getStrikeInfo: jest.fn().mockResolvedValue({ strikes: 0, blocked: false }),
    getFreeBotTOS: jest.fn().mockResolvedValue(null),
    hasAgreedToTOS: jest.fn().mockResolvedValue(false),
    recordTOSAgreement: jest.fn().mockResolvedValue(undefined),
    setServerLog: jest.fn(),
    MAX_STRIKES: 3,
    FREE_BOT_TOS_VERSION: '1.0',
}));

jest.mock('../../notifications', () => {
    const express = jest.requireActual('express');
    return {
        init: jest.fn(),
        router: express.Router(),
        initNotificationTables: jest.fn().mockResolvedValue(undefined),
    };
});

jest.mock('../../chat-integrity', () => ({
    init: jest.fn().mockReturnValue({
        verify: jest.fn().mockReturnValue({ valid: true }),
        sign: jest.fn().mockReturnValue('sig'),
    }),
    initIntegrityTable: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../device-preferences', () => ({
    init: jest.fn(),
    initTable: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../org-chart', () => ({
    initTable: jest.fn().mockResolvedValue(undefined),
    getOrgChart: jest.fn().mockResolvedValue({ hierarchy: {}, options: {} }),
    updateOrgChart: jest.fn().mockResolvedValue({ success: true, orgChart: { hierarchy: {}, options: {} } }),
    getSuperior: jest.fn().mockReturnValue(null),
    getSubordinates: jest.fn().mockReturnValue([]),
    buildDefault: jest.fn().mockReturnValue({ USER: [] }),
    pruneHierarchy: jest.fn().mockImplementation((h) => h),
    validateHierarchy: jest.fn().mockReturnValue({ valid: true }),
    validateOptions: jest.fn().mockImplementation((o) => o),
    onEntityDeleted: jest.fn().mockResolvedValue(undefined),
    invalidateCache: jest.fn(),
    DEFAULT_OPTIONS: {},
}));

const app = require('../../index');

const LOBSTER = '\u{1F99E}';
const PIG = '\u{1F437}';

describe('Character → avatar helpers', () => {
    test('createDefaultEntity seeds avatar to character default', () => {
        const e = app._createDefaultEntity(7);
        expect(e.character).toBe('LOBSTER');
        expect(e.avatar).toBe(LOBSTER);
    });

    test('getCharacterDefaultAvatar maps known characters', () => {
        expect(app._getCharacterDefaultAvatar('LOBSTER')).toBe(LOBSTER);
        expect(app._getCharacterDefaultAvatar('PIG')).toBe(PIG);
    });

    test('getCharacterDefaultAvatar falls back to LOBSTER for unknown character', () => {
        expect(app._getCharacterDefaultAvatar('UNKNOWN')).toBe(LOBSTER);
        expect(app._getCharacterDefaultAvatar(null)).toBe(LOBSTER);
    });

    test('isCharacterDefaultAvatar identifies default emojis as default', () => {
        expect(app._isCharacterDefaultAvatar(null)).toBe(true);
        expect(app._isCharacterDefaultAvatar('')).toBe(true);
        expect(app._isCharacterDefaultAvatar(LOBSTER)).toBe(true);
        expect(app._isCharacterDefaultAvatar(PIG)).toBe(true);
    });

    test('isCharacterDefaultAvatar flags custom avatars as non-default', () => {
        expect(app._isCharacterDefaultAvatar('\u{1F308}')).toBe(false); // 🌈 custom emoji
        expect(app._isCharacterDefaultAvatar('https://example.com/me.jpg')).toBe(false);
    });
});

describe('Character change → avatar sync rule (simulation)', () => {
    // Mirror the in-place logic from the /api/transform endpoint so we can
    // unit-test the sync decision matrix without standing up the full router.
    function applyCharacterChange(entity, nextCharacter) {
        if (nextCharacter && entity.character !== nextCharacter) {
            const oldDefault = app._getCharacterDefaultAvatar(entity.character);
            entity.character = nextCharacter;
            if (!entity.avatar || entity.avatar === oldDefault) {
                entity.avatar = app._getCharacterDefaultAvatar(nextCharacter);
            }
        } else if (nextCharacter) {
            entity.character = nextCharacter;
        }
        return entity;
    }

    test('character LOBSTER → PIG with default avatar updates to PIG default', () => {
        const e = { character: 'LOBSTER', avatar: LOBSTER };
        applyCharacterChange(e, 'PIG');
        expect(e.character).toBe('PIG');
        expect(e.avatar).toBe(PIG);
    });

    test('character LOBSTER → PIG with null avatar adopts PIG default', () => {
        const e = { character: 'LOBSTER', avatar: null };
        applyCharacterChange(e, 'PIG');
        expect(e.avatar).toBe(PIG);
    });

    test('character change preserves user-set custom avatar', () => {
        const e = { character: 'LOBSTER', avatar: 'https://example.com/me.jpg' };
        applyCharacterChange(e, 'PIG');
        expect(e.character).toBe('PIG');
        expect(e.avatar).toBe('https://example.com/me.jpg');
    });

    test('character change preserves user-set custom emoji', () => {
        const e = { character: 'LOBSTER', avatar: '\u{1F308}' };
        applyCharacterChange(e, 'PIG');
        expect(e.avatar).toBe('\u{1F308}');
    });

    test('no-op when character stays the same', () => {
        const e = { character: 'PIG', avatar: PIG };
        applyCharacterChange(e, 'PIG');
        expect(e.character).toBe('PIG');
        expect(e.avatar).toBe(PIG);
    });
});

describe('Rebind avatar reset rule (simulation)', () => {
    // Mirror bind-free / bind-personal: avatar resets to new character default
    // only if previous avatar was null or a known default; custom avatars survive.
    function applyRebind(existingEntity) {
        const defaults = app._createDefaultEntity(existingEntity?.entityId ?? 0);
        return {
            ...defaults,
            name: existingEntity?.name || '免費版',
            avatar: app._isCharacterDefaultAvatar(existingEntity?.avatar)
                ? app._getCharacterDefaultAvatar(defaults.character)
                : existingEntity.avatar,
        };
    }

    test('rebind from PIG default resets avatar to LOBSTER default', () => {
        const result = applyRebind({ entityId: 1, character: 'PIG', avatar: PIG });
        expect(result.character).toBe('LOBSTER');
        expect(result.avatar).toBe(LOBSTER);
    });

    test('rebind preserves user-set photo URL', () => {
        const result = applyRebind({
            entityId: 1, character: 'PIG', avatar: 'https://example.com/me.jpg',
        });
        expect(result.avatar).toBe('https://example.com/me.jpg');
    });

    test('rebind from null avatar yields LOBSTER default', () => {
        const result = applyRebind({ entityId: 1, character: 'PIG', avatar: null });
        expect(result.avatar).toBe(LOBSTER);
    });
});
