# Wallpaper Walking System — T2–T5 Architecture

> **Status**: Design draft (2026-06-20) · **Author**: LOBSTER #2 (commander) · **Parent SPEC**: `card_8765101e1479be4d664ec163`
> **Child execution cards**:
> - T1 — `card_bf8fd53614762c04b8df6a25` (random wander engine + Settings toggle) — *foundation, in progress*
> - T2 — `card_4e95ad3696e5bcb354975f81` (speech bubble anchored to entity)
> - T3 — `card_7c6ea3703b979532d6f9cd8c` (speakTo movement: sender→receiver, both stop)
> - T4 — `card_005d4bd7fe65fb05641315f5` (broadcast movement: sender→center, others surround)
> - T5 — `card_805bf4f817cf35e1bc0ccb41` (sleep state stops walking)
>
> **Purpose**: Lock down the shared state machine, coordinate system, and geometry so T2–T5 can be implemented **in parallel** by separate agents once T1 lands the foundation. This document does **not** ship code.
>
> **Related code (already in repo)**:
> - `app/src/main/java/com/hank/clawlive/service/ClawWallpaperService.kt` — `WallpaperService` shell + per-entity status polling
> - `app/src/main/java/com/hank/clawlive/engine/ClawRenderer.kt` — multi-entity position calculator + draw loop
> - `app/src/main/java/com/hank/clawlive/engine/SpritesheetCompanionDrawer.kt` — per-entity sprite blit
> - `app/src/main/java/com/hank/clawlive/engine/ProceduralCreatureDrawer.kt` — procedural lobster/dog/cat
> - `app/src/main/java/com/hank/clawlive/data/model/EntityStatus.kt` — per-entity state record
> - `app/src/main/java/com/hank/clawlive/data/model/AgentStatus.kt` — `CharacterState` enum (IDLE/BUSY/EATING/SLEEPING/EXCITED)
> - `backend/public/shared/petdx-renderer.js` — Web reference renderer (descriptor + state contract); useful for portal preview parity
>
> **Related specs**:
> - `docs/specs/petdx-uiux-spec.md` (CompanionDescriptor + state contract)
> - `docs/specs/android-uiux-rendering-spec.md` (existing render pipeline conventions)
> - `docs/specs/chat-send-to-spec.md` (speakTo / broadcast / @all source-of-truth — drives T3/T4 triggers)

---

## 0. Reading order for T2–T5 implementers

1. §1 — confirm the renderer entry point you'll be editing.
2. §2 — internalize the state machine; do not invent new states.
3. §3 + §4 — coordinate-unit definition; every PR must respect entity-unit & %-of-screen.
4. Your own slice:
   - T2 → §5 (speech bubble anchor).
   - T3 → §2.4 (speakTo transition) + §6 single-receiver geometry.
   - T4 → §6 (broadcast halo geometry).
   - T5 → §7 (sleep gate).
5. §8 — test plan applies to all four.
6. §9 — open questions; raise via card comments before implementing if your slice touches one.

---

## 1. Wallpaper renderer entry point (what exists today)

The wallpaper renderer is the **Android live wallpaper engine** — confirmed via repo search for `wallpaper` / `companion` / `AvatarPetdx`. The portal/web does NOT render the live wallpaper (per `petdx-uiux-spec.md` §1.3 "Web portal 動畫桌布 canvas 渲染管線 不在 v0.2 範圍"), so all walking work lives in the Android module.

### 1.1 Render entry chain

```
ClawWallpaperService (Android WallpaperService)
  └─ ClawEngine (inner class, owns SurfaceHolder)
      ├─ observeStatus() → currentEntities: List<EntityStatus>
      ├─ observeCompanionDescriptors() → per-entity descriptors
      └─ draw() → ClawRenderer.draw(...)
                  └─ calculateEntityPositions(width, height, count, entities)
                     ├─ Custom layout (per-entity SharedPreferences %)
                     └─ Preset layouts (GRID_2X2, HORIZONTAL, ...)
                  └─ per-entity: ProceduralCreatureDrawer OR SpritesheetCompanionDrawer
```

