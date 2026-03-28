// Script to add Spanish translations to i18n.js
import { readFileSync, writeFileSync } from 'fs';

const filePath = 'backend/public/shared/i18n.js';
let content = readFileSync(filePath, 'utf-8');

// First 50 keys for Spanish translation
const spanishKeys = {
    // Mission Control
    "mc_title": "EClawbot Centro de Misiones",
    "mc_auth_title": "Centro de Misiones",
    "mc_auth_subtitle": "Ingrese las credenciales del dispositivo para sincronizar el panel",
    "mc_input_device_id": "ID del Dispositivo",
    "mc_input_device_secret": "Secreto del Dispositivo",
    "mc_btn_connect": "Conectar",
    "mc_auth_error_missing": "Por favor ingrese el ID y Secreto del dispositivo",
    "mc_refresh": "Actualizar",
    "mc_notify_btn": "Enviar Notificación",
    "mc_syncing": "Sincronizando...",
    "mc_notify_dialog_title": "📢 Enviar Actualización de Tarea",
    "mc_notify_dialog_desc": "Seleccione los elementos a notificar — se enviarán a las entidades asignadas a través de Webhook:",
    "mc_notify_skip": "Omitir",
    "mc_notify_send": "Enviar",
    "mc_no_notify_items": "No hay cambios nuevos para notificar",
    "mc_todo_title": "Lista de Tareas",
    "mc_btn_add": "+ Agregar",
    "mc_mission_title": "Lista de Misiones",
    "mc_done_title": "Lista Completada",
    "mc_notes_title": "Notas",
    "mc_rules_title": "Reglas (Flujos de Trabajo)",
    "mc_sync_unsaved": "* Cambios sin guardar",
    "mc_sync_synced": "Sincronizado",
    "mc_task_saved": "Tarea guardada",
    "mc_empty_todo": "No hay tareas",
    "mc_empty_mission": "No hay misiones activas",
    "mc_empty_done": "No hay elementos completados",
    "mc_empty_notes": "No hay notas",
    "mc_empty_rules": "No hay reglas",
    "mc_status_pending": "Pendiente",
    "mc_status_inprogress": "En Progreso",
    "mc_status_blocked": "Bloqueado",
    "mc_status_done": "Completado",
    "mc_status_cancelled": "Cancelado",
    "mc_priority_low": "Baja",
    "mc_priority_medium": "Media",
    "mc_priority_high": "Alta",
    "mc_priority_urgent": "Urgente",
    "mc_confirm_delete": "¿Está seguro de que desea eliminar?",
    "mc_confirm_version": "Conflicto de versión (Usted: v{you}, Servidor: v{server}). ¿Descargar la última versión?",
    "mc_dlg_add_todo": "Agregar Tarea",
    "mc_dlg_edit": "Editar",
    "mc_dlg_title": "Título",
    "mc_dlg_desc": "Descripción",
    "mc_dlg_priority": "Prioridad",
    "mc_dlg_save": "Guardar",
    "mc_dlg_cancel": "Cancelar",
    "mc_dlg_due_at": "Tiempo de Ejecución",
    "mc_card_due_at": "Tiempo de Ejecución",
    "mc_card_countdown": "Cuenta Regresiva",
    "mc_countdown_overdue": "Vencido",
    "mc_countdown_min": "minutos",
    "mc_countdown_hr": "horas",
    "mc_countdown_day": "días",
    "mc_dlg_add_note": "Agregar Nota",
    "mc_dlg_edit_note": "Editar Nota",
    "mc_dlg_content": "Contenido",
    "mc_dlg_category": "Categoría",
    "mc_add_category": "+ Categoría",
    "mc_rename_category": "Renombrar",
    "mc_delete_category": "Eliminar categoría",
    "mc_clear_category": "Vaciar categoría",
    "mc_uncategorized": "-- Sin categoría --",
    "mc_confirm_clear_category": "¿Vaciar todos los elementos de esta categoría?",
    "mc_confirm_delete_category": "¿Eliminar esta categoría? Los elementos quedarán sin categoría.",
    "mc_prompt_category_name": "Nombre de categoría:",
    "mc_prompt_rename_category": "Nuevo nombre de categoría:",
    "mc_category_exists": "La categoría ya existe",
    "mc_empty_category": "Vacío",
    "mc_dlg_add_rule": "Agregar Regla",
    "mc_dlg_edit_rule": "Editar Regla",
    "mc_dlg_rule_name": "Nombre de Regla",
    "mc_dlg_rule_type": "Tipo",
    "mc_souls_title": "Alma",
    "mc_empty_souls": "Sin alma configurada",
    "mc_dlg_add_soul": "Agregar Alma",
    "mc_dlg_edit_soul": "Editar Alma",
    "mc_dlg_soul_name": "Nombre del Alma",
    "mc_dlg_soul_desc": "Descripción de Personalidad",
    "mc_dlg_soul_desc_hint": "Describa la personalidad, el tono de voz y el comportamiento de esta alma...",
    "mc_dlg_soul_template": "Plantilla de Alma",
    "mc_dlg_soul_custom": "-- Personalizado --",
    "mc_dlg_soul_template_btn": "🎭 Elegir de plantilla",
    "mc_dlg_soul_gallery_builtin": "Incorporadas",
    "mc_dlg_soul_gallery_community": "Comunidad",
    "mc_dlg_soul_multi": "Seleccionar varias",
    "mc_menu_move_mission": "Mover a Misión",
    "mc_menu_mark_done": "Marcar Completado",
    "mc_menu_delete": "Eliminar",
    "mc_search_placeholder": "Buscar…",
    "mc_browse_official_tpl": "Explorar Plantillas Oficiales",
    "mc_rule_template_title": "Plantilla de Regla",
    "mc_skill_change": "Cambiar",
    "mc_skill_name_label": "Nombre de Skill",
    "mc_skill_name_placeholder": "Ejemplo: Búsqueda de Google",
    "mc_skill_url_label": "URL Relacionada (opcional)",
    "mc_skill_steps_label": "Pasos de Instalación (opcional)",
    "mc_skill_steps_placeholder": "Pasos completos de instalación y configuración…",
    "mc_skill_assign_entity": "Asignar Entidades (seleccionar varias)",
    "mc_note_open_page": "Abrir Página",
    "mc_note_edit_page": "Editar Página",
    "mc_note_copy_link": "Copiar Enlace",
    "mc_note_link_copied": "¡Copiado!",
    "mc_note_no_public_code": "Sin código público",
    "mc_note_draw": "Dibujar",
    "mc_note_draw_save": "Guardar Dibujo",
    "mc_note_draw_clear": "Limpiar",
    "mc_note_draw_clear_confirm": "¿Limpiar todos los dibujos?",
    "mc_note_draw_eraser": "Borrador",
    "mc_note_draw_saved": "Dibujo guardado",
    "mc_note_page_close": "Cerrar",
    "mc_note_page_placeholder": "Ingrese contenido HTML...",
    "mc_note_page_link_hint": "Enlace interno: &lt;a href=\"eclaw://note/NOTE_ID\"&gt;...&lt;/a&gt;",
    "mc_note_page_saved": "Página guardada",
    "mc_note_page_empty": "Aún no hay contenido.",
    "dash_tos_load_error": "Error al cargar los términos de servicio.",
    "cardholder_proto_placeholder": "Ejemplo: A2A, REST, gRPC",
    "cardholder_cap_name": "Nombre",
    "cardholder_cap_desc": "Descripción",
    // Portal Shared
    "portal_login_title": "EClawbot - Iniciar Sesión",
    "portal_app_title": "EClawbot",
    "portal_app_subtitle": "Tu Compañero de Fondo de Pantalla Dinámico",
    "nav_dashboard": "Panel",
    "nav_chat": "Chat",
    "nav_files": "Archivos",
    "nav_mission": "Misión",
    "nav_settings": "Configuración",
    "nav_logout": "Cerrar Sesión",
    "nav_split_view": "Dividir Pantalla",
    "workspace_close_pane": "Cerrar Panel",
    "nav_compare": "Comparación",
    "nav_faq": "Preguntas Frecuentes",
    "nav_release_notes": "Notas de Lanzamiento",
    "nav_user_guide": "Guía del Usuario",
    "nav_login": "Iniciar Sesión",
    "nav_info": "Info",
    "nav_admin": "Admin",
    "nav_card_holder": "Portador de Tarjetas",
    "nav_community": "Comunidad",
    "nav_enterprise": "Empresa"
};

// Check if es: section exists
if (!content.includes('    es:')) {
    // Insert es section before the closing of TRANSLATIONS object
    // Find the last language section (probably 'id:')
    const lastLangMatch = content.match(/^    id: \{$/m);
    if (lastLangMatch) {
        // Find where the id block ends and insert es before it
        const idStart = content.indexOf('    id: {');
        const afterId = content.slice(idStart);
        const closingBrace = afterId.indexOf('\n    },');
        const idBlock = afterId.slice(0, closingBrace + 4);
        
        // Create es block
        const esBlock = '    es: {\n' + 
            Object.entries(spanishKeys)
                .map(([key, value]) => `        "${key}": "${value.replace(/"/g, '\\"')}"`)
                .join(',\n') + 
            '\n    },\n\n';
        
        // Insert es block before id block
        content = content.slice(0, idStart) + esBlock + content.slice(idStart);
        
        writeFileSync(filePath, content, 'utf-8');
        console.log('✅ Added Spanish translations for', Object.keys(spanishKeys).length, 'keys');
        console.log('📝 Language code: es (Spanish)');
    } else {
        console.error('❌ Could not find id: section to insert before');
        process.exit(1);
    }
} else {
    console.log('ℹ️  es: section already exists, skipping...');
}
