# Roadmap card mapping

`backend/public/portal/roadmap.html` shows phase / task progress for the public
roadmap. Before card_0f74c9e4941e7a350fa6f425 (Phase 4 #9 Part A) every status
was hard-coded — drift was inevitable. The page now reads **live** status from
the kanban via `/api/mission/cards`, using a small mapping file to decouple
HTML slugs from deployment-specific card IDs.

## Files

| File | Purpose |
|------|---------|
| `backend/public/portal/roadmap.html` | Hard-coded layout + `data-card-id="<slug>"` attributes on phases/tasks that have a tracked kanban card. |
| `backend/public/portal/roadmap-card-mapping.json` | Slug → kanban card ID dictionary. **Deployment-specific.** Override for your own EClaw instance. |
| Inline `injectLiveCardStatus()` at the bottom of `roadmap.html` | Pulls cards once, walks every `[data-card-id]`, swaps badge + chip in place. |

## How it works (read path)

1. `DOMContentLoaded` → `injectLiveCardStatus()`.
2. Fetch `roadmap-card-mapping.json` (same origin, no creds).
3. Read `deviceId` + `deviceSecret` from `window.currentUser` or `localStorage`
   (same pattern as `shared/auth.js`).
4. GET `/api/mission/cards?deviceId=…&deviceSecret=…&limit=300`.
5. For every `[data-card-id]` element:
   - Slug missing from JSON → small ❓ chip with tooltip "add it or remove the attribute".
   - Slug present but value is `null` → ❓ chip "no kanban card yet — set it when one exists".
   - Slug → card ID that doesn't exist on this kanban → ❓ chip "file the card or update the mapping".
   - Slug → card ID that **does** exist → swap CSS class to match `card.status`, replace badge text, append an `updated Nh ago` chip and (if the description contains a GitHub PR URL) a small `↗ PR` link.

Public visitors (no creds) silently keep the hard-coded badges — there is no
console error and no UI churn.

## Adding a new phase / task

1. Drop the live element into `roadmap.html` with a stable slug:
   ```html
   <div class="rm-phase todo" data-card-id="ooda-phase-5-something">…</div>
   <!-- or for a sub-task -->
   <li data-card-id="ooda-phase-5-something-child">…</li>
   ```
2. Add the mapping in `roadmap-card-mapping.json`:
   ```json
   "ooda-phase-5-something": "card_abcd…"
   ```
   Leave the value as `null` if no kanban card exists yet — that renders a ❓
   chip so whoever opens the page next knows to file one.
3. (Optional) drop a GitHub PR URL inside the kanban card description and the
   page will surface a clickable `↗ PR` chip on every refresh.

## Re-targeting for another deployment

Slugs are the public contract — IDs are private. Replace every card ID with one
from your own kanban (or set to `null`). The mapping file is the only thing
that needs editing; you should not need to touch `roadmap.html`.

```bash
# discover the cards in your kanban
curl "$BASE/api/mission/cards?deviceId=$DID&deviceSecret=$DSEC&limit=300" | jq '.cards[]|{id,title,status}'
```

## Status → CSS / icon mapping

| `card.status` | `rm-phase` class | `<li>` class | Badge text |
|---------------|------------------|--------------|------------|
| `done` | `done` | _(none, ✅ default)_ | Complete |
| `in_progress` | `partial` | `in_progress` (🟡) | In Progress |
| `review` | `partial` | `in_progress` (🟡) | Review |
| `blocked` | `blocked` (red rail) | `blocked` (🔒) | Blocked |
| `todo` | `todo` | `todo` (⬜) | Todo |
| `backlog` | `todo` | `todo` (⬜) | Backlog |

## Failure modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| All badges still hard-coded, no chips | Visitor not logged in, or `/api/auth/session` returned 401 | Expected for public visitors. Log in to see live state. |
| One element shows ❓ | Slug missing / `null` / card not found | Update `roadmap-card-mapping.json`. |
| Console "no deviceId/deviceSecret" | Logged in but creds not in `window.currentUser` | `auth.js` should populate them — check `loadCurrentUser()` ran before the script. |
