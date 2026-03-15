# Railway PostgreSQL 設定指南

## 📋 概述

本專案已升級至 **v5.2**，使用 PostgreSQL 作為主要資料持久化方案，並保留檔案儲存作為備援。

**優點：**
- ✅ 更穩定可靠
- ✅ 支援多實例部署
- ✅ 更好的備份/還原機制
- ✅ 可進行複雜查詢和分析
- ✅ Railway 原生支援

## 🚀 在 Railway 設定 PostgreSQL

### 步驟 1: 新增 PostgreSQL 服務

1. 登入 [Railway Dashboard](https://railway.app/)
2. 進入您的專案 (realbot)
3. 點擊 **"+ New"** 按鈕
4. 選擇 **"Database" → "Add PostgreSQL"**
5. PostgreSQL 服務會自動建立並部署

### 步驟 2: 連接到後端服務

PostgreSQL 服務建立後，Railway 會自動設定環境變數：

- `DATABASE_URL` - 完整的資料庫連接字串

**不需要手動配置！** 後端程式會自動偵測並使用此環境變數。

### 步驟 3: 驗證連接

部署完成後，查看後端服務的 Logs：

```
[Persistence] Initializing...
[DB] PostgreSQL connection established
[DB] Database tables ready
[Persistence] Using PostgreSQL (primary)
[DB] Loaded 0 devices, 0 bound entities from PostgreSQL
Claw Backend v5.2 (PostgreSQL) running on port 3000
Persistence: PostgreSQL
```

看到 `Using PostgreSQL (primary)` 表示成功！

## 📊 資料庫架構

### 資料表 1: `devices`

| 欄位 | 類型 | 說明 |
|------|------|------|
| device_id | TEXT (PK) | 裝置唯一識別碼 |
| device_secret | TEXT | 裝置金鑰 |
| created_at | BIGINT | 建立時間戳 |
| updated_at | BIGINT | 更新時間戳 |

### 資料表 2: `entities`

| 欄位 | 類型 | 說明 |
|------|------|------|
| device_id | TEXT (PK) | 裝置 ID (外鍵) |
| entity_id | INTEGER (PK) | 實體 ID (0-7) |
| bot_secret | TEXT | Bot 金鑰 |
| is_bound | BOOLEAN | 是否已綁定 |
| name | TEXT | 實體名稱 |
| character | TEXT | 角色類型 (LOBSTER/PIG) |
| state | TEXT | 狀態 (IDLE/SLEEPING/BUSY) |
| message | TEXT | 訊息內容 |
| parts | JSONB | 部件狀態 |
| battery_level | INTEGER | 電量 (0-100) |
| last_updated | BIGINT | 最後更新時間 |
| message_queue | JSONB | 訊息佇列 |
| webhook | JSONB | Webhook 設定 |
| app_version | TEXT | App 版本 |

### 索引

- `idx_entities_bound` - 加速查詢已綁定的實體

## 🔄 備援機制

如果 PostgreSQL 無法連接（例如：未設定 DATABASE_URL），系統會自動切換到檔案儲存：

```
[Persistence] Initializing...
[DB] DATABASE_URL not found. PostgreSQL persistence disabled.
[Persistence] Using file storage (fallback)
[File] No existing data file found, starting fresh
Claw Backend v5.2 (PostgreSQL) running on port 3000
Persistence: File Storage (Fallback)
```

資料會儲存到 `backend/data/devices.json`。

## 💰 費用說明

Railway PostgreSQL 有免費額度：

- **免費額度**: $5/月 (足夠小型專案使用)
- **計費方式**: 按使用量計費（CPU、記憶體、儲存空間）
- **預估成本**: 小型專案通常在免費額度內

查看用量：Railway Dashboard → 您的專案 → Usage

## 🧪 測試資料持久化

### 方法 1: 使用壓力測試

```bash
cd backend
npm run test:production
```

應該看到：
```
[Bug #2 Test] Data persistence check
✓ Entity persists after server operations
```

### 方法 2: 手動測試

```bash
# 1. 建立測試實體
npm run test:persistence

# 2. 觸發 Railway 重新部署
#    在 Railway Dashboard 點擊 "Deploy" 或推送新的 commit

# 3. 驗證資料存在
npm run test:persistence:check
```

成功的話會看到：
```
✓ SUCCESS! Entity survived server restart
Bug #2 (Data Persistence) is FIXED! 🎉
```

## 🔍 查看資料庫內容

### 使用 Railway CLI

```bash
# 安裝 Railway CLI
npm install -g @railway/cli

# 登入
railway login

# 連接到專案
railway link

# 連接到 PostgreSQL
railway run psql $DATABASE_URL

# 查詢裝置數量
SELECT COUNT(*) FROM devices;

# 查詢已綁定的實體
SELECT * FROM entities WHERE is_bound = TRUE;

# 查看所有資料表
\dt
```

### 使用 SQL 查詢

在 Railway Dashboard → PostgreSQL 服務 → Query 頁籤：

```sql
-- 查看所有裝置
SELECT * FROM devices ORDER BY created_at DESC;

-- 查看已綁定的實體
SELECT
    device_id,
    entity_id,
    name,
    character,
    state,
    is_bound
FROM entities
WHERE is_bound = TRUE;

-- 統計資料
SELECT
    COUNT(DISTINCT device_id) as total_devices,
    COUNT(*) FILTER (WHERE is_bound = TRUE) as bound_entities
FROM entities;
```

## 📝 資料備份與還原

### 手動備份

在 Railway Dashboard → PostgreSQL 服務 → Data 頁籤 → Export

### 程式化備份

```bash
# 使用 pg_dump
railway run pg_dump $DATABASE_URL > backup.sql

# 還原
railway run psql $DATABASE_URL < backup.sql
```

## 🐛 疑難排解

### 問題 1: 顯示 "File Storage (Fallback)"

**原因**: PostgreSQL 服務未正確連接

**解決方案**:
1. 確認 PostgreSQL 服務已建立並運行
2. 檢查環境變數 `DATABASE_URL` 是否存在
3. 查看 PostgreSQL 服務的 Logs 是否有錯誤

### 問題 2: "relation \"devices\" does not exist"

**原因**: 資料表未自動建立

**解決方案**:
1. 重新部署後端服務（會自動建表）
2. 或手動執行建表 SQL（在 Railway Query 頁籤）

### 問題 3: 資料在部署後消失

**原因**: 可能在使用檔案儲存模式（無 Volume）

**解決方案**:
1. 確認 PostgreSQL 已正確設定
2. 檢查 Logs 確認使用 `PostgreSQL (primary)`

## 📚 相關文件

- [PostgreSQL 官方文件](https://www.postgresql.org/docs/)
- [Railway PostgreSQL 文件](https://docs.railway.app/databases/postgresql)
- [node-postgres 文件](https://node-postgres.com/)

## ✅ 設定完成檢查清單

- [ ] Railway 上已新增 PostgreSQL 服務
- [ ] 後端服務已重新部署
- [ ] Logs 顯示 "Using PostgreSQL (primary)"
- [ ] 壓力測試通過 (`npm run test:production`)
- [ ] 資料在重新部署後仍然存在

完成以上步驟，資料持久化就設定完成了！🎉
