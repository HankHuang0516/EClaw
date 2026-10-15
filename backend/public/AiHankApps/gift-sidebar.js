(() => {
  'use strict';
  const disclosure = document.getElementById('game-gifts');
  if (!disclosure) return;
  // This standalone portfolio has no shared i18n bundle. Keep gift copy local.
  const translations = {
    en: {
      entry: 'Gift announcements', details: 'View gift details',
      celebrationTitle: 'Elemental Fighter 350 | Paper Flick Soldiers celebration gift',
      issued: 'Celebrating Paper Flick Soldiers. Gifts have been delivered to the in-game mailbox.',
      eligibility: 'One mail per eligible account that existed when distribution began. Open your in-game mailbox to claim the attachments.',
      contents: '6,000 Sparks, plus one each: fighter revive, 1-hour double loot card, 1-hour double Sparks card, and skill reset card.',
      value: 'Approximate listed item value: NT$300. No cash value.',
      deadline: 'Issued from 2026/10/07 18:53:52. Claim by 2026/11/07 18:53:52 (Taipei time), one calendar month later. Expired gifts cannot be claimed.',
      count: '146 mails delivered. This is a delivery count, not a claim count.',
      verified: 'Verified 2026/10/07 18:53:53 (Taipei): 0 delivery failures, 0 duplicates; 4 QA test accounts excluded.',
      remaining: 'Time left: {d}d {h}h {m}m {s}s', ended: 'Claim period ended'
    },
    'zh-TW': {
      entry: '禮包公告', details: '查看禮包詳情',
      celebrationTitle: '元素戰機350｜《紙上彈兵》普天同慶禮包',
      issued: 'Elemental Fighter 350 · 慶祝《紙上彈兵》，禮包已寄進遊戲信箱。',
      eligibility: '發放開始時的現有有效玩家，每帳號一封；請打開遊戲信箱領取附件。',
      contents: '火花 6,000 點、戰機復活卡／1H 戰利品加倍卡／1H 火花加倍卡／技能樹重置卡各 1 張。',
      value: '商品標價換算約 NT$300，非現金價值。',
      deadline: '2026/10/07 18:53:52 起發放，領取截止為 2026/11/07 18:53:52（台北時間），期限為一個日曆月；到期無法領取。',
      count: '已寄出 146 封；這是寄送核對結果，不代表全部已領取。',
      verified: '2026/10/07 18:53:53 核對，寄送失敗 0 封、重複 0 封，已排除 4 個 QA 測試帳號。',
      remaining: '倒數 {d} 天 {h} 時 {m} 分 {s} 秒', ended: '領取期限已截止'
    },
    'zh-CN': {
      entry: '礼包公告', details: '查看礼包详情',
      celebrationTitle: '元素战机350｜《纸上弹兵》普天同庆礼包',
      issued: 'Elemental Fighter 350 · 庆祝《纸上弹兵》，礼包已寄进游戏信箱。',
      eligibility: '发放开始时的现有有效玩家，每账号一封；请打开游戏信箱领取附件。',
      contents: '火花 6,000 点、战机复活卡／1H 战利品加倍卡／1H 火花加倍卡／技能树重置卡各 1 张。',
      value: '商品标价换算约 NT$300，非现金价值。',
      deadline: '2026/10/07 18:53:52 起发放，领取截止为 2026/11/07 18:53:52（台北时间），期限为一个日历月；到期无法领取。',
      count: '已寄出 146 封；这是寄送核对结果，不代表全部已领取。',
      verified: '2026/10/07 18:53:53 核对，寄送失败 0 封、重复 0 封，已排除 4 个 QA 测试账号。',
      remaining: '倒计时 {d} 天 {h} 时 {m} 分 {s} 秒', ended: '领取期限已截止'
    },
    ja: {
      entry: 'ギフトのお知らせ', details: 'ギフトの詳細を見る',
      celebrationTitle: 'Elemental Fighter 350｜「紙上彈兵」記念ギフト',
      issued: '「紙上彈兵」をお祝いするギフトをゲーム内メールに配布しました。',
      eligibility: '配布開始時点の対象プレイヤーに、1アカウントにつき1通。ゲーム内メールから添付アイテムを受け取ってください。',
      contents: 'スパーク6,000、戦闘機復活カード・1時間戦利品2倍カード・1時間スパーク2倍カード・スキルリセットカード各1枚。',
      value: '商品表示価格換算で約NT$300。現金価値はありません。',
      deadline: '2026/10/07 18:53:52より配布。受取期限は1暦月後の2026/11/07 18:53:52（台北時間）。期限後は受け取れません。',
      count: '146通を配布済み。受取済み人数ではなく、配布確認数です。',
      verified: '2026/10/07 18:53:53（台北時間）確認：配布失敗0、重複0。QAテストアカウント4件は対象外。',
      remaining: '残り {d}日 {h}時間 {m}分 {s}秒', ended: '受取期間は終了しました'
    },
    ko: {
      entry: '선물 공지', details: '선물 자세히 보기',
      celebrationTitle: 'Elemental Fighter 350 | 「紙上彈兵」 기념 선물',
      issued: '「紙上彈兵」을 기념하는 선물이 게임 내 우편함으로 발송되었습니다.',
      eligibility: '발송 시작 시점의 기존 대상 플레이어에게 계정당 우편 1통. 게임 내 우편함에서 첨부 아이템을 받으세요.',
      contents: '스파크 6,000개, 전투기 부활 카드·1시간 전리품 2배 카드·1시간 스파크 2배 카드·스킬 초기화 카드 각 1장.',
      value: '표시 상품 가격 기준 약 NT$300. 현금 가치가 아닙니다.',
      deadline: '2026/10/07 18:53:52부터 발송. 수령 마감은 한 달 뒤인 2026/11/07 18:53:52(타이베이 시간)이며, 만료 후에는 받을 수 없습니다.',
      count: '우편 146통 발송 완료. 수령 인원이 아닌 발송 확인 수입니다.',
      verified: '2026/10/07 18:53:53(타이베이 시간) 확인: 발송 실패 0건, 중복 0건. QA 테스트 계정 4개 제외.',
      remaining: '남은 시간: {d}일 {h}시간 {m}분 {s}초', ended: '수령 기간 종료'
    }
  };
  const campaigns = (window.AIHANK_GIFT_CAMPAIGNS || []).filter(campaign =>
    campaign.publication === 'published' && document.getElementById(campaign.id))
    .sort((a, b) => (b.startsAt || '').localeCompare(a.startsAt || ''));
  const list = document.getElementById('giftCampaignList');
  const countdown = document.getElementById('celebrationCountdown');
  const celebration = campaigns.find(campaign => campaign.titleElementId === 'celebrationGiftTitle');
  let copy;
  const updateCountdown = () => {
    if (!countdown || !celebration) return;
    const remaining = Math.max(0, Date.parse(celebration.endsAt) - Date.now());
    const parts = { d: Math.floor(remaining / 86400000), h: Math.floor(remaining / 3600000) % 24,
      m: Math.floor(remaining / 60000) % 60, s: Math.floor(remaining / 1000) % 60 };
    countdown.textContent = remaining ? copy.remaining.replace(/\{([dhms])\}/g, (_, key) =>
      key === 'd' ? parts[key] : String(parts[key]).padStart(2, '0')) : copy.ended;
  };
  const applyLanguage = () => {
    const lang = document.documentElement.lang || 'zh-Hant';
    const locale = /^zh-(Hant|TW|HK)/i.test(lang) ? 'zh-TW' : /^zh/i.test(lang) ? 'zh-CN' : lang.split('-')[0];
    copy = translations[locale] || translations.en;
    disclosure.querySelectorAll('[data-gift-i18n]').forEach(element => {
      const text = copy[element.dataset.giftI18n];
      if (text) element.textContent = text;
    });
    if (list) {
      list.replaceChildren();
      for (const campaign of campaigns) {
        const title = document.getElementById(campaign.titleElementId);
        if (!title) continue;
        const link = document.createElement('a');
        link.href = '#' + campaign.id;
        link.textContent = title.textContent;
        link.dataset.campaignId = campaign.id;
        list.appendChild(link);
      }
    }
    updateCountdown();
  };
  applyLanguage();
  if (countdown && celebration) window.setInterval(updateCountdown, 1000);
  new MutationObserver(applyLanguage).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  const desktop = window.matchMedia('(min-width: 980px)');
  const revealAnchor = () => {
    if (['#game-gifts', '#reboundGiftTitle', '#celebrationGiftTitle', ...campaigns.map(campaign => '#' + campaign.id)].includes(window.location.hash)) disclosure.open = true;
  };
  const updateLayout = () => {
    disclosure.open = desktop.matches;
    revealAnchor();
  };
  updateLayout();
  desktop.addEventListener('change', updateLayout);
  window.addEventListener('hashchange', revealAnchor);
})();
