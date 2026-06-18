# Desktop App Phase 2 — Configuration Automation Engine Spec

**Status:** Draft for spec sign-off
**Date:** 2026-06-18
**Owner:** Codex #6
**Reviewer:** LOBSTER #2 / Hank
**Parent card:** `card_7e6ac4fab3aa4c1a6e98552e` — `[Desktop/Phase 2/P3] 配置自動化引擎`
**Priority:** P3; starts after the mobile-notification P1 and Hermes tracks, and after Desktop Phase 1 foundations are accepted.
**Mode:** `feedback_spec_first` — this PR is documentation-only. No desktop implementation starts until this spec is signed off.

---

## 1. Context

The Desktop roadmap targets a one-click EClaw Desktop app that completes agent
binding configuration in under 30 seconds. D0 selected **Tauri 2** as the
desktop foundation in `docs/desktop-app-adr-001-framework.md`; Phase 1 is
responsible for the secure app shell, OAuth, OS credential storage, local agent
detection, endpoint probing, and rollback-capable binding primitives.

Phase 2 builds on those foundations with a **configuration automation engine**:

- prebuilt common agent combinations;
- scenario matching;
- dynamic configuration generation;
- parallel API calls;
- retry and resume behavior;
- real-time progress feedback;
- network environment detection;
- firewall / proxy adaptation;
- OS-specific adaptation for macOS and Windows.

The existing roadmap entry is a 9-task, 2-3 week epic. That is too large to
implement as a single card. This spec narrows the architecture and splits the
epic into independently shippable 1-3 day subcards.

## 2. Goals

1. Define a safe, reviewable architecture for Phase 2 before code is written.
2. Keep all automation deterministic and reversible: no arbitrary shell, no
   unbounded filesystem writes, no secret readback to the renderer.
3. Produce an ordered set of subcards small enough for incremental PRs and
   rollback.
4. Preserve the D0 / Phase 1 security model: privileged work remains in the
   Rust/Tauri command layer; the renderer only receives sanitized state and
   progress events.
5. Make enterprise-network handling explicit without silently weakening TLS,
   proxy, firewall, or credential boundaries.

## 3. Non-goals

- No implementation in this spec PR.
- No remote privileged UI: the desktop app must still ship local EClaw-owned UI
  assets with a restrictive CSP.
- No generic template execution, JavaScript eval, arbitrary shell execution, or
  user-supplied scripts.
- No automatic firewall or system proxy mutation in Phase 2 without an explicit
  follow-up approval; Phase 2 may detect and guide, and may apply only scoped
  app-level proxy settings.
- No new OAuth or credential-storage design; those remain Phase 1 dependencies.
- No claim that the parent epic is complete when the spec is merged.

## 4. Architecture decision

Phase 2 uses a small ports-and-adapters architecture inside the Tauri app:

```text
Renderer UI
  │
  │ invokes allowlisted Tauri commands; subscribes to progress events
  ▼
Config Automation Core (Rust)
  ├─ Template registry + constrained renderer
  ├─ Scenario matcher
  ├─ Execution-plan compiler
  ├─ Batch runner + parallel API client
  ├─ Retry/resume policy
  └─ Progress event emitter
        │
        ├─ EClaw API client adapter
        ├─ Local agent adapter(s)
        ├─ Network diagnostics adapter
        └─ OS adapter: macOS / Windows
```

The renderer can select a scenario, display a plan preview, request execution,
and display progress. It cannot directly read tokens, mutate agent config, run
commands, or bypass the automation core.

### 4.1 Template engine choice

Use a **versioned declarative template schema** plus a constrained renderer, not
a general-purpose template language.

Recommended shape:

- templates live in the local app bundle as signed/versioned JSON or JSONC
  documents;
- each template declares:
  - stable `id`, `version`, `displayName`, supported OSes, and required
    capabilities;
  - inputs with type, validation, default, and whether the value is secret;
  - emitted operations such as `createDeviceBinding`, `configureAgentEndpoint`,
    `writeAgentConfig`, `validateAgentConnection`, and `rollbackOnFailure`;
  - dependencies between operations;
  - expected rollback actions and verification probes;
- dynamic values are limited to safe substitutions from a typed context:
  authenticated user, selected entity, detected agent inventory, OS profile,
  network profile, and non-secret user inputs;
- secret inputs are referenced by opaque handles to the credential layer and are
  never rendered into renderer-visible JSON.

Why this choice:

- A full template engine such as Handlebars, Liquid, or embedded JS would make
  authoring easy but creates a new injection and review surface.
- Declarative operation graphs are easier to diff, schema-validate, localize,
  simulate, and rollback.
- The same schema can power a dry-run preview, plan validation, and test
  fixtures before any local file or backend mutation happens.

Acceptance rule: a template PR must include schema validation tests, at least one
dry-run snapshot, and a rollback statement for every mutating operation.

### 4.2 Parallel API client choice

Use a Rust-owned, concurrency-limited batch runner around the EClaw API client.

Required behavior:

- global concurrency limit defaults to `4`;
- per-origin / per-agent concurrency limit defaults to `2`;
- every mutating backend request carries an idempotency key derived from the
  local operation id and plan id;
