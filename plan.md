# Plan: Webview Static Pages for Notes

## 目標
為筆記系統增加可選的 webview 靜態頁面功能：
- Bot 可用 API 寫入/更新 HTML 靜態頁面（綁定到特定筆記）
- 筆記之間的靜態頁面可互相跳轉（內部連結 `eclaw://note/<noteId>`）
- 筆記列表顯示 webview 圖示，點擊打開全版面 webview viewer
- 全版面 viewer 上方有畫筆工具列，可在頁面上塗鴉
- 塗鴉可儲存（存為 drawing data 附加到筆記頁面）

## Step 1: Database — 新增 `note_pages` 表

在 `mission_schema.sql` 新增：
```sql
CREATE TABLE IF NOT EXISTS note_pages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id VARCHAR(64) NOT NULL,
    note_id VARCHAR(128) NOT NULL,
    html_content TEXT NOT NULL DEFAULT '',
    drawing_data TEXT DEFAULT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(device_id, note_id)
);
CREATE INDEX IF NOT EXISTS idx_note_pages_device ON note_pages(device_id);
```

在 `db.js` 的 schema init 中加入 CREATE TABLE。

## Step 2: Backend API — `mission.js` 新增 5 個端點

| Method | Path | Purpose |
|--------|------|---------|
| PUT | `/api/mission/note/page` | 寫入/更新筆記靜態頁面 HTML |
| GET | `/api/mission/note/page` | 讀取單一筆記靜態頁面 |
| GET | `/api/mission/note/pages` | 列出 device 所有有 page 的 noteId |
| DELETE | `/api/mission/note/page` | 刪除筆記靜態頁面 |
| PUT | `/api/mission/note/page/drawing` | 儲存畫筆資料 |

## Step 3: Frontend — mission.html

### 3a: Note item 顯示 webview 圖示
- `renderNoteItemHtml()` 若筆記有 page → 顯示 🌐 圖示按鈕
- 點擊圖示打開全版面 viewer

### 3b: 全版面 Webview Viewer（overlay）
- Fixed position overlay 覆蓋整個視窗
- 頂部工具列：返回、標題、畫筆 toggle、色彩/粗細、橡皮擦、清除、儲存、關閉
- `<iframe sandbox="allow-same-origin">` 顯示靜態 HTML
- 覆蓋 `<canvas>` 用於畫筆

### 3c: 畫筆 Canvas
- 透明 canvas overlay 在 iframe 之上
- 工具：自由畫筆、5 色選擇、3 級粗細、橡皮擦、清除
- 畫筆模式 toggle：開啟時 canvas 接收 pointer events，關閉時 iframe 可互動
- 儲存為 JSON strokes → PUT drawing API

### 3d: 內部連結
- `eclaw://note/<noteId>` 攔截，切換到目標筆記頁面
- 也支援 `eclaw://note-title/<TITLE>` 按標題跳轉

### 3e: 編輯筆記 dialog 新增 page 操作
- 「管理網頁」按鈕 → 打開 HTML editor (textarea)

## Step 4: Skill Template 更新
在 `eclaw-a2a-toolkit` 中新增 page API 文件

## Step 5: i18n（8 語言）
新增約 10 個 keys

## Step 6: Jest + Integration Tests

## 預計修改檔案
| File | Change |
|------|--------|
| `backend/mission_schema.sql` | Add `note_pages` table |
| `backend/db.js` | Add CREATE TABLE |
| `backend/mission.js` | Add 5 API endpoints |
| `backend/public/portal/mission.html` | Viewer overlay, canvas, note badge |
| `backend/public/shared/i18n.js` | Add i18n keys × 8 languages |
| `backend/data/skill-templates.json` | Add page API to toolkit |
| `backend/tests/jest/note-pages.test.js` | Jest tests |
| `backend/tests/test-note-pages.js` | Integration tests |
