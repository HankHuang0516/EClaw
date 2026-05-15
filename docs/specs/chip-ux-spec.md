# Task Chip UX + Smart Cross-Tab Navigation Spec

Status: draft for #1/#2 alignment  
Owner: #1 Mac_F  
Reviewer / E2E: #2 Mac_ClaudeAce / LOBSTER  
Related card: `card_171784b25e8618bd229da7f3`  
Created: 2026-05-15

## 1. Problem

EClaw currently has task-card chips and chat references that can jump across the Chat and Mission/Task areas. The jump behavior must be smarter:

- From Mission/Task, tapping a chat quote/reference should switch through the bottom Chat tab and then focus the intended thread/message.
- From Chat, tapping a task-card link should switch through the bottom Mission/Task tab and then open the intended task card/chip.
- These cross-area jumps must not pollute the current tab's normal navigation stack.
- Task chips are gaining several actions (parent, linked previous/next, PR, chat, schedule, assignment, etc.), so the action layout must stay tidy on desktop and mobile/WebView.

## 2. Goals

1. Define a bottom-tab-first routing contract for Mission ↔ Chat jumps.
2. Preserve tab-local navigation stacks and avoid fake in-WebView tab switches that bypass native tab state.
3. Define a stable, compact task-chip action hierarchy.
4. Add deterministic parent-child and previous/next linked task navigation semantics.
5. Define an E2E matrix before implementation.

## 3. Non-goals

- No global app-navigation redesign beyond the required dispatch helper(s).
- No fuzzy inference for parent/linked tasks from titles, timestamps, or nearby cards.
- No changes to cron child-card generation unless missing `parentCardId` is discovered; that should be a separate bug card.
- No self-merge: #1-authored implementation requires #2 supervisor review and merge.

## 4. Cross-tab navigation contract

### 4.1 Route intents

Use explicit route intents instead of pushing foreign pages into the current tab stack.

Recommended conceptual API:

```ts
type CrossTabIntent =
  | {
      targetTab: 'chat';
      target: 'thread' | 'message';
      threadId?: string;
      messageId?: string;
      sourceTab: 'mission';
    }
  | {
      targetTab: 'mission';
      target: 'card';
      cardId: string;
      sourceTab: 'chat';
    };
```

Implementation may map this shape onto existing app/web/native bridge names, but the semantics must remain explicit.

### 4.2 Mission/Task → Chat

When the user is on Mission/Task and taps a chat quote/reference:

1. Dispatch a bottom-tab switch to Chat.
2. If the Chat tab is not mounted, mount it first.
3. If already mounted, focus it without reloading to avoid white-screen flash and lost scroll state.
4. Then resolve the anchor:
   - `threadId` only: open/focus the thread.
   - `threadId + messageId`: open/focus the thread and scroll to `messageId`.
   - `messageId` must be treated as a specific message anchor, not merely a thread hint.
5. Mission/Task tab back stack must remain unchanged.

### 4.3 Chat → Mission/Task

When the user is on Chat and taps a task-card link:

1. Dispatch a bottom-tab switch to Mission/Task.
2. If the Mission/Task tab is not mounted, mount it first.
3. If already mounted, focus it without reloading.
4. Open the card/chip for the explicit `cardId`.
5. Chat tab back stack and scroll/thread state must remain unchanged.

### 4.4 Native/WebView tab requirements

- On iOS WebView, tab switching must trigger the native tab controller, not a fake in-WebView tab state change.
- Android WebView should use the equivalent native/bottom-tab dispatch path when available.
- Web/desktop can use the web tab controller, but should preserve the same mount/focus/anchor ordering.

## 5. Task chip data contract

### 5.1 Parent card navigation

- Child automation chips may show a parent action only when `parentCardId` exists.
- Use `parentCardId` strictly.
- Do not parse titles/descriptions such as `[Auto] ... card_xxx` as fallback.
- If `parentCardId` is missing for cron-generated child cards, file a separate generation bug; do not patch around it in chip UI.
- Parent card status behavior:
  - Active parent: open normally.
  - Done parent: open normally; do not hide the action.
  - Archived parent: allow jump, but show a clear banner such as `此母卡已封存` / `Parent card is archived`.

### 5.2 Previous/next linked task navigation

Use an explicit schema. Acceptable options:

- `linkedPrevCardId` + `linkedNextCardId`, or
- `linkedCardIds[]` plus a stable order/index.

Rules:

- Never infer previous/next from `createdAt`, title ordering, status ordering, or visual proximity.
- First item with no previous: hide the previous chip.
- Last item with no next: hide the next chip.
- Prefer hiding absent actions over disabled grey buttons to keep the chip visually clean.

