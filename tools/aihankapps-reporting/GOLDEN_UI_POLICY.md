# APP 趨勢 Golden UI 與發布門檻

## 已確認的目標

Hank 於 2026-10-01 核定 AI 示意圖為 Golden，要求追蹤相似度且至少達到 90%。
正式參考檔為 `design/golden/app-trends-v1.png`；比對規格為
`design/golden/app-trends-v1.json`。不得以示意圖當成網頁背景、偽造資料或修改
門檻來取得通過結果。Golden 是設計參考，不是正式資料來源。

## 固定且可追溯的量測

2026-10-01 第十八輪正式紀錄：masked 90.0715%、raw 81.4821%、排除面積 24.7203%、幾何誤差項目為零。逐 APP 多位置 hover／click 與 Weesh 提示框交界已通過；手機 320／390／768 px 刻度約 12 px、完整收益與觸控固定正常。新增導覽驗證誤要求 3 個入口（實際既有 4 個），故 functionalChecksPassed=false、passed=false；另外新座標單元測試誤用浮點數完全相等。兩項測試判定缺陷已記錄在 APP_TRENDS_OPEN_QUESTIONS.md，尚待修正決定。未部署，所有失敗證據保留於 design/verification/20261001-golden-r18 及對應不可變 release。

- 桌面尺寸固定 1536 × 1024、device scale 1，不縮放截圖。
- 使用 RGB SSIM、11px box window、1px Gaussian prefilter。
- 同時保存原始分數、排除動態區域後的分數、排除面積、Golden／規則／截圖
  及發布檔案 hash。保留每次分數於 `golden-score-history.jsonl`。
- 核准門檻為排除動態內容後至少 90%，原始分數至少 80%，排除面積最多 25%。
  標題條、主要面板位置與尺寸誤差不得超過 8px。
- 排除項目僅限預先列明的真實數字、日期、評論內容、圖示及資料曲線。
  背景、卡片、工具列、導覽、篩選器、字體與結構仍須比較。
- 資料缺漏、少量評論不能補假數據，也不能隱藏資料讀取錯誤。
- 手機版另驗證水平溢出、可讀性與互動；沒有手機 Golden 時不虛構手機分數。
- 保留所有失敗量測，不覆寫成通過，不在量測後擴大排除區域或降低門檻。

## 追加目標：作品集首頁 APP icon 放大（2026-10-01）

Hank 要求每款作品的首頁 icon 寬、高各放大 2 倍：52 × 52 px → 104 × 104 px。
此項追加到目前目標的驗收清單，不取代 APP 趨勢的任何既定門檻。

- 涵蓋所有作品分類及 Web／工具作品；不修改 APP 趨勢圖例、評論圖示或品牌標誌。
- 同步調整卡片標題及間距；介紹入口、觀看統計與下載按鈕不能被遮住。
- 保留商店原圖與既有分類 H 浮水印，不能重複疊加或因此修改已上架 APP 套件。
- 桌面與手機驗收實際 104 × 104 px、圖片比例、標題換行、操作入口及水平溢出。
- 發布時同步 canonical、EClaw 與 Sites；原 Golden 圖及量測門檻保持不變。

目前狀態：本機 canonical 與 EClaw 首頁已實作 104 × 104 px，保留角落 H 的相同比例並調整標題換行與間距。兩份來源的桌面／手機各 16 款尺寸、圖片與標題／操作入口不重疊檢查通過，未新增水平溢出；驗收記錄為 `design/verification/20261001-icons-2x/receipt.json`。尚未公開部署。

## 每次 UI 或每日資料發布前

手機元件級必要驗收：320／390／768 px 導覽文字不得直排、完整收益不得裁切、圖表刻度實際顯示字級至少 9 px 且橫縱比例 0.75–1.5、無水平溢出、觸控可固定 APP 提示框。桌面另強制驗證提示框交界及固定按鈕，不能只檢查一款 APP 或只看 document 寬度。此為補足功能驗收，不更改 Golden 圖、遮罩或任何既定視覺門檻。