- all request / response logs redact authorization headers, tokens, secrets,
  local usernames, and private paths;
- retries are classified by error type:
  - retry: network timeout, DNS transient, HTTP `429`, HTTP `502/503/504`;
  - do not retry automatically: `400`, `401`, `403`, validation errors,
    capability mismatch, user cancellation;
  - retry with user-visible warning: TLS/proxy/captive-portal suspicion;
- exponential backoff includes jitter and a bounded retry budget;
- cancellation is cooperative and leaves the local operation log in a resumable
  state;
- execution emits normalized progress events for the renderer.

Why this choice:

- The Rust layer already owns privileged operations and token access in the D0
  architecture, so the API client should also live there.
- The renderer should not orchestrate parallel privileged mutations because that
  makes cancellation, retries, and redaction inconsistent.
- A deterministic operation log gives support and rollback a single source of
  truth.

### 4.3 OS-adapter pattern choice

Use a trait/interface-per-OS adapter with a platform-neutral automation core.

Recommended interfaces:

```text
OsAdapter
  - profile(): OsProfile
  - appSupportDir(): SafePath
  - credentialStoreHealth(): CredentialStoreStatus
  - detectNetwork(): NetworkProfile
  - detectProxy(): ProxyProfile
  - detectFirewall(): FirewallProfile
  - agentConfigPaths(agentKind): CandidatePath[]
  - backupFile(path): BackupHandle
  - writeFileTransactional(path, content, backup): WriteResult
  - validatePermissions(path): PermissionResult
```

Implementation notes:

- macOS and Windows adapters are separate subcards.
- Tests use a fake adapter with fixture paths and simulated proxy/firewall
  states; core tests must not require a real Keychain, Credential Manager, or
  administrator permissions.
- OS adapters return structured capability results. They do not silently elevate
  privileges.
- Any future Linux support adds a new adapter without changing the core plan
  compiler or template schema.

Why this choice:

- Environment adaptation is the riskiest Phase 2 area because path, permission,
  proxy, and firewall behavior differ by OS.
- Keeping OS behavior behind explicit adapters prevents template authors from
  hardcoding platform-specific paths or shell commands.
- It gives each OS PR a small, testable surface.

## 5. Execution-plan lifecycle

Every automated configuration run follows the same lifecycle:

1. **Detect:** collect non-secret OS, network, proxy, firewall, and local-agent
   capability data.
2. **Match:** rank compatible templates and scenarios.
3. **Preview:** compile a dry-run execution plan and show a human-readable
   summary of target agents, files, backend bindings, and rollback behavior.
4. **Authorize:** user confirms the plan; the renderer passes only a plan id and
   non-secret choices.
5. **Execute:** the Rust core runs operations with concurrency limits,
   idempotency keys, retries, and progress events.
6. **Validate:** verify backend binding state and local agent connectivity.
7. **Commit:** mark the operation log as successful and retain rollback
   metadata.
8. **Rollback / resume:** on failure or cancellation, run the declared rollback
   steps when safe, or leave a resumable failed state with explicit next steps.

## 6. Data contracts

### 6.1 Template document

```jsonc
{
  "schemaVersion": 1,
  "id": "common-codex-claude-hermes",
  "version": "2026.06.18",
  "displayName": "Codex + Claude Code + Hermes",
  "supportedOs": ["macos", "windows"],
  "requiredCapabilities": ["oauthSession", "credentialStore", "agentDiscovery"],
  "inputs": [
    { "key": "entityId", "type": "entity", "required": true },
    { "key": "agentSet", "type": "enum", "values": ["codex", "claude", "hermes"] }
  ],
  "operations": [
    {
      "id": "detect-agents",
      "kind": "detectAgents",
      "rollback": "none"
    },
    {
      "id": "bind-device",
      "kind": "createDeviceBinding",
      "dependsOn": ["detect-agents"],
      "rollback": "cancelBinding"
    }
  ]
}
```

### 6.2 Execution plan

```jsonc
{
  "planId": "plan_...",
  "templateId": "common-codex-claude-hermes",
  "templateVersion": "2026.06.18",
  "dryRun": true,
  "targets": [
    { "kind": "agent", "agentKind": "codex", "displayName": "Codex CLI" }
  ],
  "operations": [
    {
      "operationId": "op_01",
      "kind": "detectAgents",
      "mutates": false,
      "rollback": "none"
    }
  ],
  "warnings": []
}
```

### 6.3 Progress event

```jsonc
{
  "planId": "plan_...",
  "operationId": "op_01",
  "phase": "execute",
  "status": "running",
  "percent": 35,
  "messageKey": "desktop_config_detecting_agents",
  "redactedDetails": {}
}
```

Progress events must be localization-ready (`messageKey`) and safe to upload as
support evidence after redaction.

## 7. Proposed subcards

These subcards are proposed implementation cards. They should be created or
activated only after this spec receives sign-off.

