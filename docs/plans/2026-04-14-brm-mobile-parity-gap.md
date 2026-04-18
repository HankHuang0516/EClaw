# BRM Mobile Platform Parity Gap — Plan

**Created**: 2026-04-14
**Status**: Known gap, accepted for v1.0.64 release (WebView fallback)
**Feature Parity Rule** (CLAUDE.md §9): "All user-facing features must be kept in sync between the Web Portal and the Android App."

---

## Context

Bot Rental Marketplace (BRM) shipped in backend + Web Portal between 2026-04-03 and 2026-04-14. 609 commits landed since the last Android release (v1.0.63). **Zero of them built native mobile BRM UI.**

BRM spans these Web-only pages:
- `community.html#rental` — Marketplace / listing grid
- `community.html` — Listing detail modal
- `my-rentals.html` — Contract management
- `wallet.html` — Rental ledger entries
- `/arena/*` — Interview flow for listings

**Impact**: Mobile users cannot reach core BRM flows natively. They can access via WebView but lack discoverability and mobile-optimised UX.

---

## Current State

### Android
| Surface | Status | Path to reach |
|---------|--------|---------------|
| Marketplace | ❌ no native UI | CARDS bottom-nav → `WebViewActivity` → `portal/card-holder.html?embed=1` → tap **Bot 廣場** sub-tab (iframes `community.html`). Since v1.0.74 the native `CardHolderActivity` was removed. |
| Listing detail | ❌ no native UI | Same path above |
| My Rentals | ❌ no native UI | No direct path — user must navigate WebView manually |
| Wallet rental ledger | ⚠️ shared wallet UI | Web wallet entries visible via WebView only |
| Arena interview | ❌ no native UI | No path |
| `OfficialBorrowActivity` | ✅ legacy stub ("Sold Out / request demand") | Main nav |

### iOS (React Native / Expo)
| Surface | Status | Path to reach |
|---------|--------|---------------|
| Marketplace | ⚠️ WebView wrapper at `community.tsx` | Not in tab bar — reachable only via deep link |
| Listing detail | ⚠️ Same WebView | Same |
| My Rentals | ✅ WebView wrapper at `my-rentals.tsx` | **Settings → My Rentals** ✅ |
| Wallet | ⚠️ shared via WebView | Settings → Wallet |
| Arena interview | ❌ no wrapper | No path |

iOS is ahead of Android by one visible entry point (Settings → My Rentals).

---

## Gap Summary

| Item | Web | Android | iOS |
|------|-----|---------|-----|
| BRM discoverability | ✅ | ❌ no nav entry | ⚠️ partial |
| Marketplace browse | ✅ | ⚠️ WebView buried | ⚠️ WebView (no nav entry) |
| Rent a bot | ✅ | ⚠️ WebView | ⚠️ WebView |
| View active rentals | ✅ | ⚠️ WebView | ✅ WebView wrapper |
| End contract | ✅ | ⚠️ WebView | ✅ WebView |
| Review & dispute | ✅ | ❌ | ❌ |
| Create listing (owner) | ✅ | ❌ | ❌ |
| Arena interview | ✅ | ❌ | ❌ |

---

## Accepted for v1.0.64: WebView Fallback Strategy

Ship v1.0.64 without native BRM UI. Release note messaging:

> "Bot Rental Marketplace is available via the in-app Community page (Android: Card Holder tab → Community; iOS: Settings → My Rentals). Native mobile BRM UI is planned for a future release."

### Why acceptable
- BRM backend is stable (6 hardening fixes over the past 24h)
- Web UI is feature-complete and mobile-responsive
- Mobile users can complete every BRM flow via WebView
- Blocking release on native UI delays 608 other commits of value

---

## Follow-Up Plan (post-v1.0.64)

### Phase 1 — Minimal native nav (1–2 days)
**Android**:
- Add "Marketplace" nav item in bottom nav or drawer → launch `WebViewActivity` with `https://eclawbot.com/portal/community.html?deviceId=...&deviceSecret=...`
- Add "My Rentals" entry in Settings → WebView to `my-rentals.html`

**iOS**:
- Add "Marketplace" tab or Settings entry → existing `community.tsx` wrapper
- Ensure deep-linking works from push notifications

### Phase 2 — Native listing cards & contract list (1 week)
- Native listing grid (marketplace browse) using existing `/api/rental/marketplace`
- Native "My Rentals" list using `/api/rental/my-contracts`
- Hybrid: rent-flow modal still opens WebView for complex fields

### Phase 3 — Full native BRM (2–3 weeks)
- Native listing create/edit
- Native rent flow
- Native arena interview UI
- Parity with web across all 15 sections of `2026-04-12-brm-uiux-rendering-spec.md`

---

## Tracking

- [ ] v1.0.64 ships with WebView fallback (accepted gap)
- [ ] Release notes explicitly document WebView entry points
- [ ] Create GitHub issues for Phase 1 / 2 / 3
- [ ] Update `CLAUDE.md` Feature Parity Rule with exception note for BRM until Phase 1 ships

---

## References

- BRM design: `docs/plans/2026-04-10-bot-rental-marketplace-design.md`
- BRM UIUX spec: `docs/plans/2026-04-12-brm-uiux-rendering-spec.md`
- E2E test scenarios: `docs/plans/2026-04-12-rental-e2e-test-scenarios.md`
- Feature Parity Rule: `CLAUDE.md` §9 "Feature Parity Rule"