1. 先建立不可變 report release；不可先套用或直接發布草稿。
2. 執行 `node scripts/capture-trends-golden.mjs --release RELEASE_DIRECTORY`。
   使用本機已安装 Chrome，所有請求只准 GET，不產生測試留言、按讚或流量事件。
3. 使用含 Pillow／NumPy 的工作區 Python 執行：

```sh
python3 scripts/compare-trends-golden.py \
  --actual design/verification/app-trends-desktop.png \
  --capture design/verification/capture.json \
  --output RELEASE_DIRECTORY/golden-score.json
```

4. 檢視排除區域診斷圖及分數。只有所有門檻通過，才執行
   `node scripts/report-release.mjs --apply RELEASE_DIRECTORY`。
   CLI 會檢查分數、規則 hash、Golden hash 及三個發布檔案的 exact hash；
   缺少或不符均停止發布。不得只改 `passed` 欄位。
5. 通過後才繼續既有攻略同步、PR、CI、合併與雙來源發布驗證流程。

## 目前結果：尚未通過，未部署

2026-10-01 第一輪：原始 SSIM 69.39%，排除動態內容後 75.94%，
排除面積 31.06%。主要面板位置通過；滑鼠提示、點擊固定、縮放、模式切換、
評論篩選與手機無水平溢出檢查通過。數值門檻與排除面積均未通過，
正式網站保留既有版本。第一輪紀錄位於 `design/verification/golden-score.json`。

尚需調整字級、文字密度、圖表視覺細節與評論區結構；不得為了模仿示意圖而
增加不存在的評論或收入。另須補強「缺資料區段」的折線命中辨識，再進行新版驗收。

## 2026-10-01 後續進度（仍未部署）

- 第二輪：原始 73.60%，動態排除後 80.94%，排除面積 25.79%。
- 第三輪：原始 76.75%，動態排除後 84.47%，排除面積 25.33%。
- 第四輪：原始 77.56%，動態排除後 85.43%，排除面積 24.77%。主要面板位置
  與尺寸、滑鼠提示、點擊固定、滾輪縮放、模式切換、評論篩選及手機無溢出
  驗證通過，但兩項 SSIM 門檻仍未通過。
- 排除範圍僅縮小，未擴大，數值门檻未放寬。歷次結果保留於
  `design/verification/golden-score-history.jsonl` 與各輪目錄。
- 已修正缺資料段的命中辨識與非等比例畫面座標，新增相關回歸測試。
- 第五輪擴充 Escape、鍵盤切 APP／固定、拖曳平移、全歷史、率值不得累計、
  APP 選單與各欄排序等互動驗收。APP 選單遭圖表攔截而停止；未產生有效
  capture.json，不能宣稱第五輪通過，也不能使用較窄測試推論所有互動正常。
- 驗證工具也有已知判定錯誤：將 mobileOverflow=false 納入所有 false 值失敗
  判斷；此項與 APP 選單層級問題已交 Hank 確認修正，尚未修改。

最近完整量測的不可變 release 為
`2026-10-01T07-48-00.282Z_4f9a1bcc-611f-4beb-ba16-262321f673a3`。
第五輪未完成驗收的 release 為
`2026-10-01T07-53-50.406Z_c4794a7c-bc65-473d-8499-ba5df176eb0d`。
兩者均未套用到公開目標。PR、CI、合併、EClaw／Sites 部署与公開 hash 核對仍待完成。

## 後續視覺診斷與隔離測試（仍未部署）

- 第六輪診斷：原始 78.51%、動態排除後 86.56%、排除面積 24.84%。
- 第七輪診斷：原始 79.10%、動態排除後 87.33%、排除面積 24.80%。
- 第八輪診斷：原始 79.48%、動態排除後 87.83%、排除面積 24.80%。
- 第九輪診斷：原始 80.01%、動態排除後 88.54%、排除面積 24.80%。
- 第十輪診斷：原始 80.16%、動態排除後 88.61%、排除面積 24.80%。
- 第十一輪診斷：原始 80.65%、動態排除後 89.08%、排除面積 24.72%。
- 第十二輪診斷：原始 80.62%、動態排除後 89.13%、排除面積 24.72%。
- 第十三輪診斷：原始 80.39%、動態排除後 89.14%、排除面積 24.72%。
- 各輪使用不同的不可變 release；`capture-diagnostic.json` 明確記錄診斷用途及
  未完成完整互動驗收，`diagnostic-score.json` 的通過狀態均為 false。
  診斷不取代原本完整驗收，也不能作為發布憑證。規則、Golden 與門檻未改。
