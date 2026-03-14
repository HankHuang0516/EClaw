# EClaw Test Coverage Analysis Report

**Date:** 2026-03-14
**Author:** Claude Code (automated analysis)
**Scope:** Backend API endpoint coverage

---

## Executive Summary

| Metric | Value |
|--------|-------|
| Total API Routes | **238** |
| Test Files | **57** (~644 KB) |
| Routes with Test Coverage | **~107 (~45%)** |
| Routes with Zero Coverage | **~131 (~55%)** |
| Jest Unit Test Files | **2** |
| Integration Test Files | **54** |
| Files Registered in `run_all_tests.js` | **25 of 57** |

---

## Coverage by Module

| Module | File | Routes | Tested | Gap | Coverage |
|--------|------|--------|--------|-----|----------|
| Core API | `index.js` | 139 | ~70 | ~69 | ~50% |
| Auth | `auth.js` | 24 | 5 | **19** | 21% |
| Mission | `mission.js` | 26 | 14 | 12 | 54% |
| Article Publisher | `article-publisher.js` | 11 | 0 | **11** | 0% |
| AI Support | `ai-support.js` | 9 | 3 | 6 | 33% |
| OAuth Server | `oauth-server.js` | 8 | 8 | 0 | 100% |
| A2A Compat | `a2a-compat.js` | 6 | 6 | 0 | 100% |
| Notifications | `notifications.js` | 5 | 0 | **5** | 0% |
| Subscription | `subscription.js` | 5 | 1 | **4** | 20% |
| Channel API | `channel-api.js` | 3 | 3 | 0 | 100% |
| gRPC | `grpc-server.js` | 2 | 2 | 0 | 100% |

---

## Test File Inventory

### Core Regression Tests (run after every deploy)

| Test File | Endpoints Covered | Status |
|-----------|------------------|--------|
| `test-bot-api-response.js` | POST /api/transform, exec+curl verification | ✅ In runner |
| `test-broadcast.js` | POST /api/entity/broadcast, GET /api/chat/history | ✅ In runner |
| `test-edit-mode-public-code.js` | PUT /api/entities, public code persistence | ✅ In runner |
| `test-cross-device-settings.js` | Entity cross-device settings CRUD | ✅ In runner |
| `test-tls-headers.js` | Security headers (HSTS, CSP, etc.) | ✅ In runner |
| `test-audit-logging.js` | GET /api/logs, GET /api/audit-logs | ✅ In runner |

### Feature Tests