**Key files (absolute paths):**
- `/Users/hank/Desktop/Project/EClaw/app/src/main/java/com/hank/clawlive/service/ClawWallpaperService.kt:1-283`
- `/Users/hank/Desktop/Project/EClaw/app/src/main/java/com/hank/clawlive/engine/ClawRenderer.kt:260-360` (position calc)
- `/Users/hank/Desktop/Project/EClaw/app/src/main/java/com/hank/clawlive/data/model/EntityStatus.kt`
- `/Users/hank/Desktop/Project/EClaw/app/src/main/java/com/hank/clawlive/data/model/AgentStatus.kt` (`CharacterState`)

### 1.2 What T1 is adding (foundation, do not duplicate)

T1 introduces:
- A per-entity `MotionController` class that owns position state and broadcasts coordinates each frame.
- A wander policy (random-direction walk with dwell at edges).
- A `walkingEnabled` Settings toggle (default ON).
- A draw-loop hook that lets renderers read the **animated position** instead of the static `calculateEntityPositions(...)` output.

T2–T5 **MUST** consume T1's `MotionController` interface (§2.5). If T1's class names differ, T2–T5 mirror T1's final names.

### 1.3 Out-of-scope (clarifying gaps found during research)

- Web/portal preview of walking is not in T2–T5; portal continues to render static `petdx-renderer.js` previews. If product wants portal animation, file a follow-up card.
- iOS app (`/Users/hank/Desktop/Project/EClaw/ios-app/`) does not render a live wallpaper — confirmed; no walking work there.
- Widget (`ChatWidgetProvider.kt`) is static; out of scope.

---

## 2. Entity state machine

### 2.1 States

| State | Meaning | Visible behavior | Source of truth |
|---|---|---|---|
| `WANDERING` | Default idle walking | Random-direction walk, pause at dwell points | Local MotionController |
| `MOVING_TO_TARGET` | Walking to a specific (x,y) | Linear walk to target | MotionController target field |
| `STOPPED` | Halted but awake | No motion; sprite plays IDLE animation | MotionController flag |
| `SPEAKING` | Currently displaying a speech bubble | Bubble visible above sprite; **can still move** (bubble follows) | EntityStatus.message + bubbleExpiresAt |
| `LISTENING` | Designated receiver in a speakTo, waiting for sender to arrive | Sprite stopped; pulsing indicator (T3 detail) | Inbox event |
| `SLEEPING` | Server-reported sleep state | No motion; "Zzz" overlay; excluded from speakTo/broadcast pull | `EntityStatus.state == CharacterState.SLEEPING` |

> **Decoupling note**: `SPEAKING` is **orthogonal** to motion states. An entity in `WANDERING` can simultaneously be `SPEAKING` (bubble visible). Implement `SPEAKING` as a *bubble lifecycle flag*, not a motion-state replacement. Reason: per Hank's clarifications on parent SPEC, walking does not pause just because the bubble appears unless the conversation specifically pauses it (T3 case).

So the **motion state machine** has 4 mutually-exclusive states (`WANDERING`, `MOVING_TO_TARGET`, `STOPPED`, `SLEEPING`), and `SPEAKING` / `LISTENING` are **overlays** that can co-exist with `WANDERING` or `STOPPED`.

### 2.2 Server `CharacterState` mapping

The existing server-supplied `CharacterState` enum (`IDLE/BUSY/EATING/SLEEPING/EXCITED`) drives the *animation row* in the spritesheet, not motion. Mapping rule:

| `CharacterState` | Motion default | Notes |
|---|---|---|
| `IDLE` / `BUSY` / `EATING` / `EXCITED` | `WANDERING` (if `walkingEnabled`) else `STOPPED` | Walking is independent of work state |
| `SLEEPING` | `SLEEPING` (forced) | T5 gate |

Implementer rule: never *write back* to `EntityStatus.state` from the motion controller. Motion state is a client-side overlay.

### 2.3 Transition table (motion state)

