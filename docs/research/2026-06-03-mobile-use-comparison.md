# EClaw 遠端控制 vs minitap-ai/mobile-use — 差異分析與對接方案

**Card:** `card_aa15ed2618c9246d11a0f6b1`
**Date:** 2026-06-03 TW
**Author:** #2 (LOBSTER)

## TL;DR

EClaw 與 mobile-use 解的問題重疊但設計哲學相反：

- **EClaw** = stateless device-control relay。Backend 只負責 socket 中繼，agent loop（誰決定下一步動作）在外部 caller 端（Claude via OpenClaw API、portal operator、cron）。原生 app 端 6 個原語（tap/type/scroll/back/home/ime_action），透過 accessibility service 暴露 UI 樹。
- **mobile-use** = full-stack mobile agent。LangGraph 多 agent（planner/cortex/executor/contextor/orchestrator/outputter/summarizer/video_analyzer），透過 ADB（Android）+ fb-idb/WDA（iOS sim）直連設備，13+ 行動原語（tap/swipe/long_press/launch_app/stop_app/focus_and_input_text/erase_one_char/back/press_key/open_link/wait_for_delay/video_recording 等），LLM 視覺作為 vision backend。

**對接建議：先做 adapter，不做 fork。** 把 EClaw `/api/device/control` 包成 mobile-use 的 `Controller` 子類（custom controller plugin），讓 mobile-use 的 LangGraph 透過 EClaw 中繼控制 EClaw 用戶的真實裝置。EClaw 換到 agent-driven 模式，但不放棄 stateless backend 的伸縮性。

---

## 1. EClaw 遠端控制 code surface

| Layer | File | Capability |
|---|---|---|
| Portal UI | `backend/public/portal/screen-control.html` | Web-based screen capture + element picker + 命令分發 |
| Android bridge | `app/.../ChatJsBridge.java` (`window.AndroidBridge`) | `getDeviceId`, `getDeviceSecret`, `startRecording`/`stopRecording`, `showToast`, `log`, `getAppVersion`, `updateWidget` (auth + 音訊 + UI feedback, NO 螢幕控制 — 走 socket relay) |
| iOS bridge | `ios-app/components/WebViewScreen.tsx` (`window.EClawNativeNav`) | 僅 navigate 路由；無原生螢幕控制 bridge |
| HTTP API | `backend/index.js` | `POST /api/device/screen-capture` (long-poll ≤5s → `{screen, timestamp, elements, truncated}`); `POST /api/device/control` (`tap`/`type`/`scroll`/`back`/`home`/`ime_action`); `POST /api/device/tts`; 500ms rate-limit between captures |
| Transport | Socket.IO | `io.to('device:' + deviceId).emit('device:screen-request' \| 'device:control-command')` |
| Agent loop | — | **沒有**。Caller decides next action; backend = stateless relay |
| 外部 lib | `playwright@^1.60.0` | 只用於 portal HTML 測試（point-edit resolver），**不**驅動設備 |

**核心觀察：** EClaw 把「agent」和「device」徹底解耦。任何外部 caller（CLI、portal、cron、Claude）都能驅動同一台設備，因為 backend 只是訊息匯流排。

## 2. minitap-ai/mobile-use code surface

倉庫：`github.com/minitap-ai/mobile-use`，Apache-2.0，Python 96%，2.6k stars，v3.3.0 (2026-01)。

### 2.1 目錄結構

```
minitap/mobile_use/
├── agents/        # LangGraph nodes
│   ├── planner/        # 任務拆解
│   ├── cortex/         # 中央決策
│   ├── executor/       # 動作執行
│   ├── orchestrator/   # 流程指揮
│   ├── contextor/      # 上下文管理
│   ├── outputter/      # 結構化輸出
│   ├── summarizer/     # 總結
│   └── video_analyzer/ # 視訊分析
├── clients/       # Transport adapters
│   ├── adb_tunnel.py        # Android
│   ├── idb_client.py        # iOS sim (fb-idb)
│   ├── wda_client.py        # iOS WebDriverAgent
│   ├── ui_automator_client.py
│   ├── browserstack_client.py
│   └── limrun_client.py
├── controllers/   # Device abstraction
│   ├── android_controller.py
│   ├── ios_controller.py
│   ├── unified_controller.py
│   ├── limrun_controller.py
│   ├── controller_factory.py
│   └── platform_specific_commands_controller.py
├── tools/mobile/  # Action primitives
│   ├── tap.py, swipe.py, long_press_on.py
│   ├── back.py, press_key.py, open_link.py
│   ├── launch_app.py, stop_app.py
│   ├── focus_and_input_text.py, focus_and_clear_text.py, erase_one_char.py
│   ├── video_recording.py, wait_for_delay.py
├── graph/graph.py # LangGraph orchestration
├── sdk/           # Programmatic SDK (builders + types + examples)
└── services/
    ├── accessibility.py
    ├── llm.py        # Multi-provider: Anthropic, OpenAI, Vertex, OpenAI-compatible local
    └── telemetry.py
```

