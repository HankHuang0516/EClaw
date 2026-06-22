---
name: instrument-then-fix
description: >-
  Debug hard-to-reproduce / intermittent / SILENT failures (black screen, blank
  UI, "works then stops", swallowed exceptions, no stack trace) by shipping an
  instrumented build that makes the bug REPORT ITSELF, then fixing the exact
  cause it surfaces. Use when you cannot get a stack trace from a normal repro,
  when the failure mode is "silent" (nothing logged / blank output), or for
  periodic self-improvement passes on flaky subsystems.
---

# Instrument-then-fix: make the bug report itself

When a bug is intermittent or silent you can burn hours guessing root cause from
static reading. Don't. Ship one instrumented build that turns the silent failure
into a loud, self-localizing one, reproduce once, and let the instrumentation
tell you the exact cause. Then ship the precise fix.

This is the loop that cracked the live-wallpaper black-screen (EClaw
card_f9b2cc2d) in three tight iterations after static analysis alone had stalled.

## When to use
- The failure is **silent**: black/blank screen, frozen UI, empty output, a
  swallowed `catch`, a half-rendered frame — no exception reaches you.
- It's **intermittent** / hard to reproduce on demand, so a debugger isn't practical.
- It only happens on a **real device / prod environment** you can't attach to.
- A periodic **self-improvement** pass on a subsystem with a history of flakiness.

## The loop (OODA-R)
1. **Stop guessing.** If two reads haven't localized it, instrument instead of
   theorizing further.
2. **Make every suspect path observable.** Put a DISTINCT visible marker on each
   candidate code path (e.g. `Loading… (surface)` vs `(resume)` vs `(changed)`),
   so *which* path executed is directly observable in the repro. Distinct, not
   generic — the label is the signal.
3. **Turn silent failures LOUD.** Wherever a failure is currently swallowed:
   - record the **full exception + context** to a crash/error reporter
     (Crashlytics `recordException` + `setCustomKey` for the state that matters:
     counts, flags, which entity/stage, validity booleans), deduped to **one
     report per distinct cause** so you don't spam per-frame;
   - replace the silent bad state with a **distinct visible state** (e.g. paint a
     dark-red "render error" frame instead of silent black) so the user/tester
     can tell you what they see and you know the path was hit.
4. **Add a cheap self-heal** where possible (watchdog / heartbeat that re-kicks
   the stuck subsystem) so the user isn't stuck while you diagnose — and so a
   "needs full restart" bug becomes "self-recovers in ~1s".
5. **Reproduce on the real target**, read which marker fired + the captured
   stack/keys → that *localizes the exact cause* (file, line, which resource).
6. **Ship the precise fix.** Keep the instrumentation until the fix is confirmed;
   then it stays as a permanent guard (visible-error + report beats silent-fail
   forever).

## Principles
- **Visible > silent.** A wrong/ugly-but-visible state you can report beats a
  silent black/blank you can't.
- **Capture context, not just the exception.** Custom keys (state flags, counts,
  which item) usually pin the cause faster than the stack alone.
- **Dedupe reports.** One per distinct cause/stage key — per-frame/per-tick spam
  buries the signal and the quota.
- **Contain blast radius.** Wrap each item/stage in its own try/catch so one bad
  element can't blank the whole screen — this is both the fix AND future-proofing.
- **Verify the real landing, not your call's end.** Confirm on the actual
  device/prod (e.g. re-pull from the store/API), not just that your upload/call
  returned 200. (See also: verify-against-origin-not-workdir.)
- **Each build is one rung of a ladder.** Don't try to fix blind; ship the
  instrumented rung, read the signal, ship the fix rung.

## Worked example (EClaw wallpaper black-screen, card_f9b2cc2d)
- Symptom: live wallpaper goes ENTIRELY BLACK on a brief app-switch return; only
  a full app kill recovers it. No logs, not reproducible on emulator.
- v1.1.2 — **markers**: paint a distinct `Loading… (<where>)` frame in each
  resume callback. Repro showed **pure black, NO marker text** → either the draw
  loop is alive painting black (markers overwritten in 33 ms) or no callback fires.
- v1.1.3 — **turn silent loud**: gate the draw loop on real `surface.isValid`
  (not a stale flag); add a resume watchdog + a lifetime self-healing heartbeat
  (framework `isVisible`, re-kick if no frame for ~1 s); harden the draw `catch`
  to `recordException` to Crashlytics with custom keys AND paint a distinct
  dark-red "render error" frame. Repro showed the **RED frame** → CONFIRMED:
  `draw()` paints the black background then THROWS while rendering an entity.
- v1.1.4 — **precise fix + contain**: wrap each render stage (per-entity, kanban
  bg, effects, usage overlay, bubbles) in its own try/catch so one bad
  entity/stage is skipped and the rest of the frame still draws;
  `reportRenderStageError` records once per stage key so any residual still names
  the exact failing stage (`render_stage`).
- Result: silent "black, needs restart" → self-localizing, self-healing, and the
  exact failing stage is always captured for a final precise fix.
