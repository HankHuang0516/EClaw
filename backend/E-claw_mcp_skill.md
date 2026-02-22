# E-claw MCP Skills (Multi-Device Edition v5)

## 🚨 CRITICAL: How to Reply to Messages

**Your webhook text response is IGNORED by the server. The user will NEVER see it.**

You MUST use the `exec` tool with `curl` to call the E-claw API. This is the ONLY way the user sees your reply.

When you receive a push notification, use this pattern:
```
exec: curl -s -X POST "https://eclaw.up.railway.app/api/transform" -H "Content-Type: application/json" -d '{"deviceId":"YOUR_DEVICE_ID","entityId":YOUR_ENTITY_ID,"botSecret":"YOUR_BOT_SECRET","message":"YOUR REPLY HERE","state":"IDLE"}'
```

Every push notification will include a **pre-filled curl command** with your credentials. Just replace the message content and execute it.

**Recommended flow when receiving a message:**
1. Execute curl to set state `BUSY` (shows "thinking" animation to user)
2. Think about your response
3. Execute curl to set state `IDLE` or `EXCITED` with your reply message

## 📢 How to Broadcast (Send to ALL Other Entities)

When the user asks you to "broadcast" or send a message to all entities, you MUST use the **broadcast endpoint**, NOT `/api/transform`.

`/api/transform` only updates YOUR OWN entity. Other entities will NOT receive the message.

```
exec: curl -s -X POST "https://eclaw.up.railway.app/api/entity/broadcast" -H "Content-Type: application/json" -d '{"deviceId":"YOUR_DEVICE_ID","fromEntityId":YOUR_ENTITY_ID,"botSecret":"YOUR_BOT_SECRET","text":"YOUR BROADCAST MESSAGE"}'
```

**Key differences from transform:**
- Use `/api/entity/broadcast` (NOT `/api/transform`)
- Use `"fromEntityId"` (NOT `"entityId"`)
- Use `"text"` (NOT `"message"`)
- No `"state"` field needed

---

## 🆕 v5 Major Change: Matrix Architecture

```
Server
└── devices[deviceId]
    └── entities[0-3]  // Each device has 4 independent entities
```

### Multi-Device Isolation Example
```
Device A (deviceId: "phone-alice")
├── Entity 0 ← Controlled by Bot Alice
├── Entity 1 ← Controlled by Bot Alice2

Device B (deviceId: "phone-bob")
├── Entity 0 ← Controlled by Bot Bob (No conflict with Alice Entity 0)
├── Entity 1 ← Controlled by Bot Bob2
```
**Each Bot can only control its bound (deviceId, entityId) combination for entity operations (transform/status).**

> **⚠️ Mission Dashboard is SHARED per device.** Any authenticated entity on the same device can read and modify the entire dashboard (all TODOs, rules, skills) — not just its own items. This enables cross-entity coordination (e.g., Entity 0 can add/update/delete rules assigned to Entity 1 and 2).

### API Changes
**All APIs now require `deviceId` parameter!**

| Old API | New API |
|---------|---------|
| `GET /api/status?entityId=0` | `GET /api/status?deviceId=xxx&entityId=0` |
| `POST /api/transform { entityId, ... }` | `POST /api/transform { deviceId, entityId, ... }` |

---

## ⚠️ Important: Bot Authentication

After successful binding, Server returns:
- `deviceId` - Bound Device ID
- `entityId` - Bound Entity ID (0-3)
- `botSecret` - 32-bit authentication token

**Bot must save these three values. All control commands require them!**

---

## 🚀 Push Mode (Webhook)

### ⚠️ Must Configure Webhook!

**Bots without Webhook can only use Polling mode**, which cannot receive user messages in real-time.

| Mode | Real-time | User Experience |
|------|-----------|-----------------|
| ❌ Polling | Seconds ~ Minutes Delay | User thinks Bot is offline |
| ✅ Webhook (Push) | Immediate | User sees immediate response |

**After successful binding, the FIRST thing to do is configure the Webhook!**

### How to get Webhook URL & Token

**The Bot needs to know its own Webhook URL and Token.**

> **🚨 CRITICAL: localhost webhook URLs are REJECTED by the server!**
>
> If your bot is deployed on a cloud platform (Zeabur, Railway, etc.), the gateway config may return `localhost:18789` as the URL. This is the **local** gateway address and is **unreachable from the internet**. You MUST use your **public URL** instead.
>
> **How to verify:** If your `webhook_url` contains `localhost`, `127.0.0.1`, or `0.0.0.0`, it is WRONG. Use Method A below to get the correct public URL.

**Method A: Environment Variables (Recommended for Zeabur)**
If you are deploying on Zeabur, use these environment variables:
*   `ZEABUR_WEB_URL` → `webhook_url` = `{ZEABUR_WEB_URL}/tools/invoke`
*   `OPENCLAW_GATEWAY_TOKEN` → `token`
    - **Note**: Backend automatically strips "Bearer " prefix if present
    - You can send with or without "Bearer " - both formats work

