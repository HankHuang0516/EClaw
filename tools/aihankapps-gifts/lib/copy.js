'use strict';

// Every sentence the public sees about a campaign is composed here, once, when the campaign is
// drafted. The result is stored in the campaign file and frozen at approval, so later template
// edits never change an approved campaign (the Typeforge mailbox rejects a re-delivery whose
// text differs from the first one).
const { formatTaipei, formatTaipeiDate } = require('./time');

const LOCALES = ['zh-TW', 'zh-CN', 'en', 'ja', 'ko'];

const TEXT = {
  'zh-TW': {
    title: holiday => `${holiday}禮包`,
    intro: holiday => `${holiday}禮包會寄進遊戲內信箱，打開信箱就能領取。`,
    game: (name, contents) => `《${name}》：${contents}。`,
    value: twd => `商品標價換算約 NT$${twd}，非現金價值。`,
    eligibility: (from, to) => `${from} 至 ${to}（台北時間）之間已有帳號或新加入的玩家，每帳號一封；新帳號通常在加入後一天內收到。`,
    starts: at => `開始寄送：${at}（台北時間）。`,
    deadline: at => `領取截止：${at}（台北時間），到期後無法領取。`,
    pending: '寄送數量核對後會更新在這裡。',
    receipt: (name, count, at) => `《${name}》已寄出 ${count} 封（${at} 核對）；這是寄送數，不代表領取數。`,
    period: (from, to) => `${from} – ${to}`,
    total: count => `共寄出 ${count} 封`,
    joiner: '、',
    gap: ''
  },
  'zh-CN': {
    title: holiday => `${holiday}礼包`,
    intro: holiday => `${holiday}礼包会寄进游戏内信箱，打开信箱就能领取。`,
    game: (name, contents) => `《${name}》：${contents}。`,
    value: twd => `商品标价换算约 NT$${twd}，非现金价值。`,
    eligibility: (from, to) => `${from} 至 ${to}（台北时间）之间已有账号或新加入的玩家，每账号一封；新账号通常在加入后一天内收到。`,
    starts: at => `开始寄送：${at}（台北时间）。`,
    deadline: at => `领取截止：${at}（台北时间），到期后无法领取。`,
    pending: '寄送数量核对后会更新在这里。',
    receipt: (name, count, at) => `《${name}》已寄出 ${count} 封（${at} 核对）；这是寄送数，不代表领取数。`,
    period: (from, to) => `${from} – ${to}`,
    total: count => `共寄出 ${count} 封`,
    joiner: '、',
    gap: ''
  },
  en: {
    title: holiday => `${holiday} gift`,
    intro: holiday => `The ${holiday} gift is delivered to your in-game mailbox. Open the mailbox to claim it.`,
    game: (name, contents) => `${name}: ${contents}.`,
    value: twd => `Approximate listed item value: NT$${twd}. No cash value.`,
    eligibility: (from, to) => `Every account that exists or joins between ${from} and ${to} (Taipei time) receives one mail. New accounts usually receive it within a day of joining.`,
    starts: at => `Delivery starts ${at} (Taipei time).`,
    deadline: at => `Claim by ${at} (Taipei time). Unclaimed gifts expire after that.`,
    pending: 'The delivery count will appear here once it has been verified.',
    receipt: (name, count, at) => `${name}: ${count} mails delivered (verified ${at}). This is a delivery count, not a claim count.`,
    period: (from, to) => `${from} – ${to}`,
    total: count => `${count} mails delivered`,
    joiner: ', ',
    gap: ' '
  },
  ja: {
    title: holiday => `${holiday}ギフト`,
    intro: holiday => `${holiday}ギフトをゲーム内メールにお届けします。メールを開いて受け取ってください。`,
    game: (name, contents) => `「${name}」：${contents}。`,
    value: twd => `商品表示価格換算で約NT$${twd}。現金価値はありません。`,
    eligibility: (from, to) => `${from}から${to}（台北時間）までに存在する、または新しく参加したアカウントに1通ずつ配布します。新規アカウントには通常、参加から1日以内に届きます。`,
    starts: at => `配布開始：${at}（台北時間）。`,
    deadline: at => `受取期限：${at}（台北時間）。期限後は受け取れません。`,
    pending: '配布数は確認後にここへ掲載します。',
    receipt: (name, count, at) => `「${name}」：${count}通を配布済み（${at}確認）。受取数ではなく配布数です。`,
    period: (from, to) => `${from} – ${to}`,
    total: count => `配布数 ${count}通`,
    joiner: '、',
    gap: ''
  },
  ko: {
    title: holiday => `${holiday} 선물`,
    intro: holiday => `${holiday} 선물이 게임 내 우편함으로 발송됩니다. 우편함을 열어 받으세요.`,
    game: (name, contents) => `「${name}」: ${contents}.`,
    value: twd => `표시 상품 가격 기준 약 NT$${twd}. 현금 가치가 아닙니다.`,
    eligibility: (from, to) => `${from}부터 ${to}(타이베이 시간)까지 이미 있거나 새로 가입한 계정에 우편 1통씩 발송됩니다. 신규 계정은 보통 가입 후 하루 안에 받습니다.`,
    starts: at => `발송 시작: ${at}(타이베이 시간).`,
    deadline: at => `수령 마감: ${at}(타이베이 시간). 마감 후에는 받을 수 없습니다.`,
    pending: '발송 수는 확인 후 여기에 표시됩니다.',
    receipt: (name, count, at) => `「${name}」: 우편 ${count}통 발송 완료(${at} 확인). 수령 수가 아닌 발송 수입니다.`,
    period: (from, to) => `${from} – ${to}`,
    total: count => `우편 ${count}통 발송`,
    joiner: ', ',
    gap: ' '
  }
};

