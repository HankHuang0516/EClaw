# Dot progress reading-position review

Scope: portfolio client rendering and browser history restoration only. Rebased on main `103d37e2` including the Demo manager; no backend/auth/config/schema, entity, production record or push operation changes. All browser fixtures use invented tasks in a fresh Chrome context.

## Reproduction and result

At 390px, synthetic Back returned from scrollY 10149 to 0; at 1280px it returned from 9073 to 0. Initial auth/data loading left a short page, so browser history restoration was clamped before the private content arrived. In a separate forced focus/visibility revalidation fixture, collapsing the existing workspace clamped those positions to 88/119. These are separate paths: real tab changes can retain position when no collapsing revalidation occurs. Push receipt updates retained the original positions and were not the primary cause.

Fixed Back restores 10149/9073 after both initial requests complete. Focus/visibility checks retain layout while concealing and disabling existing private content. Failed validation and logout still remove all private DOM/memory. Ordinary fresh navigation remains at zero; user wheel/touch/scroll-key interaction cancels pending history restoration. History stores geometry and UI choices only, excluding task IDs, text and drafts.

Language/project rerenders preserve the visible section, main expanded details and existing form focus/selection. First push metric paint is synchronous before measuring card geometry; no count, queue, click identity or API behavior changes. Public refresh preserves the current reading anchor when its response arrives rather than replaying an earlier position over user scrolling. There is no global scroll lock or manual history scrollRestoration setting.

## Manual simplify substitute

The existing user-approved substitute applies while the simplify skill is unavailable; the skill was not run.

- Reuse: one capture/restore pair serves project rerender, public replacement and history return. Existing role/epoch gates and draft helpers remain authoritative.
- Quality: restoration applies only to history return, validates safe section names and numeric geometry, never reveals failed-role content, and retains a user's new scroll during async refresh. Session generations prevent stale checks from toggling current check state.
- Efficiency: capture uses one project-index map and measures section geometry only for cards intersecting the viewport. No scroll polling, new dependencies, extra private fetches or global scrolling restriction.

## Code review — all ten checklist items

- ✅ A1 Logic trace: back/forward waits for public plus role/project rendering; successful current-role checks reveal reserved layout; logout/401/403/failed checks clear content and private return state; user scrolling cancels pending restoration.
- ✅ A2 Test coverage: `test-dot-progress-scroll.js` passes 50 checks at 390/1280, covering focus/visibility, Back/Forward, fresh navigation, filters/details, language/focus/drafts, push receipts, expired roles, history privacy, async user scrolling and cancellation. Existing complete `test-dot-progress-ui.js` passes. Public-assets plus i18n-syntax Jest suites pass 18/18; final bundle digest check re-passes 6/6. Backend lint has zero errors and nine existing warnings; changed scripts lint clean.
- ⚠️ A3 Return shape NO-OP: no REST contract changes.
- ✅ A4 Remaining limits: history card indices assume the existing project ordering; a reordered/deleted card falls back to positional behavior. Main project details are retained, while independently loaded decision/audit/sidebar subpanel state and private drafts are not persisted across departure. Fresh Chrome is tested; other browser engines/physical devices were not exercised.
- ✅ A5 Security: delayed role checks conceal/inert private content; failure/logout removes it immediately. Synthetic assertions verify no project IDs, titles or drafts in history state, no stale private DOM after expiry, unchanged admin-only access and no browser exceptions. No credentials or production records were read or written.
- ⚠️ B1 `/api/help` NO-OP: no new endpoint or modified response shape.
- ✅ B2 Related docs: `docs/dot-progress.md`, root README architecture summary updated; instruction files remain unchanged; no backend README exists. Earlier review receipts remain historical. No scheduled task refers to this client geometry.
- ⚠️ B3 i18n NO-OP: no new or changed user-facing strings; existing 12-test i18n-syntax suite passes. Native parity NO-OP: private portfolio browser behavior only.
- ⚠️ B4 Info/promo NO-OP: no features/info marketing page describes this private reading behavior; portfolio docs updated.
- ⚠️ B5 Debug NO-OP: client geometry only; existing gated dot-progress debug endpoint retained, with no new security/data/API logic.

Result: locally validated, pending required PR CI and parent release approval. Bundle version `e1d4246fc4975cda`. Synthetic evidence `/tmp/dot-progress-scroll-evidence.json`; screenshots `/tmp/dot-progress-scroll-390-fixture.png` and `/tmp/dot-progress-scroll-1280-fixture.png` are local test artifacts, not repository private data.

Combined-main regression additionally runs the synthetic Demo-share UI workflow to ensure manager language/expiry/logout controls remain intact.

Final scope correction: restored CLAUDE.md byte-for-byte to the main base because local instruction/memory files are read-only. No functional assets or bundle version changed; only this scope correction and review receipt changed.
