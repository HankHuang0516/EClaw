# 看板督促 / Kanban Nudge Spec

> Source of truth for the kanban stale-card nudge system.
> Settings: [`backend/device-preferences.js`](../../backend/device-preferences.js)
> Logic:    [`backend/kanban.js`](../../backend/kanban.js) (`checkStaleCards` / `processDeviceStaleCards`)
> UI:       [`backend/public/portal/settings.html`](../../backend/public/portal/settings.html) (`#kanban-nudge-card`)
> Statuses: [`backend/public/shared/kanban-status.js`](../../backend/public/shared/kanban-status.js)

## 動機 / Why this spec exists

The nudge system has been in production since 2026-02 but was never written down.
Behavior was scattered across `processDeviceStaleCards`, `device-preferences.js` defaults,
and `kanban-status.js` `NUDGEABLE_STATUSES` / `NUDGE_DEFAULT_STATUSES`.

When Hank asked for per-entity overrides on 2026-05-19, the gap became visible:
no one could state the existing rules cleanly. This spec is the prerequisite for
adding the per-entity layer (see §6) without breaking the existing device-uniform
contract.

---

## 1. 名詞 / Vocabulary

- **督促 (nudge)** — Server-initiated reminder targeted at the entities assigned to a
  stale card. Two physical forms exist:
  - **🅰️ Stale-card nudge** — fires when `status_changed_at` exceeds a threshold.
    This is the subject of this spec.
  - **🅱️ Cron-schedule trigger** — fires when a recurring母卡's cron expression fires.
    Governed by `kanban_cron_recurring_notify` only. NOT covered here.
- **Stale threshold** — Time elapsed in current status before L1 nudge becomes eligible.
  Per-card column `stale_threshold_ms` (default 3h).
- **Escalation levels** — L1 nudge / L2 priority bump / L3 auto-block. See §3.
- **Effective settings** — The merged pref values used at decision time. Device base
  ∪ per-entity overrides (when applicable). See §6.

---

## 2. 設定欄位 / Settings (device base layer)

All defaults from `backend/device-preferences.js` `DEFAULTS`.

| Key | Default | Range / type | 說明 |
|---|---|---|---|
| `kanban_nudge_batch_size` | `1` | int 1–20 | 每輪 L1 督促最多挑幾張卡 |
| `kanban_nudge_priority_mode` | `'priority_first'` | enum: `priority_first` / `column_first` / `column_level` | L1 候選排序模式 |
| `kanban_nudge_interval_minutes` | `180` (3h) | int 5–1440 | 同一張卡兩次督促最小間隔 |
| `kanban_nudge_statuses` | `[todo, in_progress, review]` | subset of `NUDGEABLE_STATUSES` | 哪些欄位才會觸發督促（L1/L2/L3 通用） |
| `kanban_nudge_per_entity_throttle` | `true` | bool | L1 是否套用每 entity 同 interval 內最多 1 次督促 |
| `kanban_nudge_per_entity_overrides` | `{}` | `{entityId: Partial<NudgeFields>}` | **NEW (Phase 2)** — 見 §6 |

### 排序模式 / Priority mode

`sortCardsByNudgeMode(cards, mode)` (`kanban.js:2525`):

- `priority_first` — `P0 > P1 > P2 > P3`, tiebreak by oldest `status_changed_at`
- `column_first` — `review > in_progress > todo`, tiebreak by age
- `column_level` — column first, then priority within column, then age

`backlog` and `blocked` are never on the front of these orderings (they fall to
end via `STATUS_RANK` undefined = 9).

### 督促狀態白名單 / Nudgeable statuses

Single source: `kanban-status.js`:

| Status | `NUDGEABLE` | `NUDGE_DEFAULT` | 說明 |
|---|---|---|---|
| `backlog` | ✅ | ❌ | Opt-in（用戶可加入白名單） |
| `todo` | ✅ | ✅ | 預設督促 |
| `in_progress` | ✅ | ✅ | 預設督促 |
| `review` | ✅ | ✅ | 預設督促 |
| `done` | ❌ | ❌ | **規範禁止** — 已完成不應再督促 |
| `blocked` | ✅ | ❌ | Opt-in（人工介入欄，預設不督促避免雜訊） |

If a user-saved `kanban_nudge_statuses` array filters to empty after `NUDGE_STATUS_OPTIONS`
coercion (`device-preferences.js:49`), `getPrefs` falls back to `NUDGE_DEFAULT_STATUSES`
so nudges never silently stop.

---

## 3. 三段升級時鐘 / Three-Level Escalation Clock

Background tick: every **5 minutes** (`BG_CHECK_INTERVAL` in `kanban.js:2499`).
The tick runs `checkStaleCards` → `checkDoneAutoArchive` → `checkScheduleTriggers` → `checkPendingDispatch`.