function number(value) {
  return Number(value).toLocaleString('en-US');
}

// { sparks: 3000, revive_card: 1 } -> "火花 3,000 點、戰機復活卡 1 張" in reward-catalogue order
function rewardContents(game, reward, locale) {
  return Object.keys(game.rewardItems)
    .filter(key => reward[key] > 0)
    .map(key => game.rewardItems[key].labels[locale].replace('{n}', number(reward[key])))
    .join(TEXT[locale].joiner);
}

// Listed-price estimate for the public "約 NT$…" line; null when any item has no listed price.
function listedTwd(game, reward) {
  let total = 0;
  for (const [key, amount] of Object.entries(reward)) {
    const perUnit = game.rewardItems[key] && game.rewardItems[key].listedTwdPerUnit;
    if (typeof perUnit !== 'number') return null;
    total += perUnit * amount;
  }
  return Math.round(total);
}

// Public announcement copy for one locale. `gameEntries` is [{ game, reward }].
function publicCopy(locale, holidayName, gameEntries, times) {
  const text = TEXT[locale];
  return {
    title: text.title(holidayName),
    intro: text.intro(holidayName),
    games: gameEntries.map(({ game, reward }) => {
      const twd = listedTwd(game, reward);
      return {
        gameId: game.id,
        name: game.names[locale],
        line: text.game(game.names[locale], rewardContents(game, reward, locale)),
        ...(twd === null ? {} : { value: text.value(number(twd)) }),
        // What a player of this game has to do to receive mail, when it is not automatic.
        ...(game.receiveNotes ? { note: game.receiveNotes[locale] } : {})
      };
    }),
    eligibility: text.eligibility(formatTaipei(times.startsAt), formatTaipei(times.deliveryEndsAt)),
    starts: text.starts(formatTaipei(times.startsAt)),
    deadline: text.deadline(formatTaipei(times.claimEndsAt))
  };
}

// The in-game mail is one string for every player, so it carries Traditional Chinese and
// English together. No emoji: the games' fonts are not guaranteed to have the glyphs.
function mailText(holidayNames, game, reward, times) {
  const deadline = formatTaipei(times.claimEndsAt);
  return {
    subject: `${TEXT['zh-TW'].title(holidayNames['zh-TW'])}｜${TEXT.en.title(holidayNames.en)}`,
    body: `${holidayNames['zh-TW']}禮包已送達：${rewardContents(game, reward, 'zh-TW')}。` +
      `請在 ${deadline}（台北時間）前領取，到期後無法領取。\n\n` +
      `Your ${holidayNames.en} gift has arrived: ${rewardContents(game, reward, 'en')}. ` +
      `Claim it by ${deadline} (Taipei time, UTC+8). Unclaimed gifts expire after that.`
  };
}

// Receipt and history lines are composed at build time from the receipts recorded so far.
function receiptLine(locale, gameName, receipt) {
  return TEXT[locale].receipt(gameName, number(receipt.mails), formatTaipei(receipt.verifiedAt));
}

function pendingLine(locale) {
  return TEXT[locale].pending;
}

function endedLine(locale, times, totalMails) {
  const text = TEXT[locale];
  const period = text.period(formatTaipeiDate(times.startsAt), formatTaipeiDate(times.claimEndsAt));
  return totalMails === null ? period : `${period}｜${text.total(number(totalMails))}`;
}

module.exports = {
  LOCALES, TEXT, number, rewardContents, listedTwd, publicCopy, mailText, receiptLine, pendingLine, endedLine
};
