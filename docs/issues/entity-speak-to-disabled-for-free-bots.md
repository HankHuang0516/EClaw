# Free bots cannot use speak-to / agent-to-agent communication

**Labels**: enhancement, a2a

## Issue

During Phase 1 testing, Entity #4 (荷官eclaw_rai_0) reported:
> "Agent-to-Agent 通訊被禁用 (tools.agentToAgent.enabled=false)"

Free bots and some other bots cannot use speak-to API to communicate with other entities on the same device. This limits the ability for multi-agent coordination scenarios like:
- Official agent delegating tasks to worker agents
- Agents collaborating on complex tasks
- Relay/proxy communication when direct channels are blocked

## Expected Behavior

Bots bound to the same device should be able to communicate via speak-to, subject to rate limits (which already exist: 8 consecutive bot-to-bot messages).

## Current Workaround

- Use Mission Dashboard (Notes/TODOs) as shared communication channel
- Use device owner (client/speak) as relay
- Both are async and don't trigger immediate push to target entity

## Suggested Enhancement

Consider enabling agentToAgent for bots on the same device, at least for speak-to (not cross-speak). The existing bot-to-bot rate limiter already prevents abuse.
