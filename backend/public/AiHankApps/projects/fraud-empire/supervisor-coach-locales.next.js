(function(root,factory){
  'use strict';
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.FraudCoachLocales=factory();
})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  const data={
  "zh-TW": {
    "title": "主管提示",
    "settings": "提示與聲音設定",
    "enabled": "適時提醒",
    "manual": "提示下一步",
    "dismiss": "收起提示",
    "mute": "靜音",
    "volume": "音量偏好",
    "noAudio": "目前沒有可播放的音源；僅提供文字提示。",
    "context": "職階來自本頁 Demo 情境；不是正式玩家進度。關係數值尚未接入，不推算好感。",
    "proposal": "提醒秒數與次數是可調介面提案，不是已採用的遊戲平衡。",
    "ready": "不催順暢操作；需要時再提醒。",
    "paused": "閱讀、選單或離開畫面時暫停提醒。",
    "unknown": "尚無可用職階，不代入主管身份。",
    "hou": [
      "欸，票還在你手上啦。我那邊可不會自己少一份。",
      "看半天了，卡在哪？先把眼前這一小步處理掉。",
      "我在這等你，不是等這張桌子。慢慢來也得往前嘛。"
    ],
    "houSpecific": [
      "先別亂試，看這裡。",
      "欸欸，先做這一步就好。"
    ],
    "lin2": [
      "卡在這裡嗎？先不用急著提交。",
      "你先看清楚；需要時，我會把下一步指出來。"
    ],
    "lin3": [
      "你的做法我看到了，這一步再核對一下。",
      "先把手上這一步收好，我再往下接。"
    ],
    "lin4": [
      "你有自己的節奏；卡住的地方我們一起看。",
      "先別硬試，我幫你核對眼前這一步。"
    ],
    "lin5": [
      "這段由你掌握，我只補漏掉的細節。",
      "你先照自己的判斷走；需要時我補一步。"
    ],
    "linSpecific": [
      "先把這一步核對完。",
      "先看這裡，再決定怎麼做。"
    ],
    "trusted": "我知道你會仔細處理。",
    "strained": "這次先照眼前紀錄核對。",
    "hints": {
      "selectMoon": "先選月牙拼片，不是星星或雲。",
      "placeMoon": "把已選月牙放進陶可原票的月牙缺口。",
      "goBoard": "切回「展示板」，原票和進度會保留。",
      "selectTicket": "先選 {person} 的原票。",
      "placeTicket": "把 {person} 原票放到票面固定的 {seat} 展示位。",
      "reveal": "兩張 A 都在板上了；抬起目前上卡，查看下面那張。",
      "unselectPair": "先取消選取 {person}；B 不是重複承諾。",
      "selectPair": "選 {person} 的名字，和另一張 A 一起核對。",
      "mark": "陶可與畢安都選好了；按「標記所選兩張」。",
      "expectation": "先打開「查看 {person} 期待」閱讀，讀完關閉即可。",
      "inspect": "打開「翻看模型支架」，核對空支架與未接線狀態。",
      "goChoice": "已核對缺項；切到「故事選擇」。",
      "choice": "自行選一個分支先預覽；確認前都能取消，我不替你選。",
      "confirm": "確認預覽內容；你可以提交，也可以取消，不會自動選擇。",
      "goFollowup": "切回「人物後續」，保留已選分支。",
      "followup": "打開「查看 {person} 後續」，先讀同一張原票的後果。",
      "attach": "讀過 {person} 後續了，現在可以夾回原票。",
      "seal": "三人後續都已夾回；按「封存本批一次」，只結算一次。",
      "result": "本局已封存；返回只回看，不重發結果。",
      "goAssembly": "先切回「拼片」分頁，原票和進度會保留。"
    }
  },
  "en": {
    "title": "Supervisor",
    "settings": "Hints and audio",
    "enabled": "Timely reminders",
    "manual": "Next-step hint",
    "dismiss": "Dismiss",
    "mute": "Mute",
    "volume": "Volume preference",
    "noAudio": "No playable audio assets are available. Text hints only.",
    "context": "Rank comes from this page’s Demo context, not a formal player save. Relationship values are not connected; affinity is not inferred.",
    "proposal": "Timing and counts are adjustable interface proposals, not adopted game balance.",
    "ready": "No interruptions while you make progress.",
    "paused": "Reminders pause during reading, menus, or when you leave.",
    "unknown": "No valid rank is available; no supervisor identity is assumed.",
    "hou": [
      "Hey, those tickets are still in your hands. My pile won’t shrink on its own.",
      "You’ve been staring a while. Where are you stuck? One small step first.",
      "I’m waiting for you, not the desk. Take your time, but keep moving."
    ],
    "houSpecific": [
      "Stop guessing for a second. Look here.",
      "Hey, just this next step."
    ],
    "lin2": [
      "Stuck here? No need to submit in a rush.",
      "Look carefully first. I can point out the next step."
    ],
    "lin3": [
      "I see what you’re doing. Check this step once more.",
      "Finish this part, and I’ll take it from there."
    ],
    "lin4": [
      "You have your own pace. We can check the sticking point together.",
      "Don’t force it. Let’s check this step."
    ],
    "lin5": [
      "You’re leading this part. I’ll only fill in missed details.",
      "Use your judgment. I’ll add a step if you need it."
    ],
    "linSpecific": [
      "Check this step first.",
      "Look here before deciding."
    ],
    "trusted": "I know you’ll handle it carefully.",
    "strained": "Check against the record in front of you this time.",
    "hints": {
      "selectMoon": "Select the crescent piece, not the star or cloud.",
      "placeMoon": "Put the selected crescent into Tao Ke’s crescent gap.",
      "goBoard": "Return to the display board; tickets and progress stay intact.",
      "selectTicket": "Select {person}’s original ticket.",
      "placeTicket": "Place {person}’s ticket at its fixed display position {seat}.",
      "reveal": "Both A tickets are on the board. Lift the actual top ticket to see the one below.",
      "unselectPair": "Deselect {person} first. B is not the duplicate promise.",
      "selectPair": "Select {person}’s name to compare the two A tickets.",
      "mark": "Tao Ke and Bi An are selected. Mark the selected pair.",
      "expectation": "Open {person}’s expectations and read them, then close the panel.",
      "inspect": "Inspect the model support: an empty frame with no wiring.",
      "goChoice": "The required checks are done. Open the story-choice tab.",
      "choice": "Choose a branch to preview. You can cancel before confirming; I won’t choose for you.",
      "confirm": "Review the preview, then confirm or cancel. Nothing is chosen automatically.",
      "goFollowup": "Return to the follow-up tab; your chosen branch stays intact.",
      "followup": "Open {person}’s follow-up and read the consequence for that original ticket.",
      "attach": "You’ve read {person}’s follow-up. Attach it to the original ticket.",
      "seal": "All three follow-ups are attached. Seal this batch once for a single result.",
      "result": "This session is sealed. Returning only reviews it; no duplicate result.",
      "goAssembly": "Return to the assembly tab first; original tickets and progress stay intact."
    }
  },
  "zh-CN": {
    "title": "主管提示",
    "settings": "提示与声音设置",
    "enabled": "适时提醒",
    "manual": "提示下一步",
    "dismiss": "收起提示",
    "mute": "静音",
    "volume": "音量偏好",
    "noAudio": "目前没有可播放的音源；仅提供文字提示。",
    "context": "职阶来自本页 Demo 情境；不是正式玩家进度。关系数值尚未接入，不推算好感。",
    "proposal": "提醒秒数与次数是可调界面提案，不是已采用的游戏平衡。",
    "ready": "不打断顺畅操作；需要时再提醒。",
    "paused": "阅读、菜单或离开画面时暂停提醒。",
    "unknown": "尚无可用职阶，不代入主管身份。",
    "hou": [
      "欸，票还在你手上啦。我那边可不会自己少一份。",
      "看半天了，卡在哪？先把眼前这一小步处理掉。",
      "我在这等你，不是等这张桌子。慢慢来也得往前嘛。"
    ],
    "houSpecific": [
      "先别乱试，看这里。",
      "欸欸，先做这一步就好。"
    ],
    "lin2": [
      "卡在这里吗？先不用急着提交。",
      "你先看清楚；需要时，我会把下一步指出来。"
    ],
    "lin3": [
      "你的做法我看到了，这一步再核对一下。",
      "先把手上这一步收好，我再往下接。"
    ],
    "lin4": [
      "你有自己的节奏；卡住的地方我们一起看。",
      "先别硬试，我帮你核对眼前这一步。"
    ],
    "lin5": [
      "这段由你掌握，我只补漏掉的细节。",
      "你先照自己的判断走；需要时我补一步。"
    ],
    "linSpecific": [
      "先把这一步核对完。",
      "先看这里，再决定怎么做。"
    ],
    "trusted": "我知道你会仔细处理。",
    "strained": "这次先照眼前记录核对。",
    "hints": {
      "selectMoon": "先选月牙拼片，不是星星或云。",
      "placeMoon": "把已选月牙放进陶可原票的月牙缺口。",
      "goBoard": "切回「展示板」，原票和进度会保留。",
      "selectTicket": "先选 {person} 的原票。",
      "placeTicket": "把 {person} 原票放到票面固定的 {seat} 展示位。",
      "reveal": "两张 A 都在板上了；抬起目前上卡，查看下面那张。",
      "unselectPair": "先取消选取 {person}；B 不是重复承诺。",
      "selectPair": "选 {person} 的名字，和另一张 A 一起核对。",
      "mark": "陶可与毕安都选好了；按「标记所选两张」。",
      "expectation": "先打开「查看 {person} 期待」阅读，读完关闭即可。",
      "inspect": "打开「翻看模型支架」，核对空支架与未接线状态。",
      "goChoice": "已核对缺项；切到「故事选择」。",
      "choice": "自行选一个分支先预览；确认前都能取消，我不替你选。",
      "confirm": "确认预览内容；你可以提交，也可以取消，不会自动选择。",
      "goFollowup": "切回「人物后续」，保留已选分支。",
      "followup": "打开「查看 {person} 后续」，先读同一张原票的后果。",
      "attach": "读过 {person} 后续了，现在可以夹回原票。",
      "seal": "三人后续都已夹回；按「封存本批一次」，只结算一次。",
      "result": "本局已封存；返回只回看，不重发结果。",
      "goAssembly": "先切回「拼片」分页，原票和进度会保留。"
    }
  },
  "ja": {
    "title": "上司のヒント",
    "settings": "ヒントと音声の設定",
    "enabled": "必要なときに知らせる",
    "manual": "次の手順のヒント",
    "dismiss": "閉じる",
    "mute": "ミュート",
    "volume": "音量の設定",
    "noAudio": "再生できる音声素材は未提供です。文字のヒントのみ表示します。",
    "context": "階級はこのページのデモ設定です。正式なプレイヤーの進行ではありません。関係値は未接続で、好感度は推測しません。",
    "proposal": "通知の秒数と回数は調整可能なUI案で、採用済みのゲームバランスではありません。",
    "ready": "操作が進んでいる間は割り込みません。",
    "paused": "閲覧中、メニュー表示中、画面を離れた間は通知を止めます。",
    "unknown": "有効な階級がないため、上司を推定しません。",
    "hou": [
      "おい、まだ券を持ったままだぞ。こっちの仕事は勝手に減らないからな。",
      "ずっと見てるな。どこで詰まった？まず一つ進めろ。",
      "待ってるのはお前だ、机じゃない。ゆっくりでも先へ進もうぜ。"
    ],
    "houSpecific": [
      "当てずっぽうはやめて、ここを見ろ。",
      "おい、まずこの一手だけ。"
    ],
    "lin2": [
      "ここで止まった？急いで確定しなくていい。",
      "まずよく見て。必要なら次の手順を示す。"
    ],
    "lin3": [
      "進め方は見ている。この一手をもう一度確認して。",
      "この部分を終えたら、こちらで続ける。"
    ],
    "lin4": [
      "自分のペースでいい。詰まった点は一緒に確認しよう。",
      "無理に試さず、この一手を確認しよう。"
    ],
    "lin5": [
      "ここは任せる。私は見落としだけ補う。",
      "自分の判断で進めて。必要な一手だけ補う。"
    ],
    "linSpecific": [
      "まずこの手順を確認して。",
      "決める前に、ここを見て。"
    ],
    "trusted": "丁寧に扱ってくれると分かっている。",
    "strained": "今回は目の前の記録と照合して。",
    "hints": {
      "selectMoon": "星や雲ではなく、三日月のピースを選ぶ。",
      "placeMoon": "選んだ三日月を陶可の券の切り欠きに置く。",
      "goBoard": "展示板へ戻る。券と進行はそのまま残る。",
      "selectTicket": "{person} の元の券を選ぶ。",
      "placeTicket": "{person} の券を券面指定の展示位置 {seat} に置く。",
      "reveal": "Aの券が2枚そろった。実際の上の券を持ち上げ、下を確認する。",
      "unselectPair": "まず {person} の選択を外す。Bは重複した約束ではない。",
      "selectPair": "{person} の名前を選び、もう1枚のAと照合する。",
      "mark": "陶可と畢安を選択済み。選んだ2枚に印を付ける。",
      "expectation": "{person} の期待を開いて読み、閉じる。",
      "inspect": "模型の支柱を調べ、空の枠と未接続の配線を確認する。",
      "goChoice": "必要な確認は終わった。物語の選択画面へ。",
      "choice": "自分で分岐を選んでプレビューする。確定前は取り消せる。代わりに選ばない。",
      "confirm": "内容を確認し、確定するか取り消す。自動では選ばれない。",
      "goFollowup": "人物のその後へ戻る。選んだ分岐は残る。",
      "followup": "{person} のその後を開き、元の券に対応する結果を読む。",
      "attach": "{person} のその後を読んだので、元の券に添付できる。",
      "seal": "3人分を添付済み。この一括分を1回だけ封じ、結果を1回だけ記録する。",
      "result": "この回は封じてある。戻っても閲覧のみで結果は増えない。",
      "goAssembly": "まず「拼片」タブ（組立）へ戻ってください。元の券と進行はそのまま残ります。"
    }
  },
  "ko": {
    "title": "상사의 힌트",
    "settings": "힌트 및 소리 설정",
    "enabled": "필요할 때 알림",
    "manual": "다음 단계 힌트",
    "dismiss": "접기",
    "mute": "음소거",
    "volume": "음량 설정",
    "noAudio": "재생할 음원이 아직 없습니다. 텍스트 힌트만 제공합니다.",
    "context": "직급은 이 페이지의 데모 설정이며 정식 플레이어 진행도가 아닙니다. 관계 수치는 연결되지 않았으며 호감도를 추정하지 않습니다.",
    "proposal": "알림 시간과 횟수는 조정 가능한 UI 제안이며 확정된 게임 밸런스가 아닙니다.",
    "ready": "순조롭게 조작하는 동안에는 끼어들지 않습니다.",
    "paused": "읽기, 메뉴, 화면 이탈 중에는 알림을 멈춥니다.",
    "unknown": "유효한 직급이 없어 상사를 임의로 정하지 않습니다.",
    "hou": [
      "야, 아직 표 들고 있냐. 내 일은 저절로 줄지 않는다고.",
      "한참 보고 있네. 어디서 막혔어? 한 단계만 먼저 해.",
      "책상 말고 너 기다리는 거야. 천천히 해도 앞으로는 가자."
    ],
    "houSpecific": [
      "아무거나 누르지 말고 여길 봐.",
      "야, 우선 이 한 단계만."
    ],
    "lin2": [
      "여기서 막혔어? 서둘러 확정할 필요 없어.",
      "먼저 잘 봐. 필요하면 다음 단계를 알려 줄게."
    ],
    "lin3": [
      "진행 방식은 봤어. 이 단계를 다시 확인해 줘.",
      "지금 부분을 마치면 내가 이어 받을게."
    ],
    "lin4": [
      "네 속도로 해도 돼. 막힌 곳은 함께 확인하자.",
      "억지로 시도하지 말고 이 단계를 확인하자."
    ],
    "lin5": [
      "이 부분은 맡길게. 나는 놓친 세부 사항만 보탤게.",
      "네 판단으로 진행해. 필요할 때 한 단계만 보탤게."
    ],
    "linSpecific": [
      "이 단계부터 확인해 줘.",
      "결정하기 전에 여길 봐."
    ],
    "trusted": "꼼꼼히 처리해 줄 걸 알아.",
    "strained": "이번에는 눈앞의 기록과 대조해 줘.",
    "hints": {
      "selectMoon": "별이나 구름 대신 초승달 조각을 선택하세요.",
      "placeMoon": "선택한 초승달을 陶可 표의 초승달 홈에 넣으세요.",
      "goBoard": "전시판으로 돌아가세요. 표와 진행도는 유지됩니다.",
      "selectTicket": "{person}의 원본 표를 선택하세요.",
      "placeTicket": "{person}의 표를 표면에 정해진 전시 위치 {seat}에 놓으세요.",
      "reveal": "A 표 두 장이 있습니다. 실제 위쪽 표를 들어 아래 표를 확인하세요.",
      "unselectPair": "먼저 {person}의 선택을 해제하세요. B는 중복 약속이 아닙니다.",
      "selectPair": "{person}의 이름을 선택해 다른 A 표와 대조하세요.",
      "mark": "陶可와 畢安을 선택했습니다. 선택한 두 장에 표시하세요.",
      "expectation": "{person}의 기대를 열어 읽은 뒤 닫으세요.",
      "inspect": "모형 받침을 열어 빈 틀과 연결되지 않은 배선을 확인하세요.",
      "goChoice": "필수 확인을 마쳤습니다. 이야기 선택 화면으로 가세요.",
      "choice": "직접 분기를 골라 미리 보세요. 확정 전 취소할 수 있습니다. 대신 선택하지 않습니다.",
      "confirm": "내용을 확인하고 확정하거나 취소하세요. 자동 선택은 없습니다.",
      "goFollowup": "인물 후속 화면으로 돌아가세요. 선택한 분기는 유지됩니다.",
      "followup": "{person}의 후속 내용을 열어 원본 표에 해당하는 결과를 읽으세요.",
      "attach": "{person}의 후속 내용을 읽었으니 원본 표에 첨부할 수 있습니다.",
      "seal": "세 사람의 후속 내용을 첨부했습니다. 이번 묶음을 한 번만 봉인해 결과를 한 번만 기록하세요.",
      "result": "이번 회차는 봉인됐습니다. 돌아가도 읽기만 가능하며 결과는 중복되지 않습니다.",
      "goAssembly": "먼저 「拼片」(조립) 탭으로 돌아가세요. 원본 표와 진행도는 유지됩니다."
    }
  }
};
  const codes=Object.freeze(Object.keys(data));
  const get=code=>data[codes.includes(code)?code:'zh-TW'];
  function line(code,person,level,serial,descriptor){const t=get(code),profile=person?.tone||'lin2';const pool=level==='gentle'?t[profile]:t[person?.id==='hou'?'houSpecific':'linSpecific'];let text=pool[Math.abs(serial)%pool.length];if(person?.id==='lin'&&person.relationship!=='unknown')text+=' '+t[person.relationship];if(level==='specific'){const hint=t.hints[descriptor.hint]||t.unknown;text+=' '+hint.replace(/\{(\w+)\}/g,(_,key)=>String(descriptor.params[key]||''));}return text;}
  return Object.freeze({codes,get,line});
});