For each card matching `status IN ('backlog','todo','in_progress','review')`
AND `now - status_changed_at > stale_threshold_ms`:

### L1 Nudge (default ≥ 3h)

- **Trigger**: `elapsed ≥ stale_threshold_ms` AND `now - last_stale_nudge_at > intervalMs` AND status in `kanban_nudge_statuses`.
- **Action** (`fireLevelOneNudge`):
  1. Add system comment `⏰ 催促：…已在「{status}」停留 {h} 小時，請 {bots} 繼續推進`.
  2. Update `last_stale_nudge_at = NOW()`.
  3. If assigned bots present: `notifyEntities()` push via `tKanban('staleNudge')`.
  4. `recordEntityNudge()` updates `kanban_entity_nudge_log`.
- **Constraints**:
  - Limited by `batch_size` per device per tick.
  - Limited by `per_entity_throttle`: skip candidate if every assigned bot was nudged within `intervalMs`.

### L2 Escalate (default ≥ 6h)

- **Trigger**: `elapsed ≥ escalateAfterMs` (default `6h`, overridable per-card via `config.escalationPolicy.escalateAfterMs`) AND `now - last_stale_nudge_at > intervalMs`.
- **Action** (`fireLevelTwoEscalation`):
  1. Upgrade priority `P3→P2→P1→P0` (`PRIORITY_UPGRADE` map).
  2. Update `last_stale_nudge_at`.
  3. System comment `⬆️ 自動升級：停滯 {h} 小時，優先級 X → Y`.
  4. `notifyEntities(recipients = reviewer + assigned_bots)`.
- **No batch_size cap** — clock-triggered safety rail. Per-entity throttle is **not** consulted (see §5).
- Returns `false` if priority already P0 (no change), so card continues to L1 / L3 logic.

### L3 Block (default ≥ 12h)

- **Trigger**: `elapsed ≥ blockAfterMs` (default `12h`, overridable per-card) AND status ≠ `blocked` AND `now - last_stale_nudge_at > intervalMs`.
- **Action** (`fireBlockEscalation`):
  1. `UPDATE kanban_cards SET status = 'blocked', status_changed_at = NOW(), last_stale_nudge_at = NOW()`.
  2. System comment `🚫 自動封鎖：此卡片已停滯 {h} 小時，已自動移至「blocked」，請人工介入`.
  3. `notifyEntities(recipients = reviewer + assigned_bots)`.
- **No batch_size cap.** Per-entity throttle not consulted.

### Per-card overrides

```jsonc
// kanban_cards.config
{
  "escalationPolicy": {
    "escalateAfterMs": 21600000,   // L2 threshold (default 6h)
    "blockAfterMs":    43200000,   // L3 threshold (default 12h)
    "notifyEntityId":  3            // override reviewer for L2/L3 push
  }
}
```

---

## 4. 內建排除 / Built-in exclusions

`checkStaleCards` SQL hardcodes:

```sql
WHERE archived = false
  AND status IN ('backlog','todo','in_progress','review')
  AND EXTRACT(EPOCH FROM (NOW() - status_changed_at)) * 1000 > stale_threshold_ms
  AND (schedule_enabled = false OR schedule_type != 'recurring' OR schedule_enabled IS NULL)
```

Excluded:

- **Archived cards** — never nudged.
- **`done` cards** — separate `checkDoneAutoArchive` path (retention/auto-archive).
- **`blocked` cards** — fall outside the SQL filter; can be re-included via `kanban_nudge_statuses` ∪ `{'blocked'}` opt-in.
- **Recurring schedule mothers** — `schedule_enabled=true AND schedule_type='recurring'` skipped because their `status_changed_at` never moves (cron spawns child cards instead). Without this, every recurring mother would escalate to P0 every staleThresholdMs window. Mirrors `checkDoneAutoArchive`'s same filter.

After SQL, in-memory filtering applies `allowedStatuses` from `kanban_nudge_statuses` to all L1/L2/L3 logic uniformly — opting `backlog` out also disables auto-escalation there.

---

## 5. 已知 quirks / Known design tradeoffs

These exist as deliberate design choices that should be documented to prevent
"surprise" bug reports being filed against intended behavior.

### 5.1 `batch_size=1` 餓死 / starvation under fixed sort

With `batch_size=1` and `priority_first` mode, the same top-priority card is
picked every tick until it leaves the stale window. Other stale cards never get
L1 nudged. Mitigation: raise `batch_size` or switch to `column_level` mode.

### 5.2 L2/L3 ignore per_entity_throttle

`fireLevelTwoEscalation` and `fireBlockEscalation` always push to recipients
regardless of `kanban_entity_nudge_log` state. **Intentional**: these are safety
rails (priority bump / auto-block) where suppression risk > duplicate notification.
A bot may receive an L2 push within seconds of an L1 push for the same card.

