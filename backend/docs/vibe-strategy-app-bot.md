# VibeEmpire strategy persona on the app-bot gateway

VibeEmpire uses the same `POST /api/app-bot/chat` gateway as Dream Buddy. Its
request has `appId: "vibe-empire"`, `personaId: "strategy-agent"`, an authenticated
`deviceId` and `deviceSecret`, a numeric `entityId`, and a `message` containing
one request marker, player-visible game context, and the player's instruction.
The gateway injects the strategy persona on the server and relays the request
to that device's bound official bot. The game server reads the bot reply through
`GET /api/chat/history`, matches the request marker, validates the proposed
strategy plan, and leaves final command execution to VibeEmpire.

The selected entity must have a current official-bot binding. This route
does not create one or call the free-bot terms or borrowing endpoints.
`GET /api/official-borrow/binding-status` can diagnose the binding with the
device credential. VibeEmpire accepts an existing personal binding even though
its free-binding reuse status is `binding_reuse_disabled`.

The VibeEmpire message limit is 5,000 characters and its gateway quota is
100 messages per UTC day per device. Other app personas retain their existing
limits. The server-side persona and bot credentials are never returned in the
gateway response.
