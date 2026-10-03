'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const SCOPES = Object.freeze(['codex:read', 'codex:manage']);
const MOUNT = '/api/codex/oauth';
const ACCESS_TTL = 900;
const CODE_TTL = 300;
const CONSENT_TTL = 600;
const GRANT_TTL = 30 * 24 * 60 * 60;
const BODY_LIMIT = 16 * 1024;
const OPAQUE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

// Server-side translations: no existing public HTML/i18n assets are changed.
const TEXT = {
    en: {
        title: 'Connect your EClawbot account', app: 'Application (name supplied by the client)',
        callback: 'Registered callback', resource: 'Resource', permissions: 'Requested permissions',
        read: 'Read your EClawbot Codex profile, entities, configuration and connection logs.',
        manage: 'Create and configure Codex entities; approve or disconnect their local runtime.',
        notice: 'Approve only if you recognize this application and callback. Access is limited to your account and the permissions below.',
        approve: 'Allow access', deny: 'Cancel', invalid_request: 'Invalid request.',
        invalid_client: 'Invalid application.', invalid_scope: 'Invalid permissions.',
        invalid_target: 'Invalid resource.', invalid_grant: 'Authorization is invalid or expired.',
        unsupported_grant_type: 'Unsupported authorization flow.',
        unsupported_response_type: 'Unsupported response type.',
        invalid_client_metadata: 'Invalid application registration.',
        access_denied: 'Access denied.', login_required: 'Sign in to continue.',
        server_error: 'Unable to complete authorization.', rate_limited: 'Too many requests. Try again later.',
        invalid_token: 'Authentication required.', insufficient_scope: 'Insufficient permissions.',
        unauthorized_client: 'This application cannot use this authorization flow.',
        login: 'Sign in to EClawbot', loginNotice: 'Sign in in the new tab, then return here. This page will detect your session and show the requested permissions.'
    },
    'zh-TW': {
        title: '連結你的 EClawbot 帳號', app: '應用程式（名稱由用戶端提供）',
        callback: '已註冊的回呼網址', resource: '資源', permissions: '要求的權限',
        read: '讀取你的 EClawbot Codex 個人資料、實體、設定與連線紀錄。', manage: '建立及設定 Codex 實體；核准或中斷其本機執行環境連線。',
        notice: '請確認你認得這個應用程式與回呼網址再授權。存取僅限於你的帳號及下列權限。',
        approve: '允許存取', deny: '取消', invalid_request: '請求無效。', invalid_client: '應用程式無效。',
        invalid_scope: '權限無效。', invalid_target: '資源無效。', invalid_grant: '授權無效或已到期。',
        unsupported_grant_type: '不支援此授權流程。', unsupported_response_type: '不支援此回應類型。',
        invalid_client_metadata: '應用程式註冊資料無效。', access_denied: '拒絕存取。',
        login_required: '請登入以繼續。', server_error: '無法完成授權。', rate_limited: '請求過多，請稍後再試。',
        invalid_token: '需要驗證身分。', insufficient_scope: '權限不足。', unauthorized_client: '此應用程式無法使用這個授權流程。',
        login: '登入 EClawbot', loginNotice: '請在新分頁登入，再回到這裡。此頁面會偵測你的登入狀態並顯示要求的權限。'
    },
    'zh-CN': {
        title: '连接你的 EClawbot 账号', app: '应用程序（名称由客户端提供）',
        callback: '已注册的回调网址', resource: '资源', permissions: '请求的权限',
        read: '读取你的 EClawbot Codex 个人资料、实体、配置与连接日志。', manage: '创建及配置 Codex 实体；批准或断开其本地运行环境连接。',
        notice: '请确认你认识这个应用程序与回调网址再授权。访问仅限于你的账号及下列权限。',
        approve: '允许访问', deny: '取消', invalid_request: '请求无效。', invalid_client: '应用程序无效。',
        invalid_scope: '权限无效。', invalid_target: '资源无效。', invalid_grant: '授权无效或已到期。',
        unsupported_grant_type: '不支持此授权流程。', unsupported_response_type: '不支持此响应类型。',
        invalid_client_metadata: '应用程序注册信息无效。', access_denied: '拒绝访问。',
        login_required: '请登录以继续。', server_error: '无法完成授权。', rate_limited: '请求过多，请稍后再试。',
        invalid_token: '需要身份验证。', insufficient_scope: '权限不足。', unauthorized_client: '此应用程序无法使用这个授权流程。',
        login: '登录 EClawbot', loginNotice: '请在新标签页登录，再返回这里。此页面会检测你的登录状态并显示请求的权限。'
    },
    ja: {
        title: 'EClawbot アカウントを連携', app: 'アプリ（クライアントが提供した名前）',
        callback: '登録済みコールバック', resource: 'リソース', permissions: '要求された権限',
        read: 'EClawbot の Codex プロフィール、エンティティ、設定、接続ログを読み取ります。',
        manage: 'Codex エンティティを作成・設定し、ローカル実行環境への接続を承認または解除します。',
        notice: 'アプリとコールバックを確認してから許可してください。アクセスはあなたのアカウントと以下の権限に限定されます。',
        approve: 'アクセスを許可', deny: 'キャンセル', invalid_request: '無効なリクエストです。',
        invalid_client: '無効なアプリです。', invalid_scope: '無効な権限です。', invalid_target: '無効なリソースです。',
        invalid_grant: '認可が無効または期限切れです。', unsupported_grant_type: '未対応の認可フローです。',
        unsupported_response_type: '未対応の応答形式です。', invalid_client_metadata: '無効なアプリ登録です。',
        access_denied: 'アクセスが拒否されました。', login_required: 'ログインして続行してください。',
        server_error: '認可を完了できません。', rate_limited: 'リクエストが多すぎます。後でもう一度お試しください。',
        invalid_token: '認証が必要です。', insufficient_scope: '権限が不足しています。', unauthorized_client: 'このアプリはこの認可フローを利用できません。',
        login: 'EClawbot にログイン', loginNotice: '新しいタブでログインしてから、このページに戻ってください。セッションを検出すると、要求された権限が表示されます。'
    },
    ko: {
        title: 'EClawbot 계정 연결', app: '앱 (클라이언트가 제공한 이름)', callback: '등록된 콜백',
        resource: '리소스', permissions: '요청한 권한', read: 'EClawbot Codex 프로필, 엔티티, 설정 및 연결 로그를 읽습니다.',
        manage: 'Codex 엔티티를 만들고 설정하며 로컬 실행 환경 연결을 승인하거나 해제합니다.',
        notice: '앱과 콜백을 확인한 후 허용하세요. 접근은 본인 계정과 아래 권한으로 제한됩니다.',
        approve: '접근 허용', deny: '취소', invalid_request: '잘못된 요청입니다.', invalid_client: '잘못된 앱입니다.',
        invalid_scope: '잘못된 권한입니다.', invalid_target: '잘못된 리소스입니다.',
        invalid_grant: '승인이 유효하지 않거나 만료되었습니다.', unsupported_grant_type: '지원하지 않는 승인 흐름입니다.',
        unsupported_response_type: '지원하지 않는 응답 유형입니다.', invalid_client_metadata: '잘못된 앱 등록입니다.',
        access_denied: '접근이 거부되었습니다.', login_required: '계속하려면 로그인하세요.',
        server_error: '승인을 완료할 수 없습니다.', rate_limited: '요청이 너무 많습니다. 나중에 다시 시도하세요.',
        invalid_token: '인증이 필요합니다.', insufficient_scope: '권한이 부족합니다.', unauthorized_client: '이 앱은 이 승인 흐름을 사용할 수 없습니다.',
        login: 'EClawbot 로그인', loginNotice: '새 탭에서 로그인한 후 여기로 돌아오세요. 세션이 감지되면 요청한 권한이 표시됩니다.'
    },
    th: {
        title: 'เชื่อมต่อบัญชี EClawbot ของคุณ', app: 'แอปพลิเคชัน (ชื่อที่ไคลเอนต์ระบุ)', callback: 'URL เรียกกลับที่ลงทะเบียน',
        resource: 'ทรัพยากร', permissions: 'สิทธิ์ที่ร้องขอ', read: 'อ่านโปรไฟล์ เอนทิตี การตั้งค่า และบันทึกการเชื่อมต่อ Codex ใน EClawbot ของคุณ',
        manage: 'สร้างและตั้งค่าเอนทิตี Codex รวมถึงอนุมัติหรือยกเลิกการเชื่อมต่อกับสภาพแวดล้อมการทำงานในเครื่อง',
        notice: 'อนุญาตเฉพาะเมื่อคุณรู้จักแอปและ URL เรียกกลับนี้ การเข้าถึงจำกัดเฉพาะบัญชีของคุณและสิทธิ์ด้านล่าง',
        approve: 'อนุญาตการเข้าถึง', deny: 'ยกเลิก', invalid_request: 'คำขอไม่ถูกต้อง', invalid_client: 'แอปไม่ถูกต้อง',
        invalid_scope: 'สิทธิ์ไม่ถูกต้อง', invalid_target: 'ทรัพยากรไม่ถูกต้อง', invalid_grant: 'การอนุญาตไม่ถูกต้องหรือหมดอายุ',
        unsupported_grant_type: 'ไม่รองรับขั้นตอนการอนุญาตนี้', unsupported_response_type: 'ไม่รองรับประเภทการตอบกลับนี้',
        invalid_client_metadata: 'ข้อมูลการลงทะเบียนแอปไม่ถูกต้อง', access_denied: 'ปฏิเสธการเข้าถึง', login_required: 'เข้าสู่ระบบเพื่อดำเนินการต่อ',
        server_error: 'ไม่สามารถดำเนินการอนุญาตให้เสร็จสิ้น', rate_limited: 'คำขอมากเกินไป โปรดลองใหม่ภายหลัง',
        invalid_token: 'ต้องยืนยันตัวตน', insufficient_scope: 'สิทธิ์ไม่เพียงพอ', unauthorized_client: 'แอปนี้ใช้ขั้นตอนการอนุญาตนี้ไม่ได้',
        login: 'เข้าสู่ระบบ EClawbot', loginNotice: 'เข้าสู่ระบบในแท็บใหม่แล้วกลับมาที่นี่ หน้านี้จะตรวจพบเซสชันและแสดงสิทธิ์ที่ร้องขอ'
    },
    vi: {
        title: 'Kết nối tài khoản EClawbot của bạn', app: 'Ứng dụng (tên do máy khách cung cấp)', callback: 'URL gọi lại đã đăng ký',
        resource: 'Tài nguyên', permissions: 'Quyền được yêu cầu', read: 'Đọc hồ sơ, thực thể, cấu hình và nhật ký kết nối Codex của bạn trên EClawbot.',
        manage: 'Tạo và cấu hình thực thể Codex; phê duyệt hoặc ngắt kết nối môi trường chạy cục bộ.',
        notice: 'Chỉ cho phép nếu bạn nhận ra ứng dụng và URL gọi lại này. Quyền truy cập giới hạn trong tài khoản của bạn và các quyền dưới đây.',
        approve: 'Cho phép truy cập', deny: 'Hủy', invalid_request: 'Yêu cầu không hợp lệ.', invalid_client: 'Ứng dụng không hợp lệ.',
        invalid_scope: 'Quyền không hợp lệ.', invalid_target: 'Tài nguyên không hợp lệ.', invalid_grant: 'Ủy quyền không hợp lệ hoặc đã hết hạn.',
        unsupported_grant_type: 'Luồng ủy quyền không được hỗ trợ.', unsupported_response_type: 'Loại phản hồi không được hỗ trợ.',
        invalid_client_metadata: 'Đăng ký ứng dụng không hợp lệ.', access_denied: 'Truy cập bị từ chối.', login_required: 'Đăng nhập để tiếp tục.',
        server_error: 'Không thể hoàn tất ủy quyền.', rate_limited: 'Quá nhiều yêu cầu. Vui lòng thử lại sau.',
        invalid_token: 'Cần xác thực.', insufficient_scope: 'Không đủ quyền.', unauthorized_client: 'Ứng dụng này không thể sử dụng luồng ủy quyền này.',
        login: 'Đăng nhập EClawbot', loginNotice: 'Đăng nhập trong thẻ mới rồi quay lại đây. Trang này sẽ phát hiện phiên đăng nhập và hiển thị các quyền được yêu cầu.'
    },
    id: {
        title: 'Hubungkan akun EClawbot Anda', app: 'Aplikasi (nama diberikan oleh klien)', callback: 'URL callback terdaftar',
        resource: 'Sumber daya', permissions: 'Izin yang diminta', read: 'Membaca profil, entitas, konfigurasi, dan log koneksi Codex Anda di EClawbot.',
        manage: 'Membuat dan mengonfigurasi entitas Codex; menyetujui atau memutus koneksi lingkungan runtime lokal.',
        notice: 'Izinkan hanya jika Anda mengenali aplikasi dan URL callback ini. Akses terbatas pada akun Anda dan izin di bawah ini.',
        approve: 'Izinkan akses', deny: 'Batal', invalid_request: 'Permintaan tidak valid.', invalid_client: 'Aplikasi tidak valid.',
        invalid_scope: 'Izin tidak valid.', invalid_target: 'Sumber daya tidak valid.', invalid_grant: 'Otorisasi tidak valid atau kedaluwarsa.',
        unsupported_grant_type: 'Alur otorisasi tidak didukung.', unsupported_response_type: 'Jenis respons tidak didukung.',
        invalid_client_metadata: 'Pendaftaran aplikasi tidak valid.', access_denied: 'Akses ditolak.', login_required: 'Masuk untuk melanjutkan.',
        server_error: 'Tidak dapat menyelesaikan otorisasi.', rate_limited: 'Terlalu banyak permintaan. Coba lagi nanti.',
        invalid_token: 'Autentikasi diperlukan.', insufficient_scope: 'Izin tidak mencukupi.', unauthorized_client: 'Aplikasi ini tidak dapat menggunakan alur otorisasi ini.',
        login: 'Masuk ke EClawbot', loginNotice: 'Masuk di tab baru, lalu kembali ke sini. Halaman ini akan mendeteksi sesi Anda dan menampilkan izin yang diminta.'
    },
    fr: {
        title: 'Connecter votre compte EClawbot', app: 'Application (nom fourni par le client)', callback: 'URL de retour enregistrée',
        resource: 'Ressource', permissions: 'Autorisations demandées', read: 'Lire votre profil, vos entités, leur configuration et les journaux de connexion Codex dans EClawbot.',
        manage: 'Créer et configurer des entités Codex ; approuver ou déconnecter leur environnement d’exécution local.',
        notice: 'Autorisez uniquement si vous reconnaissez cette application et cette URL de retour. L’accès est limité à votre compte et aux autorisations ci-dessous.',
        approve: 'Autoriser l’accès', deny: 'Annuler', invalid_request: 'Requête invalide.', invalid_client: 'Application invalide.',
        invalid_scope: 'Autorisations invalides.', invalid_target: 'Ressource invalide.', invalid_grant: 'Autorisation invalide ou expirée.',
        unsupported_grant_type: 'Processus d’autorisation non pris en charge.', unsupported_response_type: 'Type de réponse non pris en charge.',
        invalid_client_metadata: 'Enregistrement de l’application invalide.', access_denied: 'Accès refusé.', login_required: 'Connectez-vous pour continuer.',
        server_error: 'Impossible de terminer l’autorisation.', rate_limited: 'Trop de requêtes. Réessayez plus tard.',
        invalid_token: 'Authentification requise.', insufficient_scope: 'Autorisations insuffisantes.', unauthorized_client: 'Cette application ne peut pas utiliser ce processus d’autorisation.',
        login: 'Se connecter à EClawbot', loginNotice: 'Connectez-vous dans le nouvel onglet, puis revenez ici. Cette page détectera votre session et affichera les autorisations demandées.'
    },
    es: {
        title: 'Conectar tu cuenta de EClawbot', app: 'Aplicación (nombre proporcionado por el cliente)', callback: 'URL de retorno registrada',
        resource: 'Recurso', permissions: 'Permisos solicitados', read: 'Leer tu perfil, entidades, configuración y registros de conexión de Codex en EClawbot.',
        manage: 'Crear y configurar entidades de Codex; aprobar o desconectar su entorno de ejecución local.',
        notice: 'Autoriza solo si reconoces esta aplicación y su URL de retorno. El acceso se limita a tu cuenta y a los permisos siguientes.',
        approve: 'Permitir acceso', deny: 'Cancelar', invalid_request: 'Solicitud no válida.', invalid_client: 'Aplicación no válida.',
        invalid_scope: 'Permisos no válidos.', invalid_target: 'Recurso no válido.', invalid_grant: 'La autorización no es válida o ha caducado.',
        unsupported_grant_type: 'Flujo de autorización no compatible.', unsupported_response_type: 'Tipo de respuesta no compatible.',
        invalid_client_metadata: 'Registro de aplicación no válido.', access_denied: 'Acceso denegado.', login_required: 'Inicia sesión para continuar.',
        server_error: 'No se pudo completar la autorización.', rate_limited: 'Demasiadas solicitudes. Inténtalo más tarde.',
        invalid_token: 'Se requiere autenticación.', insufficient_scope: 'Permisos insuficientes.', unauthorized_client: 'Esta aplicación no puede usar este flujo de autorización.',
        login: 'Iniciar sesión en EClawbot', loginNotice: 'Inicia sesión en la nueva pestaña y vuelve aquí. Esta página detectará tu sesión y mostrará los permisos solicitados.'
    },
    de: {
        title: 'Ihr EClawbot-Konto verbinden', app: 'Anwendung (Name vom Client angegeben)', callback: 'Registrierte Callback-URL',
        resource: 'Ressource', permissions: 'Angeforderte Berechtigungen', read: 'Ihr Codex-Profil, Ihre Entitäten, Konfiguration und Verbindungsprotokolle in EClawbot lesen.',
        manage: 'Codex-Entitäten erstellen und konfigurieren; ihre lokale Laufzeitverbindung genehmigen oder trennen.',
        notice: 'Erlauben Sie den Zugriff nur, wenn Sie diese Anwendung und Callback-URL erkennen. Der Zugriff ist auf Ihr Konto und die folgenden Berechtigungen beschränkt.',
        approve: 'Zugriff erlauben', deny: 'Abbrechen', invalid_request: 'Ungültige Anfrage.', invalid_client: 'Ungültige Anwendung.',
        invalid_scope: 'Ungültige Berechtigungen.', invalid_target: 'Ungültige Ressource.', invalid_grant: 'Autorisierung ungültig oder abgelaufen.',
        unsupported_grant_type: 'Autorisierungsablauf nicht unterstützt.', unsupported_response_type: 'Antworttyp nicht unterstützt.',
        invalid_client_metadata: 'Ungültige Anwendungsregistrierung.', access_denied: 'Zugriff verweigert.', login_required: 'Melden Sie sich an, um fortzufahren.',
        server_error: 'Die Autorisierung konnte nicht abgeschlossen werden.', rate_limited: 'Zu viele Anfragen. Versuchen Sie es später erneut.',
        invalid_token: 'Authentifizierung erforderlich.', insufficient_scope: 'Unzureichende Berechtigungen.', unauthorized_client: 'Diese Anwendung kann diesen Autorisierungsablauf nicht verwenden.',
        login: 'Bei EClawbot anmelden', loginNotice: 'Melden Sie sich im neuen Tab an und kehren Sie hierher zurück. Diese Seite erkennt Ihre Sitzung und zeigt die angeforderten Berechtigungen an.'
    },
    ms: {
        title: 'Sambungkan akaun EClawbot anda', app: 'Aplikasi (nama diberikan oleh klien)', callback: 'URL panggil balik berdaftar',
        resource: 'Sumber', permissions: 'Kebenaran yang diminta', read: 'Baca profil, entiti, konfigurasi dan log sambungan Codex anda dalam EClawbot.',
        manage: 'Cipta dan konfigurasikan entiti Codex; luluskan atau putuskan sambungan persekitaran pelaksanaan setempat.',
        notice: 'Benarkan hanya jika anda mengenali aplikasi dan URL panggil balik ini. Akses terhad kepada akaun anda dan kebenaran di bawah.',
        approve: 'Benarkan akses', deny: 'Batal', invalid_request: 'Permintaan tidak sah.', invalid_client: 'Aplikasi tidak sah.',
        invalid_scope: 'Kebenaran tidak sah.', invalid_target: 'Sumber tidak sah.', invalid_grant: 'Kebenaran tidak sah atau telah tamat tempoh.',
        unsupported_grant_type: 'Aliran kebenaran tidak disokong.', unsupported_response_type: 'Jenis respons tidak disokong.',
        invalid_client_metadata: 'Pendaftaran aplikasi tidak sah.', access_denied: 'Akses ditolak.', login_required: 'Log masuk untuk meneruskan.',
        server_error: 'Tidak dapat melengkapkan kebenaran.', rate_limited: 'Terlalu banyak permintaan. Cuba lagi kemudian.',
        invalid_token: 'Pengesahan diperlukan.', insufficient_scope: 'Kebenaran tidak mencukupi.', unauthorized_client: 'Aplikasi ini tidak boleh menggunakan aliran kebenaran ini.',
        login: 'Log masuk ke EClawbot', loginNotice: 'Log masuk dalam tab baharu, kemudian kembali ke sini. Halaman ini akan mengesan sesi anda dan memaparkan kebenaran yang diminta.'
    },
    hi: {
        title: 'अपना EClawbot खाता जोड़ें', app: 'ऐप्लिकेशन (क्लाइंट द्वारा दिया गया नाम)', callback: 'पंजीकृत कॉलबैक URL',
        resource: 'संसाधन', permissions: 'मांगी गई अनुमतियां', read: 'EClawbot में अपनी Codex प्रोफ़ाइल, एंटिटी, कॉन्फ़िगरेशन और कनेक्शन लॉग पढ़ें।',
        manage: 'Codex एंटिटी बनाएं और कॉन्फ़िगर करें; उनके स्थानीय रनटाइम कनेक्शन को मंज़ूरी दें या डिस्कनेक्ट करें।',
        notice: 'इस ऐप्लिकेशन और कॉलबैक URL को पहचानने पर ही अनुमति दें। पहुंच आपके खाते और नीचे दी गई अनुमतियों तक सीमित है।',
        approve: 'पहुंच की अनुमति दें', deny: 'रद्द करें', invalid_request: 'अमान्य अनुरोध।', invalid_client: 'अमान्य ऐप्लिकेशन।',
        invalid_scope: 'अमान्य अनुमतियां।', invalid_target: 'अमान्य संसाधन।', invalid_grant: 'प्राधिकरण अमान्य है या उसकी समय सीमा समाप्त हो गई है।',
        unsupported_grant_type: 'यह प्राधिकरण प्रक्रिया समर्थित नहीं है।', unsupported_response_type: 'यह प्रतिक्रिया प्रकार समर्थित नहीं है।',
        invalid_client_metadata: 'ऐप्लिकेशन का पंजीकरण अमान्य है।', access_denied: 'पहुंच अस्वीकृत।', login_required: 'जारी रखने के लिए साइन इन करें।',
        server_error: 'प्राधिकरण पूरा नहीं हो सका।', rate_limited: 'बहुत अधिक अनुरोध। बाद में फिर प्रयास करें।',
        invalid_token: 'प्रमाणीकरण आवश्यक है।', insufficient_scope: 'अनुमतियां अपर्याप्त हैं।', unauthorized_client: 'यह ऐप्लिकेशन इस प्राधिकरण प्रक्रिया का उपयोग नहीं कर सकता।',
        login: 'EClawbot में साइन इन करें', loginNotice: 'नए टैब में साइन इन करें, फिर यहां लौटें। यह पृष्ठ आपके सत्र का पता लगाकर मांगी गई अनुमतियां दिखाएगा।'
    },
    ar: {
        title: 'ربط حسابك في EClawbot', app: 'التطبيق (الاسم مقدّم من العميل)', callback: 'عنوان العودة المسجّل',
        resource: 'المورد', permissions: 'الأذونات المطلوبة', read: 'قراءة ملفك الشخصي وكياناتك وإعداداتك وسجلات اتصال Codex في EClawbot.',
        manage: 'إنشاء كيانات Codex وإعدادها والموافقة على اتصال بيئة التشغيل المحلية أو فصله.',
        notice: 'اسمح بالوصول فقط إذا كنت تعرف هذا التطبيق وعنوان العودة. يقتصر الوصول على حسابك والأذونات التالية.',
        approve: 'السماح بالوصول', deny: 'إلغاء', invalid_request: 'طلب غير صالح.', invalid_client: 'تطبيق غير صالح.',
        invalid_scope: 'أذونات غير صالحة.', invalid_target: 'مورد غير صالح.', invalid_grant: 'التفويض غير صالح أو منتهي الصلاحية.',
        unsupported_grant_type: 'مسار التفويض غير مدعوم.', unsupported_response_type: 'نوع الاستجابة غير مدعوم.',
        invalid_client_metadata: 'تسجيل التطبيق غير صالح.', access_denied: 'تم رفض الوصول.', login_required: 'سجّل الدخول للمتابعة.',
        server_error: 'تعذّر إكمال التفويض.', rate_limited: 'طلبات كثيرة جدًا. حاول لاحقًا.',
        invalid_token: 'المصادقة مطلوبة.', insufficient_scope: 'الأذونات غير كافية.', unauthorized_client: 'لا يمكن لهذا التطبيق استخدام مسار التفويض هذا.',
        login: 'تسجيل الدخول إلى EClawbot', loginNotice: 'سجّل الدخول في علامة التبويب الجديدة ثم عد إلى هنا. ستكتشف هذه الصفحة جلستك وتعرض الأذونات المطلوبة.'
    }
};

