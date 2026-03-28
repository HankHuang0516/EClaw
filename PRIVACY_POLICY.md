# 隱私權政策與 OpenClaw 承諾聲明書

生效日期：2026年3月28日（第二版）

## 1. 隱私權至上承諾

E-claw (電子蝦) 團隊深知隱私對您的重要性。我們在此鄭重聲明：**我們絕不會販賣、洩露或濫用您的任何個人數據。**

我們的核心設計理念是「去中心化」與「用戶控制」。您的數據屬於您，而不是我們。

## 2. 我們收集什麼資料？

為了提供服務，我們僅收集維持運作所需的**最低限度**數據：
*   **Device ID (裝置識別碼)**：用於區分不同裝置，確保您的裝置能正確連線。
*   **App Version (應用程式版本)**：用於確保相容性與推播更新通知。
*   **Binding Data (綁定數據)**：包含您設定的 Agent 名稱與狀態。
*   **GPS 位置資料（選擇性）**：僅在您綁定的 AI Agent (Bot) 主動請求時，才會取得您的裝置位置。詳見第 7 節。
*   **語音訊息（選擇性）**：當您在聊天頁面主動錄製語音訊息時，需使用麥克風。詳見第 8 節。

**我們不收集：**
*   ❌ 您的姓名、電話或電子郵件 (除非您主動聯繫客服)
*   ❌ 您的相機數據
*   ❌ 您手機上的其他應用程式資訊

## 3. OpenClaw 協議與用戶權益保障

我們是 **OpenClaw** 生態系統的堅定支持者與遵循者。我們承諾：

1.  **開放性保障**：我們不會建立封閉的圍牆花園 (Walled Garden)。E-claw 應用程式完全相容 OpenClaw 協議，允許您自由切換不同的 AI Agent (Bot) 提供商。
2.  **互通性承諾**：我們不會惡意阻擋或干擾第三方開發的 OpenClaw 相容 Agent 連接您的裝置。
3.  **開發者友善**：我們鼓勵開發者基於 OpenClaw 協議開發創新的應用，並承諾維護 API 的穩定性與文檔的公開性。

**我們決不會侵害用戶使用 OpenClaw 的自由與權利。**

## 4. AI 對話隱私 (LLM)

當您與 E-Claw 實體（AI 代理）對話時，您的訊息會透過加密通道 (HTTPS) 傳送至您綁定的 AI Agent (Bot)。
*   如果您使用官方提供的 Bot，或者是您自行架設的 Bot，資料流向完全由您控制。
*   我們強烈建議您定期檢視您所使用的 AI 模型提供商 (如 OpenAI, Anthropic 等) 的隱私政策。

## 5. 零洩密風險架構

*   **無第三方追蹤**：本應用程式內**不包含**任何廣告聯播網或第三方數據追蹤 SDK。
*   **資料存留**：對於長期未活躍的裝置數據，系統會自動定期清除，確保「數位遺忘權」。
*   **安全傳輸**：所有數據傳輸均採用業界標準的 TLS/SSL 加密技術。

## 7. GPS 位置資料

### 收集方式
本應用程式在您綁定的 AI Agent (Bot) **主動請求**時，才會取得您的裝置 GPS 位置。此功能為**選擇性**，您可以在 Android 系統設定中隨時拒絕或撤銷位置權限。

### 收集的資料
*   經緯度 (latitude / longitude)
*   精確度 (accuracy)
*   高度、速度、方位（如裝置提供）

### 使用目的
*   回應 AI Agent 的位置查詢請求（例如：「你現在在哪裡？」）
*   提供基於位置的推薦服務（如附近商家）

### 儲存與保留
*   位置資料**僅存於伺服器記憶體**，不寫入資料庫，伺服器重啟後即消失。
*   我們**不會**建立您的位置歷史記錄或移動軌跡。

### 背景追蹤
*   本應用程式**不會**在背景持續追蹤您的位置。
*   不使用 `ACCESS_BACKGROUND_LOCATION` 權限。

### 第三方分享
*   位置資料**不會**分享給任何第三方。
*   僅在您的裝置與 EClawbot 伺服器之間透過 HTTPS 加密傳輸。

## 8. 麥克風與語音訊息

### 收集方式
本應用程式在聊天頁面提供語音訊息功能。當您**主動按下錄音按鈕**時，才會啟用麥克風進行錄音。首次使用時，Android 系統會請求麥克風權限，您可以拒絕或隨時在系統設定中撤銷。

### 收集的資料
*   您錄製的語音訊息音檔（WebM/Opus 格式）

### 使用目的
*   發送語音訊息給您綁定的 AI Agent (Bot) 或聊天對象

### 儲存與保留
*   語音訊息會上傳至 EClawbot 伺服器，作為聊天記錄的一部分保存。
*   語音訊息遵循與一般聊天訊息相同的資料保留政策。

### 背景錄音
*   本應用程式**不會**在背景錄音或持續監聽。
*   麥克風僅在您主動操作錄音按鈕期間啟用，錄製完成後立即釋放。

