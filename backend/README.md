# EClawbot backend

Run `npm ci`, `npm run lint`, and `npm test` from this directory. Existing platform setup is documented in the [root README](../README.md).

The public Codex plugin control plane adds owner OAuth 2.1/PKCE, authenticated `/mcp`, and `/api/codex/runtime/*` enrollment, polling, replies and approval forwarding. PostgreSQL tables initialize with the backend; startup and requests fail closed while persistence is unavailable. Set `CODEX_PLUGIN_BASE_URL` to the exact deployed HTTPS origin and provide the existing `JWT_SECRET`; no Codex subscription credential belongs on the backend.

Use `/api/help?intent=codex_plugin` with existing bot discovery credentials for endpoint contracts. Non-production owner diagnostics are at `/api/debug/codex-plugin`; production owners use the MCP `read_codex_logs` tool. Customer responses use server-stored sender routing and customers cannot authorize Codex actions.

See the [plugin setup](../codex-plugin/README.md) and [specification](../docs/specs/codex-public-plugin.md) for local prerequisites, original-thread preservation, customer isolation, and public directory submission blockers. This development package has not been deployed or approved for public distribution.
