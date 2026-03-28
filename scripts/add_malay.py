#!/usr/bin/env python3
"""Add Malay translations to i18n.js"""
import re

with open('backend/public/shared/i18n.js', 'r', encoding='utf-8') as f:
    content = f.read()

malay_keys = {
    "mc_title": "EClawbot Pusat Misi",
    "mc_auth_title": "Pusat Misi",
    "mc_auth_subtitle": "Masukkan bukti kelayakan peranti untuk menyegerakkan Papan Pemuka",
    "mc_input_device_id": "ID Peranti",
    "mc_input_device_secret": "Rahsia Peranti",
    "mc_btn_connect": "Sambungkan",
    "mc_auth_error_missing": "Sila masukkan ID dan Rahsia peranti",
    "mc_refresh": "Muat Semula",
    "mc_notify_btn": "Hantar Pemberitahuan",
    "mc_syncing": "Menyegerakkan...",
    "mc_notify_dialog_title": "📢 Hantar Kemas kini Tugas",
    "mc_notify_dialog_desc": "Pilih item untuk diberitahu — akan dihantar kepada entiti yang ditugaskan melalui Webhook:",
    "mc_notify_skip": "Langkau",
    "mc_notify_send": "Hantar",
    "mc_no_notify_items": "Tiada perubahan baharu untuk diberitahu",
    "mc_todo_title": "Senarai Tugasan",
    "mc_btn_add": "+ Tambah",
    "mc_mission_title": "Senarai Misi",
    "mc_done_title": "Senarai Selesai",
    "mc_notes_title": "Nota",
    "mc_rules_title": "Aturan (Alur Kerja)",
    "mc_sync_unsaved": "* Perubahan belum disimpan",
    "mc_sync_synced": "Tersegerak",
    "mc_task_saved": "Tugasan disimpan",
    "mc_empty_todo": "Tiada tugasan",
    "mc_empty_mission": "Tiada misi aktif",
    "mc_empty_done": "Tiada item selesai",
    "mc_empty_notes": "Tiada nota",
    "mc_empty_rules": "Tiada aturan",
    "mc_status_pending": "Teragak-agak",
    "mc_status_inprogress": "Dalam Proses",
    "mc_status_blocked": "Disekat",
    "mc_status_done": "Selesai",
    "mc_status_cancelled": "Dibatalkan",
    "mc_priority_low": "Rendah",
    "mc_priority_medium": "Sederhana",
    "mc_priority_high": "Tinggi",
    "mc_priority_urgent": "Segera",
    "mc_confirm_delete": "Adakah anda pasti ingin memadam?",
    "mc_confirm_version": "Konflik versi (Anda: v{you}, Pelayan: v{server}). Muat turun versi terkini?",
    "mc_dlg_add_todo": "Tambah Tugasan",
    "mc_dlg_edit": "Sunting",
    "mc_dlg_title": "Tajuk",
    "mc_dlg_desc": "Keterangan",
    "mc_dlg_priority": "Keutamaan",
    "mc_dlg_save": "Simpan",
    "mc_dlg_cancel": "Batal",
    "mc_dlg_due_at": "Masa Akhir",
    "mc_card_due_at": "Masa Akhir",
    "mc_card_countdown": "Undur Masa",
    "mc_countdown_overdue": "Lewat",
    "mc_countdown_min": "minit",
    "mc_countdown_hr": "jam",
    "mc_countdown_day": "hari",
    "mc_dlg_add_note": "Tambah Nota",
    "mc_dlg_edit_note": "Sunting Nota",
    "mc_dlg_content": "Kandungan",
    "mc_dlg_category": "Kategori",
    "mc_add_category": "+ Kategori",
    "mc_rename_category": "Namakan Semula",
    "mc_delete_category": "Padam kategori",
    "mc_clear_category": "Kosongkan kategori",
    "mc_uncategorized": "-- Tanpa kategori --",
    "mc_confirm_clear_category": "Kosongkan semua item dalam kategori ini?",
    "mc_confirm_delete_category": "Padam kategori ini? Item akan tinggal tanpa kategori.",
    "mc_prompt_category_name": "Nama kategori:",
    "mc_prompt_rename_category": "Nama kategori baharu:",
    "mc_category_exists": "Kategori sudah wujud",
    "mc_empty_category": "Kosong",
    "mc_dlg_add_rule": "Tambah Aturan",
    "mc_dlg_edit_rule": "Sunting Aturan",
    "mc_dlg_rule_name": "Nama Aturan",
    "mc_dlg_rule_type": "Jenis",
    "mc_souls_title": "Jiwa",
    "mc_empty_souls": "Tiada jiwa dikonfigurasi",
    "mc_dlg_add_soul": "Tambah Jiwa",
    "mc_dlg_edit_soul": "Sunting Jiwa",
    "mc_dlg_soul_name": "Nama Jiwa",
    "mc_dlg_soul_desc": "Keterangan Personaliti",
    "mc_dlg_soul_desc_hint": "Huraikan personaliti, nada suara dan tingkah laku jiwa ini...",
    "mc_dlg_soul_template": "Templat Jiwa",
    "mc_dlg_soul_custom": "-- Suai --",
    "mc_dlg_soul_template_btn": "🎭 Pilih dari templat",
    "mc_dlg_soul_gallery_builtin": "Terbina",
    "mc_dlg_soul_gallery_community": "Komuniti",
    "mc_dlg_soul_multi": "Pilih beberapa",
    "mc_menu_move_mission": "Pindah ke Misi",
    "mc_menu_mark_done": "Tanda Selesai",
    "mc_menu_delete": "Padam",
    "mc_search_placeholder": "Cari…",
    "mc_browse_official_tpl": "Lihat Templat Rasmi",
    "mc_rule_template_title": "Templat Aturan",
    "mc_skill_change": "Ubah",
    "mc_skill_name_label": "Nama Kemahiran",
    "mc_skill_name_placeholder": "Contoh: Carian Google",
    "mc_skill_url_label": "URL Berkaitan (pilihan)",
    "mc_skill_steps_label": "Langkah Pemasangan (pilihan)",
    "mc_skill_steps_placeholder": "Langkah lengkap pemasangan dan konfigurasi…",
    "mc_skill_assign_entity": "Tugaskan Entiti (pilih beberapa)",
    "mc_note_open_page": "Buka Halaman",
    "mc_note_edit_page": "Sunting Halaman",
    "mc_note_copy_link": "Salin Pautan",
    "mc_note_link_copied": "Disalin!",
    "mc_note_no_public_code": "Tiada kod awam",
    "mc_note_draw": "Lukis",
    "mc_note_draw_save": "Simpan Lukisan",
    "mc_note_draw_clear": "Kosongkan",
    "mc_note_draw_clear_confirm": "Kosongkan semua lukisan?",
    "mc_note_draw_eraser": "Pemadam",
    "mc_note_draw_saved": "Lukisan disimpan",
    "mc_note_page_close": "Tutup",
    "mc_note_page_placeholder": "Masukkan kandungan HTML...",
    "mc_note_page_link_hint": "Pautan dalaman: <a href=\"eclaw://note/NOTE_ID\">...</a>",
    "mc_note_page_saved": "Halaman disimpan",
    "mc_note_page_empty": "Belum ada kandungan.",
    "portal_login_title": "EClawbot - Daftar Masuk",
    "portal_app_title": "EClawbot",
    "portal_app_subtitle": "Pasangan Skrin Hidup Dinamik Anda",
    "nav_dashboard": "Papan Pemuka",
    "nav_chat": "Chat",
    "nav_files": "Fail",
    "nav_mission": "Misi",
    "nav_settings": "Tetapan",
    "nav_logout": "Daftar Keluar",
    "nav_split_view": "Paparan Terbelah",
    "workspace_close_pane": "Tutup Panel",
    "nav_compare": "Perbandingan",
    "nav_faq": "Soalan Lazim",
    "nav_release_notes": "Nota Keluaran",
    "nav_user_guide": "Panduan Pengguna",
    "nav_login": "Daftar Masuk",
    "nav_info": "Maklumat",
    "nav_admin": "Admin",
    "nav_card_holder": "Pemegang Kad",
    "nav_community": "Komuniti",
    "nav_enterprise": "Usaha",
    "dash_tos_load_error": "Ralat memuatkan terma perkhidmatan.",
    "cardholder_proto_placeholder": "Contoh: A2A, REST, gRPC",
    "cardholder_cap_name": "Nama",
    "cardholder_cap_desc": "Keterangan",
}