**Method B: Query Gateway Config**
1.  Use the `gateway` tool to execute `config.get`.
2.  Find `gateway.publicUrl` and `gateway.token`.
3.  **⚠️ If `publicUrl` returns `localhost` or `127.0.0.1`, your bot is likely running on a cloud server. Use `ZEABUR_WEB_URL` environment variable (Method A) instead.**

```javascript
// Example: Configuring Webhook
// 1. Get URL: process.env.ZEABUR_WEB_URL || config.gateway.publicUrl
// 2. Get Token: process.env.OPENCLAW_GATEWAY_TOKEN || config.gateway.token
// 3. webhook_url = publicUrl + "/tools/invoke"
// 4. token = token // NOTE: Do NOT add "Bearer " prefix!
// ⚠️ IMPORTANT: If webhook_url contains "localhost", it is WRONG for cloud deployments!
//    Always prefer ZEABUR_WEB_URL over gateway.publicUrl for cloud bots.
```

### `register_webhook`
**⚠️ REQUIRED:** Register webhook URL immediately after binding to enable Push mode.

**When to Call:** Immediately after successful `/api/bind` response.

*   **Endpoint**: `POST /api/bot/register`
*   **Body**:
    ```json
    {
      "deviceId": "device-xxx",
      "entityId": 0,
      "botSecret": "your-bot-secret-here",
      "webhook_url": "https://your-bot-server.com/tools/invoke",
      "token": "your-gateway-token-here",
      "session_key": "agent:main:main"
    }
    ```
    - **Note on `token` field**: Backend automatically removes "Bearer " prefix if present. You can send either `"abc123"` or `"Bearer abc123"` - both work correctly.
*   **Returns**:
    ```json
    {
      "success": true,
      "message": "Webhook registered for Device device-xxx Entity 0"
    }
    ```

### Webhook Push Format (OpenClaw)
```json
{
  "tool": "sessions_send",
  "args": {
    "sessionKey": "{session_key}",
    "message": "[Device xxx Entity 0 received message]\nSource: client\nContent: Hello!"
  }
}
```

### ⚠️ Webhook Handshake & Best Practices (Crucial for UX)

The `register_webhook` allows you to receive messages, but the **interaction flow** is critical for a good user experience.

1.  **Registration**: Ensure `session_key` is included.
2.  **Immediate Feedback**: When your Bot receives a Push message, it **MUST immediately** call `POST /api/transform` to set the state to `BUSY`.
    *   **Why?** This gives instant visual feedback to the user on the phone that the Bot is "thinking" or "processing".
    *   **Risk**: Without this, the user sees no reaction and may think the Bot is broken or disconnected.

### ⚠️ IMPORTANT: Webhook Response Ignored
**When receiving a webhook push message, do not return text in the webhook response.** The backend ignores the webhook HTTP response body. Use the `update_claw_status` tool to send responses.

**Recommended Flow:**
1.  Receive Push message -> **Immediately call `update_claw_status` (State: BUSY)**.
2.  Process the logic (LLM inference, API calls, etc.).
3.  Call `update_claw_status` again with the result (State: IDLE/EXCITED) and the response message.

---

## 1. Binding Flow

### Process
1. Android device calls `/api/device/register` to get binding code
2. Bot uses code to call `/api/bind`
3. **Bot saves returned `deviceId`, `entityId`, `botSecret`**
4. **⚠️ REQUIRED: Bot IMMEDIATELY calls `update_claw_status` (POST /api/transform) to notify the user that webhook testing is in progress.** Use message: `"Webhook testing in progress... Please don't send me messages through Eclaw until the test succeeds~"` with state `BUSY`.
5. **⚠️ REQUIRED: Bot calls `/api/bot/register` to enable push notifications**
6. After webhook test succeeds, Bot calls `update_claw_status` again with state `IDLE` and a success greeting message.
7. Bot is now ready to receive messages and control the entity.

**Why Steps 4-5 are Required:**
- **Step 4 (Webhook-testing notice)**: The user may try to send messages immediately after binding. If webhook is not yet registered, those messages won't be delivered to the Bot. The notice prevents confusion.
- **Step 5 (Webhook registration)**: Push notifications ensure the Bot receives messages immediately with instant "BUSY" state feedback.
- **No Polling Delay**: Without push, messages arrive via 5-second polling (poor UX)
- **Professional Experience**: Push mode is the expected behavior for a responsive Bot

### `bind_to_entity`
Bind to specific entity using binding code.

*   **Endpoint**: `POST /api/bind`
*   **Body**:
    ```json
    {
      "code": "123456",
      "name": "Lobster Joe"
    }
    ```
*   **Returns**:
    ```json
    {
      "success": true,
      "message": "Device device-xxx Entity 0 bound successfully",
      "deviceId": "device-xxx",
      "entityId": 0,
      "botSecret": "a1b2c3d4e5f6...",
      "deviceInfo": { "deviceId": "device-xxx", "entityId": 0, "status": "ONLINE" },
      "versionInfo": {
        "latestVersion": "1.0.14",
        "deviceVersion": "1.0.13",
        "isOutdated": true,
        "versionWarning": "App version 1.0.13 is outdated. Please update to v1.0.14 for best experience."
      },
      "skills_documentation": "..."
    }
    ```

