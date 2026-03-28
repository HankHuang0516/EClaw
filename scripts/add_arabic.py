#!/usr/bin/env python3
"""Add Arabic translations to i18n.js"""
import re

with open('backend/public/shared/i18n.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Arabic translations (ar) - RTL language
arabic_keys = {
    "mc_title": "EClawbot مركز المهام",
    "mc_auth_title": "مركز المهام",
    "mc_auth_subtitle": "أدخل بيانات اعتماد الجهاز لمزامنة لوحة التحكم",
    "mc_input_device_id": "معرف الجهاز",
    "mc_input_device_secret": "سر الجهاز",
    "mc_btn_connect": "اتصال",
    "mc_auth_error_missing": "يرجى إدخال معرف الجهاز والسر",
    "mc_refresh": "تحديث",
    "mc_notify_btn": "إرسال إشعار",
    "mc_syncing": "جاري المزامنة...",
    "mc_notify_dialog_title": "📢 إرسال تحديث المهمة",
    "mc_notify_dialog_desc": "حدد العناصر المراد إشعارها - سيتم إرسالها إلى الكيانات المعينة عبر Webhook:",
    "mc_notify_skip": "تخطي",
    "mc_notify_send": "إرسال",
    "mc_no_notify_items": "لا توجد تغييرات جديدة للإشعار",
    "mc_todo_title": "قائمة المهام",
    "mc_btn_add": "+ إضافة",
    "mc_mission_title": "قائمة المهام",
    "mc_done_title": "قائمة المكتمل",
    "mc_notes_title": "ملاحظات",
    "mc_rules_title": "القواعد (سير العمل)",
    "mc_sync_unsaved": "* تغييرات غير محفوظة",
    "mc_sync_synced": "متزامن",
    "mc_task_saved": "تم حفظ المهمة",
    "mc_empty_todo": "لا توجد مهام",
    "mc_empty_mission": "لا توجد مهام نشطة",
    "mc_empty_done": "لا توجد عناصر مكتملة",
    "mc_empty_notes": "لا توجد ملاحظات",
    "mc_empty_rules": "لا توجد قواعد",
    "mc_status_pending": "قيد الانتظار",
    "mc_status_inprogress": "قيد التنفيذ",
    "mc_status_blocked": "محظور",
    "mc_status_done": "مكتمل",
    "mc_status_cancelled": "ملغى",
    "mc_priority_low": "منخفض",
    "mc_priority_medium": "متوسط",
    "mc_priority_high": "عالي",
    "mc_priority_urgent": "عاجل",
    "mc_confirm_delete": "هل أنت متأكد أنك تريد الحذف؟",
    "mc_confirm_version": "تعارض في الإصدار (أنت: v{you}، الخادم: v{server}). تحميل أحدث إصدار؟",
    "mc_dlg_add_todo": "إضافة مهمة",
    "mc_dlg_edit": "تحرير",
    "mc_dlg_title": "العنوان",
    "mc_dlg_desc": "الوصف",
    "mc_dlg_priority": "الأولوية",
    "mc_dlg_save": "حفظ",
    "mc_dlg_cancel": "إلغاء",
    "mc_dlg_due_at": "وقت الاستحقاق",
    "mc_card_due_at": "وقت الاستحقاق",
    "mc_card_countdown": "العد التنازلي",
    "mc_countdown_overdue": "متأخر",
    "mc_countdown_min": "دقائق",
    "mc_countdown_hr": "ساعات",
    "mc_countdown_day": "أيام",
    "mc_dlg_add_note": "إضافة ملاحظة",
    "mc_dlg_edit_note": "تحرير الملاحظة",
    "mc_dlg_content": "المحتوى",
    "mc_dlg_category": "الفئة",
    "mc_add_category": "+ الفئة",
    "mc_rename_category": "إعادة تسمية",
    "mc_delete_category": "حذف الفئة",
    "mc_clear_category": "إفراغ الفئة",
    "mc_uncategorized": "-- بدون فئة --",
    "mc_confirm_clear_category": "إفراغ جميع العناصر في هذه الفئة؟",
    "mc_confirm_delete_category": "حذف هذه الفئة؟ ستبقى العناصر بدون فئة.",
    "mc_prompt_category_name": "اسم الفئة:",
    "mc_prompt_rename_category": "اسم الفئة الجديد:",
    "mc_category_exists": "الفئة موجودة بالفعل",
    "mc_empty_category": "فارغ",
    "mc_dlg_add_rule": "إضافة قاعدة",
    "mc_dlg_edit_rule": "تحرير القاعدة",
    "mc_dlg_rule_name": "اسم القاعدة",
    "mc_dlg_rule_type": "النوع",
    "mc_souls_title": "الروح",
    "mc_empty_souls": "لم يتم تكوين روح",
    "mc_dlg_add_soul": "إضافة روح",
    "mc_dlg_edit_soul": "تحرير الروح",
    "mc_dlg_soul_name": "اسم الروح",
    "mc_dlg_soul_desc": "وصف الشخصية",
    "mc_dlg_soul_desc_hint": "صف شخصية هذه الروح ونبرتها وسلوكها...",
    "mc_dlg_soul_template": "قالب الروح",
    "mc_dlg_soul_custom": "-- مخصص --",
    "mc_dlg_soul_template_btn": "🎭 اختر من القالب",
    "mc_dlg_soul_gallery_builtin": "مدمج",
    "mc_dlg_soul_gallery_community": "المجتمع",
    "mc_dlg_soul_multi": "اختر عدة",
    "mc_menu_move_mission": "نقل إلى مهمة",
    "mc_menu_mark_done": "تحديد كمكتمل",
    "mc_menu_delete": "حذف",
    "mc_search_placeholder": "بحث…",
    "mc_browse_official_tpl": "تصفح القوالب الرسمية",
    "mc_rule_template_title": "قالب القاعدة",
    "mc_skill_change": "تغيير",
    "mc_skill_name_label": "اسم المهارة",
    "mc_skill_name_placeholder": "مثال: بحث Google",
    "mc_skill_url_label": "URL ذات صلة (اختياري)",
    "mc_skill_steps_label": "خطوات التثبيت (اختياري)",
    "mc_skill_steps_placeholder": "خطوات التثبيت والتكوين الكاملة…",
    "mc_skill_assign_entity": "تعيين الكيانات (اختر عدة)",
    "mc_note_open_page": "فتح الصفحة",
    "mc_note_edit_page": "تحرير الصفحة",
    "mc_note_copy_link": "نسخ الرابط",
    "mc_note_link_copied": "تم النسخ!",
    "mc_note_no_public_code": "لا يوجد رمز عام",
    "mc_note_draw": "رسم",
    "mc_note_draw_save": "حفظ الرسم",
    "mc_note_draw_clear": "مسح",
    "mc_note_draw_clear_confirm": "مسح جميع الرسومات؟",
    "mc_note_draw_eraser": "ممحاة",
    "mc_note_draw_saved": "تم حفظ الرسم",
    "mc_note_page_close": "إغلاق",
    "mc_note_page_placeholder": "أدخل محتوى HTML...",
    "mc_note_page_link_hint": "رابط داخلي: <a href=\"eclaw://note/NOTE_ID\">...</a>",
    "mc_note_page_saved": "تم حفظ الصفحة",
    "mc_note_page_empty": "لا يوجد محتوى بعد.",
    "portal_login_title": "EClawbot - تسجيل الدخول",
    "portal_app_title": "EClawbot",
    "portal_app_subtitle": "شريك خلفية الشاشة الحية الديناميكية",
    "nav_dashboard": "لوحة التحكم",
    "nav_chat": "محادثة",
    "nav_files": "ملفات",
    "nav_mission": "مهمة",
    "nav_settings": "الإعدادات",
    "nav_logout": "تسجيل الخروج",
    "nav_split_view": "عرض مقسم",
    "workspace_close_pane": "إغلاق اللوحة",
    "nav_compare": "مقارنة",
    "nav_faq": "الأسئلة الشائعة",
    "nav_release_notes": "ملاحظات الإصدار",
    "nav_user_guide": "دليل المستخدم",
    "nav_login": "تسجيل الدخول",
    "nav_info": "معلومات",
    "nav_admin": "مدير",
    "nav_card_holder": "حامل البطاقة",
    "nav_community": "المجتمع",
    "nav_enterprise": "المؤسسات",
    "dash_tos_load_error": "خطأ في تحميل شروط الخدمة.",
    "cardholder_proto_placeholder": "مثال: A2A, REST, gRPC",
    "cardholder_cap_name": "الاسم",
    "cardholder_cap_desc": "الوصف",
}

# Generate ar block
ar_lines = ["    ar: {"]
for i, (key, value) in enumerate(sorted(arabic_keys.items())):
    comma = "," if i < len(arabic_keys) - 1 else ""
    escaped_value = value.replace("\\", "\\\\").replace('"', '\\"')
    ar_lines.append(f'        "{key}": "{escaped_value}"{comma}')
ar_lines.append("    },")

ar_block = "\n".join(ar_lines) + "\n"

# Find insertion point - after the last language block's closing };
# The hi block ends with "    },\n\n};\n\n// Portal version"
# We want to insert the ar block before "};\n\n// Portal version"

# Find "// Portal version"
portal_idx = content.find('// Portal version')
if portal_idx == -1:
    print("Could not find // Portal version")
    exit(1)

# Find the }; that closes TRANSLATIONS - look backwards from portal_idx
search_region = content[:portal_idx]
# Find the last "};" in the search region
closing_idx = search_region.rfind('};')
if closing_idx == -1:
    print("Could not find closing };")
    exit(1)

print(f"Found // Portal version at {portal_idx}")
print("Found closing }; at", closing_idx)

# Insert ar block before the newline that precedes };\# Actually, we want to insert between "    }," of the hi block and "};\n\n// Portal version"
# Let's find "    }," right before "};\n\n// Portal version"
pattern = r'    },\n\n};\n\n// Portal version'
match = re.search(pattern, content)

if match:
    insert_pos = match.start() + len('    },\n')
    content = content[:insert_pos] + ar_block + content[insert_pos:]
    
    with open('backend/public/shared/i18n.js', 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"Added {len(arabic_keys)} Arabic translations")
else:
    print("Could not find insertion point pattern")
    # Try alternative pattern with single newline
    pattern2 = r'    },\n};\n\n// Portal version'
    match2 = re.search(pattern2, content)
    if match2:
        insert_pos = match2.start() + len('    },\n')
        content = content[:insert_pos] + ar_block + content[insert_pos:]
        
        with open('backend/public/shared/i18n.js', 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"Added {len(arabic_keys)} Arabic translations (alt pattern)")
    else:
        print("All patterns failed")
        exit(1)
