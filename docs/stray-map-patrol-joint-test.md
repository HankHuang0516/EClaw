# 浪浪地圖文字送件聯測

Mac 上用 Draft PR #5527 的 `b1cac355a` 候選後端執行。程式會比對候選入口與模組的 SHA，以及該提交的送件程式、儲存層和驗證合約。測試使用 Docker 內的 Linux x64 Node 22.23.3 和空白 PostgreSQL／PostGIS。容器只有測試用 loopback，沒有對外連線或主機連接埠，測試程式和驗證器放在候選產物外。

## 重跑

在 Mac 終端執行以下命令。需要可讀取的既有候選產物、Docker Desktop，以及已存在的 Node 與 PostGIS 映像。每次使用新的私有目錄與空白資料庫。

```sh
repo=/Volumes/ProjectsData/Project/EClaw-stray-map-insights-20261126
root=/Volumes/ProjectsData/portfolio-private-staging/20261126-stray-map-isolated-rebuild
python3 /Volumes/ProjectsData/check_storage.py
"$root/toolchain/node-v22.23.3-darwin-arm64/bin/node" \
  "$repo/tools/stray-map-rebuild/run-linux-pilot.cjs" \
  "$root/linux-amd64-20261127" --patrol
```

可在 `--patrol` 後面加上合成 JSON 的絕對路徑。dot 可在本對話貼以下格式及預期結果，由 Mac 執行後在同一對話回傳去識別 JSON。不需帳密或對外連線。

```json
{
  "synthetic": true,
  "cases": [
    { "case": "dot-en-found", "region": "US-WA", "locale": "en-US", "kind": "DOG", "report": "FOUND" },
    { "case": "dot-missing-locale", "region": "TW-TPE", "locale": null, "kind": "CAT", "report": "SIGHTING" }
  ]
}
```

一次可追加最多四案。`case` 使用小寫 ASCII 字母開頭、共 1–32 字元，允許數字和連字號。同次不得重複。`kind` 可用 `DOG`、`CAT`、`OTHER_STRAY`。`report` 可用 `LOST`、`FOUND`、`SIGHTING`。地區與語言可以填 `null` 來測試資訊缺漏。預設配對為台北 `TW-TPE`／`zh-TW`、華盛頓州 `US-WA`／`en-US`。不支援的地區或語言、以及不一致的配對都進私有人工確認清單。案例格式只收這五個欄位，勿貼真實通報內容、精確位置或個資。

## 預期結果

- 程式在測試時鐘的第 0、15 分鐘各向合成公開 API 做一次匿名 GET。第 14 分 59.999 秒跳過。巡查及文案使用程式和固定語言模板，模型呼叫數為 0。這輪使用測試時鐘。
- 合格的台北案送繁體中文，華盛頓州案送英文。合成範例的日期與時間精度各自保留。缺語言、缺地區或資料衝突的案例寫入私有人工確認清單，收件端沒有這些案例的資料列。
- 專用候選路徑接受經驗證的測試來源並回 HTTP 202、`PENDING`、`publicVisible:false`，其他來源回 403。測試驗證器比對受隔離網路約束的系統連線位址。它使用獨立的送件 scope，人工審查與公開讀取開關全程關閉。
- 測試會在第一個案件真實收到 HTTP 202 後，模擬排程端未取得確認。重試用相同內容和冪等鍵，回執與初次一樣。第二輪重讀也拿到原回執。預設有兩份回執、兩筆案件、兩筆冪等記錄以及三筆待人工確認。`/cards` 回 503，原生裝置、動物和目擊資料列都是 0。
- 停用後跳過查詢，收件及回執 API 回 503。另一個程序在資料庫核對停用前後的回執、人工確認紀錄與案件狀態一致。輸出保留回執欄位、以雜湊別名取代原 ID。每次新測試的別名會變，單次測試內用同一個別名核對重試。

命令會輸出可貼回本對話的摘要及私有留存目錄。核對 `RESULT.private.json` 的 `persistence` 與 `CLEANUP.private.json` 的容器停止狀態。

## 已跑結果與正式環境

2026-11-27 的 `patrol-bf1bf798` 使用上面兩個追加案例。7 項檢查通過。2 次匿名 GET、7 次送件請求只建 3 案，另有 4 案轉人工。台北案例的回執別名是 `masked-c9638c7764f2`，華盛頓州走失案例為 `masked-3e556cf971b6`，追加的華盛頓州拾獲案例為 `masked-e3eb819606d6`。三份回執均為 HTTP 202、`PENDING`、`publicVisible:false`，在測試時鐘 08:00（台灣時間）取得。停用後由獨立程序確認 3 份回執與 4 筆人工確認紀錄，兩個容器已停止。

Hank 已授權沿用既有發布流程部署及使用既有官方送件權限。正式健康檢查回 200。本輪對候選 `/external-intake/v1/tips` 與先前草案 `/v1/public/tips` 的公開 `OPTIONS` 都回 404，這只能記錄所查路徑的回應。既有原生動物 POST 會直接發布，已知管理身分也沒有綁定第三方來源或 dataset 的送件證據。部署紀錄指向 Railway `api/production` 的 CLI 上傳，候選仍未接正式送件驗證器。應先核對既有官方待審端點、可用身分的設定引用、已核准 publisher／dataset 範圍，以及該範圍適用的現有自動送件規則；設定引用不含憑證值。沒有可用綁定時，新增範圍或規則例外需另外決定。正式收件、公開上圖、授權照片與 App 顯示均未驗證，這輪沒有部署。 [目前正式條款](https://api-production-8bc1.up.railway.app/terms?lang=zh-Hant)
