/**
 * One-time script: insert rn_1036 entries into i18n.js for all 8 languages
 * File uses Windows CRLF line endings (\r\n)
 * Run from project root: node scripts/update-i18n-1036.js
 */
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../backend/public/shared/i18n.js');
let content = fs.readFileSync(filePath, 'utf8');

const NL = '\r\n';
const IND = '        '; // 8 spaces

function makeBlock(entries) {
  return entries.map(([k, v]) => `${IND}"${k}": "${v}",`).join(NL) + NL + IND;
}

const features = {
  en: [
    ['rn_1036_title', 'v1.0.36'],
    ['rn_1036_date', '2026-03-04'],
    ['rn_1036_1', 'Phone Remote Control — AI can control your Android phone via Accessibility API commands'],
    ['rn_1036_2', 'Encrypted Variables Vault + JIT Approval — real-time owner approval dialog for bot secrets'],
    ['rn_1036_3', 'OpenClaw Channel Plugin — direct channel integration without webhook configuration'],
    ['rn_1036_4', 'Auto-provisioned Channel API Key — channel key created automatically on device registration'],
    ['rn_1036_5', 'Screen Control Stability — HTTP transport reverted, latency optimized, session limits removed'],
    ['rn_1036_6', 'Crash Fixes + Debug Logging — entity iteration crash fixed, crash reports sent to logs'],
  ],
  zh: [
    ['rn_1036_title', 'v1.0.36'],
    ['rn_1036_date', '2026-03-04'],
    ['rn_1036_1', '手機遠端控制 — AI 可透過無障礙 API 指令控制您的 Android 手機'],
    ['rn_1036_2', '加密變數保險庫 + 即時審批 — Bot 存取秘鑰時彈出即時擁有者審批對話框'],
    ['rn_1036_3', 'OpenClaw 頻道外掛 — 無需 Webhook 設定即可直接整合頻道'],
    ['rn_1036_4', '自動佈建頻道 API 金鑰 — 裝置註冊時自動建立頻道金鑰'],
    ['rn_1036_5', '螢幕控制穩定性 — 還原 HTTP 傳輸、優化延遲、移除 Session 限制'],
    ['rn_1036_6', '崩潰修復 + 除錯日誌 — 修復實體迭代崩潰，崩潰報告傳送至日誌'],
  ],
  'zh-CN': [
    ['rn_1036_title', 'v1.0.36'],
    ['rn_1036_date', '2026-03-04'],
    ['rn_1036_1', '手机远程控制 — AI 可通过无障碍 API 指令控制您的 Android 手机'],
    ['rn_1036_2', '加密变量保险柜 + 即时审批 — Bot 访问密钥时弹出即时拥有者审批对话框'],
    ['rn_1036_3', 'OpenClaw 频道插件 — 无需 Webhook 配置即可直接集成频道'],
    ['rn_1036_4', '自动配置频道 API 密钥 — 设备注册时自动创建频道密钥'],
    ['rn_1036_5', '屏幕控制稳定性 — 还原 HTTP 传输、优化延迟、移除 Session 限制'],
    ['rn_1036_6', '崩溃修复 + 调试日志 — 修复实体迭代崩溃，崩溃报告发送至日志'],
  ],
  ja: [
    ['rn_1036_title', 'v1.0.36'],
    ['rn_1036_date', '2026-03-04'],
    ['rn_1036_1', 'スマホリモート操作 — AIがアクセシビリティAPIでAndroidスマホを操作可能'],
    ['rn_1036_2', '暗号化変数ボールト + JIT承認 — Botが秘密情報にアクセス時にリアルタイム承認ダイアログを表示'],
    ['rn_1036_3', 'OpenClawチャンネルプラグイン — Webhook設定なしでチャンネルを直接統合'],
    ['rn_1036_4', 'チャンネルAPIキーの自動発行 — デバイス登録時にチャンネルキーを自動生成'],
    ['rn_1036_5', '画面操作安定性 — HTTPトランスポートの復元、遅延最適化、セッション制限の除去'],
    ['rn_1036_6', 'クラッシュ修正 + デバッグログ — エンティティ反復クラッシュ修正、クラッシュレポートをログに送信'],
  ],
  ko: [
    ['rn_1036_title', 'v1.0.36'],
    ['rn_1036_date', '2026-03-04'],
    ['rn_1036_1', '휴대폰 원격 제어 — AI가 접근성 API 명령으로 Android 휴대폰 제어 가능'],
    ['rn_1036_2', '암호화 변수 볼트 + JIT 승인 — Bot이 비밀에 접근 시 실시간 소유자 승인 다이얼로그 표시'],
    ['rn_1036_3', 'OpenClaw 채널 플러그인 — Webhook 설정 없이 직접 채널 통합'],
    ['rn_1036_4', '자동 발급 채널 API 키 — 기기 등록 시 채널 키 자동 생성'],
    ['rn_1036_5', '화면 제어 안정성 — HTTP 전송 복원, 지연 최적화, 세션 제한 제거'],
    ['rn_1036_6', '충돌 수정 + 디버그 로깅 — 엔티티 반복 충돌 수정, 충돌 보고서 로그에 전송'],
  ],
  th: [
    ['rn_1036_title', 'v1.0.36'],
    ['rn_1036_date', '2026-03-04'],
    ['rn_1036_1', 'ควบคุมโทรศัพท์ผ่านรีโมท — AI ควบคุมมือถือ Android ผ่านคำสั่ง Accessibility API'],
    ['rn_1036_2', 'ตู้เซฟตัวแปรเข้ารหัส + อนุมัติแบบเรียลไทม์ — กล่องอนุมัติเจ้าของเมื่อบอทเข้าถึงความลับ'],
    ['rn_1036_3', 'ปลั๊กอิน OpenClaw Channel — เชื่อมต่อช่องทางโดยตรงโดยไม่ต้องตั้งค่า Webhook'],
    ['rn_1036_4', 'สร้าง API Key ช่องทางอัตโนมัติ — สร้างคีย์ช่องทางอัตโนมัติเมื่อลงทะเบียนอุปกรณ์'],
    ['rn_1036_5', 'ความเสถียรภาพของการควบคุมหน้าจอ — ย้อนกลับ HTTP และปรับเวลาตอบสนอง ลบขีดจำกัดเซสชัน'],
    ['rn_1036_6', 'แก้ไขการเครา + ล็อกการดีบัก — แก้ไขการเคราช Entity ส่งรายงานการเคราชไปยังล็อก'],
  ],
  vi: [
    ['rn_1036_title', 'v1.0.36'],
    ['rn_1036_date', '2026-03-04'],
    ['rn_1036_1', 'Kiểm soát điện thoại từ xa — AI có thể điều khiển điện thoại Android qua lệnh Accessibility API'],
    ['rn_1036_2', 'Két biến mã hóa + Phê duyệt JIT — hộp thoại phê duyệt theo thời gian thực khi bot truy cập bí mật'],
    ['rn_1036_3', 'Plugin kênh OpenClaw — tích hợp kênh trực tiếp không cần cài đặt Webhook'],
    ['rn_1036_4', 'Khóa API kênh tự cấp phát — khóa kênh được tạo tự động khi đăng ký thiết bị'],
    ['rn_1036_5', 'Ổn định kiểm soát màn hình — đảo ngược HTTP, tối ưu độ trễ, loại bỏ giới hạn phiên'],
    ['rn_1036_6', 'Sửa lỗi sập + Ghi log — sửa lỗi lặp entity, báo cáo sập gửi vào logs'],
  ],
  id: [
    ['rn_1036_title', 'v1.0.36'],
    ['rn_1036_date', '2026-03-04'],
    ['rn_1036_1', 'Kontrol Ponsel Jarak Jauh — AI dapat mengontrol ponsel Android melalui perintah Accessibility API'],
    ['rn_1036_2', 'Vault Variabel Terenkripsi + Persetujuan JIT — dialog persetujuan pemilik real-time saat bot mengakses rahasia'],
    ['rn_1036_3', 'Plugin Saluran OpenClaw — integrasi saluran langsung tanpa konfigurasi Webhook'],
    ['rn_1036_4', 'Kunci API Saluran Otomatis — kunci saluran dibuat otomatis saat pendaftaran perangkat'],
    ['rn_1036_5', 'Stabilitas Kontrol Layar — HTTP dikembalikan, latensi dioptimalkan, batas sesi dihapus'],
    ['rn_1036_6', 'Perbaikan Crash + Debug Log — crash iterasi entitas diperbaiki, laporan crash dikirim ke log'],
  ],
};