## 6. Button hierarchy and layout

### 6.1 Hierarchy

1. **Primary action**: one prominent status/action button.
   - Examples: `Start`, `Move to Review`, `Done`, `Reopen`.
   - There should be at most one primary action in the chip.
2. **Secondary chips**: compact inline actions, max 5 visible.
   - Parent card
   - Previous task
   - Next task
   - PR link
   - Chat/reference link
3. **Overflow menu (`⋮`)**: lower-frequency/admin actions.
   - Schedule
   - Reassign
   - Set reviewer
   - Archive
   - Delete

### 6.2 Mobile layout

- At 360–412px width, secondary chips should use one horizontal scroll row.
- Do not wrap secondary chips into multiple rows; multi-row wrapping makes card height unpredictable and visually noisy.
- Use clear affordance for horizontal scrolling where possible.
- Touch targets must remain WebView-safe and reachable.

### 6.3 Desktop/tablet layout

- Desktop may show more spacing, but should preserve the same hierarchy.
- Tablet (e.g. 768px) must not diverge into a different action model.

### 6.4 Labels

Suggested labels should be short and deterministic:

- Parent: `母卡` / `Parent`
- Previous: `上一張` / `Prev`
- Next: `下一張` / `Next`
- PR: `PR`
- Chat: `聊天` / `Chat`
- Overflow: `更多` / `More`

## 7. Implementation split

### PR A — Tab routing + stack sanity

Scope:

- Add/adjust cross-tab route intent helper(s).
- Mission → Chat reference handling.
- Chat → Mission task-card handling.
- Thread vs message anchor distinction.
- Native/WebView tab dispatch path.
- Mount/focus-before-anchor sequencing.

Primary risk: navigation contract / native stack isolation.

### PR B — Task chip actions + layout

Scope:

- Parent-card chip action using `parentCardId`.
- Archived-parent banner behavior.
- Previous/next linked task actions using explicit schema.
- Primary/secondary/overflow action grouping.
- Mobile horizontal secondary-chip row.

Primary risk: UI density and schema compatibility.

## 8. E2E matrix

### 8.1 Cross-tab jump cases

Run on iOS WebView, Android WebView, and Web/desktop:

1. Mission → Chat, thread-only anchor.
2. Mission → Chat, specific `messageId` anchor with scroll-to-message.
3. Chat → Mission, card/chip anchor.

Minimum platform matrix requested by #2:

- iOS + Android + Web × 2 directions = 6 core cases.
- Include message-specific anchor as an additional Mission → Chat case where fixture data allows.

### 8.2 Stack sanity

For each cross-tab jump:

1. Start in source tab with a visible nested/scroll state.
2. Trigger cross-tab jump.
3. Verify target tab opens the intended thread/message/card.
4. Press back / return according to platform convention.
5. Verify the source tab returns to its original page/scroll/detail state, not a polluted intermediate stack.

This is the primary acceptance gate for PR A.

### 8.3 Parent-child cases

1. Child card with `parentCardId`: parent action appears and opens parent.
2. Child card missing `parentCardId`: parent action hidden; no title-parsing fallback.
3. Parent archived: jump works and archived banner appears.

### 8.4 Previous/next linked cases

1. Middle card: both previous and next actions appear and open correct cards.
2. First card: previous hidden, next visible if present.
3. Last card: next hidden, previous visible if present.
4. No linked schema: both hidden.

### 8.5 Layout cases

- Mobile widths: 360px and 412px.
- Tablet/WebView-ish width: 768px.
- Desktop width.

Assertions:

- Primary action remains visible and singular.
- Secondary chips stay in one horizontal row on mobile.
- No horizontal page overflow beyond the chip row.
- Overflow menu contains admin/rare actions.
- Labels remain understandable in zh/en contexts.

## 9. Open questions before PR A

1. What native bridge/event name should WebView use for a real bottom-tab switch on iOS/Android?
2. Where is the canonical message anchor model: `threadId`, `messageId`, both, or current chat anchor object?
3. Which existing card-link schema should hold `linkedPrevCardId` / `linkedNextCardId`, or do we need a backend/API addition in PR B?
4. Do archived cards already expose enough status metadata in the card detail payload to show the parent archived banner?

## 10. Review gates

- #1 may implement after #2 accepts this spec or posts amendments.
- #1-authored PRs must be reviewed and merged by #2.
- PR A and PR B should remain separate unless #2 explicitly approves combining.