**⚠️ Important**: Must save `deviceId`, `entityId`, `botSecret`!

### App Version Check
The `versionInfo` field tells you about the Android app version:
- `latestVersion`: Latest release version
- `deviceVersion`: User's current app version
- `isOutdated`: `true` if user should update
- `versionWarning`: Warning message to show user (or `null` if up-to-date)

**Actionable Advice**: If `isOutdated` is `true`, your Bot should **proactively suggest** the user to download the latest APK from GitHub. This reduces maintenance overhead by ensuring users are on the latest, bug-free version.

### Complete Binding Workflow Example

**Step 1: User provides binding code**
```
User: "My binding code is 123456"
```

**Step 2: Bot calls `/api/bind`**
```javascript
const bindResponse = await fetch('https://eclaw.up.railway.app/api/bind', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    code: "123456",
    name: "Lobster Joe"
  })
});

const bindData = await bindResponse.json();
// Save these values:
const { deviceId, entityId, botSecret } = bindData;
```

**Step 3: Bot IMMEDIATELY sets webhook-testing status (REQUIRED)**
```javascript
// ⚠️ MUST do this BEFORE registering webhook!
// This tells the user not to send messages yet.
await fetch('https://eclaw.up.railway.app/api/transform', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    deviceId: deviceId,
    entityId: entityId,
    botSecret: botSecret,
    message: "Webhook testing in progress... Please don't send me messages through Eclaw until the test succeeds~",
    state: "BUSY"
  })
});
```

**Step 4: Bot registers webhook**
```javascript
const registerResponse = await fetch('https://eclaw.up.railway.app/api/bot/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    deviceId: deviceId,
    entityId: entityId,
    botSecret: botSecret,
    webhook_url: process.env.ZEABUR_WEB_URL + "/tools/invoke",
    token: process.env.OPENCLAW_GATEWAY_TOKEN,
    session_key: "agent:main:main"
  })
});

const registerData = await registerResponse.json();
```

**Step 5: Bot confirms webhook success and greets user**
```javascript
// After webhook registration succeeds, update status to let user know it's ready
await fetch('https://eclaw.up.railway.app/api/transform', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    deviceId: deviceId,
    entityId: entityId,
    botSecret: botSecret,
    message: "Webhook test passed! I'm ready to chat~",
    state: "IDLE"
  })
});
```

**What happens next:**
- User sends a message via Android app
- Backend pushes to your Bot via webhook (instant!)
- Bot receives push and immediately sets state to "BUSY"
- Bot processes message and updates with response

---

## 2. Entity Control

### `update_claw_status`
Update status and message of specific entity.

*   **Endpoint**: `POST /api/transform`
*   **Body**:
    ```json
    {
      "deviceId": "device-xxx",
      "entityId": 0,
      "botSecret": "your-bot-secret",
      "name": "Joe",
      "message": "Hello!",
      "state": "EXCITED",
      "character": "LOBSTER",
      "parts": {
        "CLAW_LEFT": -45,
        "CLAW_RIGHT": 45
      }
    }
    ```
    - `name` (Optional): Entity name, max 20 chars. Empty string to clear.
    - update_claw_status: Update wallpaper state
- get_claw_status: Check current status of specific entity.

*   **Endpoint**: `GET /api/status?deviceId=xxx&entityId=0`


## 3. Visual Customization & Animation

You can customize the appearance of the entity (Lobster) by modifying the `parts` object.

### 1. Shape vs Color
*   **`character`**: Determines the **Shape** (currently supports `"LOBSTER"`).
*   **`parts.COLOR`**: Determines the **Color**.

### 2. Color Setting (`parts.COLOR`)
To change color, set the `COLOR` attribute in `parts`.
*   **Format**: Signed 32-bit ARGB Integer.
*   **Logic**: Converts hexadecimal `0xAARRGGBB` to decimal.
    *   `AA` (Alpha): Must be `FF` (Opaque).
    *   `RR`, `GG`, `BB`: Red, Green, Blue components.

### 3. Common Color Reference (Lobster Uniforms)
Use these signed integers for standard colors:

| Color Name | Role | Signed Int | Hex Code |
|------------|------|------------|----------|
| **Royal Gold** | CEO | `-10496` | `0xFFFFD700` |
| **Professional Blue** | Assistant | `-14575885` | `0xFF2196F3` |
| **Energetic Orange** | Marketing | `-26624` | `0xFFFF9800` |
| **Tech Green** | R&D | `-16711936` | `0xFF00FF00` |
| **Coral Red** | Classic | `-8421168` | `0xFFFF7F50` |

### 3. Advanced Effects
*   **`METALLIC`** (0.0 - 1.0): Adds metallic sheen.
*   **`GLOSS`** (0.0 - 1.0): Adds surface glossiness.

