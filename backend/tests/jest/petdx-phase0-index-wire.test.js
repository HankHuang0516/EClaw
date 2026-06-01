const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../../index.js'), 'utf8');

function blockBetween(start, end) {
    const i = src.indexOf(start);
    expect(i).toBeGreaterThanOrEqual(0);
    const j = src.indexOf(end, i + start.length);
    expect(j).toBeGreaterThan(i);
    return src.slice(i, j);
}

describe('Petdx Phase 0 hook wiring in backend/index.js', () => {
    test('imports the shared hook module', () => {
        expect(src).toContain("require('./petdx-phase0-hook')");
        expect(src).toContain('assignDefaultCompanionIfMissing');
    });

    test('/api/device/register captures previous entity for delete -> bind rebind cycles', () => {
        const registerBlock = blockBetween("app.post('/api/device/register'", "app.get('/api/status'");
        expect(registerBlock).toContain('previousEntity: getPreviousEntityForBind');
    });

    test('/api/bind calls hook with bind-endpoint context', () => {
        const bindBlock = blockBetween("app.post('/api/bind'", '// ============================================\n// ENTITY STATUS & CONTROL');
        expect(bindBlock).toContain('runPetdxPhase0AutoAssign');
        expect(bindBlock).toContain("source: 'bind-endpoint'");
        expect(bindBlock).toContain("mode: previousEntityForPetdx ? 'rebind' : 'bind'");
        expect(bindBlock).toContain('clearPreviousEntityForBind');
    });

    test('/api/transform calls hook for character-change side effects', () => {
        const transformBlock = blockBetween("app.post('/api/transform'", '// POST /api/wakeup');
        expect(transformBlock).toContain('previousEntityForPetdxCharacterChange');
        expect(transformBlock).toContain("mode: 'character-change'");
        expect(transformBlock).toContain("source: 'transform'");
    });

    test('official borrow bind paths call hook with source-specific bind context', () => {
        const freeBlock = blockBetween("app.post('/api/official-borrow/bind-free'", "app.post('/api/official-borrow/bind-personal'");
        expect(freeBlock).toContain('runPetdxPhase0AutoAssign');
        expect(freeBlock).toContain("source: 'official-borrow-free'");

        const personalBlock = blockBetween("app.post('/api/official-borrow/bind-personal'", "app.post('/api/official-borrow/add-paid-slot'");
        expect(personalBlock).toContain('runPetdxPhase0AutoAssign');
        expect(personalBlock).toContain("source: 'official-borrow-paid'");
    });

    test('delete paths remember the pre-reset entity snapshot', () => {
        const deleteBlock = blockBetween("app.delete('/api/entity'", "app.delete('/api/device/entity'");
        expect(deleteBlock).toContain('rememberPreviousEntityForBind');

        const deviceDeleteBlock = blockBetween("app.delete('/api/device/entity'", "app.post('/api/device/add-entity'");
        expect(deviceDeleteBlock).toContain('rememberPreviousEntityForBind');
    });
});