- 評論後端分頁隔離測試共 33/33 通過（28 項新分頁案例加 5 項既有案例）；
  報表互動、評論與發布門檻相關測試 31/31 通過。尚未完成 PR CI 與公開驗證。

## 完整驗收阻礙重驗（2026-10-01，等待修正決定）

目前版本的 APP 選單仍被圖表攔截；正常點擊「清除選取」在 1.5 秒內逾時，
按鈕中心命中 `svg#trend-chart`。驗證工具對 `mobileOverflow=false` 的成功案例
仍誤判為失敗。這兩項先前已回報的錯誤未被修改，也未以強制點擊或較窄測試繞過。
Hank 已在待確認文件中明確同意修正這兩項及輔助記錄格式。歷史重驗保留，
接著進行修正與完整自動驗收；不需人工操作驗收，也不得繞過發布門檻。

剛新增的輔助 `blocker-revalidation.json` 末尾格式錯誤也已回報，保留原始檔等待
修正決定；該檔不是有效的機器可讀驗收憑證。既有分數、截圖及其他有效 capture
記錄不受影響。正式來源維持既有版本；目前不符合完整目標完成或發布條件。

## 第十四輪修正後重驗（2026-10-01，未部署）

Hank 已明確同意三項修正，APP 選單層級、mobileOverflow 判定與輔助紀錄格式
已修復。錯誤紀錄原檔保留。通用 capture 所列互動檢查全數通過。
固定 Golden／config／門檻未變：masked 89.1525%、raw 80.6493%、排除 24.7203%，
幾何誤差項目為零，視覺門檻仍未通過。

擴展至每一款 APP 的獨立實際折線檢查，發現 Weesh 中段 hover／click 失敗；
其他 11 款有折線 APP 通過，4 款沒有資料且未製造折線。已重現提示框覆蓋
滑鼠位置、觸發圖表 pointerleave、隱藏自身的事件序列，修正決定列在
APP_TRENDS_OPEN_QUESTIONS.md 最上方。此缺陷不是官方資料缺漏。
capture 的 functionalChecksPassed=true 不能擴大解讀為逐 APP 全部驗收成功。
發布前必須包含逐 APP、多位置與提示框交界驗證，不得只依通用 capture 放行。

證據位於 design/verification/20261001-golden-r14/；report release 為
2026-10-01T09-53-21.554Z_21ec6041-3413-4f09-8c16-4fffa59f1bc9。
既有正式版本未改，沒有本輪 PR、CI 合併或公開部署證據。

## 第十五輪：逐款發布門檻與手機視覺缺陷（2026-10-01）

固定規則量測 masked 89.3648%、raw 80.7934%、排除 24.7203%，幾何誤差
項目為零。Golden/config hash 未變，視覺仍未達 90%，不可發布。
現在完整 capture 逐款選取 16 個項目，對有資料的實際路径在 10%／50%／90%
測試正常 hover／click，缺資料不製造折線；compare 強制要求
allAppsHitTestingPassed。Weesh 中段仍失敗，functionalChecksPassed=false。
實際 requireGoldenScore 已拒絕本輪不可變 release，未套用至公開目標。

42 項本地測試通過，包括 5 項新的歷史导覽面積／缺資料區段保留測試。
這不代表 PR CI 或手機視覺驗收通過。手機截圖發現頂部導覽直排、收益卡片
裁切與刻度過小；無 document 溢出不足以證明元件可用。修正決定已列在
APP_TRENDS_OPEN_QUESTIONS.md 的 OPEN 區。不得降低視覺門檻，或只依
mobileOverflow=false 宣稱手機驗收成功。

