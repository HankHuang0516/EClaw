const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(
    path.join(__dirname, '../../public/portal/chat.html'),
    'utf8',
);

// card_277c80f5 (Hank-direct): quoting more than once must ACCUMULATE quotes
// (not overwrite), with no cap, and the recipient entity must receive EVERY
// quote. Implemented in chat.html by turning the single `replyContext` into a
// `replyContexts[]` array, rendering one removable chip per quote, and emitting
// one "↩ …" line per quote at send time.
describe('chat.html multi-quote accumulation (card_277c80f5)', () => {
    test('quote state is an accumulating array, not a single overwriting object', () => {
        expect(html).toContain('let replyContexts = [];');
        // the old single-object state must be gone
        expect(html).not.toContain('let replyContext = null;');
    });

    test('adding a quote appends (with de-dupe) instead of overwriting', () => {
        const add = html.slice(html.indexOf('function addReplyContext('), html.indexOf('function removeReplyContextAt('));
        expect(add).toContain('replyContexts.push(');
        // de-dupe so re-clicking the same message is a no-op
        expect(add).toContain('replyContexts.some(rc => rc._key === key)');
        // both quote entry points append via addReplyContext
        expect(html).toContain('addReplyContext(msgId, sender, text, meta);'); // handleReplyBtn
        expect(html).toContain('addReplyContext(null, senderLabel, previewText, meta || {});'); // quoteToChat
    });

    test('each quote renders a chip with its own remove control', () => {
        expect(html).toContain('function renderReplyPreviews()');
        expect(html).toContain('function removeReplyContextAt(idx)');
        expect(html).toContain("chip.className = 'reply-preview-chip'");
        expect(html).toContain("x.addEventListener('click', () => removeReplyContextAt(i));");
        // chip text uses textContent (no innerHTML) → no quote-content XSS
        expect(html).toContain('t.textContent = rc.text || mediaLabel;');
        // bar hides when there are no quotes
        expect(html).toContain("if (replyContexts.length === 0) { bar.classList.remove('show'); return; }");
    });

    test('send emits one quote line per entry so the entity receives every quote', () => {
        const send = html.slice(html.indexOf('if (replyContexts.length) {'));
        expect(send).toContain('const quoteLines = replyContexts.map(rc => {');
        // one "↩ …" line per quote, joined by newline
        expect(send).toContain("quoteLines.join('\\n')");
        // the outgoing body is built from ALL quotes, not just the last
        expect(send).toMatch(/finalText = text \?[^\n]*quoteLines\.join/);
        // newlines collapsed per quote so the block stays strip-compatible
        expect(send).toContain("(rc.text || '').replace(/\\s*\\n+\\s*/g, ' ')");
    });

    test('auto-receivers union across ALL quotes (route to every quoted sender)', () => {
        expect(html).toContain('function recomputeAutoReceivers()');
        expect(html).toContain('replyContexts.forEach(rc => entityIdsFromMeta(rc.meta).forEach(eid => union.add(eid)));');
    });

    test('clear resets the whole array and the help affordance exists', () => {
        const clear = html.slice(html.indexOf('function clearReplyContext()'), html.indexOf('function clearReplyContext()') + 240);
        expect(clear).toContain('replyContexts = [];');
        expect(html).toContain('id="replyPreviewList"');
        expect(html).toContain('id="replyPreviewHelp"');
    });
});
