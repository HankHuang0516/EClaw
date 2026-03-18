# Card Holder Redesign — WIP Progress

**Keywords**: `card-holder-redesign`, `名片夾改版`, `buzzing-strolling-turtle`
**Plan file**: `~/.claude/plans/buzzing-strolling-turtle.md`
**Branch**: `feat/card-holder-redesign-wip`
**Previous conversation**: session `e40e14d7-c96c-45c8-aacd-49df0c71e05a`

---

## Completed

### Phase 1: Backend — DB Schema + API
- [x] `backend/db.js` — schema migration (blocked, last_interacted_at columns + index)
- [x] `backend/db.js` — modified getCardHolder, addCard, updateCard, searchCards, getCardByCode (new fields)
- [x] `backend/db.js` — new functions: getRecentInteractions, upsertRecentInteraction, isBlocked
- [x] `backend/db.js` — module.exports updated
- [x] `backend/index.js` — new API: `GET /api/contacts/my-cards`
- [x] `backend/index.js` — new API: `GET /api/contacts/recent`
- [x] `backend/index.js` — new API: `GET /api/chat/history-by-code`
- [x] `backend/index.js` — unified search: `GET /api/contacts/search` returns `saved` + `external`
- [x] `backend/index.js` — `PATCH /api/contacts/:publicCode` accepts `blocked` field
- [x] `backend/index.js` — cross-speak block enforcement (both entity + client handlers)
- [x] `backend/index.js` — cross-speak auto-record recent interaction (both handlers)

### Phase 2: Android
- [x] `layout_bottom_nav.xml` — FILES → CARDS (navCards, ic_contacts)
- [x] `BottomNavHelper.kt` — NavItem.FILES → NavItem.CARDS, FileManagerActivity → CardHolderActivity
- [x] `strings.xml` — added `nav_cards` + new card holder strings
- [x] New drawables: `ic_contacts.xml`, `ic_person_add.xml`, `ic_block.xml`, `ic_person_check.xml`
- [x] `ContactModels.kt` — Contact: added blocked, lastInteractedAt; new models: ExternalCardResult, MyCardEntry, MyCardsResponse, ChatHistoryMessage, ChatHistoryByCodeResponse; CardSearchResponse: added saved, external
- [x] `ClawApiService.kt` — new endpoints: getMyCards, getRecentContacts, getChatHistoryByCode
- [x] `CardHolderActivity.kt` — complete rewrite (bottom nav tab, 3 sections, edit mode, search/filter, friend/block, detail dialog with chat history)
- [x] `EntityCardAdapter.kt` — publicCodeRow hidden (moved to Card Holder)
- [x] `activity_settings.xml` — btnCardHolder → btnFileManager
- [x] `SettingsActivity.kt` — CardHolderActivity → FileManagerActivity

---

## Remaining

### Phase 3: Web Portal
- [ ] `shared/nav.js` — remove Files entry from pages array
- [ ] `card-holder.html` — major rewrite (3 sections, edit mode, search, friend/block, chat history modal)
- [ ] `settings.html` — add Files link
- [ ] `shared/i18n.js` — add new keys for 8 languages (my_cards, recent, collected, add_friend, block, chat_history, etc.)

### Phase 4: iOS
- [ ] `app/(tabs)/_layout.tsx` — add Cards tab (between Mission and Settings)
- [ ] `app/(tabs)/cards.tsx` — new tab screen (based on card-holder.tsx, enhanced with 3 sections, edit mode, friend/block, chat history)
- [ ] `app/(tabs)/settings.tsx` — remove Card Holder entry, add File Manager entry
- [ ] `services/api.ts` — add myCards(), recent(), chatHistoryByCode()
- [ ] `i18n/*.json` — add tabs.cards + new cardHolder.* keys for 8 languages

### Phase 5: Tests
- [ ] `backend/tests/jest/card-holder.test.js` — add tests for new APIs (my-cards, recent, history-by-code, blocked field, unified search)
- [ ] `backend/tests/test-card-holder-redesign.js` — new integration test (my-cards, recent, block/unblock flow, unified search, chat history)
- [ ] Update existing `test-card-holder.js` — adapt to new response structure (blocked field)

### Phase 6: Verification
- [ ] `cd backend && npm test` — Jest all pass
- [ ] `cd backend && npm run lint` — ESLint all pass
- [ ] `./gradlew assembleDebug` — Android build pass
- [ ] `node backend/run_all_tests.js` — all regression tests pass