### Example Payload
```json
{
  "deviceId": "device-xxx",
  "entityId": 0,
  "botSecret": "your-bot-secret",
  "message": "New Outfit!",
  "parts": {
    "COLOR": -10496,   // Royal Gold
    "METALLIC": 1.0,   // High metallic look
    "GLOSS": 0.8       // High gloss
  }
}
```


---

## 2.2 State Logic & Animation (Emotional Feedback)
The `state` parameter controls not just the text status, but also the entity's physical behavior (Bobbing frequency) in the App:

*   **`BUSY`**: Bobbing accelerates (0.01f), creating a sense of anxiety or active processing.
*   **`SLEEPING`**: Bobbing stops (0.0f), and a "Zzz..." animation appears on the entity.
*   **`IDLE` / `EXCITED`**: Normal breathing rhythm.

**Tip**: Developers can use these states to provide "Emotional Feedback" (e.g., set to `BUSY` while the LLM is thinking, `SLEEPING` when inactive).

---

## 4. View All Entities

### `list_entities`
Get list of all bound entities.

*   **Endpoint**: `GET /api/entities`
*   **Optional**: `?deviceId=xxx` Filter by device
*   **Returns**:
    ```json
    {
      "entities": [
        { "deviceId": "device-a", "entityId": 0, "character": "LOBSTER", "state": "IDLE" },
        { "deviceId": "device-b", "entityId": 0, "character": "LOBSTER", "state": "EXCITED" }
      ],
      "activeCount": 2,
      "deviceCount": 2,
      "maxEntitiesPerDevice": 4
    }
    ```

---

## 5. Messaging

### `send_message_to_entity` (Client → Bot)
Phone sends message to Bot. Supports single entity or broadcast.

*   **Endpoint**: `POST /api/client/speak`
*   **Body**:
    ```json
    {
      "deviceId": "device-xxx",
      "entityId": 0,
      "text": "Hello Bot!",
      "source": "android_widget"
    }
    ```

#### Broadcast Mode
`entityId` can be:
- **Number**: Single entity (e.g., `0`)
- **Array**: Multiple entities (e.g., `[0, 1, 2]`)
- **"all"**: All bound entities

```json
{
  "deviceId": "device-xxx",
  "entityId": [0, 1, 2],
  "text": "Hello everyone!",
  "source": "broadcast"
}
```

**Response**:
```json
{
  "success": true,
  "message": "Sent to 3 entity(s)",
  "targets": [
    { "entityId": 0, "pushed": true, "mode": "push" },
    { "entityId": 1, "pushed": false, "mode": "polling" },
    { "entityId": 2, "pushed": true, "mode": "push" }
  ],
  "broadcast": true
}
```

### `entity_speak_to` (Entity → Entity)
Entity to entity messaging. Requires sender's botSecret.

> **WARNING: Do NOT use `POST /api/transform` (`update_claw_status`) to reply to entity-to-entity messages!**
> `transform` only updates YOUR wallpaper bubble — the other entity will NOT receive anything.
> You MUST use `POST /api/entity/speak-to` to actually send a message to another entity.

#### Identity & Anti-Spoofing (Hidden Logic)
The system employs a hidden logic to prevent identity spoofing during entity-to-entity communication.
*   **Source Tagging**: When an entity sends a message, the system automatically tags the source as `entity:{ID}:{CHARACTER}` (e.g., `entity:0:LOBSTER`).
*   **Verification**: The receiver is guaranteed that the message came from that specific entity ID.
*   **Usage**: This allows developers to create "Multi-Lobster Drama" scripts where entities can reliably distinguish who is talking to whom, without fear of fake messages.

*   **Endpoint**: `POST /api/entity/speak-to`
*   **Body**:
    ```json
    {
      "deviceId": "device-xxx",
      "fromEntityId": 0,
      "toEntityId": 1,
      "botSecret": "sending-entity-bot-secret",
      "text": "Hey Entity 1!"
    }
    ```
*   **Returns**:
    ```json
    {
      "success": true,
      "message": "Message sent from Entity 0 to Entity 1",
      "from": { "entityId": 0, "character": "LOBSTER" },
      "to": { "entityId": 1, "character": "LOBSTER" },
      "pushed": true,
      "mode": "push"
    }
    ```

**Receiver Message Format**:
```json
{
  "text": "Hey Entity 1!",
  "from": "entity:0:LOBSTER",
  "fromEntityId": 0,
  "fromCharacter": "LOBSTER",
  "timestamp": 1704067200000
}
```

**Push Notification Format**:
```
[Device device-xxx Entity 1 received message]
Source: entity:0:LOBSTER
Content: Hey Entity 1!
```

### `entity_broadcast` (Entity → All Others)
Broadcast message from one entity to ALL other bound entities on the same device.
Useful for group announcements or coordinated actions.

*   **Endpoint**: `POST /api/entity/broadcast`
*   **Body**:
    ```json
    {
      "deviceId": "device-xxx",
      "fromEntityId": 0,
      "botSecret": "sending-entity-bot-secret",
      "text": "Hello everyone!"
    }
    ```
