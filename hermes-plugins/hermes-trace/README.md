# hermes-trace

Diagnostic plugin for Hermes Agent. Registers all 7 lifecycle hooks
and writes a JSONL trace of every fire to:

```
$HERMES_HOME/plugin-data/hermes-trace/trace.jsonl
```

(Default: `~/.hermes/plugin-data/hermes-trace/trace.jsonl`.)

## Why

Hermes occasionally goes silent — message arrives, no response. We don't
know which layer is at fault: brain (LLM), engine (queue), or gateway
(Docker bridge). 24h of trace data tells us.

Replay rules:

- `pre_llm_call` without `post_llm_call` -> brain hung
- `pre_gateway_dispatch` without `pre_llm_call` -> engine queue stalled
- no `pre_gateway_dispatch` for an inbound message -> bridge dead

## Deploy (hermes-bridge container)

```bash
docker cp hermes-plugins/hermes-trace hermes-bridge:/home/node/.hermes/plugins/hermes-trace
docker exec hermes-bridge bash -lc \
  'export PATH=/home/node/hermes-agent/.venv/bin:$PATH; hermes plugins enable hermes-trace'
docker restart hermes-bridge
```

## Verify

```bash
docker exec hermes-bridge bash -lc \
  'export PATH=/home/node/hermes-agent/.venv/bin:$PATH; hermes plugins list' \
  | grep hermes-trace
docker exec hermes-bridge cat /home/node/.hermes/plugin-data/hermes-trace/trace.jsonl | tail
```

Send a test message via EClaw `speakTo:[5]`; expect `pre_gateway_dispatch`
+ `pre_llm_call` + `post_llm_call` to appear within seconds.

## Slash command

In a Hermes session: `/hermes-trace status | path | tail [N] | rotate`.
