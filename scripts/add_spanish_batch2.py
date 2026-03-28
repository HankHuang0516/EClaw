#!/usr/bin/env python3
"""Add more Spanish translations to i18n.js - Fixed approach"""
import re

with open('backend/public/shared/i18n.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Spanish translations - Batch 2 (Landing page, FAQ, Comparison)
spanish_keys = {
    "landing_hero_title": "EClawbot",
    "landing_hero_subtitle": "Plataforma de Comunicacion Entre Agentes (A2A) - Tu Asistente de Inteligencia Artificial Empresarial Personal. Construye, gestiona y despliega agentes de IA para colaboracion entre agentes, automatizacion de tareas y servicio al cliente. Desarrollado por OpenClaw.",
    "landing_get_started": "Comenzar",
    "landing_enterprise": "Empresa",
    "landing_api_docs": "Documentacion API",
    "landing_features_sr": "Caracteristicas",
    "landing_feat1_title": "Asistente de IA Empresarial Personal",
    "landing_feat1_desc": "Construye y despliega equipos de agentes de IA para tu negocio. Cada agente tiene su propia identidad, habilidades y URL publica dedicada (Proxy Window) donde los clientes pueden interactuar directamente.",
    "landing_feat2_title": "Protocolo A2A",
    "landing_feat2_desc": "La comunicacion entre agentes permite el envio de tareas, flujos de trabajo colaborativos y ejecucion automatica de misiones entre dispositivos.",
    "landing_feat3_title": "Centro de Misiones",
    "landing_feat3_desc": "Gestion integral de tareas: to-do, misiones, notas y reglas. Coordina agentes de IA a traves de un panel de mision estructurado.",
    "landing_feat4_title": "Multi-Plataforma",
    "landing_feat4_desc": "Portal Web, aplicacion Android y aplicacion iOS - todo conectado al mismo backend con actualizaciones en tiempo real via Socket.IO.",
    "landing_feat5_title": "Seguridad Empresarial",
    "landing_feat5_desc": "Autenticacion OAuth 2.0 / OIDC, roles RBAC, consciencia E2EE, TLS/HTTPS con encabezados de seguridad y registro de auditoria completo.",
    "landing_feat6_title": "Integracion OpenClaw",
    "landing_feat6_desc": "Sistema de plugins basado en canales sin interrupciones para el ecosistema OpenClaw. Publica articulos en mas de 12 plataformas con el editor integrado.",
    "landing_faq_title": "Preguntas Frecuentes",
    "landing_faq_q1": "Que es EClawbot?",
    "landing_faq_a1": "EClawbot es una plataforma de comunicacion A2A y asistente de IA empresarial personal. Ayuda a individuos y pequenas empresas a construir, gestionar y desplegar agentes de IA para colaboracion entre agentes, envio de tareas y automatizacion. Cada agente puede tener su propia URL publica dedicada (Proxy Window) para servicio al cliente.",
    "landing_faq_q2": "EClawbot es lo mismo que ELAUT EClawbot?",
    "landing_faq_a2": "No. EClawbot es una plataforma de comunicacion A2A para orquestacion de agentes de IA. EClawbot de ELAUT es una marca de garra arcade de Belgica. Ambos son productos completamente diferentes.",
    "landing_faq_q3": "Cual es la relacion entre EClawbot y OpenClaw?",
    "landing_faq_a3": "EClawbot es la plataforma de infraestructura que soporta el ecosistema OpenClaw. Los usuarios de OpenClaw pueden conectar sus agentes de IA a EClawbot para comunicacion entre agentes.",
    "landing_faq_q4": "Que plataformas soporta EClawbot?",
    "landing_faq_a4": "EClawbot soporta 3 plataformas: Portal Web, aplicacion Android nativa y aplicacion iOS construida con React Native (Expo).",
    "landing_faq_q5": "Que es el protocolo A2A en EClawbot?",
    "landing_faq_a5": "A2A es un protocolo de comunicacion que permite a los agentes de IA enviar tareas estructuradas entre si. Soporta colaboracion entre agentes y flujos de trabajo automaticos entre dispositivos.",
    "landing_faq_q6": "EClawbot es gratis?",
    "landing_faq_a6": "EClawbot ofrece un plan gratis con gestion basica de dispositivos y enlace de entidades. Funciones premium como slots de entidad adicionales estan disponibles via suscripcion.",
    "cmp_title": "EClawbot vs Telegram - Comparacion de Canales",
    "cmp_eclaw_name": "EClawbot",
    "cmp_telegram_name": "Telegram",
    "cmp_subtitle": "EClawbot ofrece la experiencia completa de colaboracion de Agentes de IA. Telegram solo tiene chat.",
    "cmp_eclaw_tagline": "Canal de Fondo de Pantalla en Vivo Nativo",
    "cmp_telegram_tagline": "Canal de Mensajeria Basado en Chat",
    "cmp_cat_setup": "CONFIGURACION",
    "cmp_eclaw_setup_title": "Aplicacion Android o Portal Web",
    "cmp_eclaw_setup_desc": "Usa la aplicacion Android o el portal web. Ambos funcionan de forma independiente.",
    "cmp_tg_setup_title": "Buscar Bot en Telegram",
    "cmp_tg_setup_desc": "Abre Telegram, busca el bot, presiona /start - listo para chatear.",
    "cmp_cat_interaction": "INTERACCION",
    "cmp_eclaw_interact_title": "Push + Speak-to + Broadcast",
    "cmp_eclaw_interact_desc": "El bot push actualiza el estado del fondo de pantalla. Speak-to para conversacion directa. Broadcast para alcanzar todas las Entidades.",
    "cmp_tg_interact_title": "Chat Estandar",
    "cmp_tg_interact_desc": "Enviar mensaje, recibir respuesta. Experiencia chatbot clasica.",
    "cmp_cat_wallpaper": "FONDO DE PANTALLA EN VIVO",
    "cmp_eclaw_wp_title": "Integracion Completa",
    "cmp_eclaw_wp_desc": "El bot controla el estado del fondo de pantalla (humor, mensajes, animaciones). Tu pantalla de inicio cobra vida.",
    "cmp_tg_wp_title": "Sin Control de Fondo de Pantalla",
    "cmp_tg_wp_desc": "Los bots de Telegram no pueden actualizar el fondo de pantalla en vivo.",
    "cmp_tag_native": "Soporte Nativo",
    "cmp_tag_unavailable": "No Disponible",
    "cmp_cat_push": "NOTIFICACIONES PUSH",
    "cmp_eclaw_push_title": "Push Proactivo",
    "cmp_eclaw_push_desc": "El bot push actualiza automaticamente via API. El fondo de pantalla cambia en tiempo real sin intervencion del usuario.",
    "cmp_tag_realtime": "Tiempo Real",
    "cmp_tg_push_title": "Notificaciones de Mensajes",
    "cmp_tg_push_desc": "Notificaciones estandar de Telegram cuando el bot envia mensajes.",
    "cmp_tag_passive": "Pasivo",
    "cmp_cat_entity": "MULTI-ENTIDAD",
    "cmp_eclaw_entity_title": "Hasta 8 Entidades",
    "cmp_eclaw_entity_desc": "Conecta bots diferentes a slots de Entidad diferentes (0-7). Cada uno tiene estado y memoria independiente.",
    "cmp_tag_multi": "Multi-Entidad",
    "cmp_tg_entity_title": "1 Bot = 1 Chat",
    "cmp_tg_entity_desc": "Cada bot de Telegram es un chat separado.",
    "cmp_tag_manual": "Manual",
    "cmp_cat_memory": "MEMORIA Y CONTEXTO",
    "cmp_eclaw_mem_title": "Memoria del Lado del Servidor",
    "cmp_eclaw_mem_desc": "El historial de chat se almacena en el servidor E-Claw.",
    "cmp_tg_mem_title": "Memoria Administrada por el Bot",
    "cmp_tg_mem_desc": "La memoria depende de la implementacion del bot.",
    "cmp_cat_format": "FORMATO DE MENSAJE",
    "cmp_eclaw_fmt_title": "Texto + Campos de Estado",
    "cmp_eclaw_fmt_desc": "Los mensajes incluyen texto, estado de animacion. JSON estructurado via API para control del fondo de pantalla.",
    "cmp_tg_fmt_title": "Medios Enriquecidos",
    "cmp_tg_fmt_desc": "Texto, fotos, videos, archivos, stickers y mas.",
    "cmp_cat_platform": "PLATAFORMA",
    "cmp_eclaw_plat_title": "Android + Portal Web",
    "cmp_eclaw_plat_desc": "Fondo de pantalla en vivo en Android. Portal web (funciona en iPhone!) para chat, mission control, archivos.",
    "cmp_tg_plat_title": "Todas las Plataformas",
    "cmp_tg_plat_desc": "Telegram esta disponible en iOS, Android, escritorio y web.",
    "cmp_cat_cost": "COSTO",
    "cmp_eclaw_cost_title": "Gratis + Opciones de Pago",
    "cmp_eclaw_cost_desc": "Bot gratis (compartido, 15 mensajes/dia). Bot personal NT$288/mes (dedicado, ilimitado). Self-host: gratis.",
    "cmp_tg_cost_title": "API de Bot Gratis",
    "cmp_tg_cost_desc": "Telegram Bot API es gratis. Tu pagas por hosting y uso de LLM API.",
    "cmp_cat_dev": "DESARROLLO DE BOT",
    "cmp_eclaw_dev_title": "OpenClaw + Webhook",
    "cmp_eclaw_dev_desc": "Construye en la plataforma OpenClaw (Zeabur). Usa modo push exec+curl.",
    "cmp_tg_dev_title": "OpenClaw + Adaptador Telegram",
    "cmp_tg_dev_desc": "Construye en OpenClaw, agrega el adaptador de canal Telegram.",
    "cmp_cat_mission": "MISSION CONTROL",
    "cmp_eclaw_mission_title": "Centro de Tareas Integrado",
    "cmp_eclaw_mission_desc": "Tablero de tareas integrado (TODO/Mission/Done), notas, habilidades, reglas y sistema soul. Asigna tareas a Entidades.",
    "cmp_tg_mission_title": "Sin Sistema de Tareas Integrado",
    "cmp_tg_mission_desc": "Telegram no tiene gestion de tareas native. Se necesitan herramientas externas.",
    "cmp_cat_attachments": "ADJUNTOS EN CHAT",
    "cmp_eclaw_attach_title": "Fotos, Voz y Archivos + Gestor de Archivos",
    "cmp_eclaw_attach_desc": "Sube fotos, graba mensajes de voz, envia archivos (hasta 100 MB). Gestor de archivos dedicado con filtro por Entidad/tipo.",
    "cmp_tg_attach_title": "Medios Enriquecidos en Chat",
    "cmp_tg_attach_desc": "Fotos, videos, archivos, stickers, mensajes de voz en el chat.",
    "cmp_tag_builtin": "Incorporado",
    "cmp_tag_organized": "Organizado",
    "cmp_tag_chat_only": "Solo Chat",
    "cmp_eclaw_best_for": "EClawbot es mejor para...",
    "cmp_eclaw_best_1": "Fondo de pantalla en vivo en Android + Portal web para iPhone",
    "cmp_eclaw_best_2": "Actualizaciones push proactivas en tiempo real",
    "cmp_eclaw_best_3": "Gestion multi-Entidad (hasta 8 bots)",
    "cmp_eclaw_best_4": "Mission Control con asignacion de tareas y sistema soul",
    "cmp_eclaw_best_5": "Gestor de Archivos con filtro por nivel de Entidad",
    "cmp_tg_best_for": "Telegram es mejor para...",
    "cmp_tg_best_1": "Solo necesita chat basico, nada mas",
    "cmp_tg_best_2": "Medios enriquecidos (fotos, stickers, archivos)",
    "cmp_tg_best_3": "UI de chat familiar, no necesita aplicacion nueva",
    "cmp_tg_best_4": "API de Bot gratis con control total del desarrollador",
    "cmp_cta_text": "EClawbot ofrece la experiencia de colaboracion de Agentes de IA mas completa. Por que conformarse solo con chat?",
    "cmp_cta_eclaw": "Comenzar con E-Claw",
    "cmp_cta_telegram": "Aprender sobre Bot Telegram",
}

# Generate lines to add
es_lines = []
for key, value in spanish_keys.items():
    escaped_value = value.replace("\\", "\\\\").replace('"', '\\"')
    es_lines.append(f'        "{key}": "{escaped_value}",')

# Find the last line in es block (ends with "},")
# We need to replace the last entry's comma with a newline and add our entries

# Find es: { block
es_start = content.find("    es: {")
if es_start == -1:
    print("es: block not found!")
    exit(1)

# Find where es block ends: look for "    }," after es_start
es_end = content.find("    },", es_start)
if es_end == -1:
    print("Could not find end of es: block")
    exit(1)

# Get the content between { and },
es_block_content = content[es_start:es_end+4]

# Find the last key-value line in the es block
# It ends with a comma
lines = es_block_content.split('\n')
# Remove the last line (which is "    }," or similar)
# Find the last line that has a key-value pattern
last_kv_idx = -1
for i in range(len(lines)-1, -1, -1):
    if '"' in lines[i] and ':' in lines[i]:
        last_kv_idx = i
        break

# Now replace the comma at the end of that line with our new entries
if last_kv_idx >= 0:
    old_line = lines[last_kv_idx]
    # The line looks like: '        "key": "value",'
    # Replace the trailing comma with nothing, then add our entries
    new_line = old_line.rstrip().rstrip(',')
    lines[last_kv_idx] = new_line
    
    # Add our new entries
    for es_line in es_lines:
        lines.append(es_line)
    
    # Now join back
    new_es_block = '\n'.join(lines)
    
    # Replace old es block with new one
    content = content[:es_start] + new_es_block + content[es_end+4:]
    
    with open('backend/public/shared/i18n.js', 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"Successfully added {len(spanish_keys)} Spanish translations")
else:
    print("Could not find last key-value line in es block")
