# Plan: AI Chat ViewModel Refactor (#248)

## Goal
Refactor `AiChatBottomSheet` to use an `AiChatViewModel` (matching `MissionViewModel` conventions), fixing 8 identified bugs in the process, and adding a regression test.

## Architecture Changes

### New File: `AiChatViewModel.kt`
- `AndroidViewModel` + `MutableStateFlow<AiChatUiState>`
- Owns: messages list, isLoading, pendingRequestId, polling/status jobs
- Handles: submit, poll, busy retry, resume pending — all in `viewModelScope`
- Persists: history to SharedPreferences (load on init, save on change)
- Survives: configuration changes (rotation), process death (via SharedPrefs restore on init)

### Modified File: `AiChatBottomSheet.kt`
- Gets ViewModel via `ViewModelProvider` (scoped to activity, shared across fragment recreation)
- Fragment becomes pure UI: observes `StateFlow`, renders messages, delegates actions to VM
- No more `lifecycleScope.launch` for business logic — only for Flow collection
- Image handling stays in Fragment (needs Context for ContentResolver)

### Data Classes (move to ViewModel file)
```kotlin
data class AiChatUiState(
    val messages: List<AiMessage> = emptyList(),
    val isLoading: Boolean = false,
    val typingText: String? = null,  // null = no typing indicator
)

data class AiMessage(
    val role: String,       // "user", "assistant", "action"
    val content: String,
    val images: List<ImageData>? = null
)

data class ImageData(val data: String, val mimeType: String)
```

Key design change: **typing indicator is a separate field in UiState**, not a fake message in the list. This eliminates all `messages.removeAll { it.role == "typing" }` race conditions.

## Bug Fixes via Architecture

| Bug | How ViewModel Fixes It |
|-----|----------------------|
| 1. Typing never clears after crash | `typingText` is null by default; on init, load history from SharedPrefs (no typing persisted) |
| 2. statusJob/pollingJob race condition | Single `viewModelScope`, sequential `typingText` updates, no parallel mutation of messages list |
| 3. Busy retry leaks countdown messages | Countdown updates `typingText` field (single source), never appends to messages |
| 4. 150s poll timeout but backend still working | Clear `pendingRequestId` on timeout; on next open, no stale resume |
| 5. Stale pending_request_id | ViewModel clears it in all terminal paths (timeout, error, success) before any throw |
| 6. Rotation SharedPrefs race | ViewModel survives rotation — no save/restore cycle needed during config change |
| 7. Image persistence missing | Images stored in `AiMessage.images` and serialized in `saveHistory()` (add images to JSON) |
| 8. Backend idle timeout 60s | Not an Android fix — separate backend change in `ai-support.js` (increase to 90s) |

## Implementation Steps

### Step 1: Create `AiChatViewModel.kt`
- UiState data class with messages, isLoading, typingText
- `init {}`: load history from SharedPrefs, resume pending if needed
- `sendMessage(text, images)`: add user msg → save → submit → poll → handle result
- `clearHistory()`: clear messages, save
- Private: `submitAndPoll()`, `savePendingRequestId()`, `loadHistory()`, `saveHistory()`
- `resolveHttpError()` moves here (no string resources — use hardcoded English strings, matching current fallback pattern)

### Step 2: Refactor `AiChatBottomSheet.kt`
- Get ViewModel: `private val viewModel by activityViewModels<AiChatViewModel>()`
- `onViewCreated`: collect `viewModel.uiState` via `repeatOnLifecycle(STARTED)`
- Remove: messages list, isLoading, statusJob, pollingJob, loadHistory, saveHistory, submitAndPoll, resumePendingIfNeeded
- Keep: initViews, setupListeners, image handling (URI → base64), renderImagePreview, adapter, markdown rendering
- `sendMessage()` → extract text/images → call `viewModel.sendMessage(text, images)`
- `clearHistory()` → call `viewModel.clearHistory()`

### Step 3: Fix image persistence in saveHistory
- Serialize `images` array in JSON: `[{"data":"...","mimeType":"..."}]`
- Deserialize in loadHistory

### Step 4: Backend idle timeout bump (ai-support.js)
- Change `IDLE_TIMEOUT_MS` from 60000 to 90000

### Step 5: Regression Test
- New file: `backend/tests/test-ai-chat-viewmodel.js`
- Tests the backend endpoints that the ViewModel calls:
  - POST /api/ai-support/chat/submit → returns requestId
  - GET /api/ai-support/chat/poll/{requestId} → returns status
  - Poll a completed request → returns response
  - Poll an expired request → returns expired
  - Rate limiting works (429 after limit)
- Register in `backend/run_all_tests.js` and CLAUDE.md

### Step 6: Jest unit test
- `backend/tests/jest/ai-support.test.js` — input validation for submit/poll endpoints

## Files Changed

| File | Action |
|------|--------|
| `app/.../ui/AiChatViewModel.kt` | **NEW** — ViewModel with StateFlow |
| `app/.../ui/AiChatBottomSheet.kt` | **MODIFY** — strip business logic, observe ViewModel |
| `backend/ai-support.js` | **MODIFY** — bump IDLE_TIMEOUT_MS to 90000 |
| `backend/tests/test-ai-chat-viewmodel.js` | **NEW** — regression test |
| `backend/tests/jest/ai-support.test.js` | **NEW** — Jest unit test |
| `backend/run_all_tests.js` | **MODIFY** — register new test |
| `CLAUDE.md` | **MODIFY** — register new test in Regression Tests table |

## Risk Assessment
- **Low risk**: ViewModel is a well-established Android pattern, matching existing `MissionViewModel` conventions
- **No API changes**: Backend endpoints unchanged (except idle timeout bump)
- **No UI changes**: Same layout XML, same visual appearance
- **Testable**: Backend endpoints independently testable; Android logic verifiable via state assertions
