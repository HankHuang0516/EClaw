const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC_PATH = path.join(__dirname, '../../public/portal/shared/entity-utils.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

const LOBSTER = '\u{1F99E}';
const PIG = '\u{1F437}';

function loadResolver() {
    const ctx = {
        window: {},
        localStorage: { _data: {}, getItem(k) { return this._data[k] || null; }, setItem(k, v) { this._data[k] = v; } },
        console,
    };
    vm.createContext(ctx);
    vm.runInContext(SRC, ctx);
    return ctx;
}

describe('portal entity-utils — character-driven avatar resolver (rebind sync)', () => {
    test('character=LOBSTER avatar=null on entityId=1 resolves to LOBSTER (not hardcoded PIG)', () => {
        const ctx = loadResolver();
        ctx.updateEntityMaps([{ entityId: 1, name: 'Mac_F', character: 'LOBSTER', avatar: null }]);
        expect(ctx.getAvatarForEntity(1)).toBe(LOBSTER);
        expect(ctx.getAvatarText(1)).toBe(LOBSTER);
    });

    test('character=LOBSTER avatar=null on entityId=5 resolves to LOBSTER (not mod-4 fallback PIG)', () => {
        const ctx = loadResolver();
        ctx.updateEntityMaps([{ entityId: 5, name: 'Hermes', character: 'LOBSTER', avatar: null }]);
        expect(ctx.getAvatarForEntity(5)).toBe(LOBSTER);
    });

    test('character=PIG avatar=null resolves to PIG', () => {
        const ctx = loadResolver();
        ctx.updateEntityMaps([{ entityId: 2, name: 'Pigtest', character: 'PIG', avatar: null }]);
        expect(ctx.getAvatarForEntity(2)).toBe(PIG);
    });

    test('explicit avatar emoji wins over character default', () => {
        const ctx = loadResolver();
        ctx.updateEntityMaps([{ entityId: 1, name: 'Mac_F', character: 'LOBSTER', avatar: '\u{1F431}' }]);
        expect(ctx.getAvatarForEntity(1)).toBe('\u{1F431}');
    });

    test('URL avatar — getAvatarText falls back to character emoji, not id-default', () => {
        const ctx = loadResolver();
        ctx.updateEntityMaps([{ entityId: 1, name: 'Mac_F', character: 'LOBSTER', avatar: 'https://x/a.jpg' }]);
        expect(ctx.getAvatarText(1)).toBe(LOBSTER);
    });

    test('unknown character resolves to LOBSTER default (not PIG via id-mapping)', () => {
        const ctx = loadResolver();
        ctx.updateEntityMaps([{ entityId: 1, name: 'X', character: 'SHEEP', avatar: null }]);
        expect(ctx.getAvatarForEntity(1)).toBe(LOBSTER);
    });

    test('display name comes from server, not legacy character-id table', () => {
        const ctx = loadResolver();
        ctx.updateEntityMaps([{ entityId: 1, name: 'Mac_F', character: 'LOBSTER', avatar: null }]);
        expect(ctx.getEntityDisplayName(1)).toBe('Mac_F');
    });

    test('updateEntityMaps clears stale character state on subsequent calls', () => {
        const ctx = loadResolver();
        ctx.updateEntityMaps([{ entityId: 1, character: 'PIG', avatar: null }]);
        expect(ctx.getAvatarForEntity(1)).toBe(PIG);
        ctx.updateEntityMaps([{ entityId: 1, character: 'LOBSTER', avatar: null }]);
        expect(ctx.getAvatarForEntity(1)).toBe(LOBSTER);
    });
});

describe('portal entity-utils — Phase 0 petdx-aware resolver chain', () => {
    const PETDX_LOBSTER_URL = '/static/companions/petdx-lobster-default/avatar.png';

    test('petdxAvatarUrl from /api/entities enrichment beats character emoji', () => {
        const ctx = loadResolver();
        ctx.updateEntityMaps([{ entityId: 1, name: 'Mac_F', character: 'LOBSTER', avatar: null,
            petdxAvatarUrl: PETDX_LOBSTER_URL }]);
        expect(ctx.getAvatarForEntity(1)).toBe(PETDX_LOBSTER_URL);
    });

    test('default-emoji avatar dropped from _entityAvatarMap (§0.4 invariant) so petdx wins', () => {
        const ctx = loadResolver();
        // Stale entity carries the lobster emoji as its "avatar" — must NOT beat petdxAvatarUrl
        ctx.updateEntityMaps([{ entityId: 1, name: 'Mac_F', character: 'LOBSTER', avatar: LOBSTER,
            petdxAvatarUrl: PETDX_LOBSTER_URL }]);
        expect(ctx.getAvatarForEntity(1)).toBe(PETDX_LOBSTER_URL);
    });

    test('user-set custom emoji avatar still beats petdx idle frame', () => {
        const ctx = loadResolver();
        ctx.updateEntityMaps([{ entityId: 1, character: 'LOBSTER', avatar: '\u{1F431}',
            petdxAvatarUrl: PETDX_LOBSTER_URL }]);
        expect(ctx.getAvatarForEntity(1)).toBe('\u{1F431}');
    });

    test('AvatarPetdx.descriptorAvatarUrl is consulted when enrichment is absent', () => {
        const ctx = loadResolver();
        ctx.window.AvatarPetdx = {
            descriptorAvatarUrl: (id) => id === 1 ? '/static/companions/petdx-lobster-default/avatar.png' : null,
        };
        ctx.updateEntityMaps([{ entityId: 1, character: 'LOBSTER', avatar: null }]);
        expect(ctx.getAvatarForEntity(1)).toBe(PETDX_LOBSTER_URL);
    });

    test('character emoji stopgap still fires when no petdx layer answers', () => {
        const ctx = loadResolver();
        ctx.updateEntityMaps([{ entityId: 1, character: 'LOBSTER', avatar: null }]);
        expect(ctx.getAvatarForEntity(1)).toBe(LOBSTER);
    });
});

describe('portal entity-utils — static guard against id-based hardcoded character defaults', () => {
    test('ENTITY_CHARS_DEFAULT no longer maps any entityId to PIG', () => {
        const idDefaultMatch = SRC.match(/const\s+ENTITY_CHARS_DEFAULT\s*=\s*\{([\s\S]*?)\};/);
        expect(idDefaultMatch).not.toBeNull();
        const body = idDefaultMatch[1];
        expect(body).not.toMatch(/1F437/);
        expect(body).not.toMatch(/Pig/);
    });

    test('CHARACTER_EMOJI map is the canonical character→emoji table', () => {
        expect(SRC).toMatch(/CHARACTER_EMOJI\s*=\s*\{[\s\S]*LOBSTER[\s\S]*PIG[\s\S]*\}/);
    });

    test('_entityCharacterMap is populated by updateEntityMaps', () => {
        expect(SRC).toMatch(/_entityCharacterMap\s*=\s*\{\}/);
        expect(SRC).toMatch(/_entityCharacterMap\[e\.entityId\]\s*=\s*e\.character/);
    });

    test('getAvatarForEntity consults character map before falling back to id-defaults', () => {
        const fnMatch = SRC.match(/function\s+getAvatarForEntity[\s\S]*?\n\}/);
        expect(fnMatch).not.toBeNull();
        const charLine = fnMatch[0].indexOf('_characterEmoji');
        const legacyLine = fnMatch[0].indexOf('ENTITY_CHARS_DEFAULT[entityId]');
        expect(charLine).toBeGreaterThan(-1);
        expect(legacyLine).toBeGreaterThan(charLine);
    });
});