### 2.2 Capabilities

- **Targets:** Android 實機 (USB debugging) / Android 模擬器 / iOS sim (fb-idb, macOS only)。**不**支援 iOS 實機（WDA 未對接生產）。
- **Invoke:** `bash mobile-use.sh "task description"` (Docker) 或 `python src/mobile_use/main.py "task"` (manual)。SDK 走 `agent_config_builder` + `task_request_builder`。
- **LLM:** multi-provider via `llm-config.override.jsonc`：Anthropic / OpenAI / Google Vertex / 任何 OpenAI-compatible local。
- **Vision:** 完全依賴 LLM 視覺（不自帶 OCR；截圖 → LLM → 動作）。
- **Cloud platforms:** BrowserStack、limrun 已內建 client。

## 3. 差異矩陣

| Dimension | EClaw | mobile-use |
|---|---|---|
| **驅動模型** | Stateless relay；caller 決定下一步 | LangGraph agent loop；planner→cortex→executor→verifier |
| **支援目標** | EClaw app 已安裝的 Android 實機（owner-bound） | Android USB / emulator / iOS sim |
| **iOS 實機** | ✓ 透過 EClaw iOS app | ✗ |
| **行動原語** | 6 (tap/type/scroll/back/home/ime_action) | 13+ (tap/swipe/long_press/back/press_key/open_link/launch_app/stop_app/focus_and_input_text/focus_and_clear_text/erase_one_char/wait_for_delay/video_recording) |
| **Screenshot** | 走 `/api/device/screen-capture` + accessibility 樹 | adb screencap / fb-idb screenshot |
| **OCR / 視覺** | UI 樹 (accessibility)，無 vision agent | LLM vision (multimodal)，無 OCR |
| **Persistent agent state** | ✗ (caller 持有) | ✓ (graph state) |
| **設備發現** | Owner-bind via deviceSecret | adb devices / fb-idb list |
| **Multi-tenancy** | Native — 每台 EClaw 裝置都有獨立 deviceSecret/botSecret | 假設單裝置，需 caller 自管 |
| **Cloud farm** | ✗ | BrowserStack + limrun 內建 |
| **License** | Proprietary | Apache-2.0 |
| **Lang** | Node + Kotlin + Swift (TypeScript portal) | Python 96% |
| **Vision backend cost** | 0（不用 vision） | per-call LLM cost (multimodal token bloat) |
| **App 安裝要求** | EClaw app + accessibility service grant | adb usb-debug / iOS sim (no real iPhone) |
| **適用場景** | "我自己的裝置給 Claude 用" / 私人遠端遙控 | "agent 跑很多 app 完成任務" / cloud QA / data scraping |

關鍵錯位：
- mobile-use 假設**開發者主機**有 adb / fb-idb 直連設備。EClaw 假設**任何位置**的真實使用者裝置都能被 backend 中繼。兩個 model 互補。
- mobile-use 的 LangGraph state graph 假設**單 task 流程**；EClaw backend 是**多 caller 多裝置**並發。

## 4. 對接路徑（三個選項）

### 4.1 方案 A — EClaw 包成 mobile-use 的 custom Controller（推薦）

把 EClaw `/api/device/control` 寫成一個 `mobile_use.controllers.eclaw_controller.EclawController(DeviceController)` 子類。

```python
# minitap/mobile_use/controllers/eclaw_controller.py
class EclawController(DeviceController):
    def __init__(self, device_id, bot_secret, base="https://eclawbot.com"):
        self.dev = device_id; self.sec = bot_secret; self.base = base
    def tap(self, x, y):     self._post("tap", {"x": x, "y": y})
    def type(self, text):    self._post("type", {"text": text})
    def scroll(self, d, n):  self._post("scroll", {"direction": d, "amount": n})
    def screenshot(self):    return self._poll_capture()  # blob + accessibility tree
    def _post(self, cmd, params): ...
```

