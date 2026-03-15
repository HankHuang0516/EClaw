# EClaw 三平台 UI Code 審查報告

> 日期：2026-03-15
> 審查範圍：Web Portal (16 頁)、Android App (13 Activity)、iOS App (11 Screen)

---

## 總覽

| 嚴重度 | Web | Android | iOS | 說明 |
|--------|:---:|:-------:|:---:|------|
| CRITICAL | 87+ | 7+ | 15+ | 硬編碼顏色值 |
| CRITICAL | — | 1 | — | dimens.xml 幾乎為空（僅 1 筆） |
| CRITICAL | — | — | 2 | Dark mode 不相容的硬編碼白色 |
| HIGH | 12+ | 4 | 5 | border-radius 不一致 |
| HIGH | 9+ | 8+ | 10+ | padding/margin 不一致 |
| HIGH | — | 5+ | — | 觸控目標 < 48dp |
| MEDIUM | 4+ | 3 | 6 | elevation/shadow 不一致 |
| MEDIUM | ~40% | 1 | — | focus state 缺失 |
| LOW | — | 0 | 0 | landscape/tablet 支援 |

---

## 1. Web Portal 問題

### 1.1 硬編碼顏色（87+ 處）

應使用 CSS variable 但直接寫死 hex/rgba 的範例：

| 檔案 | 行號 | 值 | 建議 |
|------|------|---|------|
| `dashboard.html` | 95-102 | `#1a3a2a`, `#4ade80`, `#2d6a4a` | 定義 `--badge-channel-*` |
| `dashboard.html` | 157 | `#FFD700` | `var(--warning)` |
| `dashboard.html` | 169 | `linear-gradient(#FFD700, #FFA500)` | `var(--xp-gradient)` |
| `chat.html` | 156-170 | `#eef2ff`, `#e0e7ff`, `#334155` | light-theme 殘留，需移除 |
| `chat.html` | 208-210 | `#4CAF50`, `#F44336` | `var(--success)`, `var(--danger)` |
| `chat.html` | 227-229 | `#FF6B6B`, `#FFB6C1` | `var(--entity-lobster)`, `var(--entity-pig)` |
| `schedule.html` | 133-155 | 4 組 rgba status 顏色 | `var(--status-*)` |
| `feedback.html` | 88-116 | Bug/Feature/Question 各 2 色 | `var(--cat-*)` |
| `admin.html` | 187-204 | 多組 type badge rgba | `var(--type-*)` |
| `screen-control.html` | 102-104 | `#569cd6`, `#ce9178`, `#888` | `var(--code-*)` |

### 1.2 border-radius 不一致（12+ 種值）

CSS variable 定義 `--radius: 12px` 和 `--radius-sm: 8px`，但實際使用：

| 值 | 出現位置 |
|---|---------|
| `4px` | mission.html `.item-badge` |
| `6px` | admin.html 分頁按鈕 |
| `8px` | 多處（正確，= `--radius-sm`） |
| `10px` | dashboard `.badge-id`、schedule `.sched-entity`、admin `.type-badge` |
| `11px` | mission `.switch .slider` |
| `12px` | chat `.btn-reaction`（正確，= `--radius`） |
| `14px` | files `.time-chip` |
| `20px` | files `.filter-chip`、env-vars `.lock-btn` |

**建議**：統一為 `--radius-sm: 8px`、`--radius: 12px`、`--radius-pill: 20px` 三級。

### 1.3 padding 不一致

| 元件類型 | 值域 | 建議統一值 |
|----------|------|-----------|
| Card body | 12px-20px（mission 12px, dashboard 20px, admin 16px） | 16px |
| Dialog | 20px-24px | 24px |
| Form input | `10px 12px` ~ `10px 14px` | `10px 14px` |
| Button | `6px 10px` ~ `12px 24px` | `10px 20px` |

### 1.4 z-index 衝突

| 值 | 元件 |
|---|------|
| `100` | `.nav` |
| `200` | `.dialog-overlay`、`.notif-dropdown` |
| `300` | mission `.context-menu`、index `.terms-overlay` |

同一層級可能同時出現 → 衝突。

### 1.5 Accessibility 問題

- **Focus state 缺失**：chat `.btn-reaction`、files `.view-btn`/`.filter-chip`、dashboard `.slot-btn` 等約 40% 互動元素無 `:focus-visible`
- **觸控目標過小**：mission checkbox `16x16`（應 ≥ 44x44）、chat reaction button `32x32`
- **Notification dropdown**：固定 `width: 360px`，螢幕 < 400px 會溢出
- **無自訂 media query**：大部分頁面缺少 mobile breakpoint

### 1.6 Dark Theme 殘留

- `chat.html:156-162`：`.chat-msg.platform` 使用 light-theme 色（`#eef2ff`, `#e0e7ff`），167-170 行有 dark override 但是用不同的 class selector

---

## 2. Android App 問題

