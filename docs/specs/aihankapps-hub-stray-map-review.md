# 浪浪地圖人工審核

在 [管理中樞的浪浪地圖頁](https://eclawbot.com/AiHankApps/hub/#app-stray-map) 展開「人工審核」。登入管理員帳號後，用既有浪浪地圖審核通行碼解鎖。檢舉、照片及照片申訴共用同一次解鎖。離開這個 App 頁面或鎖定審核後即清除通行碼。

- 檢舉可搜尋、查看待處理與逾時案件，並依既有流程開始處理、駁回、移除內容或移除並封鎖。移除與封鎖需要留下理由。
- 照片可區分待審、核准和拒絕，並沿用核准、拒絕、隱藏與申訴處理。拒絕、隱藏與處理申訴需要留下理由。
- 管理中樞重新讀取統計時，保留已開啟的人工審核及未送出的理由。讀取中斷由頁面重新讀取。寫入結果不確定時先讀回案件狀態。

## API

所有路徑均位於 `/api/aihankapps/hub/stray-map/review/`，需要既有 EClaw 管理員 session 和 `X-Stray-Map-Review-Token`。決定操作另需正式站的同源 `Origin`。通行碼僅轉送至固定的浪浪地圖服務，回應保持私有。

| 路徑 | 用途 |
| --- | --- |
| `GET reports` | 讀取檢舉，由既有後端排序 |
| `GET photos?status=pending&offset=0` | 依 `pending`、`approved` 或 `rejected` 分頁讀取 |
| `POST reports/:id/decision` | 以 `action` 與 `note` 送出檢舉決定 |
| `POST photos/:id/decision` | 以 `action` 與 `note` 送出照片決定 |
| `POST appeals/:id/decision` | 以 `action` 與 `note` 送出申訴決定 |

這個區塊處理既有 App 的檢舉和照片。dot 專用送件的受理模式與通報統計各自沿用原本的入口。
