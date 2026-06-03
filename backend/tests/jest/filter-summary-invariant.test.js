/**
 * Static invariant test for the filter-summary collapsible primitive.
 *
 * Card: card_314c472e1e3cbd49aa0d5df9.
 * Spec: docs/specs/chat-page-filter-bar-collapse.md.
 * Adopters: chat.html today; kanban / mission may adopt later.
 *
 * jest.config.js uses testEnvironment: 'node' and the repo does not pull
 * in jsdom, so a true DOM behaviour assertion would require either adding
 * a test-only dep or hand-rolling a deep Element stub. Per the same
 * reasoning as showConfirm-danger-default-focus.test.js (PR #3088), we
 * instead lock the surface of filter-summary.js here: any future edit
 * that breaks one of the 5 wiring invariants leaves a regex fingerprint
 * and silently regresses the contract for every page that adopts it.
 *
 * The 5 invariants mirror the card description:
 *   1. Summary chip markup carries __label and __count subspans.
 *   2. Panel exposes role=dialog + aria-modal=false + aria-labelledby
 *      pointing at the title id.
 *   3. Click-out + Esc both trigger close() (which sets panel.hidden).
 *   4. refresh() wires countActive() through to badge text + is-active
 *      toggle.
 *   5. open() default-focuses the ✕ close button.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const filterSummaryJs = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'shared', 'filter-summary.js'),
    'utf8'
);

describe('filter-summary — collapsible primitive invariants', () => {
    test('1. summary chip markup includes __label and __count subspans', () => {
        // The summary button's innerHTML template must carry both the
        // label span and the count badge span so callers can style and
        // hosts can reliably find them via querySelector.
        expect(filterSummaryJs).toMatch(
            /summary\.className\s*=\s*['"]eclaw-filter-summary['"]/
        );
        expect(filterSummaryJs).toMatch(/<span class="eclaw-filter-summary__label">/);
        expect(filterSummaryJs).toMatch(/<span class="eclaw-filter-summary__count"/);
        // querySelector wiring must agree with the template classes —
        // a rename in one place without the other silently breaks refresh().
        expect(filterSummaryJs).toMatch(
            /querySelector\(\s*['"]\.eclaw-filter-summary__label['"]\s*\)/
        );
        expect(filterSummaryJs).toMatch(
            /querySelector\(\s*['"]\.eclaw-filter-summary__count['"]\s*\)/
        );
    });

    test('2. panel exposes role=dialog + aria-modal=false + aria-labelledby→title id', () => {
        // Panel role/aria contract — required for AT users and for the
        // popover semantics expected by chat.html. aria-modal must be
        // "false" because the panel does not trap focus (desktop popover
        // pattern, mobile is anchored but not full-screen modal).
        expect(filterSummaryJs).toMatch(
            /panel\.setAttribute\(\s*['"]role['"]\s*,\s*['"]dialog['"]\s*\)/
        );
        expect(filterSummaryJs).toMatch(
            /panel\.setAttribute\(\s*['"]aria-modal['"]\s*,\s*['"]false['"]\s*\)/
        );
        // aria-labelledby must point at the title id that the header
        // actually renders — pattern eclaw-filter-summary-title-${id}.
        expect(filterSummaryJs).toMatch(
            /panel\.setAttribute\(\s*['"]aria-labelledby['"]\s*,\s*`eclaw-filter-summary-title-\$\{id\}`\s*\)/
        );
        expect(filterSummaryJs).toMatch(
            /id="eclaw-filter-summary-title-\$\{id\}"/
        );
    });

    test('3. click-out + Esc handlers both route to close() and hide the panel', () => {
        // Esc on document keydown must call close() — preserves the
        // universal Esc-dismisses contract every dialog primitive owes.
        expect(filterSummaryJs).toMatch(
            /ev\.key\s*===\s*['"]Escape['"][^}]*close\(\)/
        );
        // Outside mousedown/touchstart must reach close() — the handler
        // short-circuits when the event is inside the panel or summary,
        // so the fallthrough is the close path.
        expect(filterSummaryJs).toMatch(/function\s+onOutsideMouse\s*\(/);
        expect(filterSummaryJs).toMatch(
            /if\s*\(\s*panel\.contains\(ev\.target\)\s*\)\s*return/
        );
        expect(filterSummaryJs).toMatch(
            /if\s*\(\s*summary\.contains\(ev\.target\)\s*\)\s*return/
        );
        // open() must register both keydown and outside-pointer listeners
        // so the close paths above are actually reachable.
        expect(filterSummaryJs).toMatch(
            /document\.addEventListener\(\s*['"]keydown['"]\s*,\s*onKey/
        );
        expect(filterSummaryJs).toMatch(
            /document\.addEventListener\(\s*['"]mousedown['"]\s*,\s*onOutsideMouse/
        );
        // close() must set panel.hidden = true (and overlay.hidden) so
        // CSS + AT both treat the panel as gone.
        expect(filterSummaryJs).toMatch(
            /function\s+close\s*\(\s*\)\s*\{[\s\S]*?panel\.hidden\s*=\s*true/
        );
    });

    test('4. countActive() result flows through refresh() to badge text + is-active class', () => {
        // refresh() must read opts.countActive() — without this the
        // host page can never push its updated filter count into the UI.
        expect(filterSummaryJs).toMatch(
            /function\s+refresh\s*\(\s*\)\s*\{[\s\S]*?opts\.countActive\(\)/
        );
        // The numeric result must flow into setCountUI(n) which both
        // writes the badge text and toggles the is-active class.
        expect(filterSummaryJs).toMatch(/setCountUI\(\s*n\s*\)/);
        expect(filterSummaryJs).toMatch(
            /function\s+setCountUI\s*\(\s*n\s*\)\s*\{[\s\S]*?countEl\.textContent\s*=/
        );
        // n > 0 path adds is-active; n <= 0 path removes it — both
        // branches are part of the active-class contract callers rely on.
        expect(filterSummaryJs).toMatch(/summary\.classList\.add\(\s*['"]is-active['"]\s*\)/);
        expect(filterSummaryJs).toMatch(
            /summary\.classList\.remove\(\s*['"]is-active['"]\s*\)/
        );
        // Sanity: refresh() is invoked on initial mount so the very
        // first paint is in sync with countActive().
        expect(filterSummaryJs).toMatch(/\/\/\s*Initial render[\s\S]*?refresh\(\)/);
    });

    test('5. open() default-focuses the ✕ close button (PR #3088 safe-default-focus)', () => {
        // Per the destructive-modals daily playbook + Material/Apple HIG
        // guidance, dialogs that open via pointer must land focus on a
        // safe non-destructive control. For this primitive the close
        // button is the safe default — Enter on it just dismisses the
        // panel rather than committing any filter mutation.
        expect(filterSummaryJs).toMatch(
            /function\s+open\s*\(\s*\)\s*\{[\s\S]*?closeBtn\.focus\(\s*\{\s*preventScroll:\s*true\s*\}\s*\)/
        );
        // The close button must actually exist in the rendered header
        // markup — the focus call above is meaningless otherwise.
        expect(filterSummaryJs).toMatch(/class="eclaw-filter-summary__close"/);
        expect(filterSummaryJs).toMatch(
            /querySelector\(\s*['"]\.eclaw-filter-summary__close['"]\s*\)/
        );
    });
});
