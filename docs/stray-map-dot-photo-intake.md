# 浪浪地圖 dot 照片 API

範圍限 King County Found animals 資料集的拾獲犬貓，以英文和華盛頓州概略區域呈現。dot 用既有 GitHub OIDC 工作負載身分。此版本核對新的照片專用 audience、工作流程、提交與既有擁有者身分。舊文字回執可讀，舊文字新增入口關閉。

基礎路徑 `https://api-production-8bc1.up.railway.app/external-intake/v1`。

| 操作 | 路徑 | 回應 |
| --- | --- | --- |
| 簽章身分探測 | `GET /photo-status` | `200`、`DOT_PHOTO_V1` 和照片限制 |
| 送一案 | `POST /photo-tips` | `201` 自動公開，`200` 原案重送 |
| 讀回執 | `GET /photo-receipts/:id` | `PUBLISHED`、`EXPIRED` 或 `WITHDRAWN` |
| 撤回 | `POST /photo-tips/:id/withdraw` | `200`，保留回執 |
| 公開卡片 | `GET /photo-cards` | 僅列目前有有效在案證據的卡片 |
| 公開圖片 | `GET /photo-media/:id` | 已清除 metadata 的 JPEG。到期或撤回回 `404` |

前四種操作需要 `Authorization: Bearer ...`，只由已鎖定的 GitHub 工作取得。OIDC audience 是完整 `/external-intake/v1/photo-tips` URL。送件用 `Content-Type: application/json`，`Idempotency-Key` 必須等於私有的穩定 `recordKey`。每小時新增一件，試點總量十件。

送件封套包含三部分：

- `tip` 是既有 v3 文字案格式，`photos: []`。此入口把照片放在獨立的 `photo` 欄位。
- `sourceEvidence` 含 `status: ACTIVE`、`checkedAt`（UTC ISO 毫秒）、`caseUrl`（核准資料集的個案 API）和同一 `recordKey`。簽章工作承諾已向可信來源核實在案；伺服器核對來源、範圍與時效，證據超過十五分鐘或來自未啟用來源即拒收。
- `photo` 含 `content`（原始影像的標準 base64，原始 bytes 至多 5 MiB）、`mime`、`sha256`、`rights` 和 `verification`。權利記錄需有 `license`、公開署名 `credit`、私有 `permissionUrl`、允許公開的 `creditUrl`、`permitsRedaction: true` 和 `creditApprovedForPublic: true`。允許 `EXPLICIT_PERMISSION`、`CC_BY_4_0`、`CC0_1_0`。驗證記錄需有 `recordKey`、`originalSha256`，並確認 `originalCapture`、`sameAnimalConfirmed`、`animalRecognizable`、`noFacesOrPlates`、`noPersonalData`、`noSensitiveVisualLocation`。證據連結不由伺服器代抓。

簽章驗證後才進入資料與照片檢查。通過即以同一交易保存案件、照片、回執與期限，無人工審查步驟。伺服器沿用既有影像安全檢查並重新編碼，公開欄位只含粗區域和必要署名。來源與授權憑據留在私有儲存。有效時間最長十五分鐘。同案具重新核對的有效證據可延長期限並保留原 ID。撤回後需由新的權限規則另行處理，重送無法復刊。歷史文字件各自保留原回執。

## 合成驗證及正式來源

```sh
bash tools/stray-map-rebuild/run-scheduled-photo-probe.sh publish
```

使用既有 Linux／amd64 Node 發布測試映像、隔離 PostGIS、合成簽章與本機自製圖。驗證同案重送、同日雙案件、來源證據過期、跨用途拒收、照片授權、去 EXIF、既有影像安全檢查、粗區域卡片及照片失效。正式線上驗證只用 `GET`。

King County 的資料集缺明確可核對的個案在案狀態與逐張照片再發布憑據，指定工作目前只讀取來源中繼資料並回報保留。dot 日常海巡的 API 查詢照既有方式執行。真實照片送件需先有符合上述契約的可信來源資料與一條核實結果能進入鎖定工作的傳輸路徑。公開 API、正式 App 畫面及 Hub 的驗收各自獨立。 [來源資料集](https://data.kingcounty.gov/api/views/azpa-gwmk)
