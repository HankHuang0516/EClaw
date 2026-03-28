#!/usr/bin/env python3
"""Add more Spanish translations - simplest approach"""
with open('backend/public/shared/i18n.js', 'r', encoding='utf-8') as f:
    content = f.read()

spanish_keys = {
    "landing_hero_title": "EClawbot",
    "landing_hero_subtitle": "Plataforma de Comunicacion Entre Agentes (A2A) - Tu Asistente de IA Empresarial Personal.",
    "landing_get_started": "Comenzar",
    "landing_enterprise": "Empresa",
    "landing_api_docs": "Documentacion API",
    "landing_features_sr": "Caracteristicas",
    "landing_feat1_title": "Asistente de IA Empresarial Personal",
    "landing_feat1_desc": "Construye y despliega equipos de agentes de IA para tu negocio.",
    "landing_feat2_title": "Protocolo A2A",
    "landing_feat2_desc": "Comunicacion entre agentes para envio de tareas y flujos de trabajo.",
    "landing_feat3_title": "Centro de Misiones",
    "landing_feat3_desc": "Gestion integral de tareas: to-do, misiones, notas y reglas.",
    "landing_feat4_title": "Multi-Plataforma",
    "landing_feat4_desc": "Portal Web, aplicacion Android y iOS conectados al mismo backend.",
    "landing_feat5_title": "Seguridad Empresarial",
    "landing_feat5_desc": "OAuth 2.0, RBAC, E2EE, TLS/HTTPS y registro de auditoria.",
    "landing_feat6_title": "Integracion OpenClaw",
    "landing_feat6_desc": "Sistema de plugins para el ecosistema OpenClaw.",
    "landing_faq_title": "Preguntas Frecuentes",
    "cmp_title": "EClawbot vs Telegram - Comparacion de Canales",
    "cmp_eclaw_name": "EClawbot",
    "cmp_telegram_name": "Telegram",
    "cmp_subtitle": "EClawbot ofrece experiencia completa de colaboracion AI Agent.",
    "cmp_eclaw_tagline": "Canal Nativo de Fondo de Pantalla en Vivo",
    "cmp_telegram_tagline": "Canal de Mensajeria Basado en Chat",
    "cmp_cat_setup": "CONFIGURACION",
    "cmp_eclaw_setup_title": "Android o Portal Web",
    "cmp_eclaw_setup_desc": "Usa la app Android o portal web.",
    "cmp_tg_setup_title": "Buscar Bot en Telegram",
    "cmp_tg_setup_desc": "Abre Telegram, busca bot, presiona /start.",
    "cmp_cat_interaction": "INTERACCION",
    "cmp_eclaw_interact_title": "Push + Speak-to + Broadcast",
    "cmp_tg_interact_title": "Chat Estandar",
    "cmp_cat_wallpaper": "FONDO DE PANTALLA",
    "cmp_eclaw_wp_title": "Integracion Completa",
    "cmp_tg_wp_title": "Sin Control de Fondo",
    "cmp_tag_native": "Soporte Nativo",
    "cmp_tag_unavailable": "No Disponible",
    "cmp_cat_push": "NOTIFICACIONES PUSH",
    "cmp_eclaw_push_title": "Push Proactivo",
    "cmp_tag_realtime": "Tiempo Real",
    "cmp_tg_push_title": "Notificaciones de Mensajes",
    "cmp_tag_passive": "Pasivo",
    "cmp_cat_entity": "MULTI-ENTIDAD",
    "cmp_eclaw_entity_title": "Hasta 8 Entidades",
    "cmp_tag_multi": "Multi-Entidad",
    "cmp_tg_entity_title": "1 Bot = 1 Chat",
    "cmp_tag_manual": "Manual",
    "cmp_cat_memory": "MEMORIA",
    "cmp_eclaw_mem_title": "Memoria del Servidor",
    "cmp_tg_mem_title": "Memoria del Bot",
    "cmp_cat_format": "FORMATO",
    "cmp_eclaw_fmt_title": "Texto + Estado",
    "cmp_tg_fmt_title": "Medios Enriquecidos",
    "cmp_cat_platform": "PLATAFORMA",
    "cmp_eclaw_plat_title": "Android + Web",
    "cmp_tg_plat_title": "Todas las Plataformas",
    "cmp_cat_cost": "COSTO",
    "cmp_eclaw_cost_title": "Gratis + Premium",
    "cmp_tg_cost_title": "API de Bot Gratis",
    "cmp_cat_dev": "DESARROLLO",
    "cmp_eclaw_dev_title": "OpenClaw + Webhook",
    "cmp_tg_dev_title": "OpenClaw + Adaptador",
    "cmp_cat_mission": "MISSION CONTROL",
    "cmp_eclaw_mission_title": "Centro de Tareas Integrado",
    "cmp_tg_mission_title": "Sin Sistema de Tareas",
    "cmp_cat_attachments": "ADJUNTOS",
    "cmp_eclaw_attach_title": "Fotos, Voz, Archivos",
    "cmp_tg_attach_title": "Medios Enriquecidos",
    "cmp_tag_builtin": "Incorporado",
    "cmp_tag_organized": "Organizado",
    "cmp_tag_chat_only": "Solo Chat",
    "cmp_eclaw_best_for": "EClawbot es mejor para...",
    "cmp_eclaw_best_1": "Fondo en vivo en Android + Web para iPhone",
    "cmp_eclaw_best_2": "Actualizaciones push proactivas",
    "cmp_eclaw_best_3": "Multi-Entidad (hasta 8 bots)",
    "cmp_eclaw_best_4": "Mission Control y sistema soul",
    "cmp_tg_best_for": "Telegram es mejor para...",
    "cmp_tg_best_1": "Solo chat basico",
    "cmp_tg_best_2": "Medios enriquecidos",
    "cmp_tg_best_3": "UI familiar",
    "cmp_cta_text": "EClawbot ofrece la mejor experiencia AI Agent.",
    "cmp_cta_eclaw": "Comenzar con E-Claw",
    "cmp_cta_telegram": "Aprender sobre Telegram",
    "faq_section_general": "General",
    "faq_q_what_is": "Que es E-Claw?",
    "faq_a_what_is": "EClawbot es una plataforma de colaboracion AI Agent y comunicacion A2A para Android.",
    "faq_q_openclaw": "Que es OpenClaw?",
    "faq_a_openclaw": "OpenClaw es la plataforma de desarrollo de bots detras de E-Claw.",
    "faq_q_free": "Es E-Claw gratis?",
    "faq_a_free": "Si! E-Claw ofrece un plan gratuito con bots compartidos.",
    "faq_q_proxy_window": "Que es Proxy Window?",
    "faq_a_proxy_window": "Proxy Window da a cada agente de IA una URL publica dedicada.",
    "faq_section_setup": "Configuracion",
    "faq_q_bind": "Como conecto un bot?",
    "faq_a_bind": "Ve al Panel, selecciona slot de Entidad y haz clic en Crear Codigo.",
    "faq_q_slots": "Cuantos bots puedo conectar?",
    "faq_a_slots": "Hasta 8 slots de Entidad (0-7) por dispositivo.",
    "faq_q_web_vs_app": "Necesito la app Android?",
    "faq_a_web_vs_app": "Ambos funcionan independientemente.",
    "faq_section_features": "Caracteristicas",
    "faq_q_broadcast": "Que es Broadcast?",
    "faq_a_broadcast": "Broadcast envia un mensaje a todas las Entidades conectadas.",
    "faq_q_speakto": "Que es Speak-to?",
    "faq_a_speakto": "Speak-to es conversacion directa con una Entidad especifica.",
    "faq_q_mission": "Que es Mission Control?",
    "faq_a_mission": "Mission Control es el sistema de gestion de tareas integrado.",
    "faq_section_dev": "Desarrollo",
    "faq_q_create_bot": "Como creo mi propio bot?",
    "faq_a_create_bot": "Los bots se construyen en la plataforma OpenClaw.",
    "faq_q_telegram": "Puedo usar mi bot en Telegram?",
    "faq_a_telegram": "Si! Los bots de OpenClaw soportan multiples canales.",
    "faq_cta_text": "Aun tienes preguntas? Consulta la Guia de Usuario.",
}

