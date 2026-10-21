# Dream Buddy on the Mac's existing MiniMax Code sign-in

This integration follows Wishlist's `tools/minimax-vision-bridge/poller.mjs` and
`run-poller.sh`: the Mac claims work over HTTPS, processes it locally, then posts a
result. It opens no inbound port. Wishlist uses `mcode-tools` vision Connectors;
those Connectors do not expose a pure-text chat tool. Dream Buddy therefore uses
the official `mcode exec --mode lightweight` text entry point with the **same
existing Desktop OAuth namespace**, without copying credentials or creating a
second sign-in. The existing namespace is `~/.minimax/auth/prod/en/mcode-public`.

On 2026-10-21 an actual synthetic text probe, using that existing sign-in and
the restricted runner, answered a flying-cat dream in Traditional Chinese.
This proves the local text entry point, not production queue or mobile delivery.

## Routing and recovery

`DREAM_BUDDY_AI_PROVIDER=local-minimax` changes only `appId=dream-buddy` on
`POST /api/app-bot/chat`. Authentication, server-owned persona, eight daily
messages and signed-AdMob bonus quota remain. An official bot binding is not
required in this mode. Other apps retain their existing routing.

The older source client sends authenticated text through `/api/client/speak`.
That route adapts only source `client`, slot 0, and a persisted entity app version
beginning `dream-buddy-` to the same queue. It rejects media/attachments and text
over 2000 characters. Other devices and slots retain normal speak behavior. This
supports that known legacy contract without claiming the lost build-6 source was
recovered. For the old warm-up call, `/api/official-borrow/bind-free` owner-authenticates
the marked Dream Buddy slot and acknowledges `provider:local-minimax` with
`bindingRequired:false`; it creates or replaces no official binding. Other clients
retain the existing bind flow. The new adapter discovers `/connection` and skips
that warm-up entirely in local mode.
Both read the reply from the existing owner-authenticated chat history.

The PostgreSQL transaction reserves quota, saves the raw user message and creates
a durable job. `operationId` is a per-send UUID: replay returns the same job;
different text with the same UUID is rejected. There is at most one pending job
per device and ten globally. A recent worker heartbeat is required before accepting
new work. Offline rejection is explicit and does not consume quota. There is no
automatic switch to another provider.

The worker leases one job for 120 seconds. It runs inference once, then retries
only delivery of that same result. An expired/failed job refunds its original quota
day exactly once. Completion saves the bot message and job status in one transaction;
callback replay cannot create another reply. Jobs reference devices with cascade
deletion. Pending prompts are cleared after settlement. Existing chat history is
preserved; this migration does not implement the separate guest-erasure change.

Owner endpoints require `deviceId` in the query and `X-Device-Secret`:

- `GET /api/app-bot/inference/connection`: configured provider and worker readiness.
- `GET /api/app-bot/inference/jobs/:jobId`: owned status and remaining quota.
- `GET /api/app-bot/inference/operations/:operationId`: recover status after a lost send response.

Worker endpoints require a dedicated `Authorization: Bearer` capability:

- `POST /api/app-bot/inference/worker/heartbeat` with `{}`.
- `GET /api/app-bot/inference/worker/next`: 204 if idle, otherwise job ID, lease token and prompt.
- `POST /api/app-bot/inference/worker/jobs/:jobId/result` with
  `{leaseToken,status:"completed",reply}` or `{leaseToken,status:"failed"}`.

The owner receives status and the reply message ID, never the system prompt,
worker capability or lease token. `/api/debug/dream-buddy-inference` is owner
authenticated and mounted behind the existing production-disabled debug gate.

## Worker installation

Use Node 24–26 (excluding 23) and pin `@minimax-ai/code@0.6.12`. The currently
verified installation is under `~/.cache/hank-internal/dream-buddy-minimax-cli`.
The shell launcher reads only the dedicated Dream Buddy callback token from
Keychain service `com.hankhuang.dream-buddy.minimax-worker-token`, account
`DreamBuddyMiniMaxWorker`. Set its matching value as `DREAM_BUDDY_WORKER_TOKEN`
on the EClaw backend, through secure runtime input. Never reuse Wishlist's token,
put values in launchd/Git/logs, or copy MiniMax's auth files.

The runner uses a fresh lightweight session per job, an empty temporary workspace,
no tool schemas, explicit empty tool/skill capabilities, disabled memory/delegation,
one assistant step and bounded input/output/time. Mobile text goes through stdin,
never shell interpolation. The child does not inherit callback or API credentials.
The existing Desktop profile remains the OAuth owner; the official runtime may
save its own private session records there. No other session's conversation is
reused or supplied to a model. Temporary workspace files are removed after each run.

Start the worker before activating the backend routing flag. It advertises readiness
only after a real text self-check. Keep the Mac awake and connected for availability.
Review the worker installation and backend status together after updates; deployment
of Railway alone does not change a local worker. Stop/disable this worker or set the
provider explicitly to `official-bot` for a deliberate rollback. Never restart or
modify Wishlist's own LaunchAgents as part of this integration.

## Verification

Run the worker unit tests and `dream-buddy-inference.postgres.test.js` against an
isolated local database named `dream_buddy_inference_test...`, with
`DREAM_BUDDY_TEST_DATABASE_URL`. Never use a production database for these tests.
The mobile adapter tests cover provider discovery, skipped official onboarding,
offline rejection and recovery by operation ID without another inference.

Primary CLI behavior: [MiniMax Code](https://github.com/MiniMax-AI/minimax-code)
documents lightweight mode without tools, workspace instructions, Skills or memory;
the official `mcode-tools-host` package documents host-owned OAuth leases.