// Unique anchors per language (the rn_1035_1 value differs per language)
const anchors = {
  en:      'Broadcast Recipient Info',
  zh:      '廣播接收者資訊',
  'zh-CN': '广播接收者信息',
  ja:      'ブロードキャスト受信者情報',
  ko:      '브로드캐스트 수신자 정보',
  th:      'ข้อมูลผู้รับการแพร่ภาพ',
  vi:      'Thông tin người nhận phát sóng',
  id:      'Info Penerima Siaran',
};

let updated = 0;
for (const [lang, anchor1035] of Object.entries(anchors)) {
  // Build the anchor string using actual CRLF
  const anchor = `"rn_1035_title": "v1.0.35",${NL}${IND}"rn_1035_date": "2026-03-03",${NL}${IND}"rn_1035_1": "${anchor1035}`;
  const newBlock = makeBlock(features[lang]);

  if (content.includes(anchor)) {
    content = content.replace(anchor, newBlock + anchor);
    updated++;
    console.log(`✓ ${lang}`);
  } else {
    console.error(`✗ NOT FOUND: ${lang} (anchor: ${anchor.substring(0, 60)})`);
  }
}

fs.writeFileSync(filePath, content, 'utf8');
console.log(`\nDone: ${updated}/${Object.keys(anchors).length} languages updated`);
