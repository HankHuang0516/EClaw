(function(root,factory){'use strict';if(typeof module==='object'&&module.exports)module.exports=factory();else root.FraudPlayerSceneView=factory();})(typeof globalThis==='object'?globalThis:this,function(){
'use strict';
const texts={
  "zh-TW": {
    "title": "詐騙帝國",
    "demo": "前端試玩・不計分",
    "tasks": "目前任務",
    "settings": "設定",
    "back": "返回辦公室",
    "close": "關閉",
    "available": "可接任務",
    "accept": "接下任務",
    "start": "開始票券任務",
    "resume": "繼續票券任務",
    "complete": "本次任務已完成",
    "none": "尚未接任務，點主管走近交談。",
    "floor": "點擊走道移動，點主管交談",
    "audio": "目前未具備音源，僅提供文字提示。",
    "mute": "靜音",
    "volume": "音量偏好",
    "save": "儲存",
    "load": "讀取",
    "savePending": "存檔還原尚未接入，不會假裝已保存。",
    "result": "本局結果",
    "reward": "此試玩不發放正式資源",
    "fixture": "目前為來源相容 R1／第3天10:00的獨立不計分情境，不採用正式時間成本或資源平衡。",
    "test": "程式功能測試，非核准美術",
    "invalid": "這裡暫時走不到，請點走道。",
    "menu": "任務與設定開啟時暫停移動。",
    "missing": "核准場景圖層尚未就緒，未啟動遊戲。",
    "unavailable": "目前無法執行這一步，請先完成眼前的操作。"
  },
  "en": {
    "title": "Scam Empire",
    "demo": "Frontend trial / unscored",
    "tasks": "Current task",
    "settings": "Settings",
    "back": "Back to the office",
    "close": "Close",
    "available": "Available task",
    "accept": "Accept task",
    "start": "Start ticket task",
    "resume": "Continue ticket task",
    "complete": "Task completed",
    "none": "No task yet. Tap the supervisor to approach.",
    "floor": "Tap the aisle to move; tap the supervisor to talk",
    "audio": "No audio assets are available. Text hints only.",
    "mute": "Mute",
    "volume": "Volume preference",
    "save": "Save",
    "load": "Load",
    "savePending": "Save restoration is not connected. Nothing is falsely marked saved.",
    "result": "Session result",
    "reward": "This trial grants no formal resources",
    "fixture": "An independent source-compatible R1 / Day 3, 10:00 unscored fixture; no formal time costs or resource balance adopted.",
    "test": "Program test, not approved artwork",
    "invalid": "That spot is not reachable. Tap the aisle.",
    "menu": "Movement pauses while tasks or settings are open.",
    "missing": "Approved scene layers are not ready. The game has not started.",
    "unavailable": "That action is not available yet. Complete the current step first."
  },
  "zh-CN": {
    "title": "诈骗帝国",
    "demo": "前端试玩・不计分",
    "tasks": "当前任务",
    "settings": "设置",
    "back": "返回办公室",
    "close": "关闭",
    "available": "可接任务",
    "accept": "接下任务",
    "start": "开始票券任务",
    "resume": "继续票券任务",
    "complete": "本次任务已完成",
    "none": "尚未接任务，点主管走近交谈。",
    "floor": "点击走道移动，点主管交谈",
    "audio": "目前未具备音源，仅提供文字提示。",
    "mute": "静音",
    "volume": "音量偏好",
    "save": "保存",
    "load": "读取",
    "savePending": "存档还原尚未接入，不会假装已保存。",
    "result": "本局结果",
    "reward": "此试玩不发放正式资源",
    "fixture": "目前为来源兼容 R1／第3天10:00的独立不计分情境，不采用正式时间成本或资源平衡。",
    "test": "程序功能测试，非核准美术",
    "invalid": "这里暂时走不到，请点走道。",
    "menu": "任务与设置开启时暂停移动。",
    "missing": "核准场景图层尚未就绪，未启动游戏。",
    "unavailable": "目前无法执行这一步，请先完成眼前的操作。"
  },
  "ja": {
    "title": "詐欺帝国",
    "demo": "フロントエンド体験・得点なし",
    "tasks": "現在のタスク",
    "settings": "設定",
    "back": "事務所へ戻る",
    "close": "閉じる",
    "available": "受けられるタスク",
    "accept": "タスクを受ける",
    "start": "チケットのタスクを開始",
    "resume": "チケットのタスクを続ける",
    "complete": "タスク完了",
    "none": "まだタスクはない。上司をタップして近づこう。",
    "floor": "通路をタップして移動、上司をタップして会話",
    "audio": "音声素材は未提供です。文字のヒントのみ表示します。",
    "mute": "ミュート",
    "volume": "音量の設定",
    "save": "保存",
    "load": "読込",
    "savePending": "セーブの復元は未接続です。保存済みとは表示しません。",
    "result": "今回の結果",
    "reward": "正式な資源は付与しません",
    "fixture": "R1・3日目10:00の独立した得点なしの例です。正式な時間コストや資源バランスは採用していません。",
    "test": "プログラムの動作試験・承認済み美術ではありません",
    "invalid": "そこへは行けません。通路をタップしてください。",
    "menu": "タスクや設定を開いている間は移動を止めます。",
    "missing": "承認済みの場面レイヤーは未準備です。ゲームは開始していません。",
    "unavailable": "今はこの操作を実行できません。目の前の手順を先に終えてください。"
  },
  "ko": {
    "title": "사기 제국",
    "demo": "프런트엔드 체험 / 점수 없음",
    "tasks": "현재 임무",
    "settings": "설정",
    "back": "사무실로 돌아가기",
    "close": "닫기",
    "available": "가능한 임무",
    "accept": "임무 수락",
    "start": "표 임무 시작",
    "resume": "표 임무 계속",
    "complete": "임무 완료",
    "none": "아직 임무가 없습니다. 상사를 눌러 다가가세요.",
    "floor": "통로를 눌러 이동하고 상사를 눌러 대화",
    "audio": "음원이 아직 없습니다. 텍스트 힌트만 제공합니다.",
    "mute": "음소거",
    "volume": "음량 설정",
    "save": "저장",
    "load": "불러오기",
    "savePending": "저장 복원이 연결되지 않았습니다. 저장됐다고 표시하지 않습니다.",
    "result": "이번 결과",
    "reward": "정식 자원을 지급하지 않습니다",
    "fixture": "R1 / 3일째 10:00의 독립적인 무점수 예시입니다. 정식 시간 비용이나 자원 밸런스는 적용하지 않습니다.",
    "test": "프로그램 기능 시험 / 승인된 미술 아님",
    "invalid": "그곳으로 갈 수 없습니다. 통로를 누르세요.",
    "menu": "임무나 설정을 열면 이동을 멈춥니다.",
    "missing": "승인된 장면 레이어가 준비되지 않아 게임을 시작하지 않았습니다.",
    "unavailable": "아직 이 동작을 실행할 수 없습니다. 현재 단계를 먼저 완료하세요."
  }
};
Object.assign(texts["zh-TW"],{"language":"語言","report":"回報問題","clear":"刪除本機存檔","update":"檢查更新"});
Object.assign(texts["en"],{"language":"Language","report":"Report a problem","clear":"Delete local save","update":"Check for updates"});
Object.assign(texts["zh-CN"],{"language":"语言","report":"报告问题","clear":"删除本地存档","update":"检查更新"});
Object.assign(texts["ja"],{"language":"言語","report":"問題を報告","clear":"端末のセーブを削除","update":"更新を確認"});
Object.assign(texts["ko"],{"language":"언어","report":"문제 신고","clear":"기기 저장 삭제","update":"업데이트 확인"});
texts["zh-TW"].restart="重新試玩";
texts["en"].restart="Restart trial";
texts["zh-CN"].restart="重新试玩";
texts["ja"].restart="体験をやり直す";
texts["ko"].restart="체험 다시 시작";
texts["zh-TW"].install="安裝／加入主畫面";
texts["en"].install="Install / add to home screen";
texts["zh-CN"].install="安装／添加到主屏幕";
texts["ja"].install="インストール／ホーム画面に追加";
texts["ko"].install="설치 / 홈 화면에 추가";
texts["zh-TW"].autoSaved="本機進度已儲存";
texts["en"].autoSaved="Progress saved on this device";
texts["zh-CN"].autoSaved="本机进度已保存";
texts["ja"].autoSaved="この端末に進行を保存済み";
texts["ko"].autoSaved="이 기기에 진행 상황 저장됨";
Object.assign(texts["zh-TW"],{"confirmOther":"另一個視窗已更新本機進度。是否明確以目前這局覆寫？取消會保留較新的存檔。","confirmLoad":"讀取將完整取代目前的試玩進度，不合併未來資料。是否繼續？","confirmIncompatible":"現有存檔無法相容，是否明確覆寫？取消會保留原檔。","confirmRestart":"重新試玩會清除此試玩的本機進度，未送出的回報也會結束；其他遊戲資料不受影響。是否繼續？","continuePrompt":"是否繼續？","savedMessage":"進度已儲存在這台裝置。","loadedMessage":"已完整讀取本機進度。","deletedMessage":"已刪除此試玩的本機存檔。","operationComplete":"操作完成。","notChanged":"未變更資料。若正在執行動作，請稍後再試。","installedMessage":"已加入應用程式，可由主畫面開啟。","installHelp":"可從瀏覽器選單選擇安裝／加入主畫面；iPhone請用Safari的分享選單加入主畫面。","offlinePreparing":"離線功能仍在準備，請稍後再試。","returnBeforeUpdate":"請先完成或離開眼前任務，返回辦公室後再更新。","updateDownloading":"新版資料下載中；完成後再按「檢查更新」即可安全套用。","noUpdate":"目前沒有等待中的更新。","updateNotReady":"尚未準備更新；現有資料未覆寫，請先確認存檔或稍後重試。","updateFetchFailed":"目前無法取得更新，現有版本與進度保持不變。","otherWindowMessage":"另一個視窗已更新進度；這個視窗不會自動覆寫，請關閉多餘的試玩視窗。","resumedMessage":"已恢復這台裝置的試玩進度。","preservedMessage":"原有存檔已保留，未自動覆寫；可在設定中查看。","preparedNextOpen":"新版已下載並驗證，進度已儲存。請正常關閉這個作品的所有視窗（包含企劃頁），再重新開啟以套用新版。","preparingUpdate":"正在核對並保留目前進度…","applyingUpdate":"進度已保存，正在安全套用新版…","reopeningUpdate":"新版已就緒，正在重新開啟…","updateIncomplete":"更新尚未完成或已有新互動，進度已保留；請稍後再按檢查更新。","offlineReady":"本機離線版本已就緒。","offlineWarming":"離線資料準備中，完成後下次開啟即可使用。","offlineNotReady":"離線資料尚未準備完成；連線試玩與已儲存進度仍保留。","loadFailure":"試玩資料或核准圖層未完整載入，未啟動遊戲。請重新連線後再試。","loading":"核准場景與試玩資料載入中…","savedScope":"假網購票券任務・獨立不計分試玩。穩定步驟會自動儲存在本機，重新開啟會恢復進度；也可由頂部設定手動儲存／讀取。"});
Object.assign(texts["en"],{"confirmOther":"Another window has updated this device’s progress. Replace it with this session? Cancel keeps the newer save.","confirmLoad":"Loading replaces the entire current trial session; later progress is not merged. Continue?","confirmIncompatible":"The existing save is incompatible. Explicitly overwrite it? Cancel preserves the original.","confirmRestart":"Restarting clears only this trial’s local progress and closes unsent reports. Other game data is untouched. Continue?","continuePrompt":"Continue?","savedMessage":"Progress saved on this device.","loadedMessage":"The entire local session was restored.","deletedMessage":"Only this trial’s local save was deleted.","operationComplete":"Action completed.","notChanged":"No data was changed. If an action is running, try again after it finishes.","installedMessage":"The app is installed. Open it from your home screen.","installHelp":"Choose Install or Add to Home Screen in the browser menu. On iPhone, use Safari’s Share menu.","offlinePreparing":"Offline support is still preparing. Try again shortly.","returnBeforeUpdate":"Finish or leave the current task and return to the office before updating.","updateDownloading":"The new version is downloading. When ready, choose Check for updates again to prepare it safely.","noUpdate":"No update is waiting.","updateNotReady":"The update is not prepared. Existing data was not overwritten. Check your save or try again later.","updateFetchFailed":"The update could not be retrieved. Your current version and progress are unchanged.","otherWindowMessage":"Another window updated the save. This window will not overwrite it automatically. Close extra trial windows.","resumedMessage":"Trial progress on this device was restored.","preservedMessage":"The existing save was preserved, not automatically overwritten. Check it in Settings.","preparedNextOpen":"The new version was downloaded and verified, and progress was saved. Close all windows for this work, including the design book, then reopen to use it.","preparingUpdate":"Checking and preserving current progress…","applyingUpdate":"Progress saved. Applying the new version safely…","reopeningUpdate":"The new version is ready. Reopening…","updateIncomplete":"The update is unfinished or new interaction occurred. Progress is preserved. Check for updates again later.","offlineReady":"The offline version is ready on this device.","offlineWarming":"Offline data is preparing. When complete, it will be available on the next launch.","offlineNotReady":"Offline data is not ready yet. Online play and saved progress remain available.","loadFailure":"Trial data or approved layers did not load completely. The game did not start. Reconnect and try again.","loading":"Loading approved scene and trial data…","savedScope":"Ticket task / independent unscored trial. Stable steps save on this device and restore when reopened. Manual save/load is available in the top Settings menu."});
Object.assign(texts["zh-CN"],{"confirmOther":"另一个窗口已更新本机进度。确定用当前这局覆盖吗？取消会保留较新的存档。","confirmLoad":"读取会完整替换当前试玩进度，不合并后续数据。继续吗？","confirmIncompatible":"现有存档不兼容，确定覆盖吗？取消会保留原文件。","confirmRestart":"重新试玩会清除此试玩的本地进度并结束未发送的报告，其他游戏数据不受影响。继续吗？","continuePrompt":"继续吗？","savedMessage":"进度已保存在这台设备。","loadedMessage":"已完整读取本地进度。","deletedMessage":"已删除此试玩的本地存档。","operationComplete":"操作完成。","notChanged":"数据未改变。如果正在执行操作，请稍后重试。","installedMessage":"已添加应用，可从主屏幕打开。","installHelp":"请从浏览器菜单选择安装或添加到主屏幕；iPhone请使用Safari分享菜单。","offlinePreparing":"离线功能仍在准备，请稍后重试。","returnBeforeUpdate":"请先完成或离开当前任务，返回办公室后再更新。","updateDownloading":"新版数据正在下载，完成后再次点击检查更新即可安全准备。","noUpdate":"目前没有等待中的更新。","updateNotReady":"尚未准备更新，现有数据未覆盖。请检查存档或稍后重试。","updateFetchFailed":"目前无法获取更新，当前版本与进度保持不变。","otherWindowMessage":"另一个窗口已更新进度，此窗口不会自动覆盖，请关闭多余的试玩窗口。","resumedMessage":"已恢复这台设备的试玩进度。","preservedMessage":"原有存档已保留，未自动覆盖，可在设置中查看。","preparedNextOpen":"新版已下载并验证，进度已保存。请正常关闭此作品的所有窗口，包括企划页，再重新打开以使用新版。","preparingUpdate":"正在核对并保留当前进度…","applyingUpdate":"进度已保存，正在安全应用新版…","reopeningUpdate":"新版已就绪，正在重新打开…","updateIncomplete":"更新未完成或已有新操作，进度已保留。请稍后再次检查更新。","offlineReady":"本机离线版本已就绪。","offlineWarming":"离线数据准备中，完成后下次打开即可使用。","offlineNotReady":"离线数据尚未准备完成，联网试玩与已保存的进度仍保留。","loadFailure":"试玩数据或核准图层未完整加载，游戏未启动。请重新联网后重试。","loading":"正在加载核准场景与试玩数据…","savedScope":"票券任务，独立不计分试玩。稳定步骤会自动保存在本机，重新打开时恢复。也可在顶部设置中手动保存或读取。"});
Object.assign(texts["ja"],{"confirmOther":"別のウィンドウが進行を更新しました。今回の状態で上書きしますか？キャンセルすると新しいセーブを保持します。","confirmLoad":"読込は現在の体験状態を完全に置き換えます。後の進行とは統合しません。続けますか？","confirmIncompatible":"既存のセーブは互換性がありません。上書きしますか？キャンセルすると元を保持します。","confirmRestart":"やり直すと、この体験の端末内進行だけを消去し、未送信の報告を閉じます。他のゲームデータは変更しません。続けますか？","continuePrompt":"続けますか？","savedMessage":"この端末に進行を保存しました。","loadedMessage":"端末内の状態を完全に復元しました。","deletedMessage":"この体験の端末内セーブだけを削除しました。","operationComplete":"操作が完了しました。","notChanged":"データは変更していません。操作中の場合は完了後に再度お試しください。","installedMessage":"アプリを追加しました。ホーム画面から開けます。","installHelp":"ブラウザーのメニューからインストールまたはホーム画面に追加を選びます。iPhoneはSafariの共有メニューを使います。","offlinePreparing":"オフライン機能を準備中です。しばらくしてから再度お試しください。","returnBeforeUpdate":"現在のタスクを終えるか離れて、事務所に戻ってから更新してください。","updateDownloading":"新版をダウンロード中です。完了後に更新を確認を選ぶと、安全に準備できます。","noUpdate":"待機中の更新はありません。","updateNotReady":"更新は未準備です。既存データは上書きしていません。セーブを確認するか、後で再度お試しください。","updateFetchFailed":"更新を取得できません。現在の版と進行は変更していません。","otherWindowMessage":"別のウィンドウが進行を更新しました。このウィンドウでは自動上書きしません。余分な体験ウィンドウを閉じてください。","resumedMessage":"この端末の体験進行を復元しました。","preservedMessage":"既存のセーブを保持し、自動上書きしていません。設定から確認できます。","preparedNextOpen":"新版のダウンロードと検証、進行の保存が完了しました。企画ページを含むこの作品の全ウィンドウを閉じ、再度開いて適用してください。","preparingUpdate":"現在の進行を確認して保持しています…","applyingUpdate":"進行を保存し、新版を安全に適用しています…","reopeningUpdate":"新版の準備ができました。再度開いています…","updateIncomplete":"更新は未完了、または新しい操作がありました。進行は保持しています。後で再度更新を確認してください。","offlineReady":"この端末のオフライン版は準備済みです。","offlineWarming":"オフラインデータを準備中です。完了後、次に開いた際に使えます。","offlineNotReady":"オフラインデータは未準備です。オンラインの体験と保存済み進行は利用できます。","loadFailure":"体験データまたは承認済みレイヤーを完全に読み込めず、ゲームを開始していません。再接続してお試しください。","loading":"承認済みの場面と体験データを読み込んでいます…","savedScope":"チケットのタスク・独立した得点なしの体験です。安定した手順を端末に自動保存し、再度開くと復元します。上部の設定から手動保存・読込もできます。"});
Object.assign(texts["ko"],{"confirmOther":"다른 창에서 진행 상황을 갱신했습니다. 현재 세션으로 덮어쓸까요? 취소하면 새 저장을 유지합니다.","confirmLoad":"불러오기는 현재 체험 상태 전체를 교체하며 이후 진행과 합치지 않습니다. 계속할까요?","confirmIncompatible":"기존 저장과 호환되지 않습니다. 덮어쓸까요? 취소하면 원본을 유지합니다.","confirmRestart":"다시 시작하면 이 체험의 기기 진행만 지우고 미전송 신고를 닫습니다. 다른 게임 데이터는 바꾸지 않습니다. 계속할까요?","continuePrompt":"계속할까요?","savedMessage":"이 기기에 진행 상황을 저장했습니다.","loadedMessage":"기기에 저장된 상태 전체를 불러왔습니다.","deletedMessage":"이 체험의 기기 저장만 삭제했습니다.","operationComplete":"동작이 완료되었습니다.","notChanged":"데이터를 바꾸지 않았습니다. 동작이 진행 중이라면 완료 후 다시 시도하세요.","installedMessage":"앱을 추가했습니다. 홈 화면에서 열 수 있습니다.","installHelp":"브라우저 메뉴에서 설치 또는 홈 화면 추가를 선택하세요. iPhone에서는 Safari 공유 메뉴를 이용하세요.","offlinePreparing":"오프라인 기능을 준비 중입니다. 잠시 후 다시 시도하세요.","returnBeforeUpdate":"현재 임무를 마치거나 나가서 사무실로 돌아온 뒤 업데이트하세요.","updateDownloading":"새 버전을 내려받는 중입니다. 완료되면 업데이트 확인을 다시 눌러 안전하게 준비하세요.","noUpdate":"대기 중인 업데이트가 없습니다.","updateNotReady":"업데이트를 준비하지 못했습니다. 기존 데이터는 덮어쓰지 않았습니다. 저장을 확인하거나 나중에 다시 시도하세요.","updateFetchFailed":"업데이트를 가져오지 못했습니다. 현재 버전과 진행은 그대로 유지됩니다.","otherWindowMessage":"다른 창에서 저장을 갱신했습니다. 이 창은 자동으로 덮어쓰지 않습니다. 불필요한 체험 창을 닫으세요.","resumedMessage":"이 기기의 체험 진행을 복원했습니다.","preservedMessage":"기존 저장을 유지했으며 자동으로 덮어쓰지 않았습니다. 설정에서 확인하세요.","preparedNextOpen":"새 버전을 내려받아 검증하고 진행을 저장했습니다. 기획 페이지를 포함한 이 작품의 모든 창을 정상적으로 닫은 뒤 다시 열어 적용하세요.","preparingUpdate":"현재 진행을 확인하고 보존하는 중…","applyingUpdate":"진행을 저장했습니다. 새 버전을 안전하게 적용하는 중…","reopeningUpdate":"새 버전이 준비되었습니다. 다시 여는 중…","updateIncomplete":"업데이트가 끝나지 않았거나 새 동작이 발생했습니다. 진행은 유지됩니다. 나중에 다시 업데이트를 확인하세요.","offlineReady":"이 기기의 오프라인 버전이 준비되었습니다.","offlineWarming":"오프라인 데이터를 준비 중입니다. 완료되면 다음 실행부터 사용할 수 있습니다.","offlineNotReady":"오프라인 데이터가 아직 준비되지 않았습니다. 온라인 체험과 저장된 진행은 유지됩니다.","loadFailure":"체험 데이터나 승인된 레이어를 완전히 불러오지 못해 게임을 시작하지 않았습니다. 다시 연결한 뒤 시도하세요.","loading":"승인된 장면과 체험 데이터를 불러오는 중…","savedScope":"표 임무 / 독립적인 무점수 체험입니다. 안정된 단계는 기기에 자동 저장되고 다시 열 때 복원됩니다. 위쪽 설정에서 수동 저장과 불러오기도 가능합니다."});
Object.assign(texts["zh-TW"],{"role":"角色","items":"道具","inbox":"信箱","dayWord":"第 {day} 天","morning":"上午","afternoon":"下午","trainee":"實習生","stamina":"體力","mood":"心情","satiety":"飽食","unknown":"未初始化","rankWord":"職階","wisdom":"智慧","currentOnly":"僅顯示本輪試玩已建立的資料。","noMessages":"本輪尚無已讀後續。","voicePacks":"語音包候選","candidateAudio":"已接入候選語音；請逐一試聽後確認，尚非全域主觀驗收。","pages":"回看頁面","proof":"核對條件","expectations":"查看期待"});
Object.assign(texts["en"],{"role":"Character","items":"Props","inbox":"Inbox","dayWord":"Day {day}","morning":"AM","afternoon":"PM","trainee":"Intern","stamina":"Stamina","mood":"Mood","satiety":"Satiety","unknown":"Not initialized","rankWord":"Rank","wisdom":"Wisdom","currentOnly":"Only data established in this trial is shown.","noMessages":"No follow-ups have been read in this session.","voicePacks":"Candidate voice packs","candidateAudio":"Candidate voices are available. Audition and confirm a pack; technical checks are not subjective approval.","pages":"Revisit page","proof":"Requirements","expectations":"Read expectations"});
Object.assign(texts["zh-CN"],{"role":"角色","items":"道具","inbox":"信箱","dayWord":"第 {day} 天","morning":"上午","afternoon":"下午","trainee":"实习生","stamina":"体力","mood":"心情","satiety":"饱食","unknown":"未初始化","rankWord":"职阶","wisdom":"智慧","currentOnly":"仅显示本轮试玩已建立的数据。","noMessages":"本轮尚无已读后续。","voicePacks":"语音包候选","candidateAudio":"已接入候选语音，请逐一试听后确认；技术检查不等于主观验收。","pages":"回看页面","proof":"核对条件","expectations":"查看期待"});
Object.assign(texts["ja"],{"role":"人物","items":"小道具","inbox":"受信箱","dayWord":"{day}日目","morning":"午前","afternoon":"午後","trainee":"研修生","stamina":"体力","mood":"気分","satiety":"満腹","unknown":"未初期化","rankWord":"階級","wisdom":"知恵","currentOnly":"今回の体験で成立した情報だけを表示します。","noMessages":"この回ではまだ後日談を読んでいません。","voicePacks":"音声パック候補","candidateAudio":"候補音声を接続しました。試聴後に確認してください。技術検査は主観的な承認ではありません。","pages":"ページを再表示","proof":"確認条件","expectations":"期待を読む"});
Object.assign(texts["ko"],{"role":"인물","items":"소품","inbox":"수신함","dayWord":"{day}일째","morning":"오전","afternoon":"오후","trainee":"수습생","stamina":"체력","mood":"기분","satiety":"포만감","unknown":"초기화되지 않음","rankWord":"직급","wisdom":"지혜","currentOnly":"이번 체험에서 성립한 정보만 표시합니다.","noMessages":"이번 회차에서 읽은 후속 내용이 없습니다.","voicePacks":"후보 음성 팩","candidateAudio":"후보 음성을 연결했습니다. 하나씩 듣고 확인하세요. 기술 검사는 주관적 승인이 아닙니다.","pages":"페이지 다시 보기","proof":"확인 조건","expectations":"기대 읽기"});
function validateAssets(assets,g,testing){const loaded=i=>i?.complete===true&&Number.isFinite(i.naturalWidth)&&Number.isFinite(i.naturalHeight)&&i.naturalWidth>0&&i.naturalHeight>0;const sameScene=i=>loaded(i)&&i.naturalWidth===g.width&&i.naturalHeight===g.height;if(!assets||(!testing&&assets.reviewed!==true)||!sameScene(assets.office?.image)||!assets.player)return false;for(const key of['front','right','back','left']){const s=assets.player[key];if(!s||!loaded(s.image)||!Number.isFinite(s.anchor?.x)||!Number.isFinite(s.anchor?.y)||s.anchor.x<0||s.anchor.y<0||s.anchor.x>s.image.naturalWidth||s.anchor.y>s.image.naturalHeight||!Number.isFinite(s.scale)||s.scale<=0||(!testing&&s.alphaReady!==true))return false;}if(assets.requiresContactShadow&&['front','right','back','left'].some(key=>{const s=assets.player[key];return !loaded(s.shadow)||s.shadow.naturalWidth!==s.image.naturalWidth||s.shadow.naturalHeight!==s.image.naturalHeight||(!testing&&s.shadowAlphaReady!==true);}))return false;return !g.foregroundRequired||Boolean(sameScene(assets.foreground?.image)&&(testing||assets.foreground.alphaReady===true));}
function create({document,root,geometry,assets,gameHost,language='zh-TW',testing=false,initialAudio={muted:false,volume:50}}){
if(!root||!geometry||(!testing&&geometry.reviewed!==true)||!validateAssets(assets,geometry,testing))throw new Error('Approved scene layers and source-space geometry required; no unapproved cleanup fallback');
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
let locale=Object.hasOwn(texts,language)?language:'zh-TW',handlers={},state=null,scope=null,modalKey='',disposed=false,muted=initialAudio.muted===true,volume=Number.isFinite(initialAudio.volume)?initialAudio.volume:50,hasAutoSave=false,infoPanel=null;const t=()=>texts[locale];
const app=el('section',undefined,'player-app'),header=el('header',undefined,'player-hud'),title=el('strong'),date=el('span'),badge=el('small'),returnButton=el('button'),headerSettings=el('button'),languageSelect=el('select'),stage=el('div',undefined,'player-scene'),canvas=el('canvas'),npc=el('button',undefined,'player-npc'),footer=el('nav',undefined,'player-nav'),taskButton=el('button'),settingsButton=el('button'),saveNote=el('small',undefined,'player-save-note'),status=el('p',undefined,'player-status'),dialog=el('dialog',undefined,'player-dialog');

const hudTop=el('div',undefined,'player-hud-top'),rank=el('span',undefined,'player-rank'),time=el('span',undefined,'player-time'),stats=el('div',undefined,'player-hud-stats'),expand=el('button','⌄','player-hud-expand'),roleButton=el('button'),inboxButton=el('button');roleButton.type=inboxButton.type=expand.type='button';roleButton.dataset.playerRole='true';inboxButton.dataset.playerInbox='true';headerSettings.dataset.playerSettings='true';title.className=badge.className=languageSelect.className=saveNote.className='player-sr-only';headerSettings.className='player-nav-settings';for(const [key,x]of[['stamina',32],['mood',326],['satiety',613]]){const box=el('div',undefined,'player-stat'),icon=el('canvas'),label=el('span'),bar=el('span','—','player-stat-empty');icon.width=48;icon.height=45;icon.getContext('2d').drawImage(assets.office.image,x,106,48,45,0,0,48,45);label.dataset.statLabel=key;box.dataset.stat=key;box.append(icon,label,bar);stats.append(box);}stats.append(expand);
const viewport=geometry.viewport||{x:0,y:0,width:geometry.width,height:geometry.height};canvas.width=viewport.width;canvas.height=viewport.height;canvas.tabIndex=0;canvas.setAttribute('role','img');canvas.dataset.playerCanvas='true';stage.style.aspectRatio=viewport.width+'/'+viewport.height;const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=false;
for(const b of[returnButton,headerSettings,npc,taskButton,settingsButton])b.type='button';taskButton.dataset.playerTasks='true';settingsButton.dataset.playerSettings='true';returnButton.dataset.playerBack='true';npc.dataset.playerSupervisor='true';
headerSettings.dataset.playerHeaderSettings='true';languageSelect.dataset.playerLanguage='true';for(const[code,label]of[['zh-TW','繁體中文'],['en','English'],['zh-CN','简体中文'],['ja','日本語'],['ko','한국어']]){const option=el('option',label);option.value=code;languageSelect.append(option);}languageSelect.addEventListener('change',()=>{locale=languageSelect.value;modalKey='';handlers.language?.(locale);if(state)api.render(state,scope);});headerSettings.addEventListener('click',()=>handlers.openSettings?.());hudTop.append(date,rank,time);header.append(hudTop,stats,title,badge,languageSelect,saveNote,returnButton);stage.append(canvas,npc);footer.append(roleButton,taskButton,inboxButton,headerSettings);status.setAttribute('role','status');app.append(header,stage,footer,status);root.append(app);if(gameHost)app.insertBefore(gameHost,footer);document.body.append(dialog);dialog.setAttribute('aria-label',t().tasks);returnButton.className='player-sr-only';roleButton.addEventListener('click',()=>openInfo('role'));inboxButton.addEventListener('click',()=>openInfo('inbox'));expand.addEventListener('click',()=>openInfo('resources'));
function openInfo(kind){infoPanel=kind;handlers.pausePanel?.(true);modalKey='';if(state)api.render(state,scope);}
function closeInfo(){infoPanel=null;handlers.pausePanel?.(false);modalKey='';if(state)api.render(state,scope);}
function camera(){const r=canvas.getBoundingClientRect(),scale=Math.max(r.width/viewport.width,r.height/viewport.height);return{r,scale,x:(r.width-viewport.width*scale)/2,y:(r.height-viewport.height*scale)/2};}

const button=(text,fn)=>{const b=el('button',text);b.type='button';b.addEventListener('click',fn);return b;};
function draw(){if(!state)return;ctx.clearRect(0,0,canvas.width,canvas.height);ctx.save();ctx.translate(-viewport.x,-viewport.y);ctx.drawImage(assets.office.image,0,0,geometry.width,geometry.height);if(state.path.length){ctx.beginPath();ctx.moveTo(state.position.x,state.position.y);for(const p of state.path)ctx.lineTo(p.x,p.y);ctx.strokeStyle='#b9e88c';ctx.lineWidth=3;ctx.stroke();const p=state.path.at(-1);ctx.beginPath();ctx.ellipse(p.x,p.y,16,8,0,0,Math.PI*2);ctx.stroke();}const sprite=assets.player[state.direction]||assets.player.front;const width=sprite.image.naturalWidth||sprite.image.width,height=sprite.image.naturalHeight||sprite.image.height;if(sprite.shadow)ctx.drawImage(sprite.shadow,state.position.x-sprite.anchor.x*sprite.scale,state.position.y-sprite.anchor.y*sprite.scale,width*sprite.scale,height*sprite.scale);ctx.drawImage(sprite.image,state.position.x-sprite.anchor.x*sprite.scale,state.position.y-sprite.anchor.y*sprite.scale,width*sprite.scale,height*sprite.scale);if(assets.foreground?.image)ctx.drawImage(assets.foreground.image,0,0,geometry.width,geometry.height);ctx.restore();canvas.dataset.sourceX=String(state.position.x);canvas.dataset.sourceY=String(state.position.y);canvas.dataset.sourceDirection=state.direction;canvas.dataset.assetIds=JSON.stringify([assets.office.path,sprite.path,sprite.shadowPath,assets.foreground?.path].filter(Boolean));const hit=geometry.supervisor.hitRegion||{x:geometry.supervisor.approach.x-10,y:geometry.supervisor.approach.y-10,width:20,height:20};const c=camera();npc.style.left=((hit.x-viewport.x)*c.scale+c.x)+'px';npc.style.top=((hit.y-viewport.y)*c.scale+c.y)+'px';npc.style.width=hit.width*c.scale+'px';npc.style.height=hit.height*c.scale+'px';}
function modal(){const key=JSON.stringify([state.modal,state.phase,state.task?.status,state.result?.id,locale,infoPanel]);if(key===modalKey)return;modalKey=key;if(!state.modal&&!infoPanel){if(dialog.open)dialog.close();return;}dialog.replaceChildren();const heading=el('h2'),content=el('div');dialog.append(heading,content);if(infoPanel){heading.textContent=infoPanel==='role'?t().role:infoPanel==='inbox'?t().inbox:t().settings;content.append(el('p',t().currentOnly));for(const row of handlers.panelData?.(infoPanel)||[])content.append(el('p',row));content.append(button(t().close,closeInfo));dialog.setAttribute('aria-label',heading.textContent);if(!dialog.open)dialog.showModal();return;}else if(state.modal==='supervisor'){heading.textContent=scope.supervisor==='hou'?'阿猴':'林若晴';content.append(el('p',t().available));for(const task of scope.eligibleTasks)content.append(button(task.name,()=>handlers.acceptTask?.(task.id)));if(!scope.eligibleTasks.length)content.append(el('p',t().none));}
else if(state.modal==='tasks'){heading.textContent=t().tasks;content.append(el('p',state.task?state.task.name:t().none));if(state.task){content.append(el('p',state.task.status==='completed'?t().complete:t().demo));if(state.task.status!=='completed')content.append(button(state.task.status==='in-progress'?t().resume:t().start,()=>handlers.openGame?.()));else content.append(el('small',t().reward));}}
else if(state.modal==='settings'){heading.textContent=t().settings;content.append(el('p',handlers.voicePacks?t().candidateAudio:t().audio));const muteLabel=el('label',t().mute),mute=el('input');mute.type='checkbox';mute.checked=muted;mute.addEventListener('change',()=>{muted=mute.checked;handlers.audio?.({muted,volume});});muteLabel.prepend(mute);const volumeLabel=el('label',t().volume),slider=el('input');slider.type='range';slider.min='0';slider.max='100';slider.value=String(volume);slider.addEventListener('input',()=>{volume=Number(slider.value);handlers.audio?.({muted,volume});});volumeLabel.append(slider);content.append(muteLabel,volumeLabel);const languageLabel=el('label',t().language),editor=languageSelect.cloneNode(true);editor.removeAttribute('id');editor.removeAttribute('data-player-language');editor.className='';editor.dataset.playerLanguageEditor='true';editor.value=locale;editor.addEventListener('change',()=>{languageSelect.value=editor.value;languageSelect.dispatchEvent(new document.defaultView.Event('change',{bubbles:true}));});languageLabel.append(editor);content.append(languageLabel);if(handlers.voicePacks)content.append(button(t().voicePacks,()=>handlers.voicePacks()));if(state.phase==='minigame')content.append(button(t().back,()=>{handlers.close?.();handlers.back?.();}));content.append(el('p',t().fixture),el('p',t().menu));const menuStatus=el('p');menuStatus.dataset.playerMenuStatus='true';menuStatus.setAttribute('role','status');content.append(menuStatus);const save=button(t().save,()=>handlers.save?.()),load=button(t().load,()=>handlers.load?.());save.disabled=typeof handlers.save!=='function';load.disabled=typeof handlers.load!=='function';content.append(save,load);for(const[key,handler]of[['restart',handlers.restart],['report',handlers.report],['install',handlers.install],['update',handlers.update]]){const b=button(t()[key],()=>handler?.());b.disabled=typeof handler!=='function';content.append(b);}if(save.disabled||load.disabled)content.append(el('small',t().savePending));}content.append(button(t().close,()=>handlers.close?.()));dialog.setAttribute('aria-label',heading.textContent);if(!dialog.open)dialog.showModal();}
canvas.addEventListener('pointerup',e=>{if(!state||state.phase!=='office'||state.modal)return;const r=canvas.getBoundingClientRect(),scale=Math.max(r.width/viewport.width,r.height/viewport.height),p={x:(e.clientX-r.left-(r.width-viewport.width*scale)/2)/scale+viewport.x,y:(e.clientY-r.top-(r.height-viewport.height*scale)/2)/scale+viewport.y};handlers.ground?.(p);});npc.addEventListener('click',()=>handlers.approach?.());taskButton.addEventListener('click',()=>handlers.openDrawer?.());settingsButton.addEventListener('click',()=>handlers.openSettings?.());returnButton.addEventListener('click',()=>handlers.back?.());dialog.addEventListener('cancel',e=>{e.preventDefault();if(infoPanel)closeInfo();else handlers.close?.();});const resize=()=>{const w=app.getBoundingClientRect().width;if(w&&app.style.getPropertyValue('--game-width')!==w+'px')app.style.setProperty('--game-width',w+'px');draw();};const Resize=document.defaultView.ResizeObserver,observer=Resize?new Resize(resize):null;observer?.observe(app);observer?.observe(stage);
const api=Object.freeze({subscribe(value){handlers=value;return()=>{handlers={};};},render(next,nextScope){if(disposed)return;state=next;scope=nextScope;app.lang=locale;if(hasAutoSave)saveNote.textContent=t().autoSaved;title.textContent=t().title;app.dataset.playerPhase=state.phase;const w=app.getBoundingClientRect().width;if(w)app.style.setProperty('--game-width',w+'px');date.textContent=t().dayWord.replace('{day}',String(state.clock.day))+'｜'+(Number(state.clock.time.split(':')[0])<12?t().morning:t().afternoon);rank.textContent=state.context.rank===1?t().trainee:'R'+state.context.rank;time.textContent=state.clock.time;for(const label of stats.querySelectorAll('[data-stat-label]'))label.textContent=t()[label.dataset.statLabel];for(const box of stats.querySelectorAll('[data-stat]'))box.setAttribute('aria-label',t()[box.dataset.stat]+'：'+t().unknown);expand.setAttribute('aria-label',t().settings);roleButton.textContent=t().role;inboxButton.textContent=t().inbox;headerSettings.textContent=t().settings;languageSelect.setAttribute('aria-label',t().language);languageSelect.value=locale;if(gameHost)gameHost.inert=Boolean(state.modal||infoPanel);badge.textContent=testing?t().test:t().demo;taskButton.textContent=t().items;taskButton.title=t().tasks+(state.task?' / 1':'');settingsButton.textContent=t().settings;returnButton.textContent=t().back;returnButton.hidden=!['minigame','result'].includes(state.phase);canvas.setAttribute('aria-label',t().floor);npc.setAttribute('aria-label',scope.supervisor==='hou'?'阿猴':'林若晴');npc.disabled=!scope.supervisor;stage.hidden=['minigame','result'].includes(state.phase);footer.hidden=false;if(gameHost)gameHost.hidden=!['minigame','result'].includes(state.phase);if(state.phase==='result')handlers.showResult?.(state.result.id);draw();modal();},autoSaved(){hasAutoSave=true;if(saveNote.textContent!==t().autoSaved)saveNote.textContent=t().autoSaved;},message(text){window.clearTimeout(status.playerNoticeTimer);status.playerNoticeTimer=window.setTimeout(()=>{status.textContent='';},4000);if(status.textContent!==text)status.textContent=text;const menuStatus=dialog.querySelector('[data-player-menu-status]');if(menuStatus&&menuStatus.textContent!==text)menuStatus.textContent=text;},setBusy(value){app.inert=Boolean(value);},notice(code){status.textContent=code==='unreachable-ground'?t().invalid:t().unavailable;},setLanguage(code){if(!Object.hasOwn(texts,code))return false;locale=code;modalKey='';if(state)this.render(state,scope);return true;},openSettings:()=>handlers.openSettings?.(),setAudioPreferences(p){muted=p.muted;volume=p.volume;modalKey='';if(state&&state.modal==='settings')this.render(state,scope);},getStatus:()=>({disposed,testing,visualApproved:!testing&&assets.reviewed===true,audio:{available:typeof handlers.voicePacks==='function',candidate:true,muted,volume},saveConnected:typeof handlers.save==='function'}),dispose(){if(disposed)return;disposed=true;observer?.disconnect();if(dialog.open)dialog.close();dialog.remove();app.remove();handlers={};}});return api;
}
return Object.freeze({create,validateAssets,languages:Object.freeze(Object.keys(texts)),texts});
});