# Find es: { block
# Pattern: "    es: {" at start of line
import re
es_pattern = r'\n    es: \{'
es_start = re.search(es_pattern, content)
if not es_start:
    print("es: block not found!")
    exit(1)

# Find the closing "    }," of the es block
# It comes after the last key-value pair
search_start = es_start.end()
# Find '\n    },' which closes the block
close_match = re.search(r'\n    \},', content[search_start:])
if not close_match:
    print("Could not find end of es block")
    exit(1)

es_end = search_start + close_match.start() + close_match.end() - len(close_match.group())
actual_end = search_start + close_match.end()

print(f"es block: {es_start.start()} to {actual_end}")

# Get existing content (between { and },)
existing = content[es_start.end():actual_end - len(close_match.group())]

# Count existing keys
existing_count = len(re.findall(r'"([a-z_]+)":', existing))
print(f"Existing Spanish keys: {existing_count}")

# Check if existing ends with a comma
existing_stripped = existing.rstrip('\n')
if existing_stripped and not existing_stripped.endswith(','):
    # Add comma to last entry
    lines = existing_stripped.split('\n')
    if lines:
        lines[-1] = lines[-1].rstrip(',') + ','
    existing_stripped = '\n'.join(lines)
    existing = existing_stripped + '\n'
elif existing_stripped:
    existing = existing_stripped + '\n'

# Build new entries
new_entries = []
for key in sorted(spanish_keys.keys()):
    value = spanish_keys[key]
    escaped = value.replace('\\', '\\\\').replace('"', '\\"')
    new_entries.append(f'        "{key}": "{escaped}",')

# Build new es block
new_es = '\n    es: {' + existing + '\n'.join(new_entries) + '\n    },'

# Replace
content = content[:es_start.start()] + new_es + content[actual_end:]

with open('backend/public/shared/i18n.js', 'w', encoding='utf-8') as f:
    f.write(content)

print(f"Added {len(spanish_keys)} new Spanish translations")
print(f"Total now: ~{existing_count + len(spanish_keys)} keys")