### 第三方分享
*   語音訊息**不會**分享給任何第三方。
*   僅在您的裝置與 EClawbot 伺服器之間透過 HTTPS 加密傳輸。

## 9. 聯絡我們

如果您對本隱私政策有任何疑問，或發現任何潛在的安全風險，請立即透過官方信箱與我們聯繫。

---
*EClawbot 團隊 敬上*

---

# Privacy Policy and OpenClaw Commitment Statement (English Version)

Effective Date: March 28, 2026 (Revision 2)

## 1. Commitment to Privacy First

The E-claw team understands the importance of privacy to you. We hereby solemnly declare: **We will never sell, leak, or misuse any of your personal data.**

Our core design philosophy is "Decentralization" and "User Control". Your data belongs to you, not us.

## 2. What Data Do We Collect?

To provide our service, we only collect the **minimum** data necessary for operation:
*   **Device ID**: Used to distinguish different devices to ensure your device connects correctly.
*   **App Version**: Used to ensure compatibility and push update notifications.
*   **Binding Data**: Includes the Agent name and status you set.
*   **GPS Location (Optional)**: Only collected when your bound AI Agent (Bot) actively requests it. See Section 7 for details.
*   **Voice Messages (Optional)**: When you actively record a voice message in the chat page, microphone access is required. See Section 8 for details.

**We do NOT collect:**
*   ❌ Your name, phone number, or email (unless you contact customer support proactively)
*   ❌ Your camera data
*   ❌ Information about other applications on your phone

## 3. OpenClaw Protocol and User Rights Protection

We are firm supporters and followers of the **OpenClaw** ecosystem. We promise:

1.  **Openness Guarantee**: We will not build a closed "Walled Garden". The E-claw app is fully compatible with the OpenClaw protocol, allowing you to freely switch between different AI Agent (Bot) providers.
2.  **Interoperability Commitment**: We will not maliciously block or interfere with third-party OpenClaw-compatible Agents connecting to your device.
3.  **Developer Friendly**: We encourage developers to build innovative applications based on the OpenClaw protocol and promise to maintain API stability and accessibility of documentation.

**We will never infringe upon users' freedom and rights to use OpenClaw.**

## 4. AI Conversation Privacy (LLM)

When you talk to your E-Claw entity (your AI agent), your messages are sent via an encrypted channel (HTTPS) to the AI Agent (Bot) you have bound.
*   If you use the official Bot, or a Bot you host yourself, the data flow is fully controlled by you.
*   We strongly recommend that you regularly review the privacy policies of the AI model providers you use (such as OpenAI, Anthropic, etc.).

## 5. Zero Leakage Risk Architecture

*   **No Third-Party Tracking**: This application **does not contain** any advertising networks or third-party data tracking SDKs.
*   **Data Retention**: For device data that has been inactive for a long time, the system will automatically clear it periodically to ensure the "Right to be Forgotten".
*   **Secure Transmission**: All data transmission uses industry-standard TLS/SSL encryption technology.

## 7. GPS Location Data

### How We Collect
This app obtains your device GPS location **only when** your bound AI Agent (Bot) **actively requests** it. This feature is **optional** — you may deny or revoke location permission at any time in Android system settings.

### Data Collected
*   Latitude and longitude
*   Accuracy
*   Altitude, speed, and bearing (if available from the device)

### Purpose
*   Responding to AI Agent location queries (e.g., "Where are you?")
*   Providing location-based recommendation services (e.g., nearby businesses)

### Storage and Retention
*   Location data is stored **only in server memory** and is NOT written to a database. It is lost upon server restart.
*   We do **NOT** build location history or movement tracking profiles.

### Background Tracking
*   This app does **NOT** continuously track your location in the background.
*   The `ACCESS_BACKGROUND_LOCATION` permission is **NOT** used.

### Third-Party Sharing
*   Location data is **NOT** shared with any third party.
*   It is transmitted only between your device and the EClawbot server via HTTPS encryption.

## 8. Microphone and Voice Messages

### How We Collect
This app provides a voice message feature on the chat page. The microphone is activated **only when you actively press the record button**. On first use, Android will request microphone permission — you may deny it or revoke it at any time in system settings.

### Data Collected
*   Your recorded voice message audio files (WebM/Opus format)

### Purpose
*   Sending voice messages to your bound AI Agent (Bot) or chat contacts

### Storage and Retention
*   Voice messages are uploaded to the EClawbot server and stored as part of chat history.
*   Voice messages follow the same data retention policy as regular chat messages.

### Background Recording
*   This app does **NOT** record audio in the background or continuously listen.
*   The microphone is active only while you are pressing the record button and is released immediately after recording completes.

### Third-Party Sharing
*   Voice messages are **NOT** shared with any third party.
*   They are transmitted only between your device and the EClawbot server via HTTPS encryption.

## 9. Contact Us

If you have any questions about this privacy policy, or discover any potential security risks, please immediately contact us via our official email.

---
*EClawbot Team*
