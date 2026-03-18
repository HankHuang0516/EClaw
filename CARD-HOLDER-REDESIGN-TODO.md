# Card Holder Redesign — COMPLETED

**Keywords**: `card-holder-redesign`, `名片夾改版`, `buzzing-strolling-turtle`
**Branch**: `claude/card-holder-redesign-zLLGT` (merged from `feat/card-holder-redesign-wip`)

---

## All Phases Complete

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
- [x] `ContactModels.kt` — Contact: added blocked, lastInteractedAt; new models
- [x] `ClawApiService.kt` — new endpoints: getMyCards, getRecentContacts, getChatHistoryByCode
- [x] `CardHolderActivity.kt` — complete rewrite (3 sections, edit mode, search/filter, friend/block, chat history)
- [x] `EntityCardAdapter.kt` — publicCodeRow hidden (moved to Card Holder)
- [x] `activity_settings.xml` — btnCardHolder → btnFileManager
- [x] `SettingsActivity.kt` — CardHolderActivity → FileManagerActivity

### Phase 3: Web Portal
- [x] `shared/nav.js` — removed Files entry from nav (moved to Settings)
- [x] `card-holder.html` — major rewrite (3 sections: My Cards, Recent, Collected; unified search; block/unblock; chat history modal)
- [x] `settings.html` — added Files link card
- [x] `shared/i18n.js` — added 27 new cardholder keys across all 8 languages

### Phase 4: iOS
- [x] `app/(tabs)/_layout.tsx` — added Cards tab (between Mission and Settings)
- [x] `app/(tabs)/cards.tsx` — new tab screen (3 sections, block/unblock, chat history)
- [x] `app/(tabs)/settings.tsx` — Card Holder → File Manager
- [x] `services/api.ts` — added myCards(), recent(), chatHistoryByCode()
- [x] `i18n/*.json` — added tabs.cards + cardHolder.* keys for 8 languages

### Phase 5: Tests
- [x] `backend/tests/jest/card-holder.test.js` — added tests for my-cards, recent, history-by-code, blocked field (19 tests, all pass)
- [x] `backend/tests/test-card-holder-redesign.js` — new integration test for redesign APIs
- [x] `backend/run_all_tests.js` — registered new test

### Phase 6: Verification
- [x] `cd backend && npm run lint` — ESLint: 0 errors, 57 warnings (pre-existing)
- [x] `cd backend && npm test` — card-holder.test.js: 19/19 pass
- [x] All iOS i18n JSON files validated
- [ ] `./gradlew assembleDebug` — requires Android SDK (not available in web environment)