function language(req) {
    const explicit = req.query?.lang;
    if (explicit === 'zh') return 'zh-TW';
    if (typeof explicit === 'string' && Object.hasOwn(TEXT, explicit)) return explicit;
    const preferred = req.acceptsLanguages?.(...Object.keys(TEXT));
    return preferred || 'en';
}

function oauthError(code, status = 400) {
    return Object.assign(new Error(TEXT.en[code]), { code, status, statusCode: status });
}

function hash(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function randomToken() {
    return crypto.randomBytes(32).toString('base64url');
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function string(value, max, code = 'invalid_request') {
    if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value)) {
        throw oauthError(code);
    }
    return value;
}

function fields(input, allowed) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Buffer.byteLength(JSON.stringify(input)) > BODY_LIMIT || Object.keys(input).some(key => !allowed.includes(key))) {
        throw oauthError('invalid_request');
    }
}

function scopes(value, fallback) {
    if (value === undefined) value = fallback;
    string(value, 128, 'invalid_scope');
    const list = value.split(' ');
    if (list.some(s => !SCOPES.includes(s)) || new Set(list).size !== list.length) throw oauthError('invalid_scope');
    return list;
}

function subset(requested, allowed) {
    if (requested.some(scope => !allowed.includes(scope))) throw oauthError('invalid_scope');
}