### 5.3 screenshot-gate completion trap

Independent of nudge system but interacts with L3: if a card has
`requires_screenshot_review=true` and bot reports IDLE without attaching a screenshot
(`kanban.js:3306`), the card stays in `review` indefinitely, eventually L3-blocking
it. Resolution requires attaching screenshot via `POST /api/mission/card/:id/file`
then re-IDLE transform.

### 5.4 Reviewer fallback when `notifyEntityId` is null

`buildEscalationRecipients` falls back to `card.reviewer_entity_id` when
`escalationPolicy.notifyEntityId` is unset. If neither is set, only `assigned_bots`
receive L2/L3 pushes. A card with no `assigned_bots` and no `reviewer_entity_id`
still gets system comments but no push — by design.

---

## 6. Per-entity override layer (Phase 2, 2026-05-19)

### Why

Different entities want different cadences. A high-frequency execution bot
(e.g. U-series workers) benefits from short intervals + larger batch. A senior
planner bot benefits from longer intervals to avoid context churn.
Device-uniform settings forced a worst-case compromise.

### Schema

`device_preferences.prefs.kanban_nudge_per_entity_overrides`:

```jsonc
{
  "3": {
    "kanban_nudge_interval_minutes": 60,
    "kanban_nudge_statuses": ["todo", "in_progress", "review", "blocked"]
  },
  "5": {
    "kanban_nudge_interval_minutes": 360,
    "kanban_nudge_per_entity_throttle": false
  }
}
```

Override keys are restricted to the subset that varies per-recipient:

```
kanban_nudge_interval_minutes
kanban_nudge_statuses
kanban_nudge_per_entity_throttle
```

`batch_size` and `priority_mode` remain device-wide because they govern global
candidate selection, not per-recipient delivery.

### Merge semantics (`getEffectivePrefsForEntity`)

```
effective = device_base
            with each allowed key overridden by per_entity_overrides[entityId][key]
            if present and well-typed
```

Coercion reuses `coerceValue()` so per-entity values pass the same clamps
(interval 5–1440, statuses ⊆ `NUDGEABLE_STATUSES`).

### Decision point

`processDeviceStaleCards` resolves effective prefs **per assigned bot** for L1
throttling and **per card** for `intervalMs` (using the strictest active override
among `assigned_bots`, or device base when no bots assigned).

Rationale: a 60-minute override for bot #3 must not cause bot #5 (with default
180-minute interval) to be hammered if they share an assignment.

### API

- `GET  /api/mission/nudge-prefs?deviceId&botSecret&entityId=N` → returns merged
  effective prefs for entity N, plus `_overrides: {...}` diff vs device base.
- `PUT  /api/mission/nudge-prefs` body `{deviceId, botSecret, entityId, overrides}`
  → upsert into `kanban_nudge_per_entity_overrides[entityId]`. Empty/null overrides
  delete the entity from the map.

Authorization: device-level `botSecret` of any entity on the device may read/write
(consistent with existing `device-preferences` access pattern).

### Future deprecation

If telemetry shows per-entity overrides exceed 80% of devices, fold `batch_size`
and `priority_mode` into the override set as well. Current scope kept minimal.

---

## 7. 必須改動點清單 / When changing nudge behavior

新增/調整任何 nudge 行為時務必同步：

1. **SoT**: `backend/device-preferences.js` `DEFAULTS` + `coerceValue` clamps.
2. **Logic**: `backend/kanban.js` `processDeviceStaleCards` / `fireLevel*` functions.
3. **UI**: `backend/public/portal/settings.html` `#kanban-nudge-card`.
4. **i18n**: `backend/public/shared/i18n.js` `kanban_nudge_*` keys for every locale.
5. **Spec**: this file.
6. **Tests**: `backend/tests/jest/*nudge*.test.js`.
7. **Changelog**: `CHANGELOG.md` under upcoming version.

---

## 8. 歷史 / Changelog

- **2026-05-19** — Phase 1: this spec written. Phase 2: per-entity overrides
  schema + API + UI shipped on branch `kanban-nudge-spec-and-per-entity`.
  Umbrella `card_e066cb6b2e07b242141064ba`.
- **2026-04-28** — `kanban-status.js` SoT introduced (see `kanban-status.md`).
- **2026-02** — Original L1/L2/L3 escalation system landed (`#1701`).

---

## 相關規範 / Related

- [看板狀態 SoT](kanban-status.md) — `NUDGEABLE_STATUSES` / `NUDGE_DEFAULT_STATUSES`.
- [`mission-v2-kanban-spec.md`](../mission-v2-kanban-spec.md) §十一 — `pending_notify` smart per-bot queue (delivery layer the nudge feeds into).
- [`kanban-dependencies-spec.md`](../kanban-dependencies-spec.md) — Card dependency model (orthogonal to nudge).
