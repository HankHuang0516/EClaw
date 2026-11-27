# 浪浪地圖每 15 分鐘巡查候選

現在正式收件限人工觸發的 GitHub 工作。正式紀錄 `140236060980` 回傳待審回執 `masked-2c8f9f156418`，已讀回，未公開。持續排程仍在隔離驗收。 [正式人工送件紀錄](https://github.com/HankHuang0516/EClaw/actions/runs/45914681563/job/140236060980)

## 已查到的限制

- 正式 OIDC 驗證器只接受已核准的工作流程提交、分支與 `push` 事件，而且初次執行不具寫入權。GitHub 定時工作只從預設分支執行，壅塞時可延遲或略過。重跑既有人工工作也有 30 天與 50 次上限。沿用 GitHub OIDC 發行者可免新增 API 金鑰，排程仍須有獨立且限縮的正式身分綁定。 [GitHub 定時工作](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule) · [重跑限制](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)
- King County 將 `azpa-gwmk` 標為 Public Domain。欄位有 `FOUND`、拾獲日或收容登錄日期，也有目前位置欄位。公開 metadata 沒有定義案件仍有效、明確結案或消失的語意。資料集更新時間只能佐證更新，不能佐證個案仍有效。資料缺明確在案證據就留人工確認。 [官方資料集與欄位](https://data.kingcounty.gov/api/views/azpa-gwmk)
- 目前正式條款第 4 條限制一般自動化使用。若要讓這條路徑持續自動送件，先記錄僅限官方專用端點、單一來源與待審的例外。 [正式條款](https://api-production-8bc1.up.railway.app/terms?lang=zh-Hant)

## 隔離重跑

```sh
node --test tools/stray-map-pilot/dot-identity.test.cjs \
  tools/stray-map-pilot/scheduled-intake-rehearsal.test.cjs
```

排程測試使用測試時鐘、本機 loopback 合成 API、收件替身、原子寫入的本機測試帳冊。只在隔離模式執行，可在 Linux／amd64 容器以 `--network none` 重跑。來源 GET 無登入，程式使用固定語言模板。首次完整且獲准的讀取建立基線。後續新案需有明確 `ACTIVE` 證據及合格欄位。逾時、缺頁、權限不明、缺狀態及缺實際拾獲日期不送件。明確結案不再受理，資料消失不視為結案。

預期一次送件只存一張待審回執。遺失確認後，下一輪必須再次確認是同一有效案件、內容相同才重送。收件替身測得相同冪等鍵、相同內容、同一張回執。停用後沒有新的查詢或送件，已存回執保留。每小時及待審上限的拒絕回應各自保留。這輪驗證排程決策和回執交接，收件替身沒有正式資料庫或 OIDC 權限。正式 OIDC 及 PostgreSQL 待審驗收的前次證據在 [官方送件交接](stray-map-dot-official-intake.md)。

## 正式啟用所需的最小決策

1. 先從資料發布方可讀的正式 API 或文件核實個案仍有效與明確結案的判準，並核實分頁與空集合語意。只有可完整核對的結果能建立基線或發現新案。目前缺少這項證據。
2. 核准預設分支的專用定時工作、固定版本的可重用工作與後端精確 OIDC 綁定。工作只要求一次此來源的巡查，不攜帶任意案件。後端沿用已核對的來源、英語與州級區域、每小時一件與十筆待審上限。排程與人工角色各自可停用，排程以既有 PostgreSQL 保存每 15 分鐘的執行槽、案件狀態與原回執。尚需在隔離整合中核對跨程序競用與 GitHub 延遲及漏輪的記錄。
3. 核准僅涵蓋上述正式待審路徑的自動送件規則。待審容量滿時維持阻擋。若要開始清理正式待審佇列，另核對具審查職責的身分及操作範圍。

## 獨立驗收

- 正式收件先用一筆自然出現且明確仍在案的紀錄，核對唯一待審回執、尚無公開投影、停用後保留回執。已存在的人工回執無須重送。
- Hub 用授權的後端彙總核對待審數、已去重、來源中斷與資料缺口。使用桌面與手機驗證，正式原生通報數和此來源隊列各自核對。
- 聯測版 App 用合成批准案例核對當地語言、概略區域卡片與撤回。現階段待審不得在 App 出現。正式 App 顯示、圖釘和公開上圖須獨立授權後驗。
- 照片另驗授權證據、實際 bytes、去除 EXIF、隱藏與撤回。文字排程候選不使用照片。