function httpsCallback(value) {
    string(value, 2048, 'invalid_client_metadata');
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || value.includes('#') || url.href !== value) throw new Error();
    } catch {
        throw oauthError('invalid_client_metadata');
    }
    return value;
}

/**
 * Dedicated OAuth 2.1 public-client server; mount router at /api/codex/oauth.
 * Publish metadata at the origin's /.well-known/oauth-authorization-server.
 * pool is an injected pg Pool (query + connect); devices is EClaw's owner map.
 * Requires cookie authentication from the real EClaw authMiddleware.
 * OAuth/DCR responses intentionally follow their RFC shapes, not EClaw envelopes.
 * authenticateBearer resolves only {deviceId, scopes, clientId}; it throws a
 * sanitized Error with status/statusCode 401 or 403 and a machine-readable code.
 */
function createCodexPluginOAuth({ pool, devices, authMiddleware, baseUrl, serverLog } = {}) {
    const secret = process.env.JWT_SECRET;
    if (typeof secret !== 'string' || !secret.trim()) throw new Error('JWT_SECRET is required for public-plugin OAuth');
    if (!pool || typeof pool.query !== 'function' ||
        !devices || typeof authMiddleware !== 'function') throw new Error('Public-plugin OAuth dependencies are required');
    let origin;
    try {
        const url = new URL(baseUrl);
        if (url.protocol !== 'https:' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error();
        origin = url.origin;
    } catch {
        throw new Error('Public-plugin OAuth requires an HTTPS baseUrl');
    }
    const resource = `${origin}/mcp`;
    const metadata = Object.freeze({
        issuer: origin,
        authorization_endpoint: `${origin}${MOUNT}/authorize`,
        token_endpoint: `${origin}${MOUNT}/token`,
        registration_endpoint: `${origin}${MOUNT}/register`,
        revocation_endpoint: `${origin}${MOUNT}/revoke`,
        authorization_response_iss_parameter_supported: true,
        response_types_supported: Object.freeze(['code']),
        response_modes_supported: Object.freeze(['query']),
        grant_types_supported: Object.freeze(['authorization_code', 'refresh_token']),
        token_endpoint_auth_methods_supported: Object.freeze(['none']),
        revocation_endpoint_auth_methods_supported: Object.freeze(['none']),
        code_challenge_methods_supported: Object.freeze(['S256']),
        scopes_supported: SCOPES
    });
    const router = express.Router();
    const ownerExists = id => typeof id === 'string' &&
        (devices instanceof Map ? Boolean(devices.get(id)) : Object.hasOwn(devices, id) && Boolean(devices[id]));
    // Only fixed event identifiers reach logs; never pass request/DB/error values.
    function logFailure() {
        try { if (serverLog) serverLog('error', 'codex_plugin', 'OAuth operation failed'); } catch { /* optional logger */ }
    }
    function fail(req, res, code, status = 400) {
        return res.status(status).json({ error: code, error_description: TEXT[language(req)][code] });
    }
    const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
    const limiter = (limit, windowMs) => rateLimit({
        windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false,
        keyGenerator: req => ipKeyGenerator(req.ip || req.socket.remoteAddress),
        handler: (req, res) => fail(req, res, 'rate_limited', 429)
    });
    router.use((_req, res, next) => {
        res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer',
            'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
        next();
    });
    router.use(cookieParser());
    router.use(express.json({ limit: BODY_LIMIT, strict: true }));
    router.use(express.urlencoded({ extended: false, limit: BODY_LIMIT, parameterLimit: 16 }));
    router.use((req, _res, next) => {
        if (req.originalUrl.length > 8192) return next(oauthError('invalid_request', 414));
        next();
    });

    async function initDatabase() {
        const schema = fs.readFileSync(path.join(__dirname, 'codex-plugin-oauth-schema.sql'), 'utf8');
        try {
            for (const statement of schema.split(';').filter(s => s.trim())) await pool.query(statement);
        } catch {
            logFailure();
            throw new Error('Public-plugin OAuth database initialization failed');
        }
    }

    async function transaction(fn) {
        // Existing EClaw test mocks expose a query-only pool. Allow discovery
        // and initialization with that shape, but never mint outside a real
        // dedicated transaction when connect() is unavailable.
        if (typeof pool.connect !== 'function') throw oauthError('server_error', 500);
        const connection = await pool.connect();
        try {
            await connection.query('BEGIN');
            const result = await fn(connection);
            await connection.query('COMMIT');
            return result;
        } catch (error) {
            await connection.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            connection.release();
        }
    }

    async function clientById(id) {
        string(id, 128, 'invalid_client');
        const result = await pool.query('SELECT * FROM codex_plugin_oauth_clients WHERE client_id = $1', [id]);
        if (!result.rows[0]) throw oauthError('invalid_client', 401);
        return result.rows[0];
    }

    function publicClient(req) {
        if (req.headers.authorization || req.body.client_secret !== undefined || req.body.client_assertion !== undefined) {
            throw oauthError('invalid_client', 401);
        }
    }

    function checkResource(value) {
        if (value !== resource) throw oauthError('invalid_target');
    }

    function loginRequired(req, res) {
        if (req.method !== 'GET') return fail(req, res, 'login_required', 401);
        const locale = language(req);
        const t = TEXT[locale];
        const nonce = randomToken();
        res.set('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
        // Portal return_to excludes OAuth. Keep the validated authorize URL open
        // and observe a freshly authenticated owner session without storing it.
        return res.type('html').send(page(locale, `<h1>${escapeHtml(t.title)}</h1>
            <p>${escapeHtml(t.loginNotice)}</p>
            <a href="/portal/" target="_blank" rel="noopener noreferrer">${escapeHtml(t.login)}</a>
            <script nonce="${nonce}">
            (function poll() {
                fetch('/api/auth/me', {credentials: 'same-origin', cache: 'no-store'})
                    .then(function(response) { return response.ok ? response.json() : null; })
                    .then(function(data) {
                        if (data && data.success && data.user && data.user.deviceId) { window.location.reload(); return; }
                        setTimeout(poll, 2000);
                    }).catch(function() { setTimeout(poll, 2000); });
            })();
            </script>`));
    }

    function ownerSession(req, res, next) {
        const cookie = req.cookies?.eclaw_session;
        if (typeof cookie !== 'string' || !cookie.length || cookie.length > 4096) return loginRequired(req, res);
        // Adapt EClaw's JSON 401 into a browser login redirect without exposing
        // session verification details. The real middleware still verifies it.
        const authResponse = Object.create(res);
        authResponse.status = () => authResponse;
        authResponse.json = () => loginRequired(req, res);
        return authMiddleware(req, authResponse, error => {
            if (error) return next(error);
            if (!ownerExists(req.user?.deviceId)) return fail(req, res, 'access_denied', 403);
            req.codexOwner = { deviceId: req.user.deviceId, sessionHash: hash(cookie) };
            next();
        });
    }

    router.post('/register', limiter(10, 10 * 60 * 1000), route(async (req, res) => {
        fields(req.body, ['client_name', 'redirect_uris', 'grant_types', 'response_types', 'token_endpoint_auth_method', 'scope']);
        const name = string(req.body.client_name, 200, 'invalid_client_metadata');
        const redirects = req.body.redirect_uris;
        if (!Array.isArray(redirects) || !redirects.length || redirects.length > 5 || new Set(redirects).size !== redirects.length) {
            throw oauthError('invalid_client_metadata');
        }
        redirects.forEach(httpsCallback);
        const grants = req.body.grant_types ?? ['authorization_code', 'refresh_token'];
        if (!Array.isArray(grants) || !grants.includes('authorization_code') || grants.length > 2 ||
            new Set(grants).size !== grants.length || grants.some(g => !metadata.grant_types_supported.includes(g)) ||
            (req.body.token_endpoint_auth_method !== undefined && req.body.token_endpoint_auth_method !== 'none') ||
            (req.body.response_types !== undefined && (!Array.isArray(req.body.response_types) ||
                req.body.response_types.length !== 1 || req.body.response_types[0] !== 'code'))) {
            throw oauthError('invalid_client_metadata');
        }
        const scope = scopes(req.body.scope, SCOPES.join(' ')).join(' ');
        const id = `cpo_${randomToken()}`;
        await pool.query(`INSERT INTO codex_plugin_oauth_clients (client_id, client_name, redirect_uris, grant_types, scope)
            VALUES ($1, $2, $3, $4, $5)`, [id, name, redirects, grants, scope]);
        res.status(201).json({ client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000),
            client_name: name, redirect_uris: redirects, grant_types: grants, response_types: ['code'],
            token_endpoint_auth_method: 'none', scope });
    }));

    async function authorizationRequest(req) {
        fields(req.query, ['response_type', 'client_id', 'redirect_uri', 'scope', 'resource', 'state', 'code_challenge', 'code_challenge_method', 'lang']);
        if (req.query.response_type !== 'code') throw oauthError('unsupported_response_type');
        const client = await clientById(req.query.client_id);
        const redirect = string(req.query.redirect_uri, 2048);
        if (!client.redirect_uris.includes(redirect)) throw oauthError('invalid_request');
        httpsCallback(redirect);
        checkResource(req.query.resource);
        const requested = scopes(req.query.scope, 'codex:read');
        subset(requested, scopes(client.scope));
        if (req.query.code_challenge_method !== 'S256' || !OPAQUE.test(string(req.query.code_challenge, 43))) {
            throw oauthError('invalid_request');
        }
        if (req.query.state !== undefined) string(req.query.state, 1024);
        if (req.query.lang !== undefined && (typeof req.query.lang !== 'string' ||
            (req.query.lang !== 'zh' && !Object.hasOwn(TEXT, req.query.lang)))) throw oauthError('invalid_request');
        return { client, redirect, scope: requested.join(' ') };
    }
    function page(locale, content) {
        return `<!doctype html><html lang="${escapeHtml(locale)}" dir="${locale === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(TEXT[locale].title)}</title>
            <style>body{font:16px system-ui,sans-serif;color:#182230;background:#f5f7fa;margin:0;padding:24px}
            main{max-width:620px;margin:40px auto;background:white;padding:28px;border-radius:12px;overflow-wrap:anywhere}
            button,a{font:inherit}button{padding:12px 20px;margin:8px 8px 0 0;cursor:pointer;min-height:44px}
            button:focus-visible,a:focus-visible{outline:3px solid #1259ba;outline-offset:3px}
            dt{font-weight:600;margin-top:16px}dd{margin:6px 0}code{unicode-bidi:isolate}
            @media(max-width:480px){body{padding:12px}main{margin:16px auto;padding:18px}button{width:100%}}</style>
            </head><body><main>${content}</main></body></html>`;
    }

    router.get('/authorize', limiter(30, 60 * 1000), (req, _res, next) => {
        authorizationRequest(req).then(value => { req.codexAuthorization = value; next(); }).catch(next);
    }, ownerSession, route(async (req, res) => {
        const { client, redirect, scope } = req.codexAuthorization;
        const csrf = randomToken();
        await pool.query(`INSERT INTO codex_plugin_oauth_consents
            (csrf_hash, session_hash, client_id, device_id, redirect_uri, resource, scope, state, code_challenge, expires_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [hash(csrf), req.codexOwner.sessionHash, client.client_id, req.codexOwner.deviceId,
            redirect, resource, scope, req.query.state ?? null, req.query.code_challenge, new Date(Date.now() + CONSENT_TTL * 1000)]);
        const locale = language(req);
        const t = TEXT[locale];
        res.type('html').send(page(locale, `<h1>${escapeHtml(t.title)}</h1><p>${escapeHtml(t.notice)}</p>
            <dl><dt>${escapeHtml(t.app)}</dt><dd>${escapeHtml(client.client_name)}</dd>
            <dt>${escapeHtml(t.callback)}</dt><dd><bdi dir="ltr">${escapeHtml(redirect)}</bdi></dd>
            <dt>${escapeHtml(t.resource)}</dt><dd><bdi dir="ltr">${escapeHtml(resource)}</bdi></dd></dl>
            <h2>${escapeHtml(t.permissions)}</h2><ul>${scope.split(' ').map(s =>
                `<li><code dir="ltr">${escapeHtml(s)}</code>: ${escapeHtml(s === 'codex:read' ? t.read : t.manage)}</li>`).join('')}</ul>
            <form method="post" action="${MOUNT}/authorize?lang=${encodeURIComponent(locale)}">
            <input type="hidden" name="csrf_token" value="${csrf}">
            <button type="submit" name="decision" value="approve">${escapeHtml(t.approve)}</button>
            <button type="submit" name="decision" value="deny">${escapeHtml(t.deny)}</button></form>`));
    }));

    function callback(row, params) {
        const url = new URL(row.redirect_uri);
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
        url.searchParams.set('iss', origin);
        if (row.state !== null) url.searchParams.set('state', row.state);
        return url.href;
    }

    router.post('/authorize', limiter(30, 60 * 1000), ownerSession, route(async (req, res) => {
        fields(req.body, ['csrf_token', 'decision']);
        fields(req.query, ['lang']);
        if (!OPAQUE.test(string(req.body.csrf_token, 43)) || !['approve', 'deny'].includes(req.body.decision)) {
            throw oauthError('invalid_request');
        }
        // The persisted nonce is bound to the authenticated owner AND cookie.
        // Origin/Referer checks add defense in depth; non-browser clients still
        // must possess the one-time nonce and the exact authenticated cookie.
        if (req.headers.origin && req.headers.origin !== origin) throw oauthError('access_denied', 403);
        if (req.headers.referer) {
            try { if (new URL(req.headers.referer).origin !== origin) throw new Error(); }
            catch { throw oauthError('access_denied', 403); }
        }
        const location = await transaction(async connection => {
            const result = await connection.query(`UPDATE codex_plugin_oauth_consents SET consumed_at = NOW()
                WHERE csrf_hash = $1 AND session_hash = $2 AND device_id = $3
                AND consumed_at IS NULL AND expires_at > NOW() RETURNING *`,
            [hash(req.body.csrf_token), req.codexOwner.sessionHash, req.codexOwner.deviceId]);
            const consent = result.rows[0];
            if (!consent) throw oauthError('access_denied', 403);
            // Re-check the registered client in case its allowlist was changed.
            const client = await connection.query('SELECT * FROM codex_plugin_oauth_clients WHERE client_id = $1', [consent.client_id]);
            if (!client.rows[0]?.redirect_uris.includes(consent.redirect_uri)) throw oauthError('invalid_client', 401);
            checkResource(consent.resource);
            subset(scopes(consent.scope), scopes(client.rows[0].scope));
            if (req.body.decision === 'deny') return callback(consent, { error: 'access_denied', error_description: TEXT[language(req)].access_denied });
            const code = randomToken();
            await connection.query(`INSERT INTO codex_plugin_oauth_codes
                (code_hash, client_id, device_id, redirect_uri, resource, scope, code_challenge, expires_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [hash(code), consent.client_id, consent.device_id, consent.redirect_uri, resource,
                consent.scope, consent.code_challenge, new Date(Date.now() + CODE_TTL * 1000)]);
            return callback(consent, { code });
        });
        res.redirect(303, location);
    }));

    async function issueTokens(connection, grant, scope, allowRefresh) {
        const now = Math.floor(Date.now() / 1000);
        const expires = Math.min(now + ACCESS_TTL, Math.floor(new Date(grant.expires_at).getTime() / 1000));
        if (expires <= now || !ownerExists(grant.device_id)) throw oauthError('invalid_grant');
        const access = jwt.sign({ type: 'codex_plugin_access', client_id: grant.client_id, scope,
            iat: now, exp: expires }, secret, { algorithm: 'HS256', header: { typ: 'at+jwt' },
            issuer: origin, audience: resource, subject: grant.device_id, jwtid: randomToken() });
        const refresh = allowRefresh ? randomToken() : null;
        await connection.query(`INSERT INTO codex_plugin_oauth_tokens
            (access_hash, refresh_hash, grant_id, scope, access_expires_at, refresh_expires_at)
            VALUES ($1, $2, $3, $4, $5, $6)`, [hash(access), refresh ? hash(refresh) : null,
            grant.grant_id, scope, new Date(expires * 1000), refresh ? grant.expires_at : null]);
        return { access_token: access, token_type: 'Bearer', expires_in: expires - now,
            ...(refresh ? { refresh_token: refresh } : {}), scope };
    }

    router.post('/token', limiter(60, 60 * 1000), route(async (req, res) => {
        fields(req.body, ['grant_type', 'client_id', 'code', 'redirect_uri', 'code_verifier', 'resource', 'refresh_token', 'scope']);
        publicClient(req);
        const client = await clientById(req.body.client_id);
        checkResource(req.body.resource);
        const type = req.body.grant_type;
        if (!metadata.grant_types_supported.includes(type)) throw oauthError('unsupported_grant_type');
        if (!client.grant_types.includes(type)) throw oauthError('unauthorized_client');
        if (type === 'authorization_code') {
            if (req.body.refresh_token !== undefined || req.body.scope !== undefined) throw oauthError('invalid_request');
            if (!OPAQUE.test(string(req.body.code, 43)) || !VERIFIER.test(string(req.body.code_verifier, 128))) throw oauthError('invalid_grant');
            string(req.body.redirect_uri, 2048);
            if (!client.redirect_uris.includes(req.body.redirect_uri)) throw oauthError('invalid_grant');
            const challenge = crypto.createHash('sha256').update(req.body.code_verifier).digest('base64url');
            const tokens = await transaction(async connection => {
                // One statement atomically consumes exactly one matching code;
                // rollback restores it if token persistence fails.
                const result = await connection.query(`UPDATE codex_plugin_oauth_codes SET consumed_at = NOW()
                    WHERE code_hash = $1 AND client_id = $2 AND redirect_uri = $3 AND resource = $4
                    AND code_challenge = $5 AND consumed_at IS NULL AND expires_at > NOW() RETURNING *`,
                [hash(req.body.code), client.client_id, req.body.redirect_uri, resource, challenge]);
                const code = result.rows[0];
                if (!code || !ownerExists(code.device_id)) throw oauthError('invalid_grant');
                subset(scopes(code.scope), scopes(client.scope));
                const grant = { grant_id: randomToken(), client_id: client.client_id, device_id: code.device_id,
                    expires_at: new Date(Date.now() + GRANT_TTL * 1000) };
                await connection.query(`INSERT INTO codex_plugin_oauth_grants
                    (grant_id, client_id, device_id, resource, scope, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`,
                [grant.grant_id, grant.client_id, grant.device_id, resource, code.scope, grant.expires_at]);
                return issueTokens(connection, grant, code.scope, client.grant_types.includes('refresh_token'));
            });
            return res.json(tokens);
        }
        if (req.body.code !== undefined || req.body.redirect_uri !== undefined || req.body.code_verifier !== undefined) throw oauthError('invalid_request');
        if (!OPAQUE.test(string(req.body.refresh_token, 43))) throw oauthError('invalid_grant');
        const tokens = await transaction(async connection => {
            // Lock both token and family: rotation serializes against concurrent
            // refresh and revocation. Absolute expiry is never extended.
            const result = await connection.query(`SELECT t.*, g.client_id, g.device_id, g.resource, g.expires_at
                FROM codex_plugin_oauth_tokens t JOIN codex_plugin_oauth_grants g ON g.grant_id = t.grant_id
                WHERE t.refresh_hash = $1 AND g.client_id = $2 AND g.resource = $3
                AND t.revoked_at IS NULL AND g.revoked_at IS NULL
                AND t.refresh_expires_at > NOW() AND g.expires_at > NOW() FOR UPDATE OF t, g`,
            [hash(req.body.refresh_token), client.client_id, resource]);
            const previous = result.rows[0];
            if (!previous) throw oauthError('invalid_grant');
            if (previous.refresh_consumed_at) {
                // Public-client rotation must detect replay and invalidate the
                // active family. Commit the revocation before returning an error.
                await connection.query('UPDATE codex_plugin_oauth_grants SET revoked_at = NOW() WHERE grant_id = $1', [previous.grant_id]);
                return null;
            }
            const requested = scopes(req.body.scope, previous.scope);
            subset(requested, scopes(previous.scope));
            subset(requested, scopes(client.scope));
            await connection.query(`UPDATE codex_plugin_oauth_tokens SET refresh_consumed_at = NOW()
                WHERE access_hash = $1`, [previous.access_hash]);
            return issueTokens(connection, previous, requested.join(' '), true);
        });
        if (!tokens) throw oauthError('invalid_grant');
        res.json(tokens);
    }));

    router.post('/revoke', limiter(60, 60 * 1000), route(async (req, res) => {
        fields(req.body, ['client_id', 'token', 'token_type_hint']);
        publicClient(req);
        const client = await clientById(req.body.client_id);
        const token = string(req.body.token, 4096);
        if (req.body.token_type_hint !== undefined && !['access_token', 'refresh_token'].includes(req.body.token_type_hint)) {
            throw oauthError('invalid_request');
        }
        // Revoking either token revokes the entire connection/family, including
        // rotated refresh tokens. Unknown or other-client tokens still yield 200.
        await pool.query(`UPDATE codex_plugin_oauth_grants SET revoked_at = NOW()
            WHERE client_id = $1 AND grant_id IN (SELECT grant_id FROM codex_plugin_oauth_tokens
                WHERE access_hash = $2 OR refresh_hash = $2)`, [client.client_id, hash(token)]);
        res.status(200).end();
    }));

    async function authenticateBearer(req, requiredScopes = []) {
        const invalid = () => oauthError('invalid_token', 401);
        let principal;
        try {
            const header = req.headers?.authorization;
            if (typeof header !== 'string' || header.length > 4103 || !/^Bearer [A-Za-z0-9._-]+$/i.test(header)) throw invalid();
            const token = header.slice(7);
            const { payload, header: jwtHeader } = jwt.verify(token, secret, {
                algorithms: ['HS256'], issuer: origin, audience: resource, complete: true
            });
            if (jwtHeader.typ !== 'at+jwt' || payload.type !== 'codex_plugin_access' ||
                payload.iss !== origin || payload.aud !== resource || !Number.isInteger(payload.exp) ||
                !ownerExists(payload.sub) || typeof payload.client_id !== 'string' || !OPAQUE.test(payload.jti)) throw invalid();
            const grantedScopes = scopes(payload.scope);
            const result = await pool.query(`SELECT t.scope, g.device_id, g.client_id, g.resource
                FROM codex_plugin_oauth_tokens t JOIN codex_plugin_oauth_grants g ON g.grant_id = t.grant_id
                WHERE t.access_hash = $1 AND t.revoked_at IS NULL AND g.revoked_at IS NULL
                AND t.access_expires_at > NOW() AND g.expires_at > NOW()`, [hash(token)]);
            const stored = result.rows[0];
            if (!stored || stored.device_id !== payload.sub || stored.client_id !== payload.client_id ||
                stored.resource !== resource || stored.scope !== payload.scope) throw invalid();
            principal = { deviceId: stored.device_id, scopes: grantedScopes, clientId: stored.client_id };
        } catch {
            throw invalid();
        }
        if (!Array.isArray(requiredScopes) || requiredScopes.some(s => !SCOPES.includes(s) || !principal.scopes.includes(s))) {
            throw oauthError('insufficient_scope', 403);
        }
        return principal;
    }

    router.use((error, req, res, _next) => {
        const code = Object.hasOwn(TEXT.en, error.code) ? error.code : 'server_error';
        if (error.type === 'entity.too.large') return fail(req, res, 'invalid_request', 413);
        if (error.type === 'entity.parse.failed' || error.type === 'parameters.too.many') return fail(req, res, 'invalid_request');
        if (code === 'server_error') logFailure();
        const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
        return fail(req, res, code, code === 'server_error' ? 500 : status);
    });

    return { router, metadata, authenticateBearer, initDatabase };
}

module.exports = { createCodexPluginOAuth };