證據：design/verification/20261001-golden-r15/；不可變 release：
2026-10-01T10-13-31.143Z_3c9f2b7e-ba67-4674-83c2-ffa650101f49。
本輪未建立發布 PR、未合併、未部署。

## 第十六輪：評論資訊層級與正式／診斷證據分離（2026-10-01）

正式量測 masked 89.4556%、raw 81.0196%、排除 24.7203%，幾何誤差項目為零。
Golden/config hash 未變；仍未達 90%，不可發布。評論作者與日期完整可見，
全文展開／收起正常；量測新增 reviewMetadataReadable 與
reviewExpandControlsPassed 必要條件。Weesh 中段仍失敗，功能總驗收未通過。
手機可讀性問題仍列於 OPEN，不能用 document 不溢出作為通過證據。

證據：design/verification/20261001-golden-r16/；不可變 release：
2026-10-01T10-29-43.259Z_cbd3be94-5303-41aa-bec1-7064a6511488。
本輪未套用公開目標、未建立發布 PR、未合併或部署。

另有 8 組折線透明度瀏覽器暫時樣式診斷，位於
 design/verification/20261001-line-contrast-probes/。
所有 capture 都記錄 runtimeOverride、diagnosticOnly=true、publishable=false，
並明確記錄尚未完成全部功能驗收。來源、數據與固定 mask 設定未改。
較高透明度並未改善相似度；30% 以上的診斷開始超過 25% 排除上限。
沒有將這些樣式套用至來源，也不得拿診斷結果取代正式量測或發布憑證。

## 第十七輪：視覺門檻已達標，功能仍失敗（2026-10-01）

正式固定規則量測 masked 90.0715%、raw 81.4815%、排除 24.7203%，幾何誤差
項目為零。四項視覺／版面條件均達標；Golden/config hash 未變。真實字型
300／800 字重已由瀏覽器確認載入，未使用後製、圖片縮放或新增排除範圍。

16 項目的多位置驗證仍重現 Weesh，中段 hover／click 失敗，功能總驗收為
false、passed=false。評論作者／日期與展開收起通過。發布 gate 實際拒絕
本輪 release；不得以 SSIM 達標繞過功能失敗。

手機元件客觀檢查：導覽文字 2／4／4 個換行片段；收益右邊緣 383.25px，
卡片右邊緣 378px；SVG 刻度橫向字體 2.86px、橫縱比 0.26。三項元件檢查
均 false，mobilePassed=false。這是額外明確失敗證據，尚待把此類元件級
檢查納入正式發布 verifier；不能用 mobileOverflow=false 宣稱手機通過。

證據：design/verification/20261001-golden-r17/；不可變 release：
2026-10-01T10-53-28.629Z_2635c184-381c-4b94-a29d-d8ad23f736ab。
來源與全部量測保留。本輪未套用公開目標、未發布 PR、合併或部署。

目前兩項需 Hank 明確回覆的修正決定位於 APP_TRENDS_OPEN_QUESTIONS.md
最上方：Weesh 提示框及手機可讀性。兩項均為先前介面實作的缺陷，已反覆
重現，不能把自動目標續跑當作人工修正決定，也不要求 Hank 人工操作驗收。
收到回覆後仍須完整功能、視覺、歷史／攻略／release 完整性、必要 CI、
兩個正式來源部署与公開 hash 核對；視覺達標本身不代表完整目標完成。

## 2026-10-02 第 20 輪

Golden/config 與全部門檻保持不變。正式 capture 位於
`design/verification/20261002-golden-r20`：masked 90.0730%、raw 81.5119%、
排除 24.6976%、geometryErrors=[]、所有必要功能檢查通過。
新增 allAppSeriesVisible 為必要条件：真實資料必須有可見線段或資料點，
不允許只有 SVG M 命令但沒有標記；沒有資料仍不得製造線或點。
通過只是本地發布 gate，仍需 PR/CI 與雙站公開完整性核對。