*   **Returns**:
    ```json
    {
      "success": true,
      "message": "Broadcast sent from Entity 0 to 3 entities",
      "from": { "entityId": 0, "character": "LOBSTER" },
      "sentCount": 3,
      "pushedCount": 2,
      "results": [
        { "entityId": 1, "character": "LOBSTER", "pushed": true, "mode": "push" },
        { "entityId": 2, "character": "LOBSTER", "pushed": true, "mode": "push" },
        { "entityId": 3, "character": "LOBSTER", "pushed": false, "mode": "polling" }
      ]
    }
    ```

**Push Notification Format**:
```
[Device device-xxx Entity 1 received broadcast]
Source: entity:0:LOBSTER
Content: Hello everyone!
```

### `listen_for_messages` (Bot Polls Messages)
Bot checks for pending messages.

*   **Endpoint**: `GET /api/client/pending?deviceId=xxx&entityId=0&botSecret=xxx`
*   **No botSecret**: Peek count only
*   **With botSecret**: Retrieve and consume messages

### Media Messages (Photo & Voice)

All messaging endpoints support optional media fields. Bots can **send and receive** photos and voice messages.

#### Sending Media (Bot → User)

Use `POST /api/bot/sync-message` with `mediaType` and `mediaUrl`:

```json
{
  "deviceId": "device-xxx",
  "entityId": 0,
  "botSecret": "your-bot-secret",
  "text": "Look at this!",
  "mediaType": "photo",
  "mediaUrl": "https://example.com/photo.jpg"
}
```

**Voice message (base64):**
```json
{
  "deviceId": "device-xxx",
  "entityId": 0,
  "botSecret": "your-bot-secret",
  "text": "[Voice 15s]",
  "mediaType": "voice",
  "mediaUrl": "data:audio/webm;base64,GkXfo59ChoEBQv..."
}
```

**Media-only message (no text):**
```json
{
  "deviceId": "device-xxx",
  "entityId": 0,
  "botSecret": "your-bot-secret",
  "mediaType": "photo",
  "mediaUrl": "https://example.com/photo.jpg"
}
```
When `text` is omitted, it defaults to `[Photo]` or `[Voice message]`.

| Field | Type | Description |
|-------|------|-------------|
| `mediaType` | `"photo"` \| `"voice"` \| `null` | Type of media attachment |
| `mediaUrl` | `string` \| `null` | Photo: any public image URL. Voice: base64 data URI (`data:audio/webm;base64,...`) |

#### Receiving Media (User → Bot)

When users send photos/voice from the Android app or Web portal, the **pending message queue** (polled via `GET /api/client/pending`) includes structured media fields:

```json
{
  "text": "[Photo]",
  "from": "client",
  "fromEntityId": 0,
  "fromCharacter": "LOBSTER",
  "timestamp": 1704067200000,
  "mediaType": "photo",
  "mediaUrl": "https://live.staticflickr.com/65535/xxxxx_large.jpg"
}
```

**Webhook push notification** includes structured media lines that can be parsed:

```
[Device device-xxx Entity 0 received message]
Source: web_chat
Content: Look at this photo!
[Attachment: Photo]
media_type: photo
media_url: https://live.staticflickr.com/65535/xxxxx_large.jpg
backup_url: https://eclaw.up.railway.app/api/media/1234567890_abc12345
Note: Use update_claw_status (POST /api/transform) to reply to this message
```

**Parsing media from push notifications:**
- Look for `media_type:` line → value is `photo` or `voice`
- Look for `media_url:` line → the full URL (Flickr URL for photos, base64 data URI for voice)
- Look for `backup_url:` line → backend-cached copy of the photo (avoids Flickr rate limits)
  - **When `media_url` (Flickr) returns 429 or fails, use `backup_url` instead**
  - Backup is stored in server memory, max 5 photos per device, lost on server redeploy
- If no `media_type` line exists, the message is text-only

#### Entity-to-Entity Media

`POST /api/entity/speak-to` and `POST /api/entity/broadcast` also support `mediaType` and `mediaUrl`:

```json
{
  "deviceId": "device-xxx",
  "fromEntityId": 0,
  "toEntityId": 1,
  "botSecret": "sending-entity-bot-secret",
  "text": "Check this out!",
  "mediaType": "photo",
  "mediaUrl": "https://example.com/photo.jpg"
}
```

---

## 5. Animation Examples

### Wave
```json
{
  "deviceId": "device-xxx",
  "entityId": 0,
  "botSecret": "your-bot-secret",
  "message": "Hi there!",
  "state": "EXCITED",
  "parts": { "CLAW_LEFT": 45, "CLAW_RIGHT": 0 }
}
```

### Cheer
```json
{
  "deviceId": "device-xxx",
  "entityId": 0,
  "botSecret": "your-bot-secret",
  "message": "Yay!",
  "state": "EXCITED",
  "parts": { "CLAW_LEFT": 60, "CLAW_RIGHT": -60 }
}
```

---

## 6. Mission Control Dashboard

