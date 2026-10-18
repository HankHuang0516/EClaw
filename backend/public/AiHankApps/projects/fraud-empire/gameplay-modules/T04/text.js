/* Proposal-only locale, kept inside module ownership. Host may supply t(key). */
((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FraudT04Text = api;
})(globalThis, () => ({
  title: 'T04｜兩個視窗的一場戲', notice: 'MG-P03 操作提案・尚未定案／golden 未交付／UI 未驗收',
  boundary: '僅成年虛構故事。這是可操作的規則預覽；不發正式獎勵、不寫正式存檔。新版工序時間未定，預覽停表，不套用舊版20分鐘／100分。',
  goal: '目標：讀取買家、客服、唱片三路來源；選片段再點時間格，對齊交付前的同一刻；標記兩個聲稱，指出唱片位置，交班後附上柯嵐後續。',
  start: '開始預覽', intro: '返回說明', work: '回到工作', summary: '查看事件夾', exit: '退出預覽', reset: '重設此預覽', confirmReset: '確認清空本次預覽', cancelReset: '保留本次進度', resetNotice: '重設會清空此實例的提案進度；不影響正式存檔。',
  buyer: '銀帽｜買家聲稱', service: '方塊台｜客服聲稱', record: '唱片｜原始訂單',
  read: '查看固定片段', select: '選取片段', remove: '撤回片段', mark: '標記矛盾來源',
  before: '交付前・同一刻', later: '較後時刻・不吻合', unplaced: '尚未放置',
  seekBefore: '播放頭：交付前', seekLater: '播放頭：較後時刻', timeline: '共同播放頭與三路對齊',
  seller: '唱片仍在柯嵐手中', buyerOwner: '唱片已在銀帽手中',
  stop: '選擇中止交易', dispute: '選擇保留爭議結案', handoff: '確認分支並交班一次',
  readFollowup: '讀取柯嵐後續', archive: '把後續放入事件夾', previewStop: '唯讀預覽中止片尾', previewDispute: '唯讀預覽爭議片尾',
  result: '提案事件夾已封存；正式獎勵0，不寫正式存檔。', pending: '尚未完成：',
  gap_start: '開始事件', gap_view: '讀取三路來源', gap_align: '三路與播放頭須在交付前', gap_contradiction: '標記買家及客服兩個聲稱', gap_location: '確認唱片仍在賣家手中',
  ready: '對齊完成，可選分支並交班。', selectedLabel: '已選取：', branchLabel: '唯一分支：',
  branch_stop: '中止交易：唱片留在柯嵐；故事模擬入帳0。', branch_dispute: '爭議結案：固定片尾呈現故事模擬入帳12，保留追索與不信任；不轉換業績資源。',
  artNotice: '缺 MG-P03 三路同步／唱片缺角揭露／人物後續 golden。下方是明示的操作示意，不是完成遊戲畫面。舊 T04 整頁示意不能冒充新規則素材。',
  stale: '過期或重送操作已忽略。', readonly: '本事件已交班，不能修改或再次結算。', startFirst: '請先開始事件。', already: '事件已開始。', source: '來源不存在。', readFirst: '先查看這一路固定片段。', selectFirst: '先選取來源片段，再點時間格。', time: '時間格不存在。', empty: '這一路沒有可撤回片段。', alignFirst: '三路與播放頭尚未同刻；可撤回或重新放置。', claimOnly: '訂單是原始狀態，不是角色聲稱。', wrongOwner: '交付前唱片仍在柯嵐手中；請重新檢視原始來源，不扣資源。', incomplete: '必要來源、時間、位置或分支尚未完成，不能交班。', branch: '分支不存在。', followupFirst: '先讀取已選分支的柯嵐後續，再放入事件夾。', unknown: '此預覽沒有這個操作。',
  updated: '狀態已更新。', started: '事件已開始，閱讀不耗時。', reading: '回看同一事件，不耗時、不倒退進度。',
  read_buyer: '銀帽聲稱交易失敗。這是角色聲稱，並非已確認事實。',
  read_service: '方塊台提出與原始訂單衝突的聲稱；保留來源，不把聲稱覆蓋訂單。',
  read_record: '交付前原始訂單仍未付款；唱片仍在柯嵐手中。',
  selected: '片段已選取，請點同一刻的時間格。', cancelled: '選取或未確認分支已取消。', placed: '片段已放在交付前；其他來源仍須對齊。', wrongTime: '時刻不同；這一路尚未對齊，可撤回或移回交付前。', removed: '片段已撤回，舊的矛盾標記已清除。', marked: '矛盾來源標記已更新。', located: '唱片位置已保留，聲稱不會改變原始物件狀態。', confirmBranch: '分支尚未鎖定；確認前可取消或改選。', handedOff: '本事件已單次交班，請讀取並附上人物後續。',
  followup_stop: '柯嵐鬆一口氣；唱片保留，冒名客服紀錄仍在。', followup_dispute: '柯嵐的不信任與追索仍在；結案不代表後果消失。',
  preview_stop: '另一片尾唯讀示意：中止讓柯嵐保留唱片。不改變本次已選分支。', preview_dispute: '另一片尾唯讀示意：爭議保留追索與不信任。不改變本次已選分支。', archived: '人物後續已附上；只輸出一次預覽結果。', cancel: '取消選取／待確認分支'
}));