| Test File | Endpoints Covered | In Runner? |
|-----------|------------------|------------|
| `test-agent-card.js` | PUT/GET/DELETE /api/entity/agent-card | ✅ |
| `test-oidc-foundation.js` | GET /api/auth/oauth/providers, OIDC validation | ✅ |
| `test-rbac.js` | GET/POST/DELETE /api/auth/roles, /api/auth/user-roles | ✅ |
| `test-multi-entity-push.js` | POST /api/client/speak with array entityId | ✅ |
| `test-a2a-compat.js` | /.well-known/agent.json, /api/a2a/tasks/* | ✅ |
| `test-api-docs.js` | GET /api/docs, OpenAPI spec validation | ✅ |
| `test-oauth-server.js` | /api/oauth/clients, /api/oauth/token, introspection | ✅ |
| `test-sdk-generation.js` | OpenAPI spec completeness | ✅ |
| `test-grpc-transport.js` | gRPC Health, Entity, Communication services | ✅ |
| `test-vars-merge.js` | /api/device-vars merge logic | ✅ |
| `test-channel-api.js` | /api/channel/* | ✅ |
| `test-skill-templates.js` | /api/skill-templates CRUD | ✅ |
| `test-ws-auth.js` | Socket.IO authentication | ✅ |
| `test-ai-chat-image.js` | AI chat with image support | ✅ |
| `test-discord-webhook.js` | Discord webhook registration, rich messages | ✅ |

### Test Files NOT in `run_all_tests.js` (~32 files)

Many test files in `backend/tests/` are not registered in the test runner. These include:
- `test_webhook.js` — Webhook registration lifecycle
- `test_entity_operations.js` — Entity CRUD operations
- `test_chat_history.js` — Chat history endpoints
- `test_device_registration.js` — Device registration
- Various regression-specific tests

---

## Critical Coverage Gaps

### 1. Authentication (`auth.js`) — **19 untested routes**
- `POST /api/auth/register` — User registration
- `POST /api/auth/login` — User login
- `GET /api/auth/me` — Current user profile
- `POST /api/auth/change-password` — Password change
- `DELETE /api/auth/account` — Account deletion
- `POST /api/auth/oauth/google` — Google OAuth
- `POST /api/auth/oauth/facebook` — Facebook OAuth
- `POST /api/auth/oauth/oidc` — OIDC provider login
- **Risk:** Auth is the foundation — any regression breaks all authenticated endpoints

### 2. Article Publisher (`article-publisher.js`) — **11 untested routes (0% coverage)**
- All CRUD operations for articles
- X/Twitter publishing integration
- OAuth 1.0a signing
- **Risk:** Publishing to external platforms with zero safety net

### 3. Push Notifications (`notifications.js`) — **5 untested routes**
- `POST /api/notifications/subscribe` — Web Push subscription
- `POST /api/notifications/send` — Send push notification
- `GET /api/notifications/subscriptions` — List subscriptions
- `DELETE /api/notifications/unsubscribe` — Unsubscribe
- **Risk:** Silent failures — users stop receiving notifications with no test to detect it

### 4. Subscription/Billing (`subscription.js`) — **4 untested routes**
- `POST /api/subscription/verify` — Purchase verification
- `POST /api/subscription/cancel` — Cancellation
- `GET /api/subscription/status` — Status check
- **Risk:** Handles money — regressions can cause revenue loss or overcharging

### 5. Admin Endpoints — **~10 untested routes**
- User management, system stats, log access
- Gatekeeper admin controls
- **Risk:** Admin panel operations could break without detection

---

## Infrastructure Issues

1. **Test Runner Coverage:** Only 25 of 57 test files are registered in `run_all_tests.js`
2. **Exit Code Handling:** Runner uses string matching ("FAIL", "Error") instead of process exit codes
3. **No Jest Coverage Report:** `--coverage` flag not enabled in CI workflow
4. **No Parallel Execution:** All tests run sequentially (~5-10 min total)
5. **Environment Coupling:** Many tests require specific device credentials from `.env`

---

## Priority Recommendations

### P0 (Critical — add immediately)
1. **Auth flow tests** — register → login → me → change-password → delete-account
2. **Subscription tests** — verify, cancel, status check

### P1 (High — add within 1 sprint)
3. **Notification endpoint tests** — subscribe, send, verify delivery
4. **Admin endpoint tests** — user management, system operations
5. **Fix `run_all_tests.js`** — register all 57 test files, use exit codes

### P2 (Medium — add when touching the module)
6. **Article publisher tests** — CRUD + mock X/Twitter API
7. **Cross-device contacts tests** — add/remove/list contacts
8. **Chat integrity tests** — message validation, history pagination
9. **Enable Jest `--coverage`** in CI pipeline

### P3 (Low — nice to have)
10. **Load testing** — concurrent push delivery, broadcast fan-out
11. **E2E tests** — full user journey from registration to bot chat
12. **Web Portal screenshot tests** — visual regression

---

## Appendix: All Test Files

```
backend/tests/
├── test-a2a-compat.js
├── test-a2a-task-dispatch.js
├── test-agent-card.js
├── test-ai-chat-image.js
├── test-api-docs.js
├── test-audit-logging.js
├── test-bot-api-response.js
├── test-broadcast.js
├── test-channel-api.js
├── test-cross-device-settings.js
├── test-discord-webhook.js
├── test-edit-mode-public-code.js
├── test-grpc-transport.js
├── test-multi-entity-push.js
├── test-oauth-server.js
├── test-oidc-foundation.js
├── test-rbac.js
├── test-sdk-generation.js
├── test-skill-templates.js
├── test-tls-headers.js
├── test-vars-merge.js
├── test-ws-auth.js
├── test_broadcast.js
├── test_chat_history.js
├── test_device_registration.js
├── test_entity_operations.js
├── test_webhook.js
└── ... (30+ additional files)

backend/test/
├── mission.test.js

backend/tests/jest/
├── gatekeeper.test.js
└── chat-integrity.test.js
```
