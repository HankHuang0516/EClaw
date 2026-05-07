# Idle Dispatch Hooks

> Status: PR-A foundation + PR-B/PR-C call-sites — emit-only, no listeners

## Overview

Instrumentation hooks for kanban card lifecycle events. Purely
observational at this stage. Default OFF — production behavior changes
zero until a listener is registered AND the env flag is set.

## Architecture

```
backend/
  lib/
    idle-dispatch-config.js  # Feature flag (env var gate)
    kanban-events.js          # EventEmitter + emit() wrapper
  tests/jest/
    idle-dispatch-hooks.test.js
  docs/
    idle-dispatch.md          # This file
```

## Feature Flag (Dual-Layer)

1. Environment Variable (Hard Gate):
   `IDLE_DISPATCH_HOOKS_ENABLED=true` (unset = OFF)

2. Programmatic: `config.idleDispatch.enabled`
   All `emit()` calls check this internally before emitting.

## Events

| Event | Emitted from | Payload |
|---|---|---|
| card_status_changed | `kanban.js` POST /card/:id/move (PR-B) | `{cardId, fromStatus, toStatus, deviceId, entityId, ts}` |
| auto_cron_card_created | `idle_dispatch_integration.js` createAutoCronCard (PR-C) | `{cardId, parentCardId, deviceId, assignedBots, ts}` |

Both events fire AFTER the durable DB write completes, so listeners
never see a transition that gets rolled back.

## Structured Logs

```json
{"ev":"idle_dispatch.card_status_changed","name":"<event>","payload":{...},"ts":"..."}
{"ev":"idle_dispatch.emit_error","name":"<event>","error":"...","ts":"..."}
```

No secrets logged (botSecret/deviceSecret excluded from emit() payload by design).

## Future work

A listener subsystem (queue-depth metrics, dispatch-latency tracking,
drain attempts) is out of scope for the current PR series. Adding one
only requires `kanbanEvents.on('<event>', handler)` somewhere in startup.

## Rollback

`unset IDLE_DISPATCH_HOOKS_ENABLED` to disable (zero production behavior change).