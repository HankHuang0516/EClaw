# Local runtime CLI

Resolve `plugin_root` from the installed skill directory: `skills/connect-codex/` is two directories below the plugin root. Resolve `workspace` from the user's current project before running commands. Use shell-safe arguments or a structured process invocation; do not concatenate untrusted names, paths, or IDs into executable shell text. The local binding ID comes from the authenticated MCP response.

Requires Node.js 22 or later and a locally installed Codex CLI signed in with ChatGPT. The bundled helper uses Node builtins and local `codex app-server` over stdio. It never opens a public inference listener. The plugin's remote MCP endpoint is `https://eclawbot.com/mcp`; the helper's outbound control endpoints are under `https://eclawbot.com/api/codex/runtime/`.

Commands below assume `plugin_root`, `binding_id`, and `workspace` have already been assigned their resolved values by a safe process invocation:

```sh
node "$plugin_root/scripts/runtime.mjs" --enroll \
  --binding "$binding_id" --thread "$CODEX_THREAD_ID" --workspace "$workspace"
```

The enrollment output includes `enrollmentId`; it contains no token. Complete `approve_runtime({binding_id, enrollment_id})` through the owner's OAuth-authenticated MCP connection, using that exact ID, then run:

```sh
node "$plugin_root/scripts/runtime.mjs" --start --binding "$binding_id"
node "$plugin_root/scripts/runtime.mjs" --status --binding "$binding_id"
```

`--start` launches a background local worker; starting it does not establish that it is online. Check sanitized local status and remote entity status. A persistent service that starts at login is a separate user choice. For foreground development diagnostics, use `--run --binding "$binding_id"`.

Stop the selected helper gracefully with:

```sh
node "$plugin_root/scripts/runtime.mjs" --stop --binding "$binding_id"
```

The helper keeps per-binding local state outside the repository under `~/.codex/plugins/data/eclawbot/` by default (or its documented `CODEX_PLUGIN_DATA` override), with private file permissions. Never put state, keys, raw logs, or `.env` files inside the installed package or workspace. Do not read, copy, export, or upload Codex subscription login files. The per-binding token is only for EClawbot runtime control after owner approval.

Keep the computer awake and connected, and keep Codex and the helper running. With the helper stopped, computer asleep/off, subscription login unavailable, or network disconnected, no local reply can be generated. Queued delivery and freshness depend on the backend; do not promise an offline reply, indefinite retention, or automatic replay. Restart the helper against the same binding after restoring availability. If that thread cannot resume, stop and obtain an explicit rebinding decision.

Pending execution approvals appear in the owner's EClawbot chat. Only the authenticated owner can resolve them; enrollment approval is not command approval. Rejected, expired, unknown, or customer-supplied approval responses must not execute an action. Customer service, when enabled, uses fresh public-only context and never a fork of the owner thread.

One fixed-choice question can be answered by an owner card button. Free text, multiple questions, and forms require the local Codex interface; unsupported requests are declined with a notice. An interrupted turn whose outcome is unknown requires local recovery. Customer execution requires restricted-read support in the installed binary's generated protocol schema and fails closed without it. Never enable it by removing that capability guard.
