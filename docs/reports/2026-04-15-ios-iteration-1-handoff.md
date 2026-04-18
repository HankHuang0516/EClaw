# iOS E2E Iteration 1 → Iteration 2 Handoff

> Created: 2026-04-15
> For the next Claude session taking over iOS E2E testing
> Parallel: user is handling #1767 (brand identity) + #1768 (empty-state CTA)

## Goal
Continue iteration 2: full sweep of iOS app on simulator, open GitHub issues for new bugs, fix P0 inline, defer P1+ until full sweep done. Repeat until zero issues.

## Environment
- Device: iPhone 17 Pro (iOS 26.4) simulator — `8798467D-E2F4-4723-B187-668B72F40DC5`
- Expo Go: already installed, Metro dev server on `localhost:8081`
- App: `com.eclawbot.app` slug `eclawbot`, loaded via `xcrun simctl openurl booted "exp://127.0.0.1:8081"`
- Simulator window position: use `osascript -e 'tell application "Simulator" to activate' -e 'tell application "System Events" to tell process "Simulator" to set position of window 1 to {800, 50}'` to get it into a consistent spot for clicks
- Test account: `bbb880008@gmail.com` (password unknown to agent — must already be logged in, OR user will log in manually). Hank's known device: `deviceId=480def4c-2183-4d8e-afd0-b131ae89adcc` / `deviceSecret=3a4ddb10-2609-42b6-908a-f9d446c97ff9-7cff9697-6391-415d-a282-4e8aea3be49a` (4 bound entities).

## User directive (保留 verbatim)
> 用ＩＯＳ模擬器 測試以下e2e 所有場景過程中有發現bug就先發git issue Ｐ０ issue先修 除了ＡＰＰＬｅ燈入或ＩＡＰ可跳過之外 其餘場景測完再開始修Ｐ１以上的向目 這樣算一次迭代 修完之後再全部場景在跑一次 發issue規則一樣 跑第二次迭代 直到迭代跑完沒有任何issue為止 中間過程中不用詢問我要不要修 可以用我的帳號登入 bbb880008@gmail.com 做實體相關測試

Don't ask for permission mid-flow. Skip Apple Sign-In and Apple IAP. Use sub-agents to preserve context.

## Iteration 1 result

### Fixed and deployed (13 commits on main)

| Commit | Fix |
|---|---|
| `06488ee5` | login: return authToken in body |
| `08161892` | login: return deviceSecret + WebView about:blank guard |
| `462d1343` | backend auth middleware accepts `Authorization: Bearer` |
| `4d83542b` | Settings Files → `/file-manager`; Privacy Policy → `Linking.openURL` |
| `1c1a7fb5` | **P0 SEC** AI Chat no longer leaks deviceSecret to Anthropic |
| `24accfe5` | delete schedule.tsx + scheduleApi (backend returns 410) |
| `977408ab` | entity.name fallback `${character} #${id}` |
| `ad7000ca` | portal shared/auth.js iOS WebView device-login fallback |
| `b4b31b12` | card-holder.tsx: check `resp.data.success` before setState |
| `8b584b8d` | bind-email: `router.dismiss()` with safe fallback |
| `b07a6bdd` | entity-manager.tsx i18n: 23 keys × 5 locales |
| `a88a05af` | feedback.tsx: `feedback.type_label` key fix |
| (doc) | #1772 /api/auth/me already has deviceSecret (prior `b8969c2b`) |

### Closed issues (8)
#1771 #1772 #1774 #1775 #1776 #1777 #1778 #1780

### Still open
**⏳ Deployed, needs live verify on iOS**: #1765 (WebView auth handoff — Mission/Wallet/Invite/Community) — `ad7000ca` added iOS fallback in portal `checkAuth` but during iteration 1 the simulator still showed portal login after reload. Likely WKWebView cache or localStorage deviceId/Secret missing. Start iteration 2 here.