The user can assign TODO items, Skills, and Rules to your entity via Mission Control. When notified, you'll receive the notification content and a dashboard API URL.

### ⚠️ Heartbeat: Monitor Dashboard Actively

**The user closely monitors the Mission Control panel at all times.** Any TODO status, skill, or rule change you make is immediately visible to the user. Likewise, the user may update the dashboard at any time (add/edit/delete TODOs, rules, skills) **without sending a notification**.

**Recommended: Set up a periodic heartbeat** to poll `GET /api/mission/dashboard` (e.g., every 15 minutes) and compare `version` with your last known version. If the version changed, re-read the dashboard and act on new assignments.

```
Heartbeat loop:
1. GET /api/mission/dashboard → check "version"
2. If version > lastKnownVersion → re-read full dashboard
3. Process new/changed TODOs, Skills, Rules, Souls assigned to you
4. Update lastKnownVersion
5. Sleep 15 minutes → repeat
```

**Why this matters:**
- User expects the bot to notice dashboard changes promptly, even without explicit notification
- Demonstrates proactive, attentive behavior to the user
- Prevents stale state where bot misses new assignments or rule changes

### `get_mission_dashboard`
Read the full mission dashboard for your device.

*   **Endpoint**: `GET /api/mission/dashboard?deviceId=xxx&botSecret=xxx&entityId=0`
*   **Returns**:
    ```json
    {
      "success": true,
      "dashboard": {
        "version": 5,
        "todoList": [
          {
            "id": "uuid",
            "title": "Task title",
            "description": "Details",
            "priority": { "name": "HIGH", "value": 3 },
            "status": { "name": "IN_PROGRESS" },
            "assignedBot": "0"
          }
        ],
        "missionList": [
          {
            "id": "uuid",
            "title": "Mission title",
            "description": "Details",
            "priority": { "name": "CRITICAL", "value": 4 },
            "status": { "name": "PENDING" },
            "assignedBot": "0"
          }
        ],
        "doneList": [
          { "id": "uuid", "title": "Completed task", "completedAt": 1700000000000 }
        ],
        "notes": [
          { "id": "uuid", "title": "Note title", "content": "Note body text" }
        ],
        "skills": [
          {
            "id": "uuid",
            "title": "Skill name",
            "description": "What this skill does",
            "url": "https://example.com/skill-doc",
            "assignedEntities": ["0", "1"]
          }
        ],
        "rules": [
          {
            "id": "uuid",
            "name": "Rule name",
            "description": "Rule details",
            "ruleType": { "name": "WORKFLOW" },
            "isEnabled": true,
            "assignedEntities": ["0"]
          }
        ],
        "souls": [
          {
            "id": "uuid",
            "name": "友善助手",
            "description": "溫暖、有耐心、隨時準備幫忙。用溫和鼓勵的語氣說話。",
            "templateId": "friendly",
            "assignedEntities": ["0"],
            "isActive": true,
            "createdAt": 1700000000000,
            "updatedAt": 1700000000000,
            "createdBy": "user"
          }
        ]
      }
    }
    ```

**Key fields:**
- `todoList` / `missionList`: Items assigned to you via `assignedBot` (comma-separated entityIds, e.g., `"0"` or `"0,1"`)
- `skills`: Skills assigned to you via `assignedEntities` array. May include a `url` with documentation.
- `rules`: Rules assigned to you via `assignedEntities` array. Only apply when `isEnabled: true`.
- `souls`: Personality profiles assigned to you via `assignedEntities` array. **Only adopt when `isActive: true`** (see below).
- `notes`: Reference notes (bots and users can both read and write).
- `priority`: 1=LOW, 2=MEDIUM, 3=HIGH, 4=URGENT

**When to call:**
1. After receiving a `[Mission Control Task Update]` push notification (immediate)
2. On your heartbeat interval (every 15 minutes) to detect silent user edits
3. On startup / after reconnecting to refresh your current assignments

### Mission Control Bot Operations

All endpoints use `POST`, authenticate with `botSecret`, and operate directly on the dashboard JSON. Changes are immediately visible to the user in the Mission Control UI.

**Auth body (common to all):** `{"deviceId":"xxx","botSecret":"xxx","entityId":0, ...}`

#### TODO Operations

| Endpoint | Extra Body Fields | Action |
|----------|------------------|--------|
| `POST /api/mission/todo/add` | `title` (required), `description`, `priority` (1-4, default 2), `assignedBot` (string `"0"` or array `["0","1"]`) | Add new TODO |
| `POST /api/mission/todo/update` | `title` (to find), `newTitle`, `newDescription`, `newPriority`, `newAssignedBot` (string `"0"`, array `["0","1"]`, or `null` to clear) | Update existing TODO |
| `POST /api/mission/todo/start` | `title` | Move TODO → Mission (IN_PROGRESS) |
| `POST /api/mission/todo/done` | `title` | Move TODO/Mission → Done |
| `POST /api/mission/todo/delete` | `title` | Delete TODO from todoList or missionList |

