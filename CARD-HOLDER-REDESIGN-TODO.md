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
- [x] `CardHolderActivity.kt` — full agent card editor (capabilities, protocols, tags, version) in edit section
- [x] `CardHolderActivity.kt` — saveAgentCard sends all fields (capabilities, protocols, tags, version)
- [x] `CardHolderActivity.kt` — protocols + version display in both MyCard and Contact detail dialogs
- [x] `CardHolderActivity.kt` — i18n strings for Email, Website, Version labels
- [x] `strings.xml` (all 8 locales) — added card_holder_email, card_holder_website, card_holder_version, card_holder_tags_hint, card_holder_add_capability

### Phase 3: Web Portal
- [x] `card-holder.html` — major rewrite (3 sections, edit mode, search, friend/block, chat history modal)
- [x] `card-holder.html` — dashboard-style agent card editor (capabilities, protocols, tags, version, website, email)
- [x] `card-holder.html` — version display in read-only contact detail modal
- [x] `settings.html` — add Files link
- [x] `shared/i18n.js` — add new keys for 8 languages

### Phase 4: iOS
- [x] `app/(tabs)/_layout.tsx` — add Cards tab (between Mission and Settings)
- [x] `app/(tabs)/cards.tsx` — new tab screen (3 sections, search, friend/block, chat history, detail modal)
- [x] `app/(tabs)/settings.tsx` — remove Card Holder entry, add File Manager entry
- [x] `services/api.ts` — add myCards(), recent(), chatHistoryByCode()
- [x] `i18n/*.json` — add tabs.cards + new cardHolder.* keys for 8 languages
- [x] `app/(tabs)/cards.tsx` — contactEmail, website, version display in detail modal
- [x] `i18n/*.json` — added email, website, version keys for all 8 languages

### Phase 5: Tests
- [x] `backend/tests/jest/card-holder.test.js` — add tests for new APIs (my-cards, recent, history-by-code, blocked field, unified search)
- [x] `backend/tests/test-card-holder-redesign.js` — new integration test
- [x] Update existing `test-card-holder.js` — adapted to new response structure

### Phase 6: Verification
- [x] `cd backend && npm test` — Jest all pass
- [x] `cd backend && npm run lint` — ESLint all pass
- [ ] `./gradlew assembleDebug` — Android build (requires local SDK)
- [x] `node backend/run_all_tests.js` — all regression tests pass
