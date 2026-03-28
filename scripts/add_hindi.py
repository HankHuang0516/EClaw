#!/usr/bin/env python3
"""Add Hindi translations to i18n.js"""
import re

with open('backend/public/shared/i18n.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Hindi translations (hi) - Devanagari script
hindi_keys = {
    "mc_title": "EClawbot मिशन सेंटर",
    "mc_auth_title": "मिशन सेंटर",
    "mc_auth_subtitle": "डैशबोर्ड सिंक करने के लिए डिवाइस क्रेडेंशियल दर्ज करें",
    "mc_input_device_id": "डिवाइस आईडी",
    "mc_input_device_secret": "डिवाइस सीक्रेट",
    "mc_btn_connect": "कनेक्ट करें",
    "mc_auth_error_missing": "कृपया डिवाइस आईडी और सीक्रेट दर्ज करें",
    "mc_refresh": "रीफ्रेश",
    "mc_notify_btn": "नोटिफिकेशन भेजें",
    "mc_syncing": "सिंक हो रहा है...",
    "mc_notify_dialog_title": "📢 टास्क अपडेट भेजें",
    "mc_notify_dialog_desc": "नोटिफाई करने के लिए आइटम चुनें — वे Webhook के माध्यम से असाइन किए गए एंटिटी को भेजे जाएंगे:",
    "mc_notify_skip": "छोड़ें",
    "mc_notify_send": "भेजें",
    "mc_no_notify_items": "नोटिफाई करने के लिए कोई नया बदलाव नहीं",
    "mc_todo_title": "टास्क सूची",
    "mc_btn_add": "+ जोड़ें",
    "mc_mission_title": "मिशन सूची",
    "mc_done_title": "पूर्ण सूची",
    "mc_notes_title": "नोट्स",
    "mc_rules_title": "नियम (वर्कफ़्लो)",
    "mc_sync_unsaved": "* सेव नहीं किए गए बदलाव",
    "mc_sync_synced": "सिंक हो गया",
    "mc_task_saved": "टास्क सेव हो गया",
    "mc_empty_todo": "कोई टास्क नहीं",
    "mc_empty_mission": "कोई सक्रिय मिशन नहीं",
    "mc_empty_done": "कोई पूर्ण आइटम नहीं",
    "mc_empty_notes": "कोई नोट नहीं",
    "mc_empty_rules": "कोई नियम नहीं",
    "mc_status_pending": "लंबित",
    "mc_status_inprogress": "प्रगति में",
    "mc_status_blocked": "अवरुद्ध",
    "mc_status_done": "पूर्ण",
    "mc_status_cancelled": "रद्द",
    "mc_priority_low": "कम",
    "mc_priority_medium": "मध्यम",
    "mc_priority_high": "उच्च",
    "mc_priority_urgent": "तत्काल",
    "mc_confirm_delete": "क्या आप वाकई हटाना चाहते हैं?",
    "mc_confirm_version": "संस्करण संघर्ष (आप: v{you}, सर्वर: v{server})। नवीनतम संस्करण डाउनलोड करें?",
    "mc_dlg_add_todo": "टास्क जोड़ें",
    "mc_dlg_edit": "संपादित करें",
    "mc_dlg_title": "शीर्षक",
    "mc_dlg_desc": "विवरण",
    "mc_dlg_priority": "प्राथमिकता",
    "mc_dlg_save": "सेव करें",
    "mc_dlg_cancel": "रद्द करें",
    "mc_dlg_due_at": "नियत समय",
    "mc_card_due_at": "नियत समय",
    "mc_card_countdown": "उलटी गिनती",
    "mc_countdown_overdue": "देरी",
    "mc_countdown_min": "मिनट",
    "mc_countdown_hr": "घंटे",
    "mc_countdown_day": "दिन",
    "mc_dlg_add_note": "नोट जोड़ें",
    "mc_dlg_edit_note": "नोट संपादित करें",
    "mc_dlg_content": "सामग्री",
    "mc_dlg_category": "श्रेणी",
    "mc_add_category": "+ श्रेणी",
    "mc_rename_category": "नाम बदलें",
    "mc_delete_category": "श्रेणी हटाएं",
    "mc_clear_category": "श्रेणी खाली करें",
    "mc_uncategorized": "-- बिना श्रेणी --",
    "mc_confirm_clear_category": "इस श्रेणी के सभी आइटम खाली करें?",
    "mc_confirm_delete_category": "इस श्रेणी को हटाएं? आइटम बिना श्रेणी के रह जाएंगे।",
    "mc_prompt_category_name": "श्रेणी का नाम:",
    "mc_prompt_rename_category": "श्रेणी का नया नाम:",
    "mc_category_exists": "श्रेणी पहले से मौजूद है",
    "mc_empty_category": "खाली",
    "mc_dlg_add_rule": "नियम जोड़ें",
    "mc_dlg_edit_rule": "नियम संपादित करें",
    "mc_dlg_rule_name": "नियम का नाम",
    "mc_dlg_rule_type": "प्रकार",
    "mc_souls_title": "आत्मा",
    "mc_empty_souls": "कोई आत्मा कॉन्फ़िगर नहीं",
    "mc_dlg_add_soul": "आत्मा जोड़ें",
    "mc_dlg_edit_soul": "आत्मा संपादित करें",
    "mc_dlg_soul_name": "आत्मा का नाम",
    "mc_dlg_soul_desc": "व्यक्तित्व विवरण",
    "mc_dlg_soul_desc_hint": "इस आत्मा का व्यक्तित्व, स्वर और व्यवहार वर्णन करें...",
    "mc_dlg_soul_template": "आत्मा टेम्पलेट",
    "mc_dlg_soul_custom": "-- कस्टम --",
    "mc_dlg_soul_template_btn": "🎭 टेम्पलेट से चुनें",
    "mc_dlg_soul_gallery_builtin": "बिल्ट-इन",
    "mc_dlg_soul_gallery_community": "समुदाय",
    "mc_dlg_soul_multi": "कई चुनें",
    "mc_menu_move_mission": "मिशन में ले जाएं",
    "mc_menu_mark_done": "पूर्ण चिह्नित करें",
    "mc_menu_delete": "हटाएं",
    "mc_search_placeholder": "खोजें…",
    "mc_browse_official_tpl": "आधिकारिक टेम्पलेट ब्राउज़ करें",
    "mc_rule_template_title": "नियम टेम्पलेट",
    "mc_skill_change": "बदलें",
    "mc_skill_name_label": "कौशल नाम",
    "mc_skill_name_placeholder": "उदाहरण: Google खोज",
    "mc_skill_url_label": "संबंधित URL (वैकल्पिक)",
    "mc_skill_steps_label": "इंस्टॉलेशन चरण (वैकल्पिक)",
    "mc_skill_steps_placeholder": "पूर्ण इंस्टॉलेशन और कॉन्फ़िगरेशन चरण…",
    "mc_skill_assign_entity": "एंटिटी असाइन करें (कई चुनें)",
    "mc_note_open_page": "पेज खोलें",
    "mc_note_edit_page": "पेज संपादित करें",
    "mc_note_copy_link": "लिंक कॉपी करें",
    "mc_note_link_copied": "कॉपी हो गया!",
    "mc_note_no_public_code": "कोई पब्लिक कोड नहीं",
    "mc_note_draw": "ड्रॉ करें",
    "mc_note_draw_save": "ड्रॉ सेव करें",
    "mc_note_draw_clear": "साफ़ करें",
    "mc_note_draw_clear_confirm": "सभी ड्रॉ साफ़ करें?",
    "mc_note_draw_eraser": "इरेज़र",
    "mc_note_draw_saved": "ड्रॉ सेव हो गया",
    "mc_note_page_close": "बंद करें",
    "mc_note_page_placeholder": "HTML सामग्री दर्ज करें...",
    "mc_note_page_link_hint": "आंतरिक लिंक: <a href=\"eclaw://note/NOTE_ID\">...</a>",
    "mc_note_page_saved": "पेज सेव हो गया",
    "mc_note_page_empty": "अभी तक कोई सामग्री नहीं।",
    "portal_login_title": "EClawbot - लॉगिन",
    "portal_app_title": "EClawbot",
    "portal_app_subtitle": "आपका डायनामिक लाइव वॉलपेपर पार्टनर",
    "nav_dashboard": "डैशबोर्ड",
    "nav_chat": "चैट",
    "nav_files": "फ़ाइलें",
    "nav_mission": "मिशन",
    "nav_settings": "सेटिंग्स",
    "nav_logout": "लॉग आउट",
    "nav_split_view": "स्प्लिट व्यू",
    "workspace_close_pane": "पैन बंद करें",
    "nav_compare": "तुलना",
    "nav_faq": "सामान्य प्रश्न",
    "nav_release_notes": "रिलीज़ नोट्स",
    "nav_user_guide": "उपयोगकर्ता गाइड",
    "nav_login": "लॉगिन",
    "nav_info": "जानकारी",
    "nav_admin": "एडमिन",
    "nav_card_holder": "कार्ड होल्डर",
    "nav_community": "समुदाय",
    "nav_enterprise": "एंटरप्राइज़",
    "dash_tos_load_error": "सेवा की शर्तें लोड करने में त्रुटि।",
    "cardholder_proto_placeholder": "उदाहरण: A2A, REST, gRPC",
    "cardholder_cap_name": "नाम",
    "cardholder_cap_desc": "विवरण",
}

# Generate hi block
hi_lines = ["    hi: {"]
for i, (key, value) in enumerate(sorted(hindi_keys.items())):
    comma = "," if i < len(hindi_keys) - 1 else ""
    escaped_value = value.replace("\\", "\\\\").replace('"', '\\"')
    hi_lines.append(f'        "{key}": "{escaped_value}"{comma}')
hi_lines.append("    },")

hi_block = "\n".join(hi_lines) + "\n\n"

# Find the closing of TRANSLATIONS object
# Pattern: ms block ends with "    },\n" then "};\n" then "// Portal version"
pattern = r'(\n    },\n)(};\n)(\n// Portal version)'
match = re.search(pattern, content)

if match:
    # Insert hi block after the ms block closing, before "};
    insert_pos = match.start() + len(match.group(1))
    content = content[:insert_pos] + hi_block + content[insert_pos:]
    
    with open('backend/public/shared/i18n.js', 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"Added {len(hindi_keys)} Hindi translations")
else:
    print("Could not find insertion point")
    # Debug
    idx = content.find("// Portal version")
    if idx != -1:
        print(f"Found '// Portal version' at {idx}")
        print(f"Content around it:")
        print(repr(content[idx-50:idx+50]))
    exit(1)
