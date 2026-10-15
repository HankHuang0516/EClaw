/* Page-scoped vocabulary. Never contains private project records. */
(function (root) {
  'use strict';
  const rows = {
    entry: ['dot 專案進度','dot project progress','dot 项目进度','dot プロジェクト進捗','dot 프로젝트 진행'],
    trends: ['APP 趨勢','APP trends','APP 趋势','アプリの動向','앱 동향'],
    language: ['語言','Language','语言','言語','언어'],
    title: ['把進度，慢慢做成成果。','Turning progress into finished work.','把进度，慢慢做成成果。','一歩ずつ、進捗を成果に。','한 걸음씩, 진행을 성과로.'],
    intro: ['這裡記錄 dot 已完成的交辦成果。每一筆摘要，都保留完成日期。','A journal of completed dot assignments, with a completion date for every summary.','这里记录 dot 已完成的交办成果。每一笔摘要，都保留完成日期。','dot に依頼された作業の完了記録。各概要には完了日を記載します。','dot에 맡긴 작업의 완료 기록입니다. 각 요약에 완료 날짜를 남깁니다.'],
    public: ['公開成果','Public results','公开成果','公開成果','공개 성과'],
    scope: ['已確認完成的項目；不代表所有專案都已完成。','Verified completed items; this does not mean every project is finished.','已确认完成的项目；不代表所有项目都已完成。','完了を確認した項目です。すべてのプロジェクトが完了したわけではありません。','완료를 확인한 항목입니다. 모든 프로젝트가 완료되었다는 뜻은 아닙니다.'],
    archive: ['COMPLETED / 成果記錄','COMPLETED / JOURNAL','COMPLETED / 成果记录','COMPLETED / 成果記録','COMPLETED / 성과 기록'],
    completed: ['已完成的交辦','Completed assignments','已完成的交办','完了した作業','완료한 작업'],
    loading: ['載入中…','Loading…','载入中…','読み込み中…','불러오는 중…'],
    retry: ['重新載入','Reload','重新载入','再読み込み','다시 불러오기'],
    workspace: ['WORKSPACE / 管理工作區','WORKSPACE / ADMIN','WORKSPACE / 管理工作区','WORKSPACE / 管理','WORKSPACE / 관리'],
    admin: ['接下來，要完成的事','What comes next','接下来，要完成的事','次に取り組むこと','다음에 완성할 일'],
    logout: ['登出','Sign out','退出登录','ログアウト','로그아웃'],
    checking: ['確認登入狀態…','Checking your session…','确认登录状态…','ログイン状態を確認中…','로그인 상태 확인 중…'],
    login: ['使用 EClaw 管理者登入','Sign in as an EClaw administrator','使用 EClaw 管理员登录','EClaw 管理者としてログイン','EClaw 관리자로 로그인'],
    return: ['登入後回到此頁，查看管理工作區。','Return here after signing in to view the workspace.','登录后回到此页，查看管理工作区。','ログイン後、このページに戻ってください。','로그인 후 이 페이지로 돌아오세요.'],
    check_login: ['重新確認登入','Check session again','重新确认登录','ログイン状態を再確認','로그인 다시 확인'],
    private_note: ['目標、卡點、下一步和留言僅限 EClaw 管理者。儲存修改不會自動發布公開摘要。','Goals, blockers, next steps and comments are for EClaw administrators. Saving edits does not publish a public summary.','目标、卡点、下一步和留言仅限 EClaw 管理员。保存修改不会自动发布公开摘要。','目標、課題、次の手順、コメントは EClaw 管理者専用です。保存しても概要は公開されません。','목표, 장애 요소, 다음 단계 및 댓글은 EClaw 관리자만 볼 수 있습니다. 저장해도 공개 요약은 게시되지 않습니다.'],
    pending: ['進行中','In progress','进行中','進行中','진행 중'],
    all: ['全部','All','全部','すべて','전체'],
    import: ['匯入先前記錄','Import earlier records','导入先前记录','過去の記録を取り込む','이전 기록 가져오기'],
    import_note: ['舊站留言與修改尚未匯出。可選擇自己提供的 JSON 檔案，先預覽再匯入；不會自動讀取舊站。','Old-site comments and edits have not been exported. Choose your own JSON file, preview it, then import. The old site is not fetched automatically.','旧站留言与修改尚未导出。可选择自己提供的 JSON 文件，先预览再导入；不会自动读取旧站。','旧サイトのコメントと編集は未移行です。手元の JSON をプレビューしてから取り込めます。旧サイトは自動取得しません。','기존 사이트의 댓글과 수정 사항은 아직 내보내지 않았습니다. 직접 제공한 JSON을 미리 확인한 뒤 가져옵니다. 기존 사이트를 자동 조회하지 않습니다.'],
    import_file: ['JSON 檔案','JSON file','JSON 文件','JSON ファイル','JSON 파일'],
    preview: ['預覽匯入','Preview import','预览导入','取り込みを確認','가져오기 미리 보기'],
    apply: ['確認匯入','Confirm import','确认导入','取り込む','가져오기 확인'],
    footer: ['一件一件完成，留下真實的進展。','One finished task at a time, with an honest record of progress.','一件一件完成，留下真实的进展。','一つずつ完了し、確かな進捗を残します。','하나씩 완성하며 실제 진행 기록을 남깁니다.'],
    portfolio: ['返回 APP 作品集','Back to the APP portfolio','返回 APP 作品集','アプリ作品集へ戻る','앱 포트폴리오로 돌아가기'],
    login_needed: ['登入既有 EClaw 管理者帳號，才能查看未完成項目與留言。','Sign in with your existing EClaw administrator account to see unfinished work and comments.','登录已有 EClaw 管理员账号，才能查看未完成项目与留言。','未完了の作業とコメントを見るには、既存の EClaw 管理者アカウントでログインしてください。','미완료 작업과 댓글을 보려면 기존 EClaw 관리자 계정으로 로그인하세요.'],
    forbidden: ['此帳號沒有管理者權限，私有工作區未載入。','This account is not an administrator. The private workspace has not been loaded.','此账号没有管理员权限，私有工作区未载入。','このアカウントに管理権限はありません。非公開データは読み込んでいません。','이 계정은 관리자가 아닙니다. 비공개 작업 공간을 불러오지 않았습니다.'],
    error: ['暫時無法完成，請稍後重試。','Unable to complete this request. Please try again.','暂时无法完成，请稍后重试。','処理できませんでした。再試行してください。','요청을 완료할 수 없습니다. 다시 시도하세요.'],
    empty_public: ['公開成果準備中。','Public results are being prepared.','公开成果准备中。','公開成果を準備中です。','공개 성과를 준비 중입니다.'],
    empty_projects: ['這個分類目前沒有項目。','No projects in this view.','这个分类目前没有项目。','この分類に項目はありません。','이 분류에는 항목이 없습니다.'],
    goal: ['目標與進度','Goal and progress','目标与进度','目標と進捗','목표와 진행'],
    blockers: ['卡點與未驗收項目','Blockers and unverified items','卡点与未验收项目','課題と未検証項目','장애 요소와 미검증 항목'],
    next: ['下一步','Next step','下一步','次の手順','다음 단계'],
    edit: ['編輯項目','Edit project','编辑项目','項目を編集','항목 편집'],
    project_title: ['項目名稱','Project title','项目名称','項目名','항목 이름'],
    status: ['狀態','Status','状态','状態','상태'],
    active: ['進行中','Active','进行中','進行中','진행 중'],
    blocked: ['待解決','Blocked','待解决','課題あり','해결 대기'],
    paused: ['已暫停','Paused','已暂停','一時停止','일시 중지'],
    save: ['儲存修改','Save changes','保存修改','変更を保存','변경 저장'],
    saved: ['已儲存。','Saved.','已保存。','保存しました。','저장했습니다.'],
    conflict: ['資料已被其他操作更新，未覆蓋。你的草稿保留在此；重新載入最新資料後再套用。','This record changed elsewhere. Nothing was overwritten. Your draft remains here; load the latest version before applying it.','数据已被其他操作更新，未覆盖。你的草稿保留在此；重新载入最新数据后再应用。','他の操作で更新されています。上書きしていません。下書きを残したまま最新情報を読み込み直してください。','다른 작업에서 변경되었습니다. 덮어쓰지 않았습니다. 초안은 유지됩니다. 최신 버전을 불러온 뒤 적용하세요.'],
    latest: ['載入最新版本','Load latest version','载入最新版本','最新情報を読み込む','최신 버전 불러오기'],
    publication: ['公開完成摘要','Publish completed summary','公开完成摘要','完了概要を公開','완료 요약 공개'],
    publication_note: ['以下內容會公開給所有訪客。請只填入可公開的短摘要與完成日期；發布後項目會移到完成區。','The fields below are visible to everyone. Use only a safe short summary and completion date. Publishing moves the project to completed work.','以下内容会公开给所有访客。请只填入可公开的短摘要与完成日期；发布后项目会移到完成区。','以下は全訪問者に公開されます。公開可能な短い概要と完了日のみ入力してください。公開すると完了項目へ移動します。','아래 내용은 모든 방문자에게 공개됩니다. 공개 가능한 짧은 요약과 완료 날짜만 입력하세요. 게시하면 완료 영역으로 이동합니다.'],
    public_title: ['公開標題','Public title','公开标题','公開タイトル','공개 제목'],
    public_summary: ['公開短摘要','Public short summary','公开短摘要','公開する短い概要','공개용 짧은 요약'],
    date: ['完成日期','Completion date','完成日期','完了日','완료 날짜'],
    publish: ['發布完成摘要','Publish completed result','发布完成摘要','完了概要を公開する','완료 요약 게시'],
    unpublish: ['撤下公開摘要','Unpublish summary','撤下公开摘要','概要の公開を停止','요약 게시 취소'],
    comments: ['留言','Comments','留言','コメント','댓글'],
    comment_body: ['新增留言','New comment','新增留言','新しいコメント','새 댓글'],
    send: ['送出留言','Post comment','发送留言','コメントを投稿','댓글 게시'],
    empty_comments: ['尚無留言。','No comments yet.','暂无留言。','コメントはまだありません。','아직 댓글이 없습니다.'],
    history: ['修改歷史','Change history','修改历史','変更履歴','변경 이력'],
    empty_history: ['尚無修改記錄。','No changes yet.','暂无修改记录。','変更履歴はありません。','변경 이력이 없습니다.'],
    version: ['版本','Version','版本','バージョン','버전'],
    load: ['載入','Load','载入','読み込む','불러오기'],
    import_ready: ['預覽完成，請確認項目後再匯入。','Preview ready. Review the records before importing.','预览完成，请确认项目后再导入。','プレビューできました。項目を確認して取り込んでください。','미리 보기가 준비되었습니다. 항목을 확인한 뒤 가져오세요.'],
    import_done: ['已匯入，最新項目已重新載入。','Imported. The latest projects have been reloaded.','已导入，最新项目已重新载入。','取り込みました。最新項目を読み込み直しました。','가져왔습니다. 최신 항목을 다시 불러왔습니다.'],
    invalid_file: ['請選擇有效的 JSON 記錄檔（最大 256 KB）。','Choose a valid JSON record file (up to 256 KB).','请选择有效的 JSON 记录文件（最大 256 KB）。','有効な JSON 記録ファイルを選択してください（最大 256 KB）。','올바른 JSON 기록 파일을 선택하세요(최대 256 KB).'],
    draft: ['保留的草稿','Retained draft','保留的草稿','保持した下書き','유지된 초안'],
    history_change: ['項目已更新','Project updated','项目已更新','項目を更新','항목 업데이트'],
    history_import: ['匯入記錄','Record imported','导入记录','記録を取り込み','기록 가져오기'],
    history_seed: ['建立記錄','Record created','创建记录','記録を作成','기록 생성'],
    session_changed: ['登入狀態已更新，私有內容已清除。','Session changed. Private content has been cleared.','登录状态已更新，私有内容已清除。','ログイン状態が変わりました。非公開情報を消去しました。','로그인 상태가 변경되어 비공개 내용을 지웠습니다.'],
    expires: ['登入已失效，請重新登入。','Your session expired. Please sign in again.','登录已失效，请重新登录。','セッションが切れました。再度ログインしてください。','로그인이 만료되었습니다. 다시 로그인하세요.']
  };
  const additional = {
    fr: `
entry=Progrès des projets dot
trends=Tendances des applications
language=Langue
title=Transformer les progrès en réalisations.
intro=Les missions dot terminées, avec une date pour chaque résumé.
public=Résultats publics
scope=Travaux dont la réalisation est confirmée. Tous les projets ne sont pas terminés.
archive=RÉALISATIONS / JOURNAL
completed=Missions terminées
loading=Chargement…
retry=Recharger
workspace=ESPACE DE GESTION
admin=Les prochaines étapes
logout=Se déconnecter
checking=Vérification de la session…
login=Connexion administrateur EClaw
return=Revenez ici après la connexion pour accéder à la gestion.
check_login=Vérifier la session
private_note=Objectifs, blocages, étapes et commentaires réservés aux administrateurs EClaw. Enregistrer ne publie pas le résumé.
pending=En cours
all=Tout
import=Importer des archives
import_note=Les commentaires et modifications de l’ancien site n’ont pas été exportés. Choisissez votre fichier JSON, puis vérifiez-le avant l’importation. Aucune lecture automatique de l’ancien site.
import_file=Fichier JSON
preview=Prévisualiser
apply=Confirmer l’importation
footer=Une tâche après l’autre, en gardant une trace fidèle des progrès.
portfolio=Retour au portfolio
login_needed=Connectez-vous avec votre compte administrateur EClaw pour consulter les travaux en cours et les commentaires.
forbidden=Ce compte n’est pas administrateur. Les données privées n’ont pas été chargées.
error=La demande n’a pas abouti. Réessayez.
empty_public=Les résultats publics sont en préparation.
empty_projects=Aucun projet dans cette catégorie.
goal=Objectif et progrès
blockers=Blocages et points non vérifiés
next=Prochaine étape
edit=Modifier le projet
project_title=Nom du projet
status=État
active=En cours
blocked=Bloqué
paused=En pause
save=Enregistrer
saved=Enregistré.
conflict=Une autre opération a modifié ce projet. Rien n’a été écrasé. Le brouillon est conservé ; chargez la dernière version avant de l’appliquer.
latest=Charger la dernière version
publication=Résumé public de réalisation
publication_note=Ces champs sont publics. Utilisez un court résumé publiable et la date de réalisation. La publication place le projet parmi les travaux terminés.
public_title=Titre public
public_summary=Court résumé public
date=Date de réalisation
publish=Publier la réalisation
unpublish=Retirer le résumé public
comments=Commentaires
comment_body=Nouveau commentaire
send=Envoyer le commentaire
empty_comments=Aucun commentaire.
history=Historique des modifications
empty_history=Aucune modification.
version=Version
load=Charger
import_ready=Vérifiez les projets avant de confirmer l’importation.
import_done=Importation terminée. Les projets ont été rechargés.
invalid_file=Choisissez un fichier JSON valide de 256 Ko maximum.
draft=Brouillon conservé
history_change=Projet modifié
history_import=Archive importée
history_seed=Archive créée
session_changed=La session a changé. Les données privées ont été effacées.
expires=La session a expiré. Reconnectez-vous.
`,
    es: `
entry=Progreso de proyectos dot
trends=Tendencias de aplicaciones
language=Idioma
title=Convertir el progreso en resultados.
intro=Un registro de tareas dot completadas, con fecha en cada resumen.
public=Resultados públicos
scope=Elementos verificados como completados; no significa que todos los proyectos estén terminados.
archive=RESULTADOS / REGISTRO
completed=Tareas completadas
loading=Cargando…
retry=Volver a cargar
workspace=ESPACIO DE ADMINISTRACIÓN
admin=Lo que viene después
logout=Cerrar sesión
checking=Comprobando la sesión…
login=Iniciar sesión como administrador EClaw
return=Vuelve aquí después de iniciar sesión para ver el espacio de administración.
check_login=Comprobar la sesión
private_note=Objetivos, obstáculos, próximos pasos y comentarios solo para administradores EClaw. Guardar cambios no publica el resumen.
pending=En curso
all=Todo
import=Importar registros anteriores
import_note=Los comentarios y cambios del sitio anterior no se han exportado. Elige tu archivo JSON y revísalo antes de importar. No se consulta el sitio anterior automáticamente.
import_file=Archivo JSON
preview=Vista previa de importación
apply=Confirmar importación
footer=Una tarea terminada a la vez, con un registro fiel del progreso.
portfolio=Volver al portafolio
login_needed=Inicia sesión con tu cuenta de administrador EClaw para ver tareas pendientes y comentarios.
forbidden=Esta cuenta no es de administrador. No se han cargado datos privados.
error=No se pudo completar la solicitud. Inténtalo de nuevo.
empty_public=Los resultados públicos se están preparando.
empty_projects=No hay proyectos en esta categoría.
goal=Objetivo y progreso
blockers=Obstáculos y puntos sin verificar
next=Próximo paso
edit=Editar proyecto
project_title=Nombre del proyecto
status=Estado
active=En curso
blocked=Bloqueado
paused=En pausa
save=Guardar cambios
saved=Guardado.
conflict=Otro proceso modificó el registro. No se sobrescribió nada. Tu borrador sigue aquí; carga la última versión antes de aplicarlo.
latest=Cargar última versión
publication=Resumen público del resultado
publication_note=Estos campos son públicos. Incluye solo un resumen breve publicable y la fecha. Al publicar, el proyecto pasa a los completados.
public_title=Título público
public_summary=Resumen público breve
date=Fecha de finalización
publish=Publicar resultado completado
unpublish=Retirar resumen público
comments=Comentarios
comment_body=Nuevo comentario
send=Enviar comentario
empty_comments=Todavía no hay comentarios.
history=Historial de cambios
empty_history=Todavía no hay cambios.
version=Versión
load=Cargar
import_ready=Revisa los proyectos antes de confirmar la importación.
import_done=Importado. Se han recargado los proyectos.
invalid_file=Elige un archivo JSON válido de hasta 256 KB.
draft=Borrador conservado
history_change=Proyecto actualizado
history_import=Registro importado
history_seed=Registro creado
session_changed=La sesión cambió. Se borraron los datos privados.
expires=La sesión caducó. Inicia sesión de nuevo.
`,
    de: `
entry=dot Projektfortschritt
trends=App-Trends
language=Sprache
title=Aus Fortschritt werden Ergebnisse.
intro=Ein Journal abgeschlossener dot-Aufträge, jeweils mit Abschlussdatum.
public=Öffentliche Ergebnisse
scope=Nachweislich abgeschlossene Aufgaben. Nicht alle Projekte sind abgeschlossen.
archive=ERGEBNISSE / JOURNAL
completed=Abgeschlossene Aufträge
loading=Wird geladen…
retry=Neu laden
workspace=VERWALTUNGSBEREICH
admin=Die nächsten Schritte
logout=Abmelden
checking=Sitzung wird geprüft…
login=Als EClaw-Administrator anmelden
return=Kehren Sie nach der Anmeldung hierher zurück.
check_login=Sitzung erneut prüfen
private_note=Ziele, Hindernisse, nächste Schritte und Kommentare sind nur für EClaw-Administratoren sichtbar. Speichern veröffentlicht keine Zusammenfassung.
pending=In Bearbeitung
all=Alle
import=Frühere Einträge importieren
import_note=Kommentare und Änderungen der alten Seite wurden noch nicht exportiert. Wählen Sie Ihre JSON-Datei und prüfen Sie die Vorschau. Die alte Seite wird nicht automatisch abgerufen.
import_file=JSON-Datei
preview=Importvorschau
apply=Import bestätigen
footer=Eine Aufgabe nach der anderen, mit einem ehrlichen Fortschrittsbericht.
portfolio=Zurück zum App-Portfolio
login_needed=Melden Sie sich mit Ihrem vorhandenen EClaw-Administratorkonto an, um offene Aufgaben und Kommentare zu sehen.
forbidden=Dieses Konto hat keine Administratorrechte. Private Daten wurden nicht geladen.
error=Die Anfrage konnte nicht abgeschlossen werden. Bitte erneut versuchen.
empty_public=Öffentliche Ergebnisse werden vorbereitet.
empty_projects=Keine Projekte in dieser Ansicht.
goal=Ziel und Fortschritt
blockers=Hindernisse und ungeprüfte Punkte
next=Nächster Schritt
edit=Projekt bearbeiten
project_title=Projektname
status=Status
active=In Bearbeitung
blocked=Blockiert
paused=Pausiert
save=Änderungen speichern
saved=Gespeichert.
conflict=Der Eintrag wurde anderweitig geändert. Nichts wurde überschrieben. Der Entwurf bleibt erhalten; laden Sie vor dem Anwenden die neueste Version.
latest=Neueste Version laden
publication=Öffentliche Abschlussübersicht
publication_note=Diese Felder sind öffentlich. Verwenden Sie nur eine veröffentlichbare Kurzbeschreibung und das Abschlussdatum. Die Veröffentlichung verschiebt das Projekt zu den abgeschlossenen Aufgaben.
public_title=Öffentlicher Titel
public_summary=Öffentliche Kurzbeschreibung
date=Abschlussdatum
publish=Abschluss veröffentlichen
unpublish=Veröffentlichung zurücknehmen
comments=Kommentare
comment_body=Neuer Kommentar
send=Kommentar senden
empty_comments=Noch keine Kommentare.
history=Änderungsverlauf
empty_history=Noch keine Änderungen.
version=Version
load=Laden
import_ready=Prüfen Sie die Einträge vor dem Import.
import_done=Importiert. Die aktuellen Projekte wurden neu geladen.
invalid_file=Wählen Sie eine gültige JSON-Datei mit höchstens 256 KB.
draft=Erhaltener Entwurf
history_change=Projekt aktualisiert
history_import=Eintrag importiert
history_seed=Eintrag erstellt
session_changed=Die Sitzung wurde geändert. Private Inhalte wurden gelöscht.
expires=Die Sitzung ist abgelaufen. Bitte erneut anmelden.
`,
    id: `
entry=Progres proyek dot
trends=Tren aplikasi
language=Bahasa
title=Mengubah progres menjadi hasil.
intro=Catatan tugas dot yang selesai, dengan tanggal pada setiap ringkasan.
public=Hasil publik
scope=Tugas yang terverifikasi selesai; bukan berarti semua proyek sudah selesai.
archive=HASIL / CATATAN
completed=Tugas selesai
loading=Memuat…
retry=Muat ulang
workspace=RUANG ADMINISTRATOR
admin=Langkah berikutnya
logout=Keluar
checking=Memeriksa sesi…
login=Masuk sebagai administrator EClaw
return=Kembali ke sini setelah masuk untuk melihat ruang kerja.
check_login=Periksa sesi lagi
private_note=Tujuan, kendala, langkah berikutnya, dan komentar hanya untuk administrator EClaw. Menyimpan perubahan tidak menerbitkan ringkasan.
pending=Sedang berjalan
all=Semua
import=Impor catatan sebelumnya
import_note=Komentar dan perubahan situs lama belum diekspor. Pilih berkas JSON Anda, tinjau, lalu impor. Situs lama tidak diakses otomatis.
import_file=Berkas JSON
preview=Pratinjau impor
apply=Konfirmasi impor
footer=Satu tugas demi satu, dengan catatan progres yang jujur.
portfolio=Kembali ke portofolio aplikasi
login_needed=Masuk dengan akun administrator EClaw Anda untuk melihat tugas yang belum selesai dan komentar.
forbidden=Akun ini bukan administrator. Data pribadi tidak dimuat.
error=Permintaan tidak dapat diselesaikan. Silakan coba lagi.
empty_public=Hasil publik sedang disiapkan.
empty_projects=Tidak ada proyek dalam kategori ini.
goal=Tujuan dan progres
blockers=Kendala dan hal yang belum diverifikasi
next=Langkah berikutnya
edit=Edit proyek
project_title=Nama proyek
status=Status
active=Sedang berjalan
blocked=Terhambat
paused=Dijeda
save=Simpan perubahan
saved=Tersimpan.
conflict=Catatan ini diubah oleh operasi lain. Tidak ada yang ditimpa. Draf Anda tetap ada; muat versi terbaru sebelum menerapkannya.
latest=Muat versi terbaru
publication=Ringkasan penyelesaian publik
publication_note=Kolom ini dapat dilihat semua orang. Isi hanya ringkasan singkat yang aman dibagikan dan tanggal selesai. Penerbitan memindahkan proyek ke tugas selesai.
public_title=Judul publik
public_summary=Ringkasan publik singkat
date=Tanggal selesai
publish=Terbitkan hasil selesai
unpublish=Tarik ringkasan publik
comments=Komentar
comment_body=Komentar baru
send=Kirim komentar
empty_comments=Belum ada komentar.
history=Riwayat perubahan
empty_history=Belum ada perubahan.
version=Versi
load=Muat
import_ready=Tinjau proyek sebelum mengonfirmasi impor.
import_done=Berhasil diimpor. Proyek terbaru dimuat ulang.
invalid_file=Pilih berkas JSON valid hingga 256 KB.
draft=Draf tersimpan
history_change=Proyek diperbarui
history_import=Catatan diimpor
history_seed=Catatan dibuat
session_changed=Sesi berubah. Data pribadi telah dihapus.
expires=Sesi kedaluwarsa. Silakan masuk lagi.
`,
    ms: `
entry=Kemajuan projek dot
trends=Trend aplikasi
language=Bahasa
title=Menjadikan kemajuan sebagai hasil.
intro=Rekod tugasan dot yang selesai, dengan tarikh pada setiap ringkasan.
public=Hasil awam
scope=Tugasan yang disahkan selesai; bukan semua projek telah selesai.
archive=HASIL / REKOD
completed=Tugasan selesai
loading=Memuatkan…
retry=Muat semula
workspace=RUANG PENTADBIR
admin=Langkah seterusnya
logout=Log keluar
checking=Menyemak sesi…
login=Log masuk sebagai pentadbir EClaw
return=Kembali ke halaman ini selepas log masuk.
check_login=Semak sesi semula
private_note=Matlamat, halangan, langkah seterusnya dan komen untuk pentadbir EClaw sahaja. Menyimpan perubahan tidak menerbitkan ringkasan.
pending=Sedang berjalan
all=Semua
import=Import rekod terdahulu
import_note=Komen dan perubahan laman lama belum dieksport. Pilih fail JSON anda, semak pratonton dan import. Laman lama tidak dibaca secara automatik.
import_file=Fail JSON
preview=Pratonton import
apply=Sahkan import
footer=Satu tugasan pada satu masa, dengan rekod kemajuan yang jujur.
portfolio=Kembali ke portfolio aplikasi
login_needed=Log masuk dengan akaun pentadbir EClaw sedia ada untuk melihat tugasan belum selesai dan komen.
forbidden=Akaun ini bukan pentadbir. Data peribadi tidak dimuatkan.
error=Permintaan tidak dapat diselesaikan. Sila cuba lagi.
empty_public=Hasil awam sedang disediakan.
empty_projects=Tiada projek dalam kategori ini.
goal=Matlamat dan kemajuan
blockers=Halangan dan perkara belum disahkan
next=Langkah seterusnya
edit=Sunting projek
project_title=Nama projek
status=Status
active=Sedang berjalan
blocked=Terhalang
paused=Dijeda
save=Simpan perubahan
saved=Disimpan.
conflict=Rekod telah diubah oleh operasi lain. Tiada data ditindih. Draf anda dikekalkan; muat versi terkini sebelum menggunakannya.
latest=Muat versi terkini
publication=Ringkasan penyelesaian awam
publication_note=Medan ini boleh dilihat semua orang. Masukkan hanya ringkasan ringkas yang selamat dikongsi dan tarikh selesai. Penerbitan memindahkan projek ke tugasan selesai.
public_title=Tajuk awam
public_summary=Ringkasan awam pendek
date=Tarikh selesai
publish=Terbitkan hasil selesai
unpublish=Tarik balik ringkasan awam
comments=Komen
comment_body=Komen baharu
send=Hantar komen
empty_comments=Belum ada komen.
history=Sejarah perubahan
empty_history=Belum ada perubahan.
version=Versi
load=Muat
import_ready=Semak projek sebelum mengesahkan import.
import_done=Import selesai. Projek terkini telah dimuat semula.
invalid_file=Pilih fail JSON sah sehingga 256 KB.
draft=Draf dikekalkan
history_change=Projek dikemas kini
history_import=Rekod diimport
history_seed=Rekod dicipta
session_changed=Sesi berubah. Data peribadi telah dipadam.
expires=Sesi tamat. Sila log masuk semula.
`,
    vi: `
entry=Tiến độ dự án dot
trends=Xu hướng ứng dụng
language=Ngôn ngữ
title=Biến tiến độ thành thành quả.
intro=Ghi lại các nhiệm vụ dot đã hoàn thành, mỗi tóm tắt có ngày hoàn thành.
public=Thành quả công khai
scope=Các hạng mục đã xác nhận hoàn thành; không có nghĩa là tất cả dự án đã xong.
archive=THÀNH QUẢ / NHẬT KÝ
completed=Nhiệm vụ đã hoàn thành
loading=Đang tải…
retry=Tải lại
workspace=KHÔNG GIAN QUẢN TRỊ
admin=Công việc tiếp theo
logout=Đăng xuất
checking=Đang kiểm tra phiên…
login=Đăng nhập quản trị viên EClaw
return=Quay lại đây sau khi đăng nhập để xem không gian quản trị.
check_login=Kiểm tra lại phiên
private_note=Mục tiêu, trở ngại, bước tiếp theo và bình luận chỉ dành cho quản trị viên EClaw. Lưu thay đổi không tự công khai tóm tắt.
pending=Đang thực hiện
all=Tất cả
import=Nhập bản ghi trước đây
import_note=Bình luận và chỉnh sửa ở trang cũ chưa được xuất. Chọn tệp JSON của bạn, xem trước rồi nhập. Không tự truy cập trang cũ.
import_file=Tệp JSON
preview=Xem trước dữ liệu nhập
apply=Xác nhận nhập
footer=Hoàn thành từng việc, lưu lại tiến độ trung thực.
portfolio=Về bộ sưu tập ứng dụng
login_needed=Đăng nhập tài khoản quản trị viên EClaw hiện có để xem công việc chưa hoàn thành và bình luận.
forbidden=Tài khoản này không có quyền quản trị. Dữ liệu riêng chưa được tải.
error=Không thể hoàn tất yêu cầu. Vui lòng thử lại.
empty_public=Đang chuẩn bị thành quả công khai.
empty_projects=Không có dự án trong nhóm này.
goal=Mục tiêu và tiến độ
blockers=Trở ngại và mục chưa xác minh
next=Bước tiếp theo
edit=Chỉnh sửa dự án
project_title=Tên dự án
status=Trạng thái
active=Đang thực hiện
blocked=Bị cản trở
paused=Tạm dừng
save=Lưu thay đổi
saved=Đã lưu.
conflict=Bản ghi đã được thao tác khác cập nhật. Không ghi đè dữ liệu. Bản nháp vẫn được giữ; tải phiên bản mới trước khi áp dụng.
latest=Tải phiên bản mới nhất
publication=Tóm tắt hoàn thành công khai
publication_note=Các trường này hiển thị cho mọi người. Chỉ nhập tóm tắt ngắn có thể công khai và ngày hoàn thành. Công khai sẽ đưa dự án vào khu vực đã hoàn thành.
public_title=Tiêu đề công khai
public_summary=Tóm tắt ngắn công khai
date=Ngày hoàn thành
publish=Công khai thành quả hoàn thành
unpublish=Gỡ tóm tắt công khai
comments=Bình luận
comment_body=Bình luận mới
send=Gửi bình luận
empty_comments=Chưa có bình luận.
history=Lịch sử thay đổi
empty_history=Chưa có thay đổi.
version=Phiên bản
load=Tải
import_ready=Kiểm tra các dự án trước khi xác nhận nhập.
import_done=Đã nhập. Các dự án mới nhất đã được tải lại.
invalid_file=Chọn tệp JSON hợp lệ không quá 256 KB.
draft=Bản nháp được giữ
history_change=Dự án được cập nhật
history_import=Bản ghi được nhập
history_seed=Bản ghi được tạo
session_changed=Phiên đã thay đổi. Nội dung riêng đã được xóa.
expires=Phiên đã hết hạn. Vui lòng đăng nhập lại.
`,
    th: `
entry=ความคืบหน้าโครงการ dot
trends=แนวโน้มแอป
language=ภาษา
title=เปลี่ยนความคืบหน้าให้เป็นผลงาน
intro=บันทึกงานที่มอบหมายให้ dot และเสร็จแล้ว พร้อมวันที่ในแต่ละสรุป
public=ผลงานสาธารณะ
scope=รายการที่ยืนยันว่าเสร็จแล้ว ไม่ได้หมายความว่าทุกโครงการเสร็จทั้งหมด
archive=ผลงาน / บันทึก
completed=งานที่เสร็จแล้ว
loading=กำลังโหลด…
retry=โหลดใหม่
workspace=พื้นที่ผู้ดูแล
admin=งานที่ต้องทำต่อไป
logout=ออกจากระบบ
checking=กำลังตรวจสอบการเข้าสู่ระบบ…
login=เข้าสู่ระบบด้วยบัญชีผู้ดูแล EClaw
return=กลับมาที่หน้านี้หลังเข้าสู่ระบบเพื่อดูพื้นที่จัดการ
check_login=ตรวจสอบการเข้าสู่ระบบอีกครั้ง
private_note=เป้าหมาย อุปสรรค ขั้นตอนถัดไป และความคิดเห็นสำหรับผู้ดูแล EClaw เท่านั้น การบันทึกไม่เผยแพร่สรุปโดยอัตโนมัติ
pending=กำลังดำเนินการ
all=ทั้งหมด
import=นำเข้าบันทึกเดิม
import_note=ความคิดเห็นและการแก้ไขจากเว็บเดิมยังไม่ได้ส่งออก เลือกไฟล์ JSON ของคุณ ดูตัวอย่าง แล้วนำเข้า ระบบจะไม่อ่านเว็บเดิมโดยอัตโนมัติ
import_file=ไฟล์ JSON
preview=ดูตัวอย่างการนำเข้า
apply=ยืนยันการนำเข้า
footer=ทำให้เสร็จทีละงาน พร้อมบันทึกความคืบหน้าตามจริง
portfolio=กลับไปยังผลงานแอป
login_needed=เข้าสู่ระบบด้วยบัญชีผู้ดูแล EClaw ที่มีอยู่เพื่อดูงานที่ยังไม่เสร็จและความคิดเห็น
forbidden=บัญชีนี้ไม่ใช่ผู้ดูแล ระบบไม่ได้โหลดข้อมูลส่วนตัว
error=ไม่สามารถดำเนินการได้ กรุณาลองอีกครั้ง
empty_public=กำลังเตรียมผลงานสาธารณะ
empty_projects=ไม่มีโครงการในหมวดนี้
 goal=เป้าหมายและความคืบหน้า
blockers=อุปสรรคและรายการที่ยังไม่ตรวจสอบ
next=ขั้นตอนถัดไป
edit=แก้ไขโครงการ
project_title=ชื่อโครงการ
status=สถานะ
active=กำลังดำเนินการ
blocked=ติดอุปสรรค
paused=หยุดชั่วคราว
save=บันทึกการเปลี่ยนแปลง
saved=บันทึกแล้ว
conflict=รายการถูกแก้ไขจากการดำเนินการอื่น ไม่มีการเขียนทับ แบบร่างยังอยู่ กรุณาโหลดเวอร์ชันล่าสุดก่อนนำไปใช้
latest=โหลดเวอร์ชันล่าสุด
publication=สรุปงานเสร็จแบบสาธารณะ
publication_note=ช่องเหล่านี้จะแสดงแก่ทุกคน ใส่เฉพาะสรุปสั้นที่เผยแพร่ได้และวันที่เสร็จ การเผยแพร่จะย้ายโครงการไปยังส่วนงานเสร็จ
public_title=ชื่อเรื่องสาธารณะ
public_summary=สรุปสั้นสาธารณะ
date=วันที่เสร็จ
publish=เผยแพร่ผลงานที่เสร็จแล้ว
unpublish=ถอนสรุปสาธารณะ
comments=ความคิดเห็น
comment_body=ความคิดเห็นใหม่
send=ส่งความคิดเห็น
empty_comments=ยังไม่มีความคิดเห็น
history=ประวัติการเปลี่ยนแปลง
empty_history=ยังไม่มีการเปลี่ยนแปลง
version=เวอร์ชัน
load=โหลด
import_ready=ตรวจสอบรายการก่อนยืนยันการนำเข้า
import_done=นำเข้าแล้ว และโหลดโครงการล่าสุดใหม่แล้ว
invalid_file=เลือกไฟล์ JSON ที่ถูกต้อง ขนาดไม่เกิน 256 KB
 draft=แบบร่างที่เก็บไว้
history_change=อัปเดตโครงการแล้ว
history_import=นำเข้าบันทึกแล้ว
history_seed=สร้างบันทึกแล้ว
session_changed=สถานะการเข้าสู่ระบบเปลี่ยนแล้ว ล้างข้อมูลส่วนตัวแล้ว
expires=การเข้าสู่ระบบหมดอายุ กรุณาเข้าสู่ระบบใหม่
`,
    hi: `
entry=dot परियोजना प्रगति
trends=ऐप रुझान
language=भाषा
title=प्रगति को पूरे हुए काम में बदलना।
intro=dot के पूरे किए गए कार्यों का रिकॉर्ड, हर सारांश के साथ पूरा होने की तारीख।
public=सार्वजनिक परिणाम
scope=पूरा होना सत्यापित किए गए कार्य; इसका अर्थ यह नहीं कि सभी परियोजनाएँ पूरी हैं।
archive=परिणाम / रिकॉर्ड
completed=पूरे किए गए कार्य
loading=लोड हो रहा है…
retry=फिर लोड करें
workspace=प्रशासक कार्यक्षेत्र
admin=अगले काम
logout=साइन आउट
checking=सत्र जाँचा जा रहा है…
login=EClaw प्रशासक के रूप में साइन इन
return=साइन इन के बाद कार्यक्षेत्र देखने के लिए यहाँ लौटें।
check_login=सत्र फिर जाँचें
private_note=लक्ष्य, रुकावटें, अगले कदम और टिप्पणियाँ केवल EClaw प्रशासकों के लिए हैं। बदलाव सहेजने से सारांश प्रकाशित नहीं होता।
pending=कार्य जारी
all=सभी
import=पुराने रिकॉर्ड आयात करें
import_note=पुरानी साइट की टिप्पणियाँ और बदलाव अभी निर्यात नहीं हुए हैं। अपनी JSON फ़ाइल चुनें, पूर्वावलोकन देखें, फिर आयात करें। पुरानी साइट अपने आप नहीं पढ़ी जाती।
import_file=JSON फ़ाइल
preview=आयात पूर्वावलोकन
apply=आयात की पुष्टि करें
footer=एक-एक काम पूरा करते हुए, प्रगति का सच्चा रिकॉर्ड रखें।
portfolio=ऐप पोर्टफोलियो पर लौटें
login_needed=अधूरे कार्य और टिप्पणियाँ देखने के लिए अपने मौजूदा EClaw प्रशासक खाते से साइन इन करें।
forbidden=इस खाते को प्रशासक अधिकार नहीं हैं। निजी डेटा लोड नहीं किया गया है।
error=अनुरोध पूरा नहीं हो सका। फिर कोशिश करें।
empty_public=सार्वजनिक परिणाम तैयार किए जा रहे हैं।
empty_projects=इस श्रेणी में कोई परियोजना नहीं है।
goal=लक्ष्य और प्रगति
blockers=रुकावटें और अप्रमाणित कार्य
next=अगला कदम
edit=परियोजना संपादित करें
project_title=परियोजना का नाम
status=स्थिति
active=कार्य जारी
blocked=रुका हुआ
paused=विराम पर
save=बदलाव सहेजें
saved=सहेजा गया।
conflict=यह रिकॉर्ड किसी अन्य कार्रवाई से बदल गया है। कुछ भी अधिलेखित नहीं हुआ। आपका मसौदा सुरक्षित है; लागू करने से पहले नया संस्करण लोड करें।
latest=नवीनतम संस्करण लोड करें
publication=पूरा होने का सार्वजनिक सारांश
publication_note=ये फ़ील्ड सभी को दिखेंगे। केवल साझा करने योग्य छोटा सारांश और पूरा होने की तारीख लिखें। प्रकाशित होने पर परियोजना पूरे कार्यों में चली जाएगी।
public_title=सार्वजनिक शीर्षक
public_summary=छोटा सार्वजनिक सारांश
date=पूरा होने की तारीख
publish=पूरा हुआ परिणाम प्रकाशित करें
unpublish=सार्वजनिक सारांश हटाएँ
comments=टिप्पणियाँ
comment_body=नई टिप्पणी
send=टिप्पणी भेजें
empty_comments=अभी कोई टिप्पणी नहीं है।
history=बदलाव का इतिहास
empty_history=अभी कोई बदलाव नहीं है।
version=संस्करण
load=लोड करें
import_ready=आयात की पुष्टि से पहले परियोजनाएँ जाँचें।
import_done=आयात पूरा हुआ। नवीनतम परियोजनाएँ फिर लोड की गई हैं।
invalid_file=256 KB तक की वैध JSON फ़ाइल चुनें।
draft=सुरक्षित मसौदा
history_change=परियोजना अपडेट हुई
history_import=रिकॉर्ड आयात हुआ
history_seed=रिकॉर्ड बनाया गया
session_changed=सत्र बदल गया है। निजी सामग्री हटा दी गई है।
expires=सत्र समाप्त हो गया है। फिर साइन इन करें।
`,
    ar: `
entry=تقدم مشاريع dot
trends=اتجاهات التطبيقات
language=اللغة
title=تحويل التقدم إلى أعمال مكتملة.
intro=سجل مهام dot المكتملة، مع تاريخ الإنجاز لكل ملخص.
public=نتائج عامة
scope=مهام تم التأكد من اكتمالها، ولا يعني ذلك اكتمال جميع المشاريع.
archive=النتائج / السجل
completed=المهام المكتملة
loading=جارٍ التحميل…
retry=إعادة التحميل
workspace=مساحة الإدارة
admin=الخطوات القادمة
logout=تسجيل الخروج
checking=جارٍ التحقق من الجلسة…
login=تسجيل الدخول كمسؤول EClaw
return=عُد إلى هذه الصفحة بعد تسجيل الدخول لعرض مساحة الإدارة.
check_login=التحقق من الجلسة مجددًا
private_note=الأهداف والعوائق والخطوات التالية والتعليقات لمسؤولي EClaw فقط. حفظ التغييرات لا ينشر الملخص.
pending=قيد التنفيذ
all=الكل
import=استيراد السجلات السابقة
import_note=لم تُصدّر تعليقات وتعديلات الموقع القديم بعد. اختر ملف JSON الخاص بك وراجعه قبل الاستيراد. لا يُقرأ الموقع القديم تلقائيًا.
import_file=ملف JSON
preview=معاينة الاستيراد
apply=تأكيد الاستيراد
footer=إكمال المهام واحدة تلو الأخرى مع سجل صادق للتقدم.
portfolio=العودة إلى معرض التطبيقات
login_needed=سجّل الدخول بحساب مسؤول EClaw الحالي لعرض الأعمال غير المكتملة والتعليقات.
forbidden=هذا الحساب ليس مسؤولًا. لم يتم تحميل البيانات الخاصة.
error=تعذر إكمال الطلب. يُرجى المحاولة مجددًا.
empty_public=جارٍ إعداد النتائج العامة.
empty_projects=لا توجد مشاريع في هذا القسم.
goal=الهدف والتقدم
blockers=العوائق والنقاط غير المتحقق منها
next=الخطوة التالية
edit=تعديل المشروع
project_title=اسم المشروع
status=الحالة
active=قيد التنفيذ
blocked=متعثر
paused=متوقف مؤقتًا
save=حفظ التغييرات
saved=تم الحفظ.
conflict=تغير السجل بعملية أخرى. لم تُستبدل أي بيانات. بقيت مسودتك هنا؛ حمّل أحدث نسخة قبل تطبيقها.
latest=تحميل أحدث نسخة
publication=ملخص إنجاز عام
publication_note=هذه الحقول ظاهرة للجميع. أدخل فقط ملخصًا قصيرًا صالحًا للنشر وتاريخ الإنجاز. النشر ينقل المشروع إلى المهام المكتملة.
public_title=عنوان عام
public_summary=ملخص عام قصير
date=تاريخ الإنجاز
publish=نشر النتيجة المكتملة
unpublish=إلغاء نشر الملخص
comments=التعليقات
comment_body=تعليق جديد
send=إرسال التعليق
empty_comments=لا توجد تعليقات بعد.
history=سجل التغييرات
empty_history=لا توجد تغييرات بعد.
version=النسخة
load=تحميل
import_ready=راجع المشاريع قبل تأكيد الاستيراد.
import_done=تم الاستيراد وإعادة تحميل أحدث المشاريع.
invalid_file=اختر ملف JSON صالحًا بحجم لا يتجاوز 256 كيلوبايت.
draft=المسودة المحفوظة
history_change=تم تحديث المشروع
history_import=تم استيراد السجل
history_seed=تم إنشاء السجل
session_changed=تغيرت الجلسة. تم مسح المحتوى الخاص.
expires=انتهت الجلسة. يُرجى تسجيل الدخول مجددًا.
`
  };
  const locales = ['zh-TW','en','zh-CN','ja','ko'];
  const dictionaries = Object.fromEntries(locales.map((locale,index) => [locale,Object.fromEntries(Object.entries(rows).map(([key,values]) => ['dot_progress_' + key,values[index]]))]));
  dictionaries.zh = {...dictionaries['zh-TW']};
  Object.entries(additional).forEach(([lang,lines]) => { dictionaries[lang] = Object.fromEntries(lines.trim().split('\n').map(line => {const at=line.indexOf('=');return ['dot_progress_'+line.slice(0,at).trim(),line.slice(at+1)];})); });
  let locale = 'zh-TW';
  function t(key) { return dictionaries[locale][key] || dictionaries.en[key] || key; }
  function apply(target = document) {
    target.querySelectorAll('[data-i18n]').forEach(node => { node.textContent = t(node.dataset.i18n); });
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.lang = locale === 'zh-TW' ? 'zh-Hant' : locale === 'zh-CN' ? 'zh-Hans' : locale;
    document.title = t('dot_progress_entry') + ' · AiHankApps';
  }
  root.dotI18n = {t,apply,dictionaries,get locale(){return locale;},setLocale(value){if(dictionaries[value]) locale=value; apply();}};
})(window);
