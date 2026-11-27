# 浪浪地圖 dot 照片 API

範圍限 King County Found animals 資料集的拾獲犬貓，以英文和華盛頓州概略區域呈現。dot 用既有 GitHub OIDC 工作負載身分。唯讀和送件各有自己的工作流程、受眾及簽章用途。每次從正式鎖定的提交建立新的執行，GitHub 自動簽發權杖，舊執行的重跑無法開通交接。舊文字回執可讀，舊文字新增入口關閉。

基礎路徑 `https://api-production-8bc1.up.railway.app/external-intake/v1`。

| 操作 | 路徑 | 回應 |
| --- | --- | --- |
| 唯讀探測 | `GET /photo-status` | `200`、`DOT_PHOTO_V1` 和 `PRIVATE_UPLOAD_V1` |
| 開通交接 | `POST /photo-handoffs/:id/open` | 送件工作簽章，`201` 開通一次交接 |
| 傳送照片和證據 | `PUT /photo-handoffs/:id/content` | 使用一次性交接證明，`202 CHECKED_PRIVATE` |
| 完成送件 | `POST /photo-handoffs/:id/commit` | 同一送件工作簽章，`201` 自動公開，`200` 原案重送 |
| 讀交接結果 | `GET /photo-handoffs/:id` | 使用一次性交接證明，傳回本次回執及結果 |
| 讀歷史回執 | `GET /photo-receipts/:id` | 唯讀工作簽章，`PUBLISHED`、`EXPIRED` 或 `WITHDRAWN` |
| 公開卡片 | `GET /photo-cards` | 僅列目前有有效在案證據的卡片 |
| 公開圖片 | `GET /photo-media/:id` | 已清除 metadata 的 JPEG。到期或撤回回 `404` |

唯讀工作的 audience 是完整 `/external-intake/v1/photo-status` URL，送件工作的 audience 是完整 `/external-intake/v1/photo-tips` URL。伺服器再核對各自的工作流程檔案、GitHub 擁有者身分、執行事件及鎖定的提交。每小時新增一件，試點總量十件。

## dot 傳送合格案件

已核實的 manifest 本機模式：

```sh
node tools/stray-map-pilot/dot-photo-client.cjs --submit-verified /private/MANIFEST.json ACTUAL_DEPLOYED_WORKFLOW_SHA
```

使用已登入的 GitHub CLI，manifest 為僅本機帳號可讀的普通檔案。程式先檢查資料、選擇新交接，再觸發新的送件工作。GitHub 不接收照片或案情。Dot 有原始資料時，也可用既有 GitHub 連線和 HTTP 等價操作。

1. 生成隨機 16-byte 交接 ID 和 32-byte 交接證明，各以小寫 hex 表示。以正式部署所指定的完整 commit SHA 建立分支 `dot-photo-submit/v1/ID.SECRET_HASH.CONTENT_HASH`。其中 `SECRET_HASH` 是交接證明的 hex 字串之 SHA-256，`CONTENT_HASH` 是交接證明的原始 32 bytes 串接完整 JSON 請求 bytes 後的 SHA-256。分支上只有交接 ID 與校驗值。
2. 送件工作憑簽章開通交接。以 `X-Photo-Handoff-Proof` 帶交接證明，等待交接查詢顯示 `OPEN`。交接開通後四分鐘內可用。傳送同一份 JSON bytes，使用 `Content-Type: application/json`，`Idempotency-Key` 等於私有穩定 `recordKey`。
3. 收到 `CHECKED_PRIVATE` 代表格式、來源與照片通過，仍在私有交接區。送件工作隨即完成獨立簽章確認。保留回執 ID 供讀回與撤回。若透過同一份資料重送，正式案件沿用原 ID。結果未確認時，先讀這次交接結果。
4. 撤回以同一方式形成新的交接，JSON 僅含 `{"withdrawId":"PHOTO_RECEIPT_ID"}`。完成後回執仍可讀，公開圖片停止提供。

送件封套包含三部分：

- `tip` 是既有 v3 文字案格式，`photos: []`。此入口把照片放在獨立的 `photo` 欄位。
- `sourceEvidence` 含 `status: ACTIVE`、`checkedAt`（UTC ISO 毫秒）、`caseUrl`（核准資料集的個案 API）和同一 `recordKey`。簽章工作承諾已向可信來源核實在案；伺服器核對來源、範圍與時效，證據超過十五分鐘或來自未啟用來源即拒收。
  - `caseUrl` 可使用官方個案 API 的 Socrata `:id`，例如合成網址 `https://data.kingcounty.gov/resource/azpa-gwmk/row-abcd-efgh.ijkl.json`。Dot 應核對個案 API 回傳同一筆紀錄，再填入查核結果。`recordKey` 照既有規則從 `impound_no` 產生。網址只接受指定 HTTPS 網域及該資料集的單筆路徑，省略查詢參數及 fragment。
- `photo` 含 `content`（原始影像的標準 base64，原始 bytes 至多 5 MiB）、`mime`、`sha256`、`rights` 和 `verification`。權利記錄需有 `license`、公開署名 `credit`、私有 `permissionUrl`、允許公開的 `creditUrl`、`permitsRedaction: true` 和 `creditApprovedForPublic: true`。允許 `EXPLICIT_PERMISSION`、`CC_BY_4_0`、`CC0_1_0`。驗證記錄需有 `recordKey`、`originalSha256`，並確認 `originalCapture`、`sameAnimalConfirmed`、`animalRecognizable`、`noFacesOrPlates`、`noPersonalData`、`noSensitiveVisualLocation`。證據連結不由伺服器代抓。

簽章驗證後才進入資料與照片檢查。通過即以同一交易保存案件、照片、回執與期限，無人工審查步驟。伺服器沿用既有影像安全檢查並重新編碼，公開欄位只含粗區域和必要署名。來源與授權憑據留在私有儲存。有效時間最長十五分鐘。同案具重新核對的有效證據可延長期限並保留原 ID。撤回後需由新的權限規則另行處理，重送無法復刊。歷史文字件各自保留原回執。

## 合成驗證及正式來源

```sh
bash tools/stray-map-rebuild/run-scheduled-photo-probe.sh publish
```

使用既有 Linux／amd64 Node 發布測試映像、隔離 PostGIS、合成簽章與本機自製圖。驗證同案重送、同日雙案件、來源證據過期、跨用途拒收、照片授權、去 EXIF、既有影像安全檢查、粗區域卡片及照片失效。正式線上驗證只用 `GET`。

King County 的資料集仍需從可信資料核對每案在案狀態與逐張照片再發布憑據。Dot 日常海巡的 API 查詢照既有方式執行，只有合格資料進入上述寫入路徑。公開 API、正式 App 畫面及 Hub 的驗收各自獨立。 [來源資料集](https://data.kingcounty.gov/api/views/azpa-gwmk)