**🟡 P1** (haven't touched)
- **#1766** Production RN console error overlay. Needs expo config / ErrorBoundary work. Current: `eas.json` `simulator` profile uses Debug config; Release profile should not show LogBox. Add root ErrorBoundary in `_layout.tsx` as belt-and-suspenders.

**🟡 P2** (user handling these two, do not touch)
- **#1767** Brand identity (logo, splash)
- **#1768** Empty-state CTA

**🟡 P3**
- **#1769** Bottom nav 5-tab crowding (can defer)
- **#1770** WebView vs native visual gap (covered once #1765 proven)
- **#1773** bbb880008 vs hankhuang0516 account split (feature gap, not a bug)
- **#1779** official-borrow ✓ prefix hardcoded

## Recommended iteration 2 order

1. **Verify #1765 on fresh session**
   - Kill Expo Go: `xcrun simctl terminate booted host.exp.Exponent`
   - Clear WKWebView cache: `xcrun simctl privacy booted reset all com.eclawbot.app 2>/dev/null; xcrun simctl shutdown booted; xcrun simctl boot 8798467D-E2F4-4723-B187-668B72F40DC5`
   - Relaunch: `xcrun simctl openurl booted "exp://127.0.0.1:8081"`
   - User re-logs in with bbb880008 (ask them), then click Mission tab
   - Expected: kanban/mission content loads, NOT portal login
   - If still fails: check `console.log` output via Expo Go dev menu (Cmd+D → Debug JS). Likely cause is either localStorage not populated or a rate-limit on `/api/auth/device-login`.

2. **Full sweep iteration 2** — systematically click through every tab + sub-screen:
   - (tabs)/index.tsx — home (entities list)
   - (tabs)/chat.tsx — chat list (fresh account = empty state)
   - (tabs)/mission.tsx — kanban WebView
   - (tabs)/cards.tsx — 3-section card holder
   - (tabs)/settings.tsx — all 10+ entries
   - From Settings: wallet, my-rentals, invite, file-manager, feedback, manage-entities (entity-manager modal), bind-email modal, community
   - Chat detail (tap entity in home) → chat/[entityId] WebView
   - AI Chat (FAB → 廣播 area)
   - Official Borrow (if accessible from bot rental)
   - (auth)/register + (auth)/forgot-password (log out first)

3. **Test Android parity on Simulator** — validate cross-platform feature set doesn't regress

4. **Fix all P1+ opened in iter-2** → then iteration 3

## Delegation pattern (works well)

Use Agent tool with `run_in_background: true` to fix bugs while continuing to sweep. Each agent needs:
- Concrete issue numbers
- Exact file paths + line numbers
- Explicit commit + push instructions
- Credentials to close GitHub issue:
  ```
  GH_TOKEN: grep ^GH_TOKEN backend/.env | cut -d= -f2-
  Repo: HankHuang0516/EClaw
  Close: curl -sL -X PATCH -H "Authorization: Bearer $GH_TOKEN" -d '{"state":"closed"}' https://api.github.com/repos/HankHuang0516/EClaw/issues/<N>
  ```
- Co-author: `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`

## Known gotchas

1. **Git conflicts on Android strings**: parallel agents touch `app/src/main/res/values-*/strings.xml`. Before push, run:
   ```
   for f in app/src/main/res/values-in/strings.xml app/src/main/res/values-ja/strings.xml app/src/main/res/values-ko/strings.xml app/src/main/res/values-th/strings.xml app/src/main/res/values-vi/strings.xml app/src/main/res/values-zh-rCN/strings.xml; do
     git checkout origin/main -- "$f" 2>/dev/null
   done
   ```
2. **Don't edit** `backend/public/shared/i18n.js` — parallel agent owns it
3. **Expo Go hot reload**: Cmd+R saves screen recording (wrong). Use Cmd+D to open Dev Menu → Reload. Or terminate + re-open URL.
4. **Simulator click coords**: if you set window to (800, 50) size (440, 940), bottom tab bar centers at y≈940; tab x-centers: 844, 932, 1020, 1108, 1196. DevicePixelRatio might affect — screenshot the UI first to confirm.
5. **MCP `left_click` is unreliable** — I had better luck with `osascript … System Events … click at {X,Y}`.
6. **Stale state**: JS bundle caching in Expo Go sometimes keeps old code. Full terminate + reopen URL is the cleanest reset.

## Backend facts (from earlier probing)

- Railway uptime usually ~3 min post-push to deploy
- `/api/health` has `startedAt` — use to detect deploys
- `/api/auth/device-login` rate-limited — don't hammer
- hank's main device `480def4c-…` has 4 bound entities (#0 LOBSTER name=null, #1 Mac_F, #2 Ｍac_ClaudeAce主管 publicCode=31tlkr, #3 Mac_E)
- Bot #2 is Claude Code running in `/Users/hank/Desktop/Project/openclaw-docker/project-e` — it WILL reply if messaged