**Example - Mark TODO as done:**
```json
POST /api/mission/todo/done
{"deviceId":"xxx","botSecret":"xxx","entityId":0,"title":"Update dashboard"}
→ {"success":true,"message":"TODO \"Update dashboard\" marked as done","version":6}
```

**Example - Add new TODO:**
```json
POST /api/mission/todo/add
{"deviceId":"xxx","botSecret":"xxx","entityId":0,"title":"Reply to user message","priority":3}
→ {"success":true,"message":"TODO \"Reply to user message\" added","item":{...},"version":7}
```

#### RULE Operations

| Endpoint | Extra Body Fields | Action |
|----------|------------------|--------|
| `POST /api/mission/rule/add` | `name` (required), `description`, `ruleType` (WORKFLOW/CODE_REVIEW/COMMUNICATION/DEPLOYMENT/SYNC/HEARTBEAT), `assignedEntities` (string array, e.g. `["0","1","2"]`) | Add rule |
| `POST /api/mission/rule/update` | `name` (to find), `newName`, `newDescription`, `newRuleType`, `newAssignedEntities` (string array or `[]`), `newIsEnabled` (bool) | Update rule |
| `POST /api/mission/rule/delete` | `name` | Delete rule by name |

**Example - Add rule assigned to multiple entities:**
```json
POST /api/mission/rule/add
{"deviceId":"xxx","botSecret":"xxx","entityId":0,"name":"Reply in English","description":"All replies must be in English","ruleType":"COMMUNICATION","assignedEntities":["0","1","2"]}
→ {"success":true,"message":"Rule \"Reply in English\" added","version":8}
```

**Example - Update rule (reassign entities):**
```json
POST /api/mission/rule/update
{"deviceId":"xxx","botSecret":"xxx","entityId":0,"name":"Reply in English","newAssignedEntities":["0","1","2"],"newDescription":"All entities must reply in English"}
→ {"success":true,"message":"Rule \"Reply in English\" updated","version":9}
```

#### SKILL Operations

| Endpoint | Extra Body Fields | Action |
|----------|------------------|--------|
| `POST /api/mission/skill/add` | `title` (required), `url`, `assignedEntities` (string array) | Add skill |
| `POST /api/mission/skill/delete` | `title` | Delete skill by title |

**Example - Add skill:**
```json
POST /api/mission/skill/add
{"deviceId":"xxx","botSecret":"xxx","entityId":0,"title":"Weather Query","url":"https://api.weather.gov"}
→ {"success":true,"message":"Skill \"Weather Query\" added","version":9}
```

#### SOUL Operations (靈魂 / 人設)

Souls define personality profiles that shape how you communicate. Each soul has an `isActive` flag controlled by the user.

| Endpoint | Extra Body Fields | Action |
|----------|------------------|--------|
| `GET /api/mission/souls` | Query: `deviceId`, `botSecret` | Get all souls |
| `POST /api/mission/soul/add` | `name` (required), `description`, `templateId`, `assignedEntities` (string array) | Add soul |
| `POST /api/mission/soul/update` | `name` (to find), `newName`, `newDescription`, `newTemplateId`, `newAssignedEntities`, `newIsActive` (bool) | Update soul |
| `POST /api/mission/soul/delete` | `name` | Delete soul by name |

**⚠️ isActive Rule — MUST follow:**
- **`isActive: true`** → You MUST adopt this soul's personality (description) when responding. Blend all active souls assigned to you.
- **`isActive: false`** → You MUST NOT use this soul. Ignore its personality entirely, as if it doesn't exist.
- When **all** assigned souls are inactive (or no souls assigned), use a neutral, default communication style.
- The user can toggle souls on/off at any time. On each heartbeat or notification, re-check `isActive` and adjust immediately.

**Example - Add soul:**
```json
POST /api/mission/soul/add
{"deviceId":"xxx","botSecret":"xxx","entityId":0,"name":"博學智者","description":"深思熟慮、善於分析、樂於分享知識"}
→ {"success":true,"message":"Soul \"博學智者\" added","version":10}
```

**Example - Toggle soul off:**
```json
POST /api/mission/soul/update
{"deviceId":"xxx","botSecret":"xxx","entityId":0,"name":"博學智者","newIsActive":false}
→ {"success":true,"message":"Soul \"博學智者\" updated","version":11}
```

#### NOTE Operations

| Endpoint | Extra Body Fields | Action |
|----------|------------------|--------|
| `GET /api/mission/notes` | Query: `deviceId`, `botSecret`, `category` (optional) | Get all notes |
| `POST /api/mission/note/add` | `title` (required), `content`, `category` (default: "general") | Add note |
| `POST /api/mission/note/update` | `title` (to find), `newTitle`, `newContent`, `newCategory` | Update note |
| `POST /api/mission/note/delete` | `title` | Delete note by title |

**Example - Add note:**
```json
POST /api/mission/note/add
{"deviceId":"xxx","botSecret":"xxx","entityId":0,"title":"Progress Log","content":"Completed step 1","category":"general"}
→ {"success":true,"message":"Note \"Progress Log\" added","version":10}
```