### 2.1 dimens.xml 幾乎為空（CRITICAL）

`app/src/main/res/values/dimens.xml` 只定義 1 筆 `chat_input_section_height: 180dp`。

所有 padding/margin/textSize/cornerRadius/elevation 都在 layout XML 中硬編碼，無法集中管理。

**需要新增的 design token（約 50+）**：
- padding: 4dp, 8dp, 10dp, 12dp, 16dp, 20dp, 24dp
- text: 10sp, 12sp, 14sp, 16sp, 18sp, 24sp
- radius: 8dp, 12dp, 16dp
- elevation: 0dp, 2dp, 4dp

### 2.2 硬編碼顏色

| 檔案 | 行號 | 值 | 建議 |
|------|------|---|------|
| `item_message_sent.xml` | 203 | `#AA90EE90` | `@color/success` + alpha |
| `item_mission_skill.xml` | 57 | `#6688CC` | 定義 `@color/info_blue` |
| `item_mission_rule.xml` | 76 | `#80CBC4` | 定義 `@color/teal` |
| `item_schedule.xml` | 46 | `#1A1A3E` | `@color/surface_bright` |
| `activity_feedback.xml` | 7 | `#000000` | `@color/surface_dim` |
| `item_entity_card.xml` | 136-161 | `#33FF7F50`, `#336C63FF`, `#33FF5252` | theme ripple |

### 2.3 corner-radius 不一致

| 值 | 出現位置 |
|---|---------|
| `8dp` | `item_mission.xml` card |
| `12dp` | mission_control cards、feedback cards、TextInputLayout |
| `16dp` | `item_entity_card.xml`、`activity_main.xml` addEntity card |

**建議**：統一 card 為 12dp，entity card 維持 16dp（特殊強調）。

### 2.4 elevation 不一致

| 值 | 出現位置 | 視覺效果 |
|---|---------|---------|
| `0dp` | mission_control 所有 card | 扁平 |
| `2dp` | entity_card、file_card | 輕微浮起 |
| `4dp` | main addEntity card、chat inputSection | 明顯浮起 |

Mission Control 用扁平設計，其他畫面用浮起設計 → 視覺不連貫。

### 2.5 top bar padding 不一致

| Activity | horizontal | top | bottom |
|----------|-----------|-----|--------|
| `activity_main.xml` | 16dp | 12dp | 8dp |
| `activity_mission_control.xml` | 16dp | 12dp | 8dp |
| `activity_chat.xml` | 16dp | 10dp | 10dp |
| `activity_feedback.xml` | 8dp | — | 8dp |
| `activity_settings.xml` | 16dp | — | — |

### 2.6 觸控目標 < 48dp

| 檔案 | 元件 | 尺寸 | 最低要求 |
|------|------|------|---------|
| `item_entity_card.xml` | Talk 按鈕 | 36dp | 48dp |
| `item_entity_card.xml` | Agent Card 按鈕 | 36dp | 48dp |
| `item_message_received.xml` | Play 按鈕 | 32dp | 48dp |

### 2.7 Chat top bar 顏色突兀

`activity_chat.xml:15` 使用 `@color/lobster_orange` 背景，其他 Activity 使用 `@color/surface_dim` 或無背景。Chat 畫面視覺上與其他畫面斷裂。

### 2.8 缺少 landscape/tablet layout

- 無 `layout-land/` 目錄
- 無 `layout-sw600dp/` 目錄
- `chat_input_section_height: 180dp` 在橫向模式佔過多空間

---

## 3. iOS/React Native App 問題

### 3.1 硬編碼顏色（15+ 處，CRITICAL）

| 檔案 | 行號 | 值 | 問題 |
|------|------|---|------|
| `chat.tsx` | 20 | `#FF6B6B`, `#FFB3C6` | CHARACTER_COLORS 硬編碼 |
| `EntityCard.tsx` | 15-16 | 同上 | 重複定義 |
| `chat.tsx` | 86 | `#4CAF50` | online status 硬編碼 |
| `EntityCard.tsx` | 30 | `#4CAF50` | 同上，重複 |
| `BindingCodeCard.tsx` | 124 | `'white'` | dark mode 不相容 |
| `chat/[entityId].tsx` | 54 | `'white'` | dark mode 不相容 |
| `ai-chat.tsx` | 141 | `'white'` | dark mode 不相容 |
| `chat/[entityId].tsx` | 61 | `rgba(255,255,255,0.7)` | 硬編碼 |
| `ai-chat.tsx` | 248 | `rgba(0,0,0,0.1)` | 硬編碼 |
| `official-borrow.tsx` | 123 | `#FFD700` | 金色硬編碼 |
| `schedule.tsx` | 143-145 | `#4CAF50` | status 硬編碼 |

**CHARACTER_COLORS 在兩個檔案重複定義** → 應集中到 constants。

### 3.2 border-radius 不一致（7 種值）

