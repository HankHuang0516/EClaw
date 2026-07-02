/**
 * card_3ffe8415: single-note delete must offer an UNDO toast (parity with bulk).
 *
 * Before: deleteNote() confirmed then permanently filtered the note out — bulk
 * delete had a ~6s undo safety net, single delete had none (inconsistent; a mis-tap
 * was unrecoverable). This EXECUTES the real deleteNote() extracted from
 * mission.html (same new Function harness as the chat-action-request tests) and
 * pins: on confirm it removes the note AND calls showUndoToast, and the undo
 * callback restores the note at its original index.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'portal', 'mission.html'), 'utf8'
);

function extractFunction(name) {
    const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, 'g');
    const m = re.exec(html);
    if (!m) throw new Error(`function ${name} not found in mission.html`);
    let depth = 1, i = m.index + m[0].length;
    while (i < html.length && depth > 0) {
        const ch = html[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    return html.slice(m.index, i);
}

function makeHarness({ confirm = true } = {}) {
    const dashboard = { notes: [
        { id: 'n1', title: 'first' },
        { id: 'n2', title: 'second' },
        { id: 'n3', title: 'third' },
    ] };
    const calls = { markChanged: 0, renderNotes: 0, undoToasts: [] };
    const showConfirm = jest.fn(async () => confirm);
    const markChanged = () => { calls.markChanged++; };
    const renderNotes = () => { calls.renderNotes++; };
    const showUndoToast = (msg, undoFn) => { calls.undoToasts.push({ msg, undoFn }); };
    const i18n = { t: (k) => k };

    const factory = new Function(
        'dashboard', 'showConfirm', 'markChanged', 'renderNotes', 'showUndoToast', 'i18n', 'Math',
        `${extractFunction('deleteNote')}\n return deleteNote;`
    );
    const deleteNote = factory(dashboard, showConfirm, markChanged, renderNotes, showUndoToast, i18n, Math);
    return { deleteNote, dashboard, calls, showConfirm };
}

describe('mission single-note delete — undo toast (card_3ffe8415)', () => {
    it('removes the note AND offers an undo toast on confirm (FAIL-ON-OLD: no showUndoToast call)', async () => {
        const h = makeHarness({ confirm: true });
        await h.deleteNote('n2');
        expect(h.dashboard.notes.map(n => n.id)).toEqual(['n1', 'n3']);   // removed
        expect(h.calls.undoToasts).toHaveLength(1);                        // FAIL-ON-OLD: was 0
        expect(typeof h.calls.undoToasts[0].undoFn).toBe('function');
    });

    it('the undo callback restores the deleted note at its ORIGINAL index', async () => {
        const h = makeHarness({ confirm: true });
        await h.deleteNote('n2');                    // remove the middle note
        h.calls.undoToasts[0].undoFn();              // user clicks Undo
        expect(h.dashboard.notes.map(n => n.id)).toEqual(['n1', 'n2', 'n3']);  // back in place
        expect(h.dashboard.notes[1]).toMatchObject({ id: 'n2', title: 'second' });
    });

    it('cancelling the confirm deletes nothing and shows no undo toast', async () => {
        const h = makeHarness({ confirm: false });
        await h.deleteNote('n2');
        expect(h.dashboard.notes.map(n => n.id)).toEqual(['n1', 'n2', 'n3']);
        expect(h.calls.undoToasts).toHaveLength(0);
    });

    it('deleting an unknown id is a no-op (no toast, no throw)', async () => {
        const h = makeHarness({ confirm: true });
        await h.deleteNote('nope');
        expect(h.dashboard.notes).toHaveLength(3);
        expect(h.calls.undoToasts).toHaveLength(0);
        expect(h.showConfirm).not.toHaveBeenCalled();
    });
});
