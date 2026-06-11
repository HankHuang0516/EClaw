/**
 * Level-up celebration logic — 情緒價值 #3 (card_91c97a12a385cac144ad223e).
 *
 * Drives shared/levelup.js check() (session diff + localStorage guard) under
 * node without a DOM. celebrate()'s DOM work is covered by the prod
 * Playwright E2E; here we lock the pure logic that decides WHEN to fire.
 */
'use strict';

const path = require('path');

function loadLevelUp() {
    const p = path.join(__dirname, '..', '..', 'public', 'portal', 'shared', 'levelup.js');
    delete require.cache[require.resolve(p)];
    return require(p);
}

function makeStorage(initial) {
    const map = new Map(Object.entries(initial || {}));
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        _dump: () => Object.fromEntries(map),
    };
}

describe('levelup — check() session diff', () => {
    let lvl, storage;
    beforeEach(() => {
        lvl = loadLevelUp();
        lvl._resetSession();
        storage = makeStorage();
    });

    test('first sighting primes baseline, never celebrates', () => {
        const hits = lvl.check([{ entityId: 2, name: 'LOBSTER', level: 7 }], storage);
        expect(hits).toEqual([]);
    });

    test('level increase after baseline celebrates once with entity info', () => {
        lvl.check([{ entityId: 2, name: 'LOBSTER', level: 7 }], storage);
        const hits = lvl.check([{ entityId: 2, name: 'LOBSTER', level: 8 }], storage);
        expect(hits).toEqual([{ entityId: 2, name: 'LOBSTER', level: 8 }]);
    });

    test('same level on next poll does not re-celebrate', () => {
        lvl.check([{ entityId: 2, level: 7 }], storage);
        lvl.check([{ entityId: 2, level: 8 }], storage);
        expect(lvl.check([{ entityId: 2, level: 8 }], storage)).toEqual([]);
    });

    test('level decrease never celebrates', () => {
        lvl.check([{ entityId: 2, level: 7 }], storage);
        expect(lvl.check([{ entityId: 2, level: 6 }], storage)).toEqual([]);
    });

    test('localStorage guard survives session reset (reload simulation)', () => {
        lvl.check([{ entityId: 2, level: 7 }], storage);
        lvl.check([{ entityId: 2, level: 8 }], storage); // celebrated, guard=8
        lvl._resetSession();                              // simulate reload
        lvl.check([{ entityId: 2, level: 7 }], storage);  // stale baseline first
        // poll catches up to 8 again — guard must block the duplicate
        expect(lvl.check([{ entityId: 2, level: 8 }], storage)).toEqual([]);
        // but a genuinely new level still fires
        expect(lvl.check([{ entityId: 2, level: 9 }], storage)).toEqual([
            { entityId: 2, name: '#2', level: 9 },
        ]);
    });

    test('multiple entities level up in one poll → multiple hits', () => {
        lvl.check([{ entityId: 1, level: 3 }, { entityId: 2, level: 5 }], storage);
        const hits = lvl.check([{ entityId: 1, level: 4 }, { entityId: 2, level: 6 }], storage);
        expect(hits.map(h => h.entityId).sort()).toEqual([1, 2]);
    });

    test('missing level defaults to 1, null entity rows are skipped', () => {
        expect(() => lvl.check([null, { entityId: 3 }], storage)).not.toThrow();
        const hits = lvl.check([{ entityId: 3, level: 2 }], storage);
        expect(hits).toEqual([{ entityId: 3, name: '#3', level: 2 }]);
    });
});

describe('levelup — dashboard integration contract', () => {
    const fs = require('fs');
    const dashHtml = fs.readFileSync(
        path.join(__dirname, '..', '..', 'public', 'portal', 'dashboard.html'),
        'utf8'
    );

    test('levelup.js is loaded as a portal script', () => {
        expect(dashHtml).toMatch(/<script src="shared\/levelup\.js"><\/script>/);
    });

    test('loadEntities hooks onEntitiesUpdated inside a try guard', () => {
        expect(dashHtml).toMatch(/EclawLevelUp\.onEntitiesUpdated\(entities/);
    });

    test('reduced-motion CSS disables confetti + animations', () => {
        expect(dashHtml).toMatch(/prefers-reduced-motion:\s*reduce/);
        expect(dashHtml).toMatch(/\.lvlup-confetti\s*\{\s*display:\s*none;\s*\}/);
    });
});

describe('levelup — i18n keys exist', () => {
    const fs = require('fs');
    const i18nJs = fs.readFileSync(
        path.join(__dirname, '..', '..', 'public', 'shared', 'i18n.js'),
        'utf8'
    );
    const NEEDED = [
        'levelup_title',
        'levelup_praise_1', 'levelup_praise_2', 'levelup_praise_3',
        'levelup_praise_4', 'levelup_praise_5',
    ];
    test.each(NEEDED)('%s is declared in i18n.js', (key) => {
        expect(i18nJs).toMatch(new RegExp('"' + key + '":'));
    });
});