| 值 | 出現位置 |
|---|---------|
| `8` | feedback screenshot、file-manager grid |
| `10` | feedback removeOverlay |
| `12` | mission itemCard |
| `16` | entity-manager card、EntityCard、schedule card |
| `18` | chat bubble、ai-chat bubble |
| `20` | BindingCodeCard、official-borrow overviewCard |

**建議**：card `16`、bubble `18`、chip/pill `20`、small `8`。

### 3.3 padding/gap 不一致

| 畫面 | padding | gap | paddingBottom |
|------|---------|-----|--------------|
| Home (index) | — | — | 100 |
| Chat list | — | 8 | — |
| Mission | 16 | 8 | 100 |
| Settings | 24 | 16 | — |
| Entity Manager | 16 | 12 | 40 |
| Feedback | 20 | 8 | 40 |
| Schedule | 16 | 12 | 100 |
| Official Borrow | 16 | 12 | 40 |

`paddingBottom` 有 FAB 的頁面用 100，沒有的用 40，但不一致。

### 3.4 Dialog maxHeight 不一致

| 畫面 | maxHeight | 問題 |
|------|-----------|------|
| Home (broadcast) | 無限制 | 可能超出螢幕 |
| Mission (add todo) | `85%` | |
| Entity Manager (agent card) | 無限制 | 表單很長可能溢出 |
| Schedule (create) | `400` | 硬編碼 px |

### 3.5 SafeAreaView edges 不一致

`chat.tsx` 缺少 `edges={['bottom']}`，其他 tab 頁面都有。

### 3.6 KeyboardAvoidingView 不一致

| 畫面 | 有 | offset |
|------|:--:|--------|
| ai-chat | ✅ | 100 |
| chat/[entityId] | ✅ | 90 |
| feedback | ❌ | — |
| entity-manager | ❌ | — |
| schedule | ❌ | — |

有 TextInput 的畫面應統一加入 KeyboardAvoidingView。

### 3.7 TextInput dense 不一致

| 畫面 | dense | 問題 |
|------|:-----:|------|
| mission (add todo) | ✅ | |
| ai-chat | ✅ | |
| chat/[entityId] | ✅ | |
| entity-manager (rename) | ❌ | 比其他 input 大 |
| feedback | ❌ | 比其他 input 大 |

### 3.8 Chip 使用不一致

部分畫面用 `compact` prop（EntityCard、file-manager），部分不用（mission、feedback）。

---

## 4. 跨平台共通問題

### 4.1 Entity 角色顏色定義散落各處

| 平台 | LOBSTER 色 | PIG 色 | 定義位置 |
|------|-----------|--------|---------|
| Web | `#FF6B6B` | `#FFB6C1` | chat.html 硬編碼 |
| Android | `@color/lobster_orange` | `@color/pig_pink` | colors.xml（正確） |
| iOS | `#FF6B6B` | `#FFB3C6` | chat.tsx + EntityCard.tsx 兩處重複 |

**Web 和 iOS 的 PIG 色還不一致**：`#FFB6C1` vs `#FFB3C6`。

### 4.2 Status 顏色未統一

`#4CAF50`（success green）在三個平台都硬編碼，沒有走 theme/variable 系統。

### 4.3 spacing 系統缺乏統一規範

三個平台沒有共用的 spacing scale，各自使用不同的值：
- Web: 10px, 14px, 16px, 20px, 24px
- Android: 8dp, 10dp, 12dp, 16dp, 20dp
- iOS: 8, 12, 16, 20, 24

---

## 5. 修復優先級建議

### P0 — 立即修復（影響功能/accessibility）
1. Android 觸控目標 < 48dp（entity card 按鈕、play 按鈕）
2. Web mission checkbox 16x16 觸控目標
3. iOS SafeAreaView edges 缺失（chat.tsx）
4. iOS KeyboardAvoidingView 缺失（feedback、entity-manager、schedule）

### P1 — 高優先（視覺一致性）
5. 建立三平台 Entity 角色顏色統一定義（修正 PIG 色差異）
6. Android `dimens.xml` 補齊 50+ design token
7. Web CSS variable 統一（先處理 status badge 顏色 × 5 頁）
8. iOS 集中 CHARACTER_COLORS 到 constants 檔（消除重複）
9. 統一 card border-radius（Web 12px、Android 12dp、iOS 16）

### P2 — 中優先（polish）
10. Web focus state 補齊（約 15 個元件）
11. Android Mission Control elevation 統一（0dp → 2dp）
12. iOS dialog maxHeight 統一
13. Web dark theme 殘留清理（chat.html platform bubble）
14. Android chat top bar 顏色統一

### P3 — 低優先（nice to have）
15. Android landscape/tablet layout
16. Web responsive media query
17. iOS Chip compact prop 統一
18. Web z-index 層級重整

---

*此報告由 Claude Code 基於 code 審查自動產生，2026-03-15。*