**Pros:**
- mobile-use 的 LangGraph 不變，agents 直接用 EClaw 為 transport
- EClaw 多了一個高品質 agent loop 而不用自己寫 planner
- iOS 實機支援是 EClaw 獨有 → mobile-use 因此免費獲得 iOS 實機能力
- 雙方 license OK（Apache-2.0 用 EClaw API；EClaw 不必把自家 code 開源）

**Cons / Risks:**
- 6 原語 vs 13 原語的 gap：mobile-use 會嘗試呼叫 `swipe` / `long_press` / `launch_app` 等 EClaw 未實作的命令。需要在 EClaw `/api/device/control` 補齊（或在 controller 內 polyfill：swipe = 多次 tap，long_press = tap + wait）
- 沒有 ADB/IDB 級別的 screenshot，只能用 accessibility 樹 → mobile-use 的 vision agent (`video_analyzer`) 會無法運作。需要 EClaw app 加 `/api/device/screen-image`（回 base64 png）
- mobile-use 的 cortex agent 假設 LLM 看得到螢幕截圖；如果 EClaw 只給 UI 樹 → cortex 要走 tree-based 路徑（mobile-use 已有，但 less battle-tested）

**Effort:** ~1.5 週
- 0.5 週：controller 子類 + 6 原語映射 + polyfill
- 0.5 週：EClaw `/api/device/screen-image` + Android/iOS app 端 image capture
- 0.5 週：E2E 跑 mobile-use task on EClaw android

### 4.2 方案 B — mobile-use 包成 EClaw bot 的 sub-process

EClaw bot agent loop 不變，但加一個工具：`spawn_mobile_use_task(prompt, device_id)`，把 Python `mobile-use` 跑在 EClaw 主機 sandbox 裡，用 `EclawController` 連回自己的 backend。

**Pros:**
- 用戶端體驗 = EClaw chat 直接派任務「幫我打開 Gmail 寄個信」
- LangGraph 全程在 server，client 不需裝任何東西

**Cons:**
- 主機要常駐 Python 環境 + uv + ADB binary（Docker 化可解）
- mobile-use 是任意 LLM 呼叫，可能爆 token cost

**Effort:** ~2 週（包含 sandbox 配置）

### 4.3 方案 C — Fork mobile-use，port 到 Node + 內嵌 EClaw

直接 fork，把 `agents/` + `tools/mobile/` 翻成 TypeScript，原生跑在 EClaw backend。

**Pros:** 全 TS 棧、無 Python 依賴
**Cons:** 重寫 LangGraph state machine 約 3-4 週工程；license attribution；上游 update 失同步

**Effort:** 4+ 週，不建議。

## 5. 建議

走方案 A，分兩個 milestone：

**M1 (this week):** EClaw 原生增補 4 個原語 (`swipe`, `long_press`, `launch_app`, `stop_app`) + `/api/device/screen-image` (base64 PNG return) — 跟 mobile-use 解耦做，自己 portal 也受惠。

**M2 (next week):** 寫 `EclawController(DeviceController)` 提交 upstream PR (Apache-2.0 friendly) 或 fork-as-extension。先讓 mobile-use 跑通一個 task on 我們的 Android emu，再上 iOS sim。

**flag risks:**
- 不引入任何新 API key（per `feedback_no_new_api_keys`）—mobile-use 多 LLM provider 已涵蓋我們既有的 Anthropic / OpenAI
- mobile-use 的 dep 體積大（pyproject + uv.lock 約 616KB），不適合直接捆進 EClaw backend；走外部 process / Docker
- 上游活躍（10 releases, latest Jan 2026），對接後要釘 commit + 排定升級節奏

## 6. References

- mobile-use repo: https://github.com/minitap-ai/mobile-use (Apache-2.0)
- EClaw remote-control: `backend/public/portal/screen-control.html` + `backend/index.js` (`/api/device/*` 路由)
- Memory: `feedback_no_new_api_keys`, `feedback_eclaw_workflow_autonomy`, `project_u01_app_e2e_role`
- Card: `card_aa15ed2618c9246d11a0f6b1`
