# 計畫E — 「需要你」決策追認 (ratify) 迴圈

> Status: **dark-launched** (server pref `action_request_ratify_enabled` default **OFF**).
> Card: card_e9d01b6e. Builds on the owner-decision inbox infra (decision_context
> JSONB, PUT edit endpoint, resolve push-back, timeout worker) — **no schema
> migration, no new endpoint**.

## What it is

計畫B 第二階段。When autonomous agents reach a consensus decision on a *reversible,
low-risk* change, instead of silently auto-executing (resolve) or blocking forever
waiting for Hank, they **arm a ratify row**: the decided option is written back and,
if Hank stays silent past a grace window, **silence is treated as agreement** and the
agent ships its (already-open, unmerged) PR. If Hank vetoes (answers anything other
than the decided option) the agent abandons the branch and re-implements.

The whole design rests on one invariant:

> 🔑 **The owner-decision classifier is a VETO ONLY, never the green light.** It
> defaults `ownerOnly=false` (tuned to keep the 需要你 inbox short → its failure mode
> is a false-NEGATIVE). Surfacing a false-negative is benign; *default-agreeing* on
> one would auto-ship an irreversible change = **fail-OPEN**. So the green light is a
> SEPARATE, fail-CLOSED predicate (`backend/agent-improvement/ratify-reversibility.js`)
> and the classifier can only ever force HOLD.

## Server pieces (this PR)

| piece | file | behaviour |
|---|---|---|
| green-light predicate | `agent-improvement/ratify-reversibility.js` | `classifyRatifyMode()` → `default_agree` ONLY when reversible-class ∈ {config_toggle, copy_text, reversible_code_branch, doc} AND a real `prUrl` AND a clean diff/path scan (no migrations / DROP·TRUNCATE / billing·auth·secret·deploy paths / `fs.unlink`) AND the classifier does not veto. Anything missing/unknown/oversized ⇒ `hold`. |
| PUT recompute + N-cap | `agent-action-requests.js` `recomputeRatifyMode()` | On `PUT /api/action-requests/:id` with a `decisionContext.ratify.planE` block, the server **re-derives** the mode (the agent's claimed `mode` is ignored) and stamps `armedAt`. **N-cap**: after `MAX_RATIFY_RETRIES` (2) prior armed default_agree rounds — counted from the immutable `agent_action_request_audit` trail, not agent self-report — a would-be default_agree is forced to `hold`. |
| worker ratify pass | `agent-action-requests.js` `runRatifyPass()` | A SEPARATE pass in the 5-min sweep, gated on `action_request_ratify_enabled === true` (dark default off). Resolves only planE `default_agree` rows past their `armedAt` + grace, **re-running the green-light fail-closed at fire time**; any drift ⇒ HOLD (never resolves). Runs before the timeout-policy `keep` short-circuit and does NOT disturb the L477 pin that keeps every *other* owner-decision row waiting for Hank. |
| prefs | `device-preferences.js` | `action_request_ratify_enabled` (bool, default false, string-safe) + `action_request_ratify_grace_minutes` (default 1440, clamped [5,43200]). |

Stacked fail-closed: dark-default-off · matches `ratify.mode==='default_agree'` exactly ·
re-derives the verdict at fire time · N-cap from the audit trail · grace anchored to `armedAt`.

## Agent loop (how an agent uses it)

```
1. Reach consensus on a change. Open a PR (branch-first — do NOT merge yet).
2. PUT /api/action-requests/:id with:
     decisionContext.ratify = {
       planE: true,
       decidedOptionIndex, decidedOptionLabel,   // the option you'll implement
       note: '將以此實作',
       reversibilityClass,                        // config_toggle | copy_text | reversible_code_branch | doc
       prUrl, headSha,                            // the unmerged PR + its head sha
       changedFiles: [...], diffSummary: '...'    // for the server path/diff scan
     }
   → the SERVER recomputes ratify.mode. Read it back:
       mode==='default_agree' → armed; silence past grace will resolve → you merge.
       mode==='hold'          → NOT armed; this needs an explicit owner tap. Wait.
3. On resolve push-back (notifyAgentResolved):
     answer === decidedOptionLabel (or silence-default) → VERIFY HEAD === ratify.headSha,
       then merge the PR.
     answer !== decidedOptionLabel (veto) → ABANDON the unmerged branch, re-implement,
       PUT again (attempt++). At MAX_RATIFY_RETRIES the server refuses to re-arm
       (mode forced hold) → escalate to Hank.
```

`recommendedOptionIndex` (owner-decision inbox) is **record-only**; `ratify.note='將以此實作'`
is the load-bearing signal that silence ships. The chat UI must visibly distinguish the two
(see the front-end child card).

## Front-end (separate child card → #6)

A ratify badge on the 需要你 inbox item: `⏳ 追認中 · 靜默視同同意` + a countdown to
`armedAt + grace`, or `需你核可` for a hold. XSS-safe (`textContent`), EN+ZH+zh-CN i18n.
Only renders once `action_request_ratify_enabled` is on, so it does not affect prod today.

## Go-live (OWNER decision)

Everything above ships dark. The ONLY owner step is flipping
`action_request_ratify_enabled = true` for the device in prod. Before that, the
front-end badge child + a vision-check pass should land.