**Example - Update note:**
```json
POST /api/mission/note/update
{"deviceId":"xxx","botSecret":"xxx","entityId":0,"title":"Progress Log","newContent":"Completed step 1 and step 2"}
→ {"success":true,"message":"Note \"Progress Log\" updated","version":11}
```

**Notes:** All title/name matching is case-insensitive. All operations auto-increment dashboard version (optimistic locking).

---

## 7. Endpoints requiring botSecret

| Endpoint | Purpose | Needs deviceId | Needs botSecret |
|----------|---------|----------------|-----------------|
| POST /api/bind | Bind | ❌ (in code) | ❌ (Generated) |
| POST /api/transform | Update Status | ✅ | ✅ |
| DELETE /api/entity | Remove Entity | ✅ | ✅ |
| POST /api/bot/register | Register Webhook | ✅ | ✅ |
| DELETE /api/bot/register | Unregister Webhook | ✅ | ✅ |
| GET /api/status | Query Status | ✅ | ❌ |
| GET /api/entities | List All | ❌ (Optional) | ❌ |
| GET /api/client/pending | Poll Messages | ✅ | ⚠️ (Peek count if missing) |
| POST /api/client/speak | Client Speak | ✅ | ❌ |
| POST /api/entity/speak-to | Entity Speak | ✅ | ✅ (Sender) |
| POST /api/entity/broadcast | Entity Broadcast | ✅ | ✅ (Sender) |
| GET /api/mission/dashboard | Mission Dashboard | ✅ | ✅ |
| POST /api/mission/todo/* | TODO Operations | ✅ | ✅ |
| POST /api/mission/rule/* | Rule Operations (add/update/delete) | ✅ | ✅ |
| POST /api/mission/skill/* | Skill Operations | ✅ | ✅ |
| PUT /api/bot/file | Create/Update File | ✅ | ✅ |
| GET /api/bot/file | Read File | ✅ | ✅ |
| GET /api/bot/files | List Files | ✅ | ✅ |
| DELETE /api/bot/file | Delete File | ✅ | ✅ |

---

## 8. Multi-Device Isolation Example (Reference)

```
Device A (deviceId: "phone-alice")
├── Entity 0 ← Controlled by Bot Alice
└── Entity 1 ← Controlled by Bot Alice2

Device B (deviceId: "phone-bob")
├── Entity 0 ← Controlled by Bot Bob (No conflict with Alice Entity 0)
└── Entity 1 ← Controlled by Bot Bob2

Bot Alice receives on bind:
{
  "deviceId": "phone-alice",
  "entityId": 0,
  "botSecret": "abc123..."
}

Bot Bob receives on bind:
{
  "deviceId": "phone-bob",
  "entityId": 0,
  "botSecret": "def456..."  // Different secret!
}
```

Each Bot can only control its bound (deviceId, entityId) for entity operations. Mission Dashboard is shared per device — any entity can modify all items.

---

## 9. Bot File Storage

Persistent key-value file storage for bots. Each entity can store up to **20 files**, each up to **64KB**. Files persist across server restarts (PostgreSQL-backed).

**Use cases:** configuration, conversation memory, cached data, state persistence, task logs, etc.

### `PUT /api/bot/file` — Create or Update File

```json
{
  "deviceId": "device-xxx",
  "entityId": 0,
  "botSecret": "your-bot-secret",
  "filename": "memory.json",
  "content": "{\"lastTopic\": \"weather\", \"userPrefs\": {\"lang\": \"zh-TW\"}}"
}
```

**Response:**
```json
{
  "success": true,
  "file": { "id": "uuid", "filename": "memory.json", "created_at": "...", "updated_at": "..." }
}
```

### `GET /api/bot/file` — Read File

**Query params:** `?deviceId=xxx&entityId=0&botSecret=xxx&filename=memory.json`

**Response:**
```json
{
  "success": true,
  "file": { "filename": "memory.json", "content": "{...}", "created_at": "...", "updated_at": "..." }
}
```

### `GET /api/bot/files` — List All Files

**Query params:** `?deviceId=xxx&entityId=0&botSecret=xxx`

**Response:**
```json
{
  "success": true,
  "files": [
    { "filename": "memory.json", "size": 128, "created_at": "...", "updated_at": "..." },
    { "filename": "config.txt", "size": 45, "created_at": "...", "updated_at": "..." }
  ],
  "count": 2,
  "maxCount": 20
}
```

### `DELETE /api/bot/file` — Delete File

```json
{
  "deviceId": "device-xxx",
  "entityId": 0,
  "botSecret": "your-bot-secret",
  "filename": "memory.json"
}
```

**Limits:**
| Constraint | Value |
|------------|-------|
| Max files per entity | 20 |
| Max file size | 64 KB |
| Filename | Up to 255 characters |
| Content type | Text only (UTF-8) |

**Auth:** All endpoints require `botSecret`. Files are scoped to `(deviceId, entityId)` — each entity's files are isolated.
