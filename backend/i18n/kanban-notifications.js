// Kanban bot push notification translations
// Looked up by device owner's user_accounts.language
// Falls back to English when language not in table

const TRANSLATIONS = {
    en: {
        statusLabels: { backlog: 'Backlog', todo: 'TODO', in_progress: 'In Progress', review: 'Review', done: 'Done', blocked: 'Blocked' },
        cardCreated: '📋 New task assigned: {priorityIcon} [{priority}] {title}\nStatus: {status}',
        statusChanged: '{direction} Task status changed: [{title}]\n{from} → {to}',
        staleNudge: '⏰ Task nudge: [{title}]\nStuck in "{status}" for {hours}h, please continue',
        scheduleOnce: '🗓️ Schedule triggered: [{title}]\nPlease begin this task',
        automationTrigger: '🗓️ Automation triggered: [{title}]\nChild card created: {childTitle}\nPlease begin',
        scheduleRecurring: '🗓️ Schedule triggered: [{title}]\nPlease continue this task',
        scheduleRecurringWithStatus: '🗓️ Schedule triggered: [{title}]\nStatus: {from} → {to}, please continue this task',
        reviewerNotify: '🔍 Task completed, awaiting review: [{title}]\nBot #{entityId} reported: {reply}\nIf there are issues, please create a new card.',
        reviewerMovedToReview: '🔍 Pending review: [{title}]\nMoved from {from} to Review. Please review.',
        reviewerNoReply: '(no reply content)'
    },
    zh: {
        statusLabels: { backlog: '待辦池', todo: '待辦', in_progress: '進行中', review: '審查', done: '完成', blocked: '已封鎖' },
        cardCreated: '📋 新任務指派：{priorityIcon} [{priority}] {title}\n狀態: {status}',
        statusChanged: '{direction} 任務狀態變更：[{title}]\n{from} → {to}',
        staleNudge: '⏰ 任務催促：[{title}]\n已在「{status}」停留 {hours} 小時，請繼續推進',
        scheduleOnce: '🗓️ 排程觸發：[{title}]\n請開始執行此任務',
        automationTrigger: '🗓️ 自動化觸發：[{title}]\n子卡已建立: {childTitle}\n請開始執行',
        scheduleRecurring: '🗓️ 排程觸發：[{title}]\n請繼續推進此任務',
        scheduleRecurringWithStatus: '🗓️ 排程觸發：[{title}]\n狀態: {from} → {to}，請繼續推進此任務',
        reviewerNotify: '🔍 任務完成待審：[{title}]\nBot #{entityId} 已完成並回報：{reply}\n如有問題請重新建卡指派。',
        reviewerMovedToReview: '🔍 待審：[{title}]\n已從 {from} 移到審查階段，請審。',
        reviewerNoReply: '（無回覆內容）'
    },
    'zh-CN': {
        statusLabels: { backlog: '待办池', todo: '待办', in_progress: '进行中', review: '审查', done: '完成', blocked: '已封锁' },
        cardCreated: '📋 新任务指派：{priorityIcon} [{priority}] {title}\n状态: {status}',
        statusChanged: '{direction} 任务状态变更：[{title}]\n{from} → {to}',
        staleNudge: '⏰ 任务催促：[{title}]\n已在「{status}」停留 {hours} 小时，请继续推进',
        scheduleOnce: '🗓️ 排程触发：[{title}]\n请开始执行此任务',
        automationTrigger: '🗓️ 自动化触发：[{title}]\n子卡已建立: {childTitle}\n请开始执行',
        scheduleRecurring: '🗓️ 排程触发：[{title}]\n请继续推进此任务',
        scheduleRecurringWithStatus: '🗓️ 排程触发：[{title}]\n状态: {from} → {to}，请继续推进此任务',
        reviewerNotify: '🔍 任务完成待审：[{title}]\nBot #{entityId} 已完成并回报：{reply}\n如有问题请重新建卡指派。',
        reviewerMovedToReview: '🔍 待审：[{title}]\n已从 {from} 移到审查阶段，请审。',
        reviewerNoReply: '（无回复内容）'
    },
    ja: {
        statusLabels: { backlog: 'バックログ', todo: 'TODO', in_progress: '進行中', review: 'レビュー', done: '完了', blocked: 'ブロック中' },
        cardCreated: '📋 新タスク割当：{priorityIcon} [{priority}] {title}\nステータス: {status}',
        statusChanged: '{direction} タスク状態変更：[{title}]\n{from} → {to}',
        staleNudge: '⏰ タスク催促：[{title}]\n「{status}」で{hours}時間停滞中、進めてください',
        scheduleOnce: '🗓️ スケジュール起動：[{title}]\nこのタスクを開始してください',
        automationTrigger: '🗓️ 自動化起動：[{title}]\n子カード作成: {childTitle}\n開始してください',
        scheduleRecurring: '🗓️ スケジュール起動：[{title}]\nこのタスクを進めてください',
        scheduleRecurringWithStatus: '🗓️ スケジュール起動：[{title}]\nステータス: {from} → {to}、このタスクを進めてください',
        reviewerNotify: '🔍 タスク完了、レビュー待ち：[{title}]\nBot #{entityId} の報告：{reply}\n問題がある場合は新しいカードを作成してください。',
        reviewerMovedToReview: '🔍 レビュー待ち：[{title}]\n{from} からレビューへ移動しました。確認してください。',
        reviewerNoReply: '（返信内容なし）'
    },
    ko: {
        statusLabels: { backlog: '백로그', todo: '할 일', in_progress: '진행 중', review: '검토', done: '완료', blocked: '차단됨' },
        cardCreated: '📋 새 작업 할당: {priorityIcon} [{priority}] {title}\n상태: {status}',
        statusChanged: '{direction} 작업 상태 변경: [{title}]\n{from} → {to}',
        staleNudge: '⏰ 작업 독촉: [{title}]\n"{status}"에서 {hours}시간 정체, 계속 진행해주세요',
        scheduleOnce: '🗓️ 일정 트리거: [{title}]\n이 작업을 시작하세요',
        automationTrigger: '🗓️ 자동화 트리거: [{title}]\n자식 카드 생성: {childTitle}\n시작하세요',
        scheduleRecurring: '🗓️ 일정 트리거: [{title}]\n이 작업을 계속 진행하세요',
        scheduleRecurringWithStatus: '🗓️ 일정 트리거: [{title}]\n상태: {from} → {to}, 이 작업을 계속 진행하세요',
        reviewerNotify: '🔍 작업 완료, 검토 대기 중: [{title}]\nBot #{entityId} 보고: {reply}\n문제가 있으면 새 카드를 만들어주세요.',
        reviewerMovedToReview: '🔍 검토 대기: [{title}]\n{from}에서 검토로 이동되었습니다. 검토해주세요.',
        reviewerNoReply: '(회신 내용 없음)'
    },
    th: {
        statusLabels: { backlog: 'รอดำเนินการ', todo: 'รายการที่ต้องทำ', in_progress: 'กำลังดำเนินการ', review: 'ตรวจสอบ', done: 'เสร็จสิ้น', blocked: 'ถูกบล็อก' },
        cardCreated: '📋 งานใหม่ที่ได้รับมอบหมาย: {priorityIcon} [{priority}] {title}\nสถานะ: {status}',
        statusChanged: '{direction} สถานะงานเปลี่ยน: [{title}]\n{from} → {to}',
        staleNudge: '⏰ เตือนงาน: [{title}]\nค้างใน "{status}" มา {hours} ชั่วโมง โปรดดำเนินการต่อ',
        scheduleOnce: '🗓️ กำหนดเวลาเริ่มทำงาน: [{title}]\nโปรดเริ่มงานนี้',
        automationTrigger: '🗓️ ระบบอัตโนมัติเริ่มทำงาน: [{title}]\nสร้างการ์ดย่อย: {childTitle}\nโปรดเริ่ม',
        scheduleRecurring: '🗓️ กำหนดเวลาเริ่มทำงาน: [{title}]\nโปรดดำเนินงานนี้ต่อ',
        scheduleRecurringWithStatus: '🗓️ กำหนดเวลาเริ่มทำงาน: [{title}]\nสถานะ: {from} → {to}, โปรดดำเนินงานนี้ต่อ',
        reviewerNotify: '🔍 งานเสร็จสิ้น รอการตรวจสอบ: [{title}]\nBot #{entityId} รายงาน: {reply}\nหากมีปัญหา กรุณาสร้างการ์ดใหม่',
        reviewerMovedToReview: '🔍 รอตรวจสอบ: [{title}]\nย้ายจาก {from} ไปยังตรวจสอบ โปรดตรวจสอบ',
        reviewerNoReply: '(ไม่มีเนื้อหาตอบกลับ)'
    },
    vi: {
        statusLabels: { backlog: 'Hàng chờ', todo: 'Cần làm', in_progress: 'Đang làm', review: 'Đánh giá', done: 'Hoàn thành', blocked: 'Bị chặn' },
        cardCreated: '📋 Nhiệm vụ mới được giao: {priorityIcon} [{priority}] {title}\nTrạng thái: {status}',
        statusChanged: '{direction} Trạng thái nhiệm vụ đã thay đổi: [{title}]\n{from} → {to}',
        staleNudge: '⏰ Nhắc nhiệm vụ: [{title}]\nĐã ở "{status}" trong {hours} giờ, vui lòng tiếp tục',
        scheduleOnce: '🗓️ Lịch trình kích hoạt: [{title}]\nVui lòng bắt đầu nhiệm vụ này',
        automationTrigger: '🗓️ Tự động hóa kích hoạt: [{title}]\nThẻ con đã tạo: {childTitle}\nVui lòng bắt đầu',
        scheduleRecurring: '🗓️ Lịch trình kích hoạt: [{title}]\nVui lòng tiếp tục nhiệm vụ này',
        scheduleRecurringWithStatus: '🗓️ Lịch trình kích hoạt: [{title}]\nTrạng thái: {from} → {to}, vui lòng tiếp tục nhiệm vụ này',
        reviewerNotify: '🔍 Nhiệm vụ hoàn thành, chờ đánh giá: [{title}]\nBot #{entityId} báo cáo: {reply}\nNếu có vấn đề, vui lòng tạo thẻ mới.',
        reviewerMovedToReview: '🔍 Chờ đánh giá: [{title}]\nĐã chuyển từ {from} sang Đánh giá. Vui lòng đánh giá.',
        reviewerNoReply: '(không có nội dung phản hồi)'
    },
    id: {
        statusLabels: { backlog: 'Backlog', todo: 'TODO', in_progress: 'Sedang Berjalan', review: 'Tinjauan', done: 'Selesai', blocked: 'Diblokir' },
        cardCreated: '📋 Tugas baru ditugaskan: {priorityIcon} [{priority}] {title}\nStatus: {status}',
        statusChanged: '{direction} Status tugas berubah: [{title}]\n{from} → {to}',
        staleNudge: '⏰ Pengingat tugas: [{title}]\nMacet di "{status}" selama {hours} jam, mohon lanjutkan',
        scheduleOnce: '🗓️ Jadwal terpicu: [{title}]\nMohon mulai tugas ini',
        automationTrigger: '🗓️ Otomatisasi terpicu: [{title}]\nKartu anak dibuat: {childTitle}\nMohon mulai',
        scheduleRecurring: '🗓️ Jadwal terpicu: [{title}]\nMohon lanjutkan tugas ini',
        scheduleRecurringWithStatus: '🗓️ Jadwal terpicu: [{title}]\nStatus: {from} → {to}, mohon lanjutkan tugas ini',
        reviewerNotify: '🔍 Tugas selesai, menunggu tinjauan: [{title}]\nBot #{entityId} melaporkan: {reply}\nJika ada masalah, mohon buat kartu baru.',
        reviewerMovedToReview: '🔍 Menunggu tinjauan: [{title}]\nDipindahkan dari {from} ke Tinjauan. Mohon tinjau.',
        reviewerNoReply: '(tidak ada konten balasan)'
    },
    hi: {
        statusLabels: { backlog: 'बैकलॉग', todo: 'करना है', in_progress: 'जारी है', review: 'समीक्षा', done: 'पूर्ण', blocked: 'अवरुद्ध' },
        cardCreated: '📋 नया कार्य सौंपा गया: {priorityIcon} [{priority}] {title}\nस्थिति: {status}',
        statusChanged: '{direction} कार्य स्थिति बदली: [{title}]\n{from} → {to}',
        staleNudge: '⏰ कार्य अनुस्मारक: [{title}]\n"{status}" में {hours} घंटे से अटका, कृपया जारी रखें',
        scheduleOnce: '🗓️ शेड्यूल ट्रिगर: [{title}]\nकृपया यह कार्य शुरू करें',
        automationTrigger: '🗓️ ऑटोमेशन ट्रिगर: [{title}]\nचाइल्ड कार्ड बनाया गया: {childTitle}\nकृपया शुरू करें',
        scheduleRecurring: '🗓️ शेड्यूल ट्रिगर: [{title}]\nकृपया यह कार्य जारी रखें',
        scheduleRecurringWithStatus: '🗓️ शेड्यूल ट्रिगर: [{title}]\nस्थिति: {from} → {to}, कृपया यह कार्य जारी रखें',
        reviewerNotify: '🔍 कार्य पूर्ण, समीक्षा प्रतीक्षित: [{title}]\nBot #{entityId} रिपोर्ट: {reply}\nयदि कोई समस्या हो, तो कृपया नया कार्ड बनाएं।',
        reviewerMovedToReview: '🔍 समीक्षा प्रतीक्षित: [{title}]\n{from} से समीक्षा में स्थानांतरित किया गया। कृपया समीक्षा करें।',
        reviewerNoReply: '(कोई उत्तर सामग्री नहीं)'
    },
    es: {
        statusLabels: { backlog: 'Pendientes', todo: 'Por hacer', in_progress: 'En progreso', review: 'Revisión', done: 'Hecho', blocked: 'Bloqueado' },
        cardCreated: '📋 Nueva tarea asignada: {priorityIcon} [{priority}] {title}\nEstado: {status}',
        statusChanged: '{direction} Estado de tarea cambiado: [{title}]\n{from} → {to}',
        staleNudge: '⏰ Recordatorio de tarea: [{title}]\nAtascado en "{status}" durante {hours}h, por favor continúa',
        scheduleOnce: '🗓️ Horario activado: [{title}]\nPor favor inicia esta tarea',
        automationTrigger: '🗓️ Automatización activada: [{title}]\nTarjeta hija creada: {childTitle}\nPor favor inicia',
        scheduleRecurring: '🗓️ Horario activado: [{title}]\nPor favor continúa esta tarea',
        scheduleRecurringWithStatus: '🗓️ Horario activado: [{title}]\nEstado: {from} → {to}, por favor continúa esta tarea',
        reviewerNotify: '🔍 Tarea completada, esperando revisión: [{title}]\nBot #{entityId} informó: {reply}\nSi hay problemas, por favor crea una nueva tarjeta.',
        reviewerMovedToReview: '🔍 Pendiente de revisión: [{title}]\nMovido de {from} a Revisión. Por favor revisa.',
        reviewerNoReply: '(sin contenido de respuesta)'
    },
    fr: {
        statusLabels: { backlog: 'Backlog', todo: 'À faire', in_progress: 'En cours', review: 'Révision', done: 'Terminé', blocked: 'Bloqué' },
        cardCreated: '📋 Nouvelle tâche assignée: {priorityIcon} [{priority}] {title}\nStatut: {status}',
        statusChanged: '{direction} Statut de tâche modifié: [{title}]\n{from} → {to}',
        staleNudge: '⏰ Rappel de tâche: [{title}]\nBloqué dans "{status}" depuis {hours}h, veuillez continuer',
        scheduleOnce: '🗓️ Planification déclenchée: [{title}]\nVeuillez commencer cette tâche',
        automationTrigger: '🗓️ Automatisation déclenchée: [{title}]\nCarte enfant créée: {childTitle}\nVeuillez commencer',
        scheduleRecurring: '🗓️ Planification déclenchée: [{title}]\nVeuillez continuer cette tâche',
        scheduleRecurringWithStatus: '🗓️ Planification déclenchée: [{title}]\nStatut: {from} → {to}, veuillez continuer cette tâche',
        reviewerNotify: '🔍 Tâche terminée, en attente de révision: [{title}]\nBot #{entityId} a rapporté: {reply}\nEn cas de problème, veuillez créer une nouvelle carte.',
        reviewerMovedToReview: '🔍 En attente de révision: [{title}]\nDéplacé de {from} à Révision. Veuillez réviser.',
        reviewerNoReply: '(aucun contenu de réponse)'
    },
    ms: {
        statusLabels: { backlog: 'Backlog', todo: 'Perlu Buat', in_progress: 'Sedang Berjalan', review: 'Semakan', done: 'Selesai', blocked: 'Disekat' },
        cardCreated: '📋 Tugas baharu ditugaskan: {priorityIcon} [{priority}] {title}\nStatus: {status}',
        statusChanged: '{direction} Status tugas berubah: [{title}]\n{from} → {to}',
        staleNudge: '⏰ Peringatan tugas: [{title}]\nTersekat dalam "{status}" selama {hours} jam, sila teruskan',
        scheduleOnce: '🗓️ Jadual dicetuskan: [{title}]\nSila mulakan tugas ini',
        automationTrigger: '🗓️ Automasi dicetuskan: [{title}]\nKad anak dicipta: {childTitle}\nSila mulakan',
        scheduleRecurring: '🗓️ Jadual dicetuskan: [{title}]\nSila teruskan tugas ini',
        scheduleRecurringWithStatus: '🗓️ Jadual dicetuskan: [{title}]\nStatus: {from} → {to}, sila teruskan tugas ini',
        reviewerNotify: '🔍 Tugas selesai, menunggu semakan: [{title}]\nBot #{entityId} melaporkan: {reply}\nJika ada masalah, sila cipta kad baharu.',
        reviewerMovedToReview: '🔍 Menunggu semakan: [{title}]\nDipindahkan dari {from} ke Semakan. Sila semak.',
        reviewerNoReply: '(tiada kandungan balasan)'
    },
    ar: {
        statusLabels: { backlog: 'قائمة الانتظار', todo: 'للقيام', in_progress: 'قيد التنفيذ', review: 'مراجعة', done: 'منجز', blocked: 'محظور' },
        cardCreated: '📋 مهمة جديدة معينة: {priorityIcon} [{priority}] {title}\nالحالة: {status}',
        statusChanged: '{direction} تغيرت حالة المهمة: [{title}]\n{from} → {to}',
        staleNudge: '⏰ تذكير بالمهمة: [{title}]\nعالقة في "{status}" منذ {hours} ساعة، يرجى المتابعة',
        scheduleOnce: '🗓️ تم تشغيل الجدول: [{title}]\nيرجى البدء بهذه المهمة',
        automationTrigger: '🗓️ تم تشغيل الأتمتة: [{title}]\nتم إنشاء البطاقة الفرعية: {childTitle}\nيرجى البدء',
        scheduleRecurring: '🗓️ تم تشغيل الجدول: [{title}]\nيرجى متابعة هذه المهمة',
        scheduleRecurringWithStatus: '🗓️ تم تشغيل الجدول: [{title}]\nالحالة: {from} → {to}, يرجى متابعة هذه المهمة',
        reviewerNotify: '🔍 المهمة مكتملة، بانتظار المراجعة: [{title}]\nBot #{entityId} أبلغ: {reply}\nإذا كانت هناك مشكلات، يرجى إنشاء بطاقة جديدة.',
        reviewerMovedToReview: '🔍 بانتظار المراجعة: [{title}]\nتم النقل من {from} إلى المراجعة. يرجى المراجعة.',
        reviewerNoReply: '(لا يوجد محتوى رد)'
    },
    de: {
        statusLabels: { backlog: 'Backlog', todo: 'Zu erledigen', in_progress: 'In Bearbeitung', review: 'Überprüfung', done: 'Erledigt', blocked: 'Blockiert' },
        cardCreated: '📋 Neue Aufgabe zugewiesen: {priorityIcon} [{priority}] {title}\nStatus: {status}',
        statusChanged: '{direction} Aufgabenstatus geändert: [{title}]\n{from} → {to}',
        staleNudge: '⏰ Aufgaben-Erinnerung: [{title}]\nSteckt in "{status}" seit {hours}h fest, bitte fortfahren',
        scheduleOnce: '🗓️ Zeitplan ausgelöst: [{title}]\nBitte diese Aufgabe beginnen',
        automationTrigger: '🗓️ Automatisierung ausgelöst: [{title}]\nUnterkarte erstellt: {childTitle}\nBitte beginnen',
        scheduleRecurring: '🗓️ Zeitplan ausgelöst: [{title}]\nBitte diese Aufgabe fortführen',
        scheduleRecurringWithStatus: '🗓️ Zeitplan ausgelöst: [{title}]\nStatus: {from} → {to}, bitte diese Aufgabe fortführen',
        reviewerNotify: '🔍 Aufgabe erledigt, wartet auf Überprüfung: [{title}]\nBot #{entityId} berichtet: {reply}\nBei Problemen bitte neue Karte erstellen.',
        reviewerMovedToReview: '🔍 Wartet auf Überprüfung: [{title}]\nVon {from} zu Überprüfung verschoben. Bitte überprüfen.',
        reviewerNoReply: '(keine Antwortinhalte)'
    }
};

// BCP-47 Traditional Chinese aliases resolve to the 'zh' dict (Traditional).
const ZH_TRADITIONAL_ALIASES = new Set(['zh-TW', 'zh-Hant', 'zh-HK', 'zh-Hant-TW', 'zh-Hant-HK']);
function resolveDict(lang) {
    if (ZH_TRADITIONAL_ALIASES.has(lang)) return TRANSLATIONS.zh;
    return TRANSLATIONS[lang] || TRANSLATIONS.en;
}

function tKanban(lang, key, params = {}) {
    const dict = resolveDict(lang);
    let str = dict[key] || TRANSLATIONS.en[key] || key;
    for (const [k, v] of Object.entries(params)) {
        str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
    }
    return str;
}

function statusLabel(lang, status) {
    const dict = resolveDict(lang);
    return (dict.statusLabels && dict.statusLabels[status]) || TRANSLATIONS.en.statusLabels[status] || status;
}

module.exports = { tKanban, statusLabel, TRANSLATIONS };
