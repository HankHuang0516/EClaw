# Idle Dispatch Hooks - PR-A Instrumentation

> Status: PR-A - instrumentation only (no listener logic)

## Overview

PR-A adds instrumentation hooks for kanban card lifecycle events.
It is purely observational. Default OFF - production behavior changes zero.

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

| Event | Payload |
|---|---|
| card_status_changed | `{cardId, fromStatus, toStatus, deviceId, entityId, ts}` |

## Structured Logs

```json
{"ev":"idle_dispatch.card_status_changed","name":"card_status_changed","payload":{...},"ts":"..."}
{"ev":"idle_dispatch.emit_error","name":"card_status_changed","error":"...","ts":"..."}
```

No secrets logged (botSecret/deviceSecret excluded from emit() payload by design).

## PR-B (Future)

PR-B will add listeners for: queue depth, drain attempt, drain result, latency.

## Rollback

`unset IDLE_DISPATCH_HOOKS_ENABLED` to disable (zero production behavior change).