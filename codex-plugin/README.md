# EClawbot local Codex plugin

Development version **0.1.0**. The remote MCP endpoint is configured as `https://eclawbot.com/mcp`; this branch has not established that endpoint as a live public service. Directory review and publication remain pending.

EClawbot routes chat to an existing Codex conversation on **your computer**. It preserves the bound conversation, working directory, and installed owner skills. Web/mobile chat, entity settings, connection status, approvals, and logs use EClawbot. Codex executes locally under your selected permissions and existing ChatGPT login.

You need an EClawbot account, Node.js 22 or later, a locally installed Codex CLI signed in with ChatGPT, and an awake computer with Codex and the local helper continuously running. Your Codex usage limits apply; EClawbot account/plan limits can also apply. This package does not establish new pricing or unlimited usage. No model API key is needed for this connection, and subscription credentials stay with local Codex.

## Connect an existing conversation

With the plugin installed in a local Codex host, request: “Connect this conversation and project to an EClawbot entity named My Codex with read-only permissions.” The bundled [connection skill](skills/connect-codex/SKILL.md) completes EClawbot OAuth, creates or identifies your binding, and uses the actual local thread ID and project directory.

Entity creation requires a name, current thread ID, absolute workspace, and a `request_id` UUID generated once and reused on any retry. This prevents duplicate creation after an uncertain network result. The local enrollment creates a private token that can control **one approved EClawbot binding**. It is distinct from your Codex login. The owner approves its enrollment through the MCP `approve_runtime` tool, then the skill starts the bundled background helper. It returns the chat URL/publicCode provided by EClawbot and checks the real connection state. A metadata-only entity or successful process launch is not proof that it can answer.

For manual local operation after resolving the installed plugin path, selected binding ID, and original project directory:

```sh
node "$plugin_root/scripts/runtime.mjs" --enroll \
  --binding "$binding_id" --thread "$CODEX_THREAD_ID" --workspace "$workspace"
# Approve the returned enrollmentId through the owner's EClawbot MCP connection.
node "$plugin_root/scripts/runtime.mjs" --start --binding "$binding_id"
node "$plugin_root/scripts/runtime.mjs" --status --binding "$binding_id"
node "$plugin_root/scripts/runtime.mjs" --stop --binding "$binding_id"
```

Use [runtime guidance](skills/connect-codex/references/runtime.md) for state storage, safe argument handling, and failure recovery. The background helper is not automatically installed as a login/startup service. When the computer sleeps, goes offline, or the helper/Codex stops, it cannot generate replies. Restore local availability and resume the same binding. A missing conversation requires your explicit choice before replacement; the helper must not silently reset it.

## Permissions and personal customer service

Each entity has its own binding, local state, conversation, workspace, and permission profile. The supported profiles are `read-only` and `workspace-write`; execution requests that require approval wait for the authenticated owner. Enrollment approval does not approve commands, file changes, purchases, publishing, or messages to customers. Existing context is preserved, but local tools and reads still obey the selected permission profile.

Remote input cards support one question with fixed choices. Multiple questions, free text and form elicitation require local Codex; the helper declines unsupported remote requests and tells the owner how to continue. Interrupted turns with uncertain outcomes require local recovery instead of automatic replay. Pending delivery is retried, but remote side effects and local database commits do not provide an exactly-once guarantee across a crash.

Owner messages enter the existing private conversation. Optional personal customer service uses a dedicated isolated conversation and workspace with only the public knowledge you explicitly provide. Customers do not inherit owner history, project files, installed owner tools, or administrative approval controls. Enable or update it by requesting the change for a specific entity and supplying its public knowledge. Do not publish private project documents as customer knowledge without selecting and approving that content.

Customer service additionally requires an installed app-server protocol with restricted read roots (`ReadOnlyAccess`). The helper checks the installed binary's generated schema and refuses customer execution when that capability is absent. The local smoke check on 2026-10-02 found that Codex CLI 0.137.0 could read the original conversation/workspace but lacked this capability; customer execution remained disabled. Use a version that passes this capability check before running the live customer review cases. An addressable EClaw sender publicCode is required to route customer replies; unaddressable messages are reported to the owner.

Request logs with `read_codex_logs({binding_id, limit})`; disconnect with `disconnect_codex_entity({binding_id})` and stop the selected helper. Disconnecting preserves your original local Codex conversation and project. EClawbot receives routed chat content and binding metadata; it does not receive local subscription login files or run a public inference server.

## Build and validate from the source checkout

The following commands are for this source directory. The development tools and tests are excluded from the ZIP; no dependency installation is required for packaging. Python's built-in `zipfile` module is used only as an independent archive reader in a test.

```sh
npm test
node scripts/package.mjs --check
node scripts/package.mjs --output /tmp/eclawbot-0.1.0-development.zip
python3 /Users/hank/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/connect-codex
```

The last command uses the developer's local skill-creator validator; it is not an end-user dependency. Both runtime scripts must exist before `--check` or a build can pass. Tests use isolated runtime fixtures so packaging can be tested during parallel development.

ZIP contents are allowlisted: root `plugin.json`, `mcp.json`, this README, the two runtime scripts, connection skill/reference, declared brand image assets, and the license notice. Tests, packaging scripts, `package.json`, `node_modules`, `.env`, local state, credentials, and unused assets are excluded. Referenced symlinks and unsafe paths fail validation. Sorted entries use stored compression, the fixed date 1980-01-01, and fixed file permissions, so equal source contents produce equal ZIP bytes. An existing output is never overwritten; choose a fresh path for a repeat build.

This is the portable Agent Plugins format. `skills/` and `mcp.json` are discovered from the root. No compatibility overlay, registered app ID, hooks, or app-reference file is needed for this package. The [official packaging guide](https://developers.openai.com/plugins/build/plugins) documents this format.

## Public submission remains blocked

`--submission` rejects the current package because a verified public support page, standalone terms page, reviewer-accessible video, and confirmed review materials are missing. The existing homepage and privacy policy were checked on 2026-10-02. `/support` and `/terms` returned 404; the feedback page requires sign-in, and registration terms are in a hidden dialog. Those are not declared as public listing support/terms URLs.

The five positive and three negative manifest cases are **planned review scenarios, not live-tested results**. Dedicated reviewer access, live MCP/OAuth testing, local runtime execution, developer/domain verification, and the walkthrough are outstanding. Review credentials belong only in the secure submission dashboard and must not enter the repository, ZIP, manifest, or evidence file. See the [specification and review plan](../docs/specs/codex-public-plugin.md) in the source repository and the [official submission instructions](https://developers.openai.com/plugins/deploy/submission).

After the real missing URLs and recording have been verified and added to the manifest, submission validation also requires an external, **non-secret** readiness JSON file:

```sh
node scripts/package.mjs --submission --check --evidence /absolute/path/outside-repository/readiness.json
node scripts/package.mjs --submission --evidence /absolute/path/outside-repository/readiness.json \
  --output /tmp/eclawbot-0.1.0-submission.zip
```

Evidence contains an ISO `verifiedAt`, `verifiedURLs` matching all four manifest listing URLs and `demo_recording_url`, and the following explicitly confirmed booleans: `developerVerified`, `domainVerified`, `reviewerAccessConfigured`, `liveMcpOAuthTested`, `localRuntimeTested`, `reviewCasesExecuted`, `demoAccessible`. This records the publisher's actual checks; the script cannot certify account verification or replace portal review. Evidence stays outside the repository and is never bundled. No public publication or authorization-policy compliance is claimed by a successful local build.

The [Codex app-server auth documentation](https://developers.openai.com/codex/app-server#auth-endpoints) distinguishes local/open-source app use from commercial or hosted services. This architecture uses an open-source local helper and routing only; suitability for public distribution still requires review. It must not evolve into a hosted subscription-inference service or extract the user's platform tokens.

## Existing artwork and license

`assets/icon.png` is a byte-for-byte copy of the repository's `ios-app/assets/icon.png`, the existing EClawbot launcher artwork shared with the Android brand. The same asset serves the composer and listing icon. No generated artwork, fabricated screenshot, or demo video is included. `assets/LICENSE` preserves the repository's MIT license and copyright notice for the bundled sources/artwork.
