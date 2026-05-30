const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
    path.join(__dirname, '../../public/portal/shared/point-edit-demo.js'),
    'utf8'
);
const HTML = fs.readFileSync(
    path.join(__dirname, '../../public/portal/info.html'),
    'utf8'
);

describe('Track C — mind-map mock', () => {
    test('renderTargetBlock encodes mindmap-specific fields', () => {
        // Ensure the renderer emits nodeId, resourceType, anchorId attributes
        // so the composer <target> block matches the payload contract.
        const fn = SRC.match(/function\s+renderTargetBlock[\s\S]*?\n    \}/);
        expect(fn).not.toBeNull();
        expect(fn[0]).toMatch(/payload\.anchorId/);
        expect(fn[0]).toMatch(/payload\.nodeId/);
        expect(fn[0]).toMatch(/payload\.resourceType/);
        expect(fn[0]).toMatch(/payload\.sourceHint/);
    });

    test('pickFromMindmapNode returns canonical payload shape', () => {
        const fn = SRC.match(/function\s+pickFromMindmapNode[\s\S]*?\n    \}/);
        expect(fn).not.toBeNull();
        const body = fn[0];
        expect(body).toMatch(/mode:\s*['"]mindmap['"]/);
        expect(body).toMatch(/nodeId/);
        expect(body).toMatch(/anchorId/);
        expect(body).toMatch(/resourceType:\s*['"]infohtml-block['"]/);
        expect(body).toMatch(/confidence:\s*0\.95/);
        expect(body).toMatch(/sourceHint:\s*['"]mindmap-mock['"]/);
    });

    test('buildAnchorRegistry walks [data-point-edit-id] inside the sandbox', () => {
        const fn = SRC.match(/function\s+buildAnchorRegistry[\s\S]*?\n    \}/);
        expect(fn).not.toBeNull();
        expect(fn[0]).toMatch(/querySelectorAll\(['"]?\[data-point-edit-id\]['"]?\)/);
        expect(fn[0]).toMatch(/sanitizeOuterHtml\(el, 4096\)/);
        expect(fn[0]).toMatch(/clampText\(el\.textContent, 240\)/);
        expect(fn[0]).toMatch(/bboxRect\(el\)/);
    });

    test('boot wires mindmap click handlers + hides/shows the mini-panel via setMode', () => {
        const bootScope = SRC.match(/function\s+boot\(\)[\s\S]*?\n    \}/);
        expect(bootScope).not.toBeNull();
        const b = bootScope[0];
        // Mode-aware visibility
        expect(b).toMatch(/mindmap\.hidden\s*=\s*next\s*!==\s*['"]mindmap['"]/);
        // Status hint
        expect(b).toMatch(/hintMindmap/);
        // Click wiring gated on mode === 'mindmap'
        expect(b).toMatch(/mindmapNodes\.forEach/);
        expect(b).toMatch(/mode !== ['"]mindmap['"]/);
        // Registry refresh on resize so rect stays accurate
        expect(b).toMatch(/window\.addEventListener\(['"]resize['"], refreshAnchorRegistry/);
    });

    test('HTML widget exposes 6 nodes mapped to the canonical sandbox anchors', () => {
        // Panel still hosts the mini-map placeholder
        expect(HTML).toMatch(/<section[^>]+class="ped-mindmap"[^>]+data-ped-mindmap/);
        // Six required node mappings per spec §2 (hero / feature / cta / note / agent-card / nested)
        const expected = [
            ['hero', 'hero'],
            ['feature', 'feature.card'],
            ['cta', 'cta.block'],
            ['note', 'note.block'],
            ['agent-card', 'agent.card'],
            ['nested', 'note.em'],
        ];
        for (const [nodeId, anchorId] of expected) {
            const re = new RegExp(
                `data-ped-node="${nodeId}"\\s+data-ped-anchor-id="${anchorId.replace('.', '\\.')}"`
            );
            expect(HTML).toMatch(re);
        }
    });

    test('Mode C button is no longer disabled in the harness HTML', () => {
        // Find the mindmap mode button line
        const m = HTML.match(/<button class="ped-mode"[^>]+data-ped-mode="mindmap"[^>]*>/);
        expect(m).not.toBeNull();
        expect(m[0]).not.toMatch(/\bdisabled\b/);
        expect(m[0]).not.toMatch(/title="Track C — pending"/);
    });

    test('mindmap mode shares the same pointedit:target dispatcher (no separate listener)', () => {
        // Only one document.dispatchEvent + one document.addEventListener for pointedit:target
        const dispatches = (SRC.match(/document\.dispatchEvent\(new CustomEvent\(['"]pointedit:target['"]/g) || []).length;
        const listeners = (SRC.match(/document\.addEventListener\(['"]pointedit:target['"]/g) || []).length;
        expect(dispatches).toBe(1);
        expect(listeners).toBe(1);
    });

    test('Public test surface exposes Track C helpers', () => {
        const frozen = SRC.match(/window\.PointEditDemo\s*=\s*Object\.freeze\(\{[\s\S]*?\}\);/);
        expect(frozen).not.toBeNull();
        expect(frozen[0]).toMatch(/pickFromMindmapNode/);
        expect(frozen[0]).toMatch(/buildAnchorRegistry/);
        expect(frozen[0]).toMatch(/getAnchorRegistry/);
    });
});