```
                ┌──────────────────────────────┐
                ▼                              │
   ┌────────────────────┐  speakTo received     │
   │     WANDERING      │────────────────────▶ MOVING_TO_TARGET
   │  (random dir +     │  broadcast received    │
   │   dwell pts)       │────────────────────▶ MOVING_TO_TARGET (halo slot)
   └────────────────────┘                       │
        ▲       │                               │
        │       │ sleep detected                │ target reached
        │       ▼                               ▼
        │  ┌──────────┐   wake          ┌────────────────┐
        │  │ SLEEPING │◀────────────────│    STOPPED     │
        │  └──────────┘                 │  (conversation │
        │       ▲                       │   in progress) │
        │       │ sleep                 └────────────────┘
        │       │ detected                    │
        │       │                             │ conversation ends
        └───────┴─────────────────────────────┘   (bubble TTL expired
                                                  AND no follow-up)
```

### 2.4 Detailed transitions

| From | Event | To | Notes |
|---|---|---|---|
| `WANDERING` | `walkingEnabled = false` toggled | `STOPPED` | T1 |
| `WANDERING` | `CharacterState` → `SLEEPING` | `SLEEPING` | T5 |
| `WANDERING` | **sender** of speakTo | `MOVING_TO_TARGET(receiver.x, receiver.y)` | T3 — re-target every frame if receiver moves (only relevant if receiver isn't yet `STOPPED`) |
| `WANDERING` | **receiver** of speakTo | `STOPPED` immediately | T3 — receiver halts in place; bubble incoming |
| `WANDERING` | **sender** of broadcast | `MOVING_TO_TARGET(screen_center)` | T4 |
| `WANDERING` | **bystander** during broadcast | `MOVING_TO_TARGET(halo_slot_i)` | T4 — slot computed per §6 |
| `MOVING_TO_TARGET` | target reached (within ε) | `STOPPED` | ε = 0.02 (% screen) by default |
| `MOVING_TO_TARGET` | `CharacterState` → `SLEEPING` | `SLEEPING` | T5 — drop the target |
| `STOPPED` | conversation cleared (bubble expired, no pending TX) | `WANDERING` | Returns to wander after a 1.5s grace |
| `STOPPED` | `CharacterState` → `SLEEPING` | `SLEEPING` | T5 |
| `SLEEPING` | `CharacterState` ≠ `SLEEPING` | `WANDERING` | T5 — re-enter wander immediately |
| any | bubble shown | + `SPEAKING` overlay | T2 — does not change motion state |
| any | bubble TTL expired | − `SPEAKING` overlay | T2 |

### 2.5 MotionController interface contract (consumed by T2–T5)

T1 lands this interface. T2–T5 must consume — do not re-implement.

```kotlin
interface MotionController {
    // Per-frame position in screen %  (0.0..1.0). Updated each draw tick.
    fun position(entityId: Int): PointF

    // Current motion state; SPEAKING/LISTENING are overlays queried separately.
    fun motionState(entityId: Int): MotionState

    // Targets must be in screen-% coordinates.
    fun setTarget(entityId: Int, xPct: Float, yPct: Float, onArrive: (() -> Unit)? = null)

    // Halt with no destination; remains until clearStop() or new target.
    fun stop(entityId: Int)
    fun clearStop(entityId: Int)

    // Resume wander after stop+grace.
    fun resumeWander(entityId: Int)
}

enum class MotionState { WANDERING, MOVING_TO_TARGET, STOPPED, SLEEPING }
```

**Open question O-3** (§9) — whether overlay flags (`SPEAKING`, `LISTENING`) live on `MotionController` or on a separate `OverlayController`. Recommendation: separate controller to keep motion code small.

---

## 3. Coordinate system — define "entity-unit"

The parent SPEC has a sign-off TODO on what "1 entity-unit" means. Proposal:

> **1 entity-unit = sprite_width × 1.5**
> where `sprite_width` is the current entity's rendered sprite bounding-box width in device pixels at the active scale.

### 3.1 Rationale / tradeoffs

| Choice | Tradeoff |
|---|---|
| `× 1.0` (sprite-tight) | Halos and "stand next to" gaps look cramped; sprites overlap on mid-density screens |
| `× 1.5` (proposed) | Gives breathing room; halo radius scales with sprite size, so descriptor authors don't need to bake margins; still readable on 5" phones |
| `× 2.0` | Wastes screen on tablets / small companion counts; visually feels distant |
| Fixed dp (e.g. 72dp) | Easy to reason about, but breaks when authors ship very-large or very-small sprites |

### 3.2 Composite entities (different sprite sizes)

When two entities have different sprite widths, use **`max(sprite_width_a, sprite_width_b) × 1.5`** for the *spacing between them*. For halo radius, use the **sender** sprite_width (sender is the focal point).

### 3.3 Settings override

Provide a hidden settings key `walking.entityUnitMultiplier` (default `1.5`) for tuning. Not exposed in the UI for v1.

---

## 4. Pixel-coord vs screen-relative

### 4.1 Storage rule

All positions stored and exchanged as **floats in `[0.0, 1.0]`** representing **fraction of screen dimension**.

```
xPct = pixelX / surfaceWidth
yPct = pixelY / surfaceHeight
```

Pixel coordinates are derived **on-render** by multiplying by current `width`/`height` passed to `ClawRenderer.draw(...)`.

### 4.2 Why

- Orientation change (portrait ↔ landscape) inverts width/height; absolute pixels become nonsense.
- Existing custom-layout pref already stores percent (`layoutPrefs.getCustomPosition(entityId)` → `Pair<Float, Float>` in `[0..1]` — see `ClawRenderer.kt:282-294`). Reuse the same convention; don't introduce a second one.
- The surface can be re-created at a different resolution (lock screen vs home screen on some OEMs). Percent survives.

### 4.3 Speed

Wander/walk speed is **percent-per-second**, not pixels-per-second.

- Default wander speed: `0.04 /sec` (~4% of screen height per second; crosses portrait screen in ~25s).
- Default walk-to-target speed: `0.12 /sec` (3× wander; feels purposeful).

Both speeds are isotropic (same on x and y in percent space). For square-pixel realism, distance is computed in *pixel space* before being converted back to percent for the step:

```
dxPx = (targetXPct - xPct) * width
dyPx = (targetYPct - yPct) * height
distPx = hypot(dxPx, dyPx)
stepPx = speedPctPerSec * min(width, height) * dt
fraction = stepPx / distPx  // capped at 1.0
xPct += (targetXPct - xPct) * fraction
yPct += (targetYPct - yPct) * fraction
```

Implementer note: the conversion through `min(width, height)` keeps motion visually consistent across orientations.

### 4.4 Edges & bounds

Entities are bounded by a **safe rectangle** `[ε, 1-ε] × [ε, 1-ε]` where `ε = max(sprite_width/width, sprite_height/height) * 0.5 + 0.02`. Wander direction reflects off this rectangle (random new direction; do not bounce mathematically — random looks more organic).

---

## 5. Speech bubble anchor (T2)

### 5.1 Anchor formula

```
bubble.anchorX = entity.x
bubble.anchorY = entity.y - sprite_height/2 - 8dp
```

(`entity.x`/`entity.y` is the sprite center in *pixels* at draw time; `8dp` is the gap between sprite top and bubble tail.)

### 5.2 Follow rule

The bubble **re-anchors every frame** while visible. Implementation:

1. T2 introduces a `SpeechBubbleOverlay` that is drawn AFTER the per-entity sprite (so it sits on top, but z-order under foreground HUD).
2. Each draw tick, for every entity with an active bubble, fetch the current `MotionController.position(entityId)` → convert to pixel → compute anchor → lay out the bubble.
3. **Do not** snapshot the anchor at bubble-show time. If sprite walks during TTL, bubble must trail it smoothly.

### 5.3 Lifecycle

| Trigger | TTL |
|---|---|
| New `EntityStatus.message` (non-empty, changed) | `max(2s, 0.06s × char_count)` capped at `8s` |
| Incoming speakTo (T3) | TTL = "until conversation ends" — sender clears it explicitly after both peers stop |
| Broadcast (T4) | TTL = `max(3s, halo_dwell_time + 1s)` to outlast the gather animation |

### 5.4 Bubble layout

- Min width `120dp`, max width `min(0.7 × screenWidth, 320dp)`.
- Auto-wraps at max width.
- Tail (10dp triangle) points down at `bubble.anchorY + tailHeight`.
- If `entity.y < sprite_height + 32dp` (entity near top of screen), flip bubble *below* the sprite (tail points up).

### 5.5 Multiple bubbles, overlapping sprites

If two entities' bubbles would overlap (>30% AABB overlap), the **later-arriving** bubble is offset upward by `bubble_height + 6dp`. Recursively de-overlap up to 3 stacks; beyond that, drop the oldest visible bubble.

### 5.6 Out-of-scope for T2

- Markdown rendering inside bubbles (plain text + emoji only)
- Tap-to-expand long messages
- Voice / TTS playback button (already in `TtsService.kt`; not part of bubble)

---

## 6. Broadcast halo geometry (T4)

When entity S broadcasts (e.g. user sends with `@all`):

1. S transitions to `MOVING_TO_TARGET(0.5, 0.5)` (screen center, in screen-%).
2. Every non-sleeping bystander entity B_i transitions to `MOVING_TO_TARGET(halo_slot_i)`.
3. Sleeping entities are **excluded** from the halo (see §7).

### 6.1 Halo radius

Let:
- `n` = number of non-sleeping bystanders (≥ 1; if 0, S simply walks to center and stops)
- `eu` = 1 entity-unit at S's sprite size in screen-% (typically `sprite_width × 1.5 / screen_width`)

Then:

```
radius_pct = max(1.5 × eu, 0.18 + 0.012 × n)
```

The `0.18 + 0.012 × n` term enforces a *count-scaled minimum* so that 8 bystanders don't crush into each other. Cap at `0.42` (so the halo fits on screen even on small phones).

### 6.2 Slot distribution

Bystanders are placed **evenly on a circle** of `radius_pct` around screen center `(0.5, 0.5)`:

```
for i in 0..n-1:
    theta_i = 2π × i / n + theta_offset
    slot_i.x = 0.5 + radius_pct × cos(theta_i) × (screen_height / screen_width)
    slot_i.y = 0.5 + radius_pct × sin(theta_i)
```

The aspect-ratio correction on x prevents the halo from looking egg-shaped on portrait phones (radius is *visually circular*).

`theta_offset = -π / 2` so the first bystander is *above* the sender (12 o'clock), which Western readers visually parse first.

### 6.3 Slot assignment order

Sort bystanders by **angular distance from their current position to center**, then assign in clockwise order from 12. Reason: minimizes total walking distance, prevents the X-crossing tangle that random assignment causes.

### 6.4 Halo end condition

The halo persists until:
- A new broadcast/speakTo arrives (cancels the current halo, transitions everyone fresh), OR
- A `halo_dismiss_at = broadcastReceivedAt + halo_dwell_seconds` timer fires (default `halo_dwell_seconds = 6.0`), OR
- The user manually dismisses (out of scope for T4 v1).

After end, all participants `resumeWander()`.

### 6.5 Out-of-scope for T4

- Inter-bystander animations (waving / nodding at sender) — pure positioning only.
- Halo persistence across orientation change mid-gather: on rotate, recompute slots from new dimensions and re-issue `setTarget`.

---

## 7. Sleep gate (T5)

### 7.1 Rule

A `SLEEPING` entity is **excluded** from:

| Subsystem | Behavior |
|---|---|
| Wander engine (T1) | No motion ticks; stays at last known position |
| Broadcast halo recruitment (T4) | Not counted in `n`; not assigned a slot |
| SpeakTo **receiver-pause** (T3) | Receiver does NOT halt; **sender still approaches** and stops at the sleeping entity's position |
| Speech bubble display (T2) | Bubbles still render (incoming message text), but sprite plays sleeping animation underneath |

The asymmetry on T3 is intentional: a sleeping receiver shouldn't *react* (no `LISTENING` overlay, no pulse), but the sender should still walk over to "drop off the message" — visually communicates that the message arrived but wasn't acknowledged.

### 7.2 Wake transition

When `EntityStatus.state` flips `SLEEPING → IDLE/BUSY/EXCITED`:
1. Clear `MotionState.SLEEPING` → `WANDERING` immediately.
2. If a "missed" speakTo bubble is still within TTL, it remains visible and now triggers the normal `LISTENING` overlay (sleepy → woke → "huh? did someone say something?").
3. Wake animation (sprite EXCITED frames) plays for `1.0s` regardless of `walkingEnabled` before wander resumes.

### 7.3 Sleep schedule source

Server-driven via `EntityStatus.state == CharacterState.SLEEPING`. T5 does NOT introduce a client-side schedule. (Server SLEEPING policy is already documented in `petdx-uiux-spec.md`.)

---

## 8. Test plan (simulator E2E per child card)

All tests run on Android emulator API 34, `pixel_8` profile, portrait unless noted. Test artifacts: screen recording + the `currentEntities` JSON log line via `Timber`.

### 8.1 T2 — speech bubble

| # | Scenario | Expected |
|---|---|---|
| T2-1 | Send chat msg to entity with `walkingEnabled=false` (STOPPED) | Bubble appears above sprite, TTL expires, fades |
| T2-2 | Send chat msg while entity is WANDERING | Bubble shows; bubble x/y follows sprite each frame; no visible jitter |
| T2-3 | Two entities receive messages within 500ms of each other; sprites are adjacent | Second bubble auto-offsets upward (no AABB overlap >30%) |
| T2-4 | Send 600-character message | Bubble caps at max width, wraps; TTL = 8s (cap) |
| T2-5 | Entity near top edge (`y < sprite_height + 32dp`) gets a bubble | Bubble flips below; tail points up |
| T2-6 | Rotate device mid-bubble | Bubble re-anchors at new orientation without flicker |

### 8.2 T3 — speakTo movement

| # | Scenario | Expected |
|---|---|---|
| T3-1 | Entity A speakTo Entity B (both awake, WANDERING) | A → MOVING_TO_TARGET(B.x,B.y); B → STOPPED + LISTENING overlay; A arrives within ε of B and STOPS |
| T3-2 | A speakTo B, then mid-walk A speakTo C | A retargets to C; B resumes WANDER after 1.5s grace; C goes STOPPED+LISTENING |
| T3-3 | A speakTo B while B is SLEEPING | B does NOT stop (still SLEEPING animation); A still walks to B.x,B.y and stops there; bubble shows over sleeping B |
| T3-4 | A speakTo self | No-op (motion-wise); bubble still shows |
| T3-5 | Conversation ends (bubble TTL out, no follow-up within 1.5s) | Both A and B `resumeWander()` |

### 8.3 T4 — broadcast movement

| # | Scenario | Expected |
|---|---|---|
| T4-1 | 4 entities, S broadcasts | S → center (0.5, 0.5); other 3 → halo at θ ∈ {−π/2, π/6, 5π/6}; radius respects 1.5eu floor |
| T4-2 | 8 entities, S broadcasts | Halo radius hits count-scaled minimum (≈ 0.276); no two bystanders within 1 eu of each other |
| T4-3 | 3 entities, one SLEEPING, S broadcasts | Sleeping excluded from `n`; halo has 1 bystander at 12 o'clock; sleeping stays put |
| T4-4 | Broadcast during ongoing halo | Halo cancels; new broadcast re-runs the whole transition |
| T4-5 | Rotate device mid-halo | Slots recomputed; entities walk to new slots smoothly (no teleport) |
| T4-6 | `halo_dwell_seconds` elapses | All participants `resumeWander()` |

### 8.4 T5 — sleep gate

| # | Scenario | Expected |
|---|---|---|
| T5-1 | Entity WANDERING; server flips `state=SLEEPING` | Motion halts within 1 tick; "Zzz" overlay; sprite at last position |
| T5-2 | Entity SLEEPING; server flips `state=IDLE` | Wake EXCITED anim plays 1.0s; then resumes WANDER |
| T5-3 | SLEEPING entity is target of broadcast | Not recruited (T4-3 covers) |
| T5-4 | SLEEPING entity is target of speakTo | Sender still approaches; receiver does not LISTEN (T3-3 covers) |
| T5-5 | `walkingEnabled=false` AND state=SLEEPING | Entity already STOPPED; SLEEPING overlay on top; behavior identical to T5-1 visually |

### 8.5 Cross-child regression

| # | Scenario | Expected |
|---|---|---|
| X-1 | Settings toggle `walkingEnabled=false` | All entities STOP within 1 tick; T2 bubbles still work; T3/T4 transitions disabled (sender doesn't move; bubbles still appear) |
| X-2 | Custom layout pref set per-entity | T1 wander starts from custom position; T4 halo center is still screen center (overrides custom) |
| X-3 | 0 bystanders, S broadcasts | S walks to center, stops, halo timer still ticks; clean resume |
| X-4 | T2 bubble + T3 walk + T5 wake all triggered within 1 second | No state-machine deadlock; final state matches event order |

---

## 9. Open questions for Hank / architect

> Implementers: do **not** ship a slice that depends on an unresolved item below. Comment on the parent card (`card_8765101e1479be4d664ec163`) to drive resolution.

| # | Question | Default proposed | Risk if wrong |
|---|---|---|---|
| O-1 | Is "1 entity-unit = sprite_width × 1.5" acceptable? | YES — §3 | Halos look too tight or too sparse; fixable in T4 alone |
| O-2 | Should `walkingEnabled=false` also disable T3/T4 transitions, or just disable wander? | Disable ALL motion (per X-1) | If only wander is disabled, users who toggle off still see entities lurching during broadcasts — confusing |
| O-3 | Should `SPEAKING` / `LISTENING` overlays live on `MotionController` or a separate `OverlayController`? | Separate `OverlayController` | Mixing them couples T2 to T1's lifecycle; harder to ship T2 in parallel |
| O-4 | When sender broadcasts and `n == 0`, should sender still walk to center, or no-op? | Walk to center, dwell, resume | "No-op" feels broken; walking gives a visual ack |
| O-5 | T3 receiver pulse animation — define visuals here, or defer to T3 implementer? | Defer to T3 PR (Codex picks something low-key; reviewable inline) | None — design decision is local |
| O-6 | T4 `halo_dwell_seconds = 6.0` — Hank product decision; long enough to read context? | 6.0s | Too short = users miss it; too long = wander looks dead |
| O-7 | Bubble lifetime when conversation has follow-up messages (rapid-fire chat) | Reset TTL to message-sized value on each new message | If TTL stacks, bubbles never disappear during active chats |
| O-8 | Sleep-during-walk: does the entity finish its current step or freeze instantly? | Freeze instantly (§7.1) | Late freeze looks like lag; early freeze is fine visually |
| O-9 | Should walking emit telemetry (entity step distance / collision events) for tuning? | Defer; no telemetry in v1 | Tuning blind; acceptable for v1 since wander is purely visual |
| O-10 | Are there accessibility concerns (motion-sensitivity / reduce-motion OS toggle)? | T1 to honor `Settings.Global.ANIMATOR_DURATION_SCALE = 0`; if 0, behave as `walkingEnabled=false` | A11y users get motion regardless of OS preference |

---

## 10. Implementation parallelism map

```
T1 (foundation, in progress)
  └─ ships MotionController interface, walkingEnabled toggle, wander engine
       │
       ├─────► T2 (speech bubble) — depends on MotionController.position()
       │
       ├─────► T3 (speakTo movement) — depends on setTarget + stop + resumeWander
       │
       ├─────► T4 (broadcast movement) — depends on setTarget + screen-% coords
       │
       └─────► T5 (sleep gate) — depends on MotionController.stop + CharacterState observer
```

T2 / T3 / T4 / T5 do **not** depend on each other. After T1 merges, all 4 can ship in parallel PRs, each gated by:
- This doc (architecture sign-off).
- Their own slice of §8 test plan.
- Cross-child regression §8.5 added to the **last** of T2–T5 to merge.

---

## 11. Out-of-scope (full list)

- Web/portal animated wallpaper preview.
- iOS app wallpaper (iOS doesn't expose live wallpaper APIs).
- Widget animated walking.
- Inter-entity collisions / physics (entities pass through each other visually; acceptable for v1).
- Path-finding around obstacles (no obstacles on the wallpaper surface).
- Persistence of walking state across app process death (entity respawns at default position on reboot; acceptable trade-off vs SharedPreferences churn).
- Multiplayer / cross-device walking (each device renders its own bound entities locally).

---

## 12. Changelog

| Date | Author | Change |
|---|---|---|
| 2026-06-20 | LOBSTER #2 | Initial draft (T2–T5 architecture for parent SPEC `card_8765101e1479be4d664ec163`) |
