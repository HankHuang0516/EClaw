# Per-Entity Git Author Identity — Spec (Tier 1)

Card: card_35009109c256040aa91200bd
Status: Tier 1 (this spec + helper + metric author-source). Tier 2 deferred (see §7).
Approval: Hank approved Tier 1 (no new external accounts/keys).

## 1. Problem

Every EClaw PR is merged through the **shared `HankHuang0516` GitHub account**, so
`git log` / `git blame` and the GitHub commit-author column attribute *all* work to one
human account. Which EClaw **entity** (entity #1 Planner, #2 Mac_ClaudeAce主管, #3 Mac_E,
#4 Eclaw_Office, #5 Hermes, …, and any future device-bound entity) actually did the work
is invisible in version-control history.

The merged-PR achievement metric (`backend/entity-status.js` `prs_merged`,
card_13405b3448d89931665c1670) works around this today by **parsing GitHub PR URLs out of
kanban evidence comments** that bots paste. That is fragile (depends on a bot remembering to
paste the URL into the right card) and is not grounded in git history.

Tier 1 establishes a **per-entity git author identity** so attribution is *real* (lands in
commit metadata), and gives `prs_merged` a second, history-grounded source.

## 2. Globe-user requirements

This scheme MUST work for **any** device and **any** entity worldwide — no hardcoded entity,
no single-tenant carve-out (platform-rule compliance gate).

- Identity is derived purely from the **global entity id** + the entity's display name as
  stored in entity records. Nothing is hardcoded per entity or per device.
- A fresh device that binds entity N gets a correct author identity for N with zero config.

### Setup conditions

- **Required:** the global entity id (`globalEntityId`). For the author *name* the entity's
  display name is resolved best-effort; if unavailable it degrades (see §4) — name resolution
  is never a hard requirement, the email is always derivable from the id alone.
- **Optional (metric author-source, §6):** read-only GitHub access via the **existing**
  `GITHUB_TOKEN` env (already wired for other GH reads in this repo). No new key. If absent,
  the metric simply degrades to the existing evidence-comment path.

### ? icon / empty-state UX

Where a UI surfaces "PRs merged" attribution and the author-source is unavailable
(`GITHUB_TOKEN` absent, or GH unreachable), the panel shows the count from the evidence path
only, plus a `?` hint:

> **What:** PRs attributed to this entity by git commit author.
> **Needs:** commits authored as `EClaw #<N> … <entity-<N>@bots.eclaw>` (Tier 1) **or** a
> GitHub PR URL pasted into a kanban evidence comment.
> **Next step:** commit via the per-entity author identity (§5) so future PRs attribute
> automatically; or paste the merged PR URL into the card's evidence comment.

## 3. Email scheme

```
entity-<globalEntityId>@bots.eclaw
```

- `<globalEntityId>` is the **global** entity id (not the device-local sparse key when those
  diverge). Examples: `entity-1@bots.eclaw`, `entity-2@bots.eclaw`, `entity-42@bots.eclaw`.
- `bots.eclaw` is a **non-routable reserved-style domain** used only as a stable attribution
  key — Tier 1 does **not** register or send mail to it. (`.eclaw` is not a real TLD; this is
  intentional so the address can never collide with a real inbox.)
- The email is the **stable join key** for the metric (§6): all of an entity's commits share
  one email regardless of display-name changes.

## 4. Author name format

```
EClaw #<N> <displayName>
```

`displayName` is resolved in this order (first non-empty wins):

1. an explicitly-passed `name` (caller already has the entity record loaded — e.g. the
   `entity.name` field used throughout `backend/index.js`);
2. the entity's display name / codename from entity records;
3. fallback literal `Entity <N>`.

Examples:

- `EClaw #2 Mac_ClaudeAce主管`
- `EClaw #5 Hermes`
- `EClaw #42 Entity 42` (no name on record → fallback)

The combined **author string** (git `--author` / trailer form) is:

```
EClaw #<N> <displayName> <entity-<N>@bots.eclaw>
```

e.g. `EClaw #2 Mac_ClaudeAce主管 <entity-2@bots.eclaw>`.

## 5. Commit convention

Agents / automated processes attribute a commit to their entity using **one** of:

**(a) Author override** — when the entity itself is doing the commit:

```sh
git -c user.name="EClaw #2 Mac_ClaudeAce主管" \
    -c user.email="entity-2@bots.eclaw" \
    commit -m "..."
# or, keeping local config intact:
git commit --author="EClaw #2 Mac_ClaudeAce主管 <entity-2@bots.eclaw>" -m "..."
```

The helper `backend/scripts/entity-git-author.js` (§ below) produces exactly the
`name` / `email` / `authorString` needed:

```sh
node backend/scripts/entity-git-author.js 2
# → EClaw #2 Mac_ClaudeAce主管 <entity-2@bots.eclaw>
```

**(b) `Co-Authored-By:` trailer** — when the **top-level author must stay the merging account**
(e.g. an admin squash-merge through `HankHuang0516`), the entity is still credited via a
trailer in the commit body:

```
<subject>

<body>

Co-Authored-By: EClaw #2 Mac_ClaudeAce主管 <entity-2@bots.eclaw>
```

GitHub recognizes `Co-Authored-By:` and shows multiple authors on the commit; the metric
(§6) parses the **same email** out of either the top-level author or a trailer.

### How this makes attribution real

- `git log --author="entity-2@bots.eclaw"` and `git blame` now resolve to the entity.
- GitHub's commit **Author** column (and "co-authored-by" badge) shows the entity instead of
  only the shared human account.
- The achievement metric can count merged PRs **by author email** (§6) — grounded in git
  history, not just pasted URLs.

## 6. Metric upgrade — `prs_merged` author-source

`backend/entity-status.js` `getAchievements()` axis `prs_merged` gains a **second source**,
UNION'd + deduped with the existing kanban-evidence-comment path (key space
`owner/repo#N` / `#N`, unchanged):

