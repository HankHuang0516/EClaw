/* global window, document */
(function () {
  'use strict';
  // Source copy is also the stable key. Keep every supported locale complete.
  const locales = ['zh-TW', 'en', 'zh-CN', 'ja', 'ko'];
  const rows = [
    ['展開', 'Expand', '展开', '展開', '펼치기'],
    ['收合', 'Collapse', '收起', '折りたたむ', '접기'],
    ['上架 · 60 分鐘', 'Listings · 60 min', '上架 · 60 分钟', '掲載 · 60分', '게시 · 60분'],
    ['尚無數據。', 'No data yet.', '暂无数据。', 'データはまだありません。', '아직 데이터가 없습니다.'],
    ['等待最近 60 分鐘的完整觀測', 'Waiting for rolling-hour observations', '等待最近 60 分钟的完整观测', '直近60分の観測待ち', '최근 60분 관측 대기 중'],
    ['觀測已延遲，等待更新', 'Observations delayed; awaiting an update', '观测已延迟，等待更新', '観測が遅延しています。更新待ち', '관측이 지연되어 업데이트 대기 중'],
    ['截至 {time}，最近 60 分鐘', '60 minutes ending at {time}', '截至 {time}，最近 60 分钟', '{time}までの直近60分', '{time} 기준 최근 60분'],
    ['截至 {time}，部分時段尚未完成觀測', 'As of {time}; some observations are incomplete', '截至 {time}，部分时段尚未完成观测', '{time}時点。一部の観測は未完了です', '{time} 기준, 일부 구간 관측 미완료'],
    ['觀測不足，尚無可確認件數', 'Insufficient observations; count unknown', '观测不足，尚无可确认件数', '観測不足のため件数は不明です', '관측이 부족하여 건수를 확인할 수 없음'],
    ['原價查找 · 60 分鐘', 'Retail lookup · 60 min', '原价查找 · 60 分钟', '新品価格検索 · 60分', '정가 검색 · 60분'],
    ['CP 評估 · 60 分鐘', 'CP evaluation · 60 min', 'CP 评估 · 60 分钟', 'CP評価 · 60分', 'CP 평가 · 60분'],
    ['至少 {n} 件', 'At least {n}', '至少 {n} 件', '{n}件以上', '최소 {n}건'],
    ['{n} 件', '{n} items', '{n} 件', '{n}件', '{n}건'],
    ['工作來源', 'Work source', '工作来源', '作業ソース', '작업 소스'],
    ['AI 工作來源', 'AI work source', 'AI 工作来源', 'AI作業ソース', 'AI 작업 소스'],
    ['顯示方式', 'Display mode', '显示方式', '表示モード', '표시 방식'],
    ['時間刻度', 'Time unit', '时间刻度', '時間単位', '시간 단위'],
    ['每段件數', 'Period count', '每段件数', '期間ごとの件数', '구간별 건수'],
    ['區間累計', 'Range cumulative', '区间累计', '表示範囲の累計', '표시 범위 누적'],
    ['重設範圍', 'Reset range', '重设范围', '表示範囲をリセット', '범위 초기화'],
    ['其他數列', 'More series', '其他数列', 'その他の系列', '다른 데이터 계열'],
    ['{title}波形；方向鍵查看、加減號縮放、Home 重設、Escape 關閉', '{title} chart; arrows inspect, plus/minus zoom, Home resets, Escape closes', '{title}波形；方向键查看、加减号缩放、Home 重设、Escape 关闭', '{title}グラフ。矢印で確認、+/-で拡大縮小、Homeでリセット、Escapeで閉じる', '{title} 그래프. 방향키로 확인, +/-로 확대/축소, Home으로 초기화, Escape로 닫기'],
    ['點選圖表後滾輪縮放、拖曳平移；點選或長按查看該時段。未知留空。', 'Focus the chart to zoom with the wheel and drag to pan. Click or hold to inspect. Unknown values stay blank.', '点选图表后滚轮缩放、拖曳平移；点选或长按查看该时段。未知留空。', 'グラフを選んでホイールで拡大縮小、ドラッグで移動。クリックや長押しで詳細を確認。不明値は空欄です。', '그래프를 선택한 후 휠로 확대/축소하고 드래그하여 이동하세요. 클릭하거나 길게 눌러 확인하며, 알 수 없는 값은 비워 둡니다.'],
    ['CP 評估', 'CP evaluation', 'CP 评估', 'CP評価', 'CP 평가'],
    ['原價查找', 'Retail lookup', '原价查找', '新品価格検索', '정가 검색'],
    ['覆核後寫入原價', 'Reviewed retail price', '复核后写入原价', '確認済み新品価格', '검토 후 기록한 정가'],
    ['自動寫入原價', 'Automatic retail price', '自动写入原价', '新品価格の自動記録', '자동으로 기록한 정가'],
    ['原價提案', 'Retail price proposal', '原价提案', '新品価格の提案', '정가 제안'],
    ['原價退回', 'Rejected retail proposal', '原价退回', '新品価格提案の却下', '반려된 정가 제안'],
    ['商品圖片辨識', 'Product image recognition', '商品图片识别', '商品画像認識', '상품 이미지 인식'],
    ['行銷素材', 'Marketing assets', '营销素材', '販促素材', '마케팅 자료'],
    ['照片標籤', 'Photo tags', '照片标签', '写真タグ', '사진 태그'],
    ['照片人物比對', 'Photo person matching', '照片人物比对', '写真の人物照合', '사진 인물 대조'],
    ['影片人物比對', 'Video person matching', '视频人物比对', '動画の人物照合', '동영상 인물 대조'],
    ['對話回合', 'Conversation turns', '对话回合', '会話ターン', '대화 차례'],
    ['後台完整彙總', 'Full backend summary', '后台完整汇总', 'バックエンド集計', '전체 백엔드 요약'],
    ['帳戶、願望、刊登與訊息的收集快照', 'Collected snapshots of accounts, wishes, listings and messages', '账户、愿望、刊登与消息的采集快照', 'アカウント・願望・掲載・メッセージの収集スナップショット', '계정, 위시, 게시물, 메시지 수집 현황'],
    ['帳戶智慧數據庫', 'Account insights', '账户智慧数据库', 'アカウント分析', '계정 인사이트'],
    ['搜尋帳戶、QA 篩選與個別使用歷程', 'Account search, QA filters and individual activity', '搜索账户、QA 筛选与个人使用历程', 'アカウント検索、QAフィルター、個別の利用履歴', '계정 검색, QA 필터, 개별 이용 내역'],
    ['服務與資源', 'Services and resources', '服务与资源', 'サービスとリソース', '서비스 및 리소스'],
    ['健康狀態、部署、流量與 worker 明細', 'Health, deployments, traffic and worker details', '健康状态、部署、流量与 worker 明细', '稼働状況・デプロイ・通信量・ワーカー詳細', '상태, 배포, 트래픽 및 워커 상세'],
    ['上架與原價／CP 趨勢', 'Listing, retail lookup and CP trends', '上架与原价／CP 趋势', '掲載・新品価格検索・CPの推移', '게시, 정가 검색 및 CP 추이'],
    ['成功上架、原價查找與 CP 評估；可切換每段件數或區間累計。', 'Listings, retail lookups and CP evaluations, by period or cumulative range.', '成功上架、原价查找与 CP 评估；可切换每段件数或区间累计。', '掲載・新品価格検索・CP評価。期間別件数と表示範囲の累計を切り替えられます。', '게시, 정가 검색, CP 평가를 구간별 또는 누적으로 확인하세요.'],
    ['其他 AI 工作量', 'Other AI workloads', '其他 AI 工作量', 'その他のAI作業量', '기타 AI 작업량'],
    ['依工作來源查看，避免不同單位混加', 'View one source at a time; keep units separate', '按工作来源查看，避免不同单位混加', '作業ソースごとに確認。異なる単位は合算しません', '작업 소스별로 확인하며 서로 다른 단위를 합산하지 않음'],
    ['AI 工作量', 'AI workloads', 'AI 工作量', 'AI作業量', 'AI 작업량'],
    ['一次看一個工作來源，各種工作分開計件。', 'One work source at a time, with separate counts for each task.', '一次看一个工作来源，各种工作分开计件。', '一度に1つの作業ソースを表示。作業の種類ごとに件数を分けます。', '한 번에 하나의 작업 소스를 표시하며 작업별 건수를 구분합니다.'],
    ['Worker CPU 波形', 'Worker CPU chart', 'Worker CPU 波形', 'ワーカーCPUグラフ', '워커 CPU 그래프'],
    ['近 6 小時的真實負載，可選擇各個 worker', 'Measured load over six hours; choose individual workers', '近 6 小时的实际负载，可选择各个 worker', '直近6時間の実測負荷。ワーカーを選択できます', '최근 6시간의 실제 부하. 개별 워커 선택 가능'],
    ['一顆核心全忙 = 100%；可用圖例切換來源。', 'One fully busy core = 100%; toggle sources in the legend.', '一个核心全忙 = 100%；可用图例切换来源。', '1コアの全稼働が100%。凡例でソースを切り替えられます。', '코어 하나의 최대 사용량은 100%이며 범례에서 소스를 전환할 수 있습니다.'],
    ['更多上架統計', 'More listing statistics', '更多上架统计', '掲載統計の詳細', '추가 게시 통계'],
    ['昨日、平均速度與歷史累計', 'Yesterday, average pace and historical totals', '昨天、平均速度与历史累计', '昨日・平均ペース・過去の累計', '어제, 평균 속도 및 과거 누적'],
    ['商店與作品集趨勢', 'Store and portfolio trends', '商店与作品集趋势', 'ストアと作品集の推移', '스토어 및 포트폴리오 추이'],
    ['安裝、廣告收入、介紹頁瀏覽與平台分布', 'Installs, ad revenue, introduction views and platforms', '安装、广告收入、介绍页浏览与平台分布', 'インストール・広告収益・紹介ページ閲覧・プラットフォーム別内訳', '설치, 광고 수익, 소개 페이지 조회 및 플랫폼 분포'],
    ['留存', 'Retention', '留存', '継続利用', '리텐션'],
    ['帳戶在註冊後是否持續回來使用', 'Whether registered accounts keep returning', '账户注册后是否持续回来使用', '登録後も継続して利用しているか', '가입한 계정의 지속적인 재방문 여부'],
    ['回饋與資料來源', 'Feedback and data sources', '反馈与数据来源', 'フィードバックとデータソース', '피드백 및 데이터 소스'],
    ['問題回饋、各項數據定義與更新時間', 'Feedback, metric definitions and update times', '问题反馈、各项数据定义与更新时间', '問題報告・指標の定義・更新日時', '문제 보고, 지표 정의 및 업데이트 시간'],
    ['上架與原價／CP 查找；查找和評估分別計件，不相加成商品總數', 'Listings and retail/CP lookups; lookup and evaluation counts are separate, not a product total', '上架与原价／CP 查找；查找和评估分开计件，不相加为商品总数', '掲載と新品価格・CPの確認。検索と評価は別々に数え、商品総数として合算しません', '게시 및 정가/CP 검색. 검색과 평가는 별도 건수이며 상품 총수로 합산하지 않음']
  ];
  const messages = Object.fromEntries(locales.map((locale, i) => [locale, Object.fromEntries(rows.map(row => [row[0], row[i]]))]));
  const lang = (document.documentElement.lang || 'zh-Hant').toLowerCase();
  const locale = /^zh-(cn|hans|sg)/.test(lang) ? 'zh-CN' : /^zh/.test(lang) ? 'zh-TW' : locales.find(l => l === lang.split('-')[0]) || 'en';
  const t = (key, vars = {}) => (messages[locale][key] || messages.en[key] || key).replace(/\{(\w+)\}/g, (token, name) => vars[name] == null ? token : String(vars[name]));
  window.HubWishlistText = { t, locale, locales, messages };
})();
