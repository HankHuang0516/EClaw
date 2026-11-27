# 浪浪地圖 dot 官方送件

dot 以現有 GitHub 連線操作指定的 [GitHub Actions 工作流程](https://github.com/HankHuang0516/EClaw/actions/workflows/stray-map-dot-intake.yml)。工作流程向 GitHub 取得短效 OIDC 身分。浪浪地圖核對發行者、用途、專案及帳號 ID、分支、執行環境、工作流程檔案與發布時鎖定的提交。觸發及重跑均限定專案擁有者帳號。授權對象是這個受限工作流程，dot 不需取得或保管 API 金鑰。[GitHub OIDC](https://docs.github.com/en/actions/concepts/security/openid-connect)

## dot 操作

1. 在指定執行紀錄重跑 **Verify official identity (read only)** 可驗證身分與私下受理模式。預期 `signed=404 anonymous=403 public=503`，使用的保留 ID 不會建立案件。
2. 有明確人工送件指示時，才在同一紀錄單獨重跑 **Submit one official case (manual rerun)**。請用已連接的 GitHub Actions 工具及該工作的 ID。切勿以「重跑全部工作」做唯讀驗證。初次執行不讀取或送出案件。[GitHub 單一工作重跑 API](https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2022-11-28#re-run-a-job-from-a-workflow-run)
3. 新件通過檢查後立即取得 `ACCEPTED_PRIVATE`、`publicVisible: false` 和遮蔽回執，無需人工審查。若來源仍回傳同一案件，重跑會取得同一回執並出現 `replay: true`。舊件仍顯示原本的 `PENDING` 回執。收到 `MANUAL_CONFIRMATION_REQUIRED` 代表來源資料不足，該輪沒有送件。日誌無 OIDC 憑證、來源案件編號和通報全文。

入口為 `POST /external-intake/v1/tips` 和本來源的 `GET /external-intake/v1/receipts/:id`。資料限 King County 公開 Found animals 資料集的拾獲犬貓，保留當地日期、英文通報和華盛頓州概略區域。每次手動操作最多送一筆，每小時最多新增一筆，試點總量上限十筆。公開、照片和 App 顯示均在此工作流程授權範圍外。15 分鐘巡查仍為唯讀。[King County 資料集](https://data.kingcounty.gov/d/azpa-gwmk)

GitHub 單次執行可重跑期限為 30 天。若需更新這個試點，發布者須重新核對並綁定新的工作流程執行及其提交。正式停止收件可回退至已驗證的原先關閉版，關閉入口會保留已收的資料。[GitHub 重跑限制](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)

聚焦測試可在 Mac 或隔離環境執行 `node --test tools/stray-map-pilot/dot-identity.test.cjs`。日常送件程式與測試皆不需要模型。
