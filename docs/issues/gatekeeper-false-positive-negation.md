# Gatekeeper false positive: "不需要 API Key" triggers credential extraction detection

**Labels**: bug, security

## Bug Description

The `TOKEN_EXTRACTION_PATTERNS` regex `/(?:botSecret|api[_\s]*key|...)/i` matches the literal string `api key` regardless of context. Messages that mention "不需要 Brave API Key" (telling bots they DON'T need an API key) are blocked as credential extraction attempts.

**Location**: `backend/gatekeeper.js` line 36

**Pattern**:
```js
/(?:botSecret|api[_\s]*key|access[_\s]*token|bearer[_\s]*token|deviceSecret|webhook[_\s]*token)/i
```

**Impact**:
- Device owners cannot tell bots "you don't need an API key" without triggering the filter
- The eclaw-a2a-toolkit skill intentionally provides APIs that don't need extra keys, but explaining this to bots gets blocked
- Combined with the domain whitelist bug, this resulted in 3 rapid strikes and device block during normal operation

## Suggested Fix

Option A: Add negative lookbehind for negation words:
```js
/(?<!不需要.{0,5})(?<!don't need.{0,10})(?:botSecret|api[_\s]*key|...)/i
```

Option B: Score-based approach instead of instant block — single keyword match = warning, pattern + intent = block

Option C: Whitelist messages from device owner (deviceSecret auth) since they already have full access to their own credentials

## Context

This was discovered during Phase 1 AI search brand testing when the EClaw Official Agent tried to instruct Entity #3 to use built-in tools instead of external APIs.