| ID | Original roadmap task | Proposed subcard title | Estimate | Ship slice / acceptance |
| --- | --- | --- | --- | --- |
| D2-1 | 預建常用 Agent 組合 | `[Desktop/Phase 2] Template schema + bundled registry MVP` | 2-3 days | Define schema, validator, 2-3 read-only starter templates, dry-run snapshots, docs. No config mutation yet. |
| D2-2 | 用戶使用場景快速匹配 | `[Desktop/Phase 2] Scenario matcher and recommendation rules` | 1-2 days | Given detected agents + user goals, rank compatible templates with explainable reasons and tests. |
| D2-3 | 動態配置生成 | `[Desktop/Phase 2] Execution-plan compiler and safe substitutions` | 2-3 days | Compile selected template to dry-run execution plan; reject invalid/secret-leaking substitutions; snapshot tests. |
| D2-4 | 並行 API 調用優化 | `[Desktop/Phase 2] Concurrency-limited EClaw API batch client` | 2-3 days | Rust API client wrapper with global/per-origin limits, idempotency keys, redacted logs, mocked integration tests. |
| D2-5 | 失敗重試機制 | `[Desktop/Phase 2] Retry, cancellation, and resumable operation log` | 2-3 days | Error taxonomy, backoff/jitter, cancellation semantics, resumable failed-state fixtures. |
| D2-6 | 進度即時回饋 | `[Desktop/Phase 2] Progress event stream and renderer contract` | 1-2 days | Normalized progress events, localization keys, redaction tests, renderer mock consuming event stream. |
| D2-7 | 網路環境檢測 | `[Desktop/Phase 2] Read-only network diagnostics preflight` | 1-2 days | DNS/TLS/reachability/captive-portal/proxy hints with no mutation; fixtures for healthy/offline/proxy cases. |
| D2-8 | 防火牆/代理自動適配 | `[Desktop/Phase 2] Scoped proxy/firewall adaptation guidance` | 2-3 days | App-level proxy config support when explicit; firewall/proxy guidance and diagnostics; no silent system mutation. |
| D2-9 | 不同作業系統適配 | `[Desktop/Phase 2] OS adapter interface + fake adapter test harness` | 1-2 days | Define adapter trait, fake adapter, contract tests shared by macOS/Windows implementations. |
| D2-10 | 不同作業系統適配 | `[Desktop/Phase 2] macOS adapter for paths, permissions, network profile` | 2-3 days | macOS implementation for app support paths, transactional backup/write, proxy/network profile, non-admin behavior tests. |
| D2-11 | 不同作業系統適配 | `[Desktop/Phase 2] Windows adapter + VM smoke contract` | 2-3 days | Windows path/permission/proxy adapter plus documented VM smoke checklist; no D2 completion without Windows evidence. |

Suggested dependency order:

```text
D2-1 -> D2-3 -> D2-4 -> D2-5
   │       │       │       │
   └-> D2-2       └-> D2-6
D2-9 -> D2-10 -> D2-11
D2-7 -> D2-8
```

The first shippable vertical slice is `D2-1 + D2-3 + fake adapter from D2-9`:
it can produce a dry-run plan without touching real credentials, files, or
backend state.

## 8. Phase 2 entry criteria

Do not start implementation subcards until all are true:

- D0 architecture decision remains accepted: Tauri 2, local UI assets, Rust
  command layer, no remote privileged UI.
- Phase 1 has a working OAuth session, OS credential-store access, agent
  discovery, endpoint probing, and rollback-capable binding primitive.
- This spec is reviewed and signed off.
- The first implementation subcard links back to this spec and includes a
  rollback/no-secret-leak acceptance checklist.

## 9. Acceptance criteria for Phase 2 as a whole

- Common templates can be selected, previewed, and executed without exposing
  secrets to the renderer.
- Scenario matching recommends compatible templates and explains why a template
  is incompatible.
- Dynamic plans are schema-validated and dry-run before mutation.
- Parallel backend operations are idempotent, concurrency-limited, retry-safe,
  cancelable, and redacted in logs.
- The UI receives real-time progress events and a clear final success/failure
  result.
- Network/proxy/firewall diagnostics are visible before execution when they may
  affect success.
- OS-specific behavior is isolated behind adapters and tested through fake,
  macOS, and Windows paths.
- Rollback/resume evidence exists for at least one successful and one forced
  failure run on macOS and Windows before the epic is considered done.

## 10. Open questions for sign-off

1. Should templates be shipped only in the desktop app bundle for Phase 2, or
   may signed remote template updates be introduced after the local-bundle MVP?
   Recommendation: bundle-only for Phase 2 MVP; remote templates require a
   separate signing and rollback spec.
2. Should Phase 2 support app-level proxy credentials, or only unauthenticated
   proxy detection and user guidance?
   Recommendation: detect and guide first; credentials are a follow-up after
   credential-store UX is reviewed.
3. What is the minimum first "common Agent combination" for D2-1?
   Recommendation: choose 2-3 combinations from the agents Phase 1 can already
   detect reliably; do not template agents without detection support.
4. Should automatic firewall changes ever be in scope?
   Recommendation: no silent changes; any system-level firewall mutation needs a
   separate explicit admin-permission spec.