# Generate ms block
ms_lines = ["    ms: {"]
for i, (key, value) in enumerate(sorted(malay_keys.items())):
    comma = "," if i < len(malay_keys) - 1 else ""
    escaped_value = value.replace("\\", "\\\\").replace('"', '\\"')
    ms_lines.append(f'        "{key}": "{escaped_value}"{comma}')
ms_lines.append("    },")

ms_block = "\n".join(ms_lines) + "\n\n"

# Find the closing of TRANSLATIONS object
# After the id block ends with "    },\n", then "\n};\n" closes TRANSLATIONS
# Pattern: insert ms block before the "};  " that closes TRANSLATIONS
# Looking for "    },\n\n};\n\n// Portal version"
pattern = r'(\n    },\n)(\n};\n)(\n// Portal version)'
match = re.search(pattern, content)

if match:
    # Insert ms_block after the id block closing, before "};"
    insert_pos = match.start() + len(match.group(1))
    content = content[:insert_pos] + ms_block + content[insert_pos:]
    
    with open('backend/public/shared/i18n.js', 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"Added {len(malay_keys)} Malay translations")
else:
    print("Could not find insertion point, trying alternative...")
    # Alternative: find "};  " after the last language block and insert before it
    alt_pattern = r'(\n    },\n)(\n};\n)(\n// Portal)'
    match2 = re.search(alt_pattern, content)
    if match2:
        insert_pos = match2.start() + len(match2.group(1))
        content = content[:insert_pos] + ms_block + content[insert_pos:]
        with open('backend/public/shared/i18n.js', 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"Added {len(malay_keys)} Malay translations (alt method)")
    else:
        print("All methods failed")
        exit(1)
