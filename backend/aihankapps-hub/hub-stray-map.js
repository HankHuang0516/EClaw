/* global window, document */
/* Aggregates only. The collector never transfers an animal, source post, photo or location. */
(function () {
  'use strict';

  const LOCALES = ['zh-TW', 'en', 'zh-CN', 'ja', 'ko'];
  const ROWS = [
    ['title', '通報智慧統計', 'Animal report insights', '通报智慧统计', '動物通報の統計', '동물 제보 통계'],
    ['subtitle', '既有地圖紀錄與外部線索分開計算', 'Existing map records and external tips are counted separately', '现有地图记录与外部线索分开计算', '既存の地図記録と外部情報を別々に集計', '기존 지도 기록과 외부 정보를 별도로 집계'],
    ['existing', '既有地圖紀錄', 'Existing map records', '现有地图记录', '既存の地図記録', '기존 지도 기록'],
    ['external', '外部公開線索', 'External public tips', '外部公开线索', '外部の公開情報', '외부 공개 정보'],
    ['unknown', '待確認', 'Unknown', '待确认', '未確認', '확인 필요'],
    ['unconnected', '未接通', 'Not connected', '未接通', '未接続', '연결되지 않음'],
    ['empty', '尚未匯入通報統計。', 'Report statistics have not been imported yet.', '尚未导入通报统计。', '通報統計はまだ取り込まれていません。', '제보 통계가 아직 수집되지 않았습니다.'],
    ['interrupted', '統計來源讀取中斷。', 'The statistics source is unavailable.', '统计来源读取中断。', '統計ソースを読み取れません。', '통계 소스를 읽을 수 없습니다.'],
    ['stale', '來源尚未更新；以下保留上次讀數與時間。', 'The source has not updated; the last reading and its time are shown below.', '来源尚未更新；以下保留上次读数与时间。', 'ソースが更新されていないため、前回の数値と日時を表示しています。', '소스가 갱신되지 않아 마지막 수치와 시간을 표시합니다.'],
    ['current', '未刪除通報', 'Reports not deleted', '未删除通报', '未削除の通報', '삭제되지 않은 제보'],
    ['visible', '符合公開條件', 'Eligible for public queries', '符合公开条件', '公開条件を満たす記録', '공개 조건을 충족하는 기록'],
    ['deleted', '已刪除紀錄', 'Deleted records', '已删除记录', '削除済みの記録', '삭제된 기록'],
    ['new7d', '近 7 天建立', 'Created in 7 days', '近 7 天建立', '過去7日間に作成', '최근 7일 생성'],
    ['new30d', '近 30 天建立', 'Created in 30 days', '近 30 天建立', '過去30日間に作成', '최근 30일 생성'],
    ['count', '筆數', 'Count', '笔数', '件数', '건수'],
    ['category', '類別', 'Category', '类别', '分類', '분류'],
    ['type', '動物類型', 'Animal types', '动物类型', '動物の種類', '동물 유형'],
    ['status', '目前狀態', 'Current status', '当前状态', '現在の状態', '현재 상태'],
    ['trend', '建立趨勢', 'Creation trend', '建立趋势', '作成日の推移', '생성 추이'],
    ['date', '日期（台北時間）', 'Date (Taipei)', '日期（台北时间）', '日付（台北時間）', '날짜 (타이베이 시간)'],
    ['period', '趨勢範圍', 'Trend period', '趋势范围', '推移の期間', '추이 기간'],
    ['days7', '近 7 個完整日', 'Last 7 complete days', '近 7 个完整日', '直近7日間（完了日）', '최근 완료된 7일'],
    ['days30', '近 30 個完整日', 'Last 30 complete days', '近 30 个完整日', '直近30日間（完了日）', '최근 완료된 30일'],
    ['trendNote', '依目前未刪除紀錄的建立日回推，不是歷史當天的地圖存量。', 'Reconstructed from creation dates of records still present, not the map population on past days.', '按当前未删除记录的建立日回推，并非历史当天的地图存量。', '未削除記録の作成日から再集計した値です。過去の地図上の件数ではありません。', '현재 남아 있는 기록의 생성일 기준이며 과거 당시 지도 기록 수가 아닙니다.'],
    ['none', '此範圍沒有紀錄。', 'No records in this scope.', '此范围没有记录。', 'この範囲に記録はありません。', '이 범위에 기록이 없습니다.'],
    ['received', '收到線索', 'Tips received', '收到线索', '受信した情報', '접수된 정보'],
    ['deduplicated', '疑似重複', 'Suspected duplicates', '疑似重复', '重複の可能性', '중복 의심'],
    ['pending', '待審', 'Pending review', '待审', '審査待ち', '검토 대기'],
    ['rejected', '審核未通過', 'Review declined', '审核未通过', '審査不承認', '검토 미승인'],
    ['published', '實際上圖', 'Published on map', '实际上图', '地図に公開済み', '지도에 공개됨'],
    ['externalNote', '正式匯入 API 尚未驗證，巡查維持只讀。沒有接通的階段不填成 0。', 'The formal intake API is not verified; patrols remain read-only. Unconnected stages are not zero.', '正式导入 API 尚未验证，巡查维持只读。未接通的阶段不填为 0。', '正式な受付APIは未検証です。巡回は読み取り専用とし、未接続の段階を0件とは表示しません。', '공식 접수 API는 검증 전이며 순찰은 읽기 전용입니다. 미연결 단계를 0건으로 표시하지 않습니다.'],
    ['region', '粗粒度區域', 'Broad regions', '粗粒度区域', '広域の地域', '넓은 지역 구분'],
    ['regionNote', '尚無經核對的粗粒度區域彙總；不傳送座標、地址或敏感棲地。', 'No verified broad-region aggregate is available. Coordinates, addresses and sensitive habitats are not transferred.', '尚无核实的粗粒度区域汇总；不传送坐标、地址或敏感栖息地。', '検証済みの広域集計はありません。座標、住所、保護すべき生息地は転送しません。', '검증된 광역 집계가 없습니다. 좌표, 주소 및 민감한 서식지는 전송하지 않습니다.'],
    ['provenance', '既有紀錄沒有原生／外部來源標記，不能回推來源，也未辨識 QA 紀錄。', 'Existing records lack native/external provenance and QA classification; neither is inferred.', '现有记录没有原生／外部来源标记，不能反推来源，也未识别 QA 记录。', '既存記録にアプリ／外部由来やQAの区分がないため、推定しません。', '기존 기록에 앱/외부 출처 및 QA 구분이 없어 추정하지 않습니다.'],
    ['scope', '統計範圍', 'Scope', '统计范围', '集計範囲', '통계 범위'],
    ['scopeNote', '正式資料庫目前保留的紀錄；數量不代表不同動物或救援案件。', 'Records currently retained in the production database; counts are not distinct animals or rescue cases.', '正式数据库当前保留的记录；数量不代表不同动物或救援案件。', '本番データベースに現在残る記録です。動物の個体数や救助件数ではありません。', '운영 데이터베이스에 현재 남은 기록이며 개체 수나 구조 건수가 아닙니다.'],
    ['mapNote', '公開條件數量包含已領養，尚未套用畫面範圍、個人封鎖、篩選與單次 1,000 筆上限。', 'Public-query candidates include adopted records, before viewport, personal blocks, filters and the 1,000-record request limit.', '公开条件数量含已领养，尚未应用画面范围、个人屏蔽、筛选与单次 1,000 笔上限。', '公開候補には譲渡済みも含まれます。表示範囲、個人のブロック、絞り込み、1回1,000件の上限は適用前です。', '공개 후보에는 입양된 기록도 포함되며 화면 범위, 개인 차단, 필터 및 요청당 1,000건 제한 적용 전입니다.'],
    ['asOf', '資料更新', 'Data observed', '数据更新', 'データ取得日時', '데이터 확인 시각'],
    ['cadence', '透過既有收集工具每日更新。', 'Updated daily through the existing collector.', '通过现有收集工具每日更新。', '既存の収集ツールで毎日更新します。', '기존 수집 도구로 매일 갱신합니다.'],
    ['cat', '貓', 'Cat', '猫', '猫', '고양이'], ['dog', '狗', 'Dog', '狗', '犬', '개'],
    ['bird', '鳥', 'Bird', '鸟', '鳥', '새'], ['rabbit', '兔', 'Rabbit', '兔', 'ウサギ', '토끼'],
    ['crocodile', '鱷魚', 'Crocodile', '鳄鱼', 'ワニ', '악어'], ['other', '其他', 'Other', '其他', 'その他', '기타'],
    ['recently_seen', '最近目擊', 'Recently seen', '最近目击', '最近の目撃', '최근 목격'],
    ['not_seen_recently', '近期未目擊', 'Not seen recently', '近期未目击', '最近の目撃なし', '최근 목격 없음'],
    ['cared_for', '有人照顧', 'Being cared for', '有人照顾', '世話を受けている', '돌봄을 받고 있음'],
    ['adopted', '已領養', 'Adopted', '已领养', '譲渡済み', '입양됨'],
    ['hospitalized', '已送醫', 'Receiving medical care', '已送医', '治療中', '치료 중'],
    ['deceased', '已死亡', 'Deceased', '已死亡', '死亡', '사망']
  ];
  const messages = Object.fromEntries(LOCALES.map((locale, i) => [locale, Object.fromEntries(ROWS.map(r => [r[0], r[i + 1]]))]));
  function language() {
    const lang = (document.documentElement.lang || 'zh-Hant').toLowerCase();
    return /^zh-(cn|hans|sg)/.test(lang) ? 'zh-CN' : /^zh/.test(lang) ? 'zh-TW' : LOCALES.find(l => l === lang.split('-')[0]) || 'en';
  }
  const t = key => messages[language()][key] || messages.en[key] || messages.en.other;
  const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const n = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const format = value => n(value) === null ? t('unknown') : value.toLocaleString(language());
  const date = value => Number.isSafeInteger(value) && value > 0 ? new Date(value).toLocaleString(language(), { timeZone: 'Asia/Taipei', hour12: false }) : t('unknown');

  function fromFacts(facts, imports, now = Date.now()) {
    const f = (facts || {}).smMapStats;
    const valid = f && f.v === 1 && f.source === 'stray-map' && Number.isSafeInteger(f.asOf) && f.asOf > 0 && f.asOf <= now + 3600000;
    const failed = imports && imports.ok === false;
    return { snapshot: valid ? f : null, state: failed ? 'interrupted' : !valid ? 'empty' : now - f.asOf > 36 * 3600000 ? 'stale' : 'current' };
  }

  function buckets(rows) {
    if (!Array.isArray(rows)) return null;
    const groups = new Map();
    rows.filter(r => Array.isArray(r) && r.length === 2 && n(r[1]) !== null).forEach(r => {
      const key = typeof r[0] === 'string' && /^[a-z_]{2,30}$/.test(r[0]) && messages.en[r[0]] ? r[0] : 'other';
      groups.set(key, (groups.get(key) || 0) + r[1]);
    });
    return Array.from(groups);
  }

  function table(title, rows, dateRows) {
    const body = rows === null ? '<p class="empty">' + esc(t('unknown')) + '</p>' : !rows.length ? '<p class="empty">' + esc(t('none')) + '</p>' :
      '<div class="tbl-wrap"><table class="tbl sm-table"><thead><tr><th scope="col">' + esc(t(dateRows ? 'date' : 'category')) + '</th><th scope="col" class="num">' + esc(t('count')) + '</th></tr></thead><tbody>' +
      rows.map(r => '<tr><th scope="row">' + esc(dateRows ? r[0] : t(r[0])) + '</th><td class="num">' + esc(format(r[1])) + '</td></tr>').join('') + '</tbody></table></div>';
    return '<section class="sm-section"><h3>' + esc(t(title)) + '</h3>' + body + '</section>';
  }

  function mount(el, model) {
    let days = 7;
    const data = model || { snapshot: null, state: 'empty' }, s = data.snapshot, native = s && s.native || {};
    function paint() {
      const status = data.state === 'current' ? '' : '<p class="note" role="status">' + esc(t(data.state)) + (s && data.state === 'interrupted' ? ' ' + esc(t('stale')) : '') + '</p>';
      const cells = ['current', 'visible', 'deleted', 'new7d', 'new30d'].map((key, i) => '<div class="dm-c"><span>' + esc(t(key)) + '</span><b>' + esc(format(native[['notDeleted', 'mapVisible', 'deleted', 'new7d', 'new30d'][i]])) + '</b></div>').join('');
      const daily = !s || !Array.isArray(s.days) ? null : s.days.filter(r => Array.isArray(r) && /^\d{4}-\d{2}-\d{2}$/.test(r[0]) && n(r[1]) !== null).slice(-days);
      const trend = '<section class="sm-section sm-trend"><header class="sm-heading"><h3>' + esc(t('trend')) + '</h3><label>' + esc(t('period')) + ' <select class="field" data-sm-period><option value="7"' + (days === 7 ? ' selected' : '') + '>' + esc(t('days7')) + '</option><option value="30"' + (days === 30 ? ' selected' : '') + '>' + esc(t('days30')) + '</option></select></label></header>' +
        table('existing', daily, true) + '<p class="hint">' + esc(t('trendNote')) + '</p></section>';
      const pipeline = '<section class="sm-section"><h3>' + esc(t('external')) + '</h3><div class="tbl-wrap"><table class="tbl sm-table"><thead><tr><th scope="col">' + esc(t('status')) + '</th><th scope="col" class="num">' + esc(t('count')) + '</th></tr></thead><tbody>' +
        ['received', 'deduplicated', 'pending', 'rejected', 'published'].map(key => '<tr><th scope="row">' + esc(t(key)) + '</th><td class="num">' + esc(t('unconnected')) + '</td></tr>').join('') + '</tbody></table></div><p class="hint">' + esc(t('externalNote')) + '</p></section>';
      el.innerHTML = '<section class="card sm-card" aria-labelledby="sm-title"><header class="card-h"><div class="card-t"><h2 id="sm-title">' + esc(t('title')) + '</h2><p class="sub">' + esc(t('subtitle')) + '</p></div></header>' + status +
        '<div class="dm">' + cells + '</div><p class="hint">' + esc(t('asOf')) + ' ' + esc(date(s && s.asOf)) + ' · Asia/Taipei</p>' +
        '<div class="sm-grid">' + table('type', buckets(s && s.types)) + table('status', buckets(s && s.statuses)) + trend + pipeline + '</div>' +
        '<section class="sm-section"><h3>' + esc(t('region')) + '</h3><p class="hint">' + esc(t('regionNote')) + '</p></section>' +
        '<footer class="sm-scope"><p><b>' + esc(t('scope')) + '</b> · ' + esc(t('scopeNote')) + '</p><p>' + esc(t('mapNote')) + '</p><p>' + esc(t('provenance')) + '</p><p>' + esc(t('cadence')) + '</p></footer></section>';
    }
    el.onchange = e => {
      if (e.target.matches('[data-sm-period]')) { days = e.target.value === '30' ? 30 : 7; paint(); el.querySelector('[data-sm-period]').focus({ preventScroll: true }); }
    };
    paint();
    return { destroy() { el.onchange = null; } };
  }
  function sourceRow(facts, imports) {
    const model = fromFacts(facts, imports);
    return '<li><span class="feed-k">' + esc(t('existing')) + '</span><span class="feed-t"><b>' + esc(t('title')) + '</b> ' + esc(t('subtitle')) + '</span><time class="muted">' + esc(model.snapshot ? date(model.snapshot.asOf) : t('unconnected')) + '</time></li>';
  }
  window.HubStrayMap = { mount, fromFacts, sourceRow, messages, language };
})();