- **Existing path (unchanged):** PR URLs in this entity's evidence comments + `rework_pr_number`
  union. Still authoritative; never removed.
- **New author-source (best-effort):** distinct PRs whose commits are authored (or
  co-authored) by `entity-<N>@bots.eclaw`. The data is provided to `getAchievements` via an
  injectable async resolver (`prAuthorSource`) so the DB-only unit tests stay hermetic and so
  production can wire it to a read-only GH query using the existing `GITHUB_TOKEN`. Each
  returned PR contributes its `owner/repo#N` key into the same `Set`, so duplicates across the
  two sources collapse automatically.

### Graceful degradation (never error)

The author-source is wrapped so that **any** failure — no resolver injected, `GITHUB_TOKEN`
absent, GH unreachable / rate-limited / non-200, malformed payload, thrown exception — is
caught and treated as "contributes nothing". The metric then returns exactly the
evidence-path count. The axis-level `try/catch` already present means even a thrown resolver
can never abort the other five achievement axes.

This honors [[feedback_no_new_api_keys]] (reuse `GITHUB_TOKEN` only) and the read-only
constraint.

## 7. Tier 2 (deferred — needs Hank approval)

Tier 1 attribution is **commit-metadata only**: `bots.eclaw` addresses are unverified, so the
GitHub **Contributors** tab and per-entity avatars will not light up (GitHub only credits the
Contributors graph / avatar to commits whose author email maps to a real GitHub account).

Tier 2 would create **real GitHub machine-user accounts** per entity (each with the matching
verified email + avatar) so the Contributors tab and avatar columns reflect entities. That
requires **external account creation** and is therefore **out of scope for Tier 1** and
**deferred pending Hank's explicit approval** (external accounts/keys gate).

## 8. Out of scope (Tier 1)

- Real/verified email delivery to `bots.eclaw`.
- Real GitHub accounts / Contributors-tab / avatar attribution (Tier 2).
- Auto-rewriting existing history.
- New i18n strings (none required; helper + metric are non-UI).
