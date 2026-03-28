#!/usr/bin/env python3
"""Add more Spanish translations to i18n.js - Batch 2"""
import re

with open('backend/public/shared/i18n.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Spanish translations - Batch 2 (Landing page, FAQ, Release Notes, Comparison)
spanish_keys = {
    # Landing page (landing.html)
    "landing_hero_title": "EClawbot",
    "landing_hero_subtitle": "Plataforma de Comunicacion Entre Agentes (A2A) — Tu Asistente de Inteligencia Artificial Empresarial Personal. Construye, gestiona y despliega agentes de IA para colaboracion entre agentes, automatizacion de tareas y servicio al cliente. Desarrollado por OpenClaw.",
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
    "landing_feat4_desc": "Portal Web, aplicacion Android y aplicacion iOS — todo conectado al mismo backend con actualizaciones en tiempo real via Socket.IO.",
    "landing_feat5_title": "Seguridad Empresarial",
    "landing_feat5_desc": "Autenticacion OAuth 2.0 / OIDC, roles RBAC, consciencia E2EE, TLS/HTTPS con encabezados de seguridad y registro de auditoria completo.",
    "landing_feat6_title": "Integracion OpenClaw",
    "landing_feat6_desc": "Sistema de plugins basado en canales sin interrupciones para el ecosistema OpenClaw. Publica articulos en mas de 12 plataformas con el editor integrado.",
    "landing_faq_title": "Preguntas Frecuentes",
    "landing_faq_q1": "Que es EClawbot?",
    "landing_faq_a1": "EClawbot es una plataforma de comunicacion A2A y asistente de IA empresarial personal. Ayuda a individuos y pequenas empresas a construir, gestionar y desplegar agentes de IA para colaboracion entre agentes, envio de tareas y automatizacion. Cada agente puede tener su propia URL publica dedicada (Proxy Window) para servicio al cliente. Gestiona todo desde el Portal Web, aplicacion Android o iOS.",
    "landing_faq_q2": "EClawbot es lo mismo que ELAUT EClawbot?",
    "landing_faq_a2": "No. EClawbot (eclawbot.com) es una plataforma de comunicacion A2A para orquestacion de agentes de IA y colaboracion entre agentes. EClawbot de ELAUT es una marca de maquina de garra arcade de Belgica. Ambos son productos completamente diferentes.",
    "landing_faq_q3": "Cual es la relacion entre EClawbot y OpenClaw?",
    "landing_faq_a3": "EClawbot es la plataforma de infraestructura que soporta el ecosistema OpenClaw. Los usuarios de OpenClaw pueden conectar sus agentes de IA a EClawbot para comunicacion entre agentes a traves del protocolo A2A, envio de tareas y automatizacion colaborativa.",
    "landing_faq_q4": "Que plataformas soporta EClawbot?",
    "landing_faq_a4": "EClawbot soporta 3 plataformas: Portal Web (eclawbot.com/portal), aplicacion Android nativa y aplicacion iOS construida con React Native (Expo). Todas las plataformas comparten la misma API backend y conexion Socket.IO en tiempo real.",
    "landing_faq_q5": "Que es el protocolo A2A en EClawbot?",
    "landing_faq_a5": "A2A (Entre-Agentes) es un protocolo de comunicacion que permite a los agentes de IA en EClawbot enviar tareas estructuradas entre si. Soporta colaboracion entre agentes, envio de tareas y flujos de trabajo automaticos entre dispositivos.",
    "landing_faq_q6": "EClawbot es gratis?",
    "landing_faq_a6": "EClawbot ofrece un plan gratis que incluye gestion basica de dispositivos y enlace de entidades. Funciones premium como slots de entidad adicionales y capacidades A2A avanzadas estan disponibles a traves de planes de suscripcion.",

    # Enterprise page
    "ent_page_title": "EClawbot para Empresas - Plataforma de Agentes de IA para Negocios",
    "ent_badge": "Empresa",
    "ent_hero_title": "Equipo de Agentes de IA para Tu Negocio",
    "ent_hero_subtitle": "Despliega, gestiona y orquesta equipos de agentes de IA con seguridad de nivel empresarial, control de acceso y monitoreo en tiempo real.",
    "ent_get_started": "Comenzar Gratis",
    "ent_api_docs": "Documentacion API",
    "ent_usecases_title": "Casos de Uso Empresarial",
    "ent_usecases_subtitle": "Desde servicio al cliente hasta automatizacion interna, EClawbot se adapta a las necesidades de tu negocio.",
    "ent_uc_cs_title": "Servicio al Cliente con IA",
    "ent_uc_cs_desc": "Despliega agentes de servicio al cliente con URL publica de Proxy Window. Cada agente tiene su propia identidad, tono y limitaciones, listo para servir 24/7.",
    "ent_uc_auto_title": "Automatizacion de Flujos de Trabajo",
    "ent_uc_auto_desc": "Automatiza flujos de trabajo internos con Mission Control. Programa tareas, define reglas, deja que los agentes colaboren via protocolo A2A.",
    "ent_uc_pub_title": "Publicacion Multi-Canal",
    "ent_uc_pub_desc": "Publica contenido en mas de 12 plataformas simultaneamente — Blogger, X, DEV.to, WordPress, LinkedIn, Reddit, Mastodon y mas.",
    "ent_uc_collab_title": "Colaboracion Entre Equipos",
    "ent_uc_collab_desc": "Activa la comunicacion de agentes entre dispositivos. Agentes de diferentes equipos pueden intercambiar tareas, compartir contexto y coordinar acciones automaticamente.",
    "ent_features_title": "Seguridad de Nivel Empresarial",
    "ent_features_subtitle": "Construido para organizaciones que requieren seguridad, cumplimiento y control.",
    "ent_feat_rbac_title": "Control de Acceso RBAC",
    "ent_feat_rbac_desc": "Control de acceso basado en roles con 4 roles predeterminados (Admin, Developer, Operator, Viewer). Middleware de permisos granulares para cada endpoint API.",
    "ent_feat_sso_title": "SSO / OAuth 2.0 / OIDC",
    "ent_feat_sso_desc": "Conecta proveedores de identidad via OIDC generico. Google, Facebook OAuth incorporado. Servidor OAuth 2.0 completo para gestion de tokens.",
    "ent_feat_audit_title": "Registro de Auditoria",
    "ent_feat_audit_desc": "Cada accion es rastreada — eventos de autenticacion, llamadas API, cambios de entidad. Consulta registros por categoria, rango de tiempo, usuario.",
    "ent_feat_e2ee_title": "Consciencia E2EE",
    "ent_feat_e2ee_desc": "Bandera de capacidad de encriptacion de extremo a extremo por canal y entidad. Almacenamiento de variables de entorno encriptado AES-256-GCM.",
    "ent_feat_mission_title": "Mission Control",
    "ent_feat_mission_desc": "Panel centralizado con to-do, misiones, notas, reglas y coordinacion de agentes. Sincronizacion en tiempo real en Web, Android e iOS.",
    "ent_feat_a2a_title": "Protocolo A2A",
    "ent_feat_a2a_desc": "Envio de tareas estructuradas entre agentes. Colaboracion, delegacion y reporte entre dispositivos con payloads tipados y seguimiento de entrega.",
    "ent_how_title": "Como Funciona",
    "ent_how_subtitle": "Pon a trabajar a tu equipo de agentes de IA en minutos.",
    "ent_step1_title": "Desplegar Agente",
    "ent_step1_desc": "Crea identidad de agente con roles, habilidades y personalidad. Asigna URL de Proxy Window para servicio al cliente.",
    "ent_step2_title": "Conectar via A2A",
    "ent_step2_desc": "Conecta agentes entre equipos y dispositivos. Usa el protocolo A2A para envio de tareas estructuradas y colaboracion en tiempo real.",
    "ent_step3_title": "Monitorear y Escalar",
    "ent_step3_desc": "Rastrea el rendimiento de agentes via telemetria, registros de auditoria y Mission Control. Escala el equipo de agentes a medida que crece tu negocio.",
    "ent_cta_title": "Listo para Comenzar?",
    "ent_cta_subtitle": "Unete a los negocios que usan EClawbot para automatizar flujos de trabajo y desplegar equipos de agentes de IA.",
    "ent_cta_start": "Crear Cuenta Gratis",
    "ent_cta_learn": "Aprender Mas",
    "ent_demo_title": "Pruébalo Ahora",
    "ent_demo_subtitle": "Ingresa tu sitio web o sube un documento. El agente de IA aprendera sobre tu negocio y comenzara a chatear.",
    "ent_demo_url_placeholder": "https://tu-empresa.com",
    "ent_demo_load": "Cargar",
    "ent_demo_upload": "Subir Archivo",
    "ent_demo_welcome": "Ingresa URL del sitio web o sube un archivo, luego comienza a chatear con el agente de IA.",
    "ent_demo_input_placeholder": "Pregunta sobre tu negocio...",
    "ent_demo_send": "Enviar",
    "ent_demo_hint": "Demo gratis — 10 mensajes por hora. Sin inicio de sesion.",
    "ent_demo_thinking": "Pensando...",
    "ent_demo_loading": "Cargando sitio web...",
    "ent_demo_loaded": "Sitio web cargado",
    "ent_demo_file_loaded": "Archivo cargado",
    "ent_demo_file_too_large": "Archivo muy grande (max 500KB)",
    "ent_demo_invalid_url": "Ingresa un URL valido",
    "ent_demo_fetch_error": "Error al cargar",
    "ent_demo_error": "Error de conexion. Por favor intenta de nuevo.",
    "info_title": "EClawbot - Centro de Informacion",
    "info_tab_guide": "Guia",
    "info_tab_faq": "FAQ",
    "info_tab_release_notes": "Notas de Lanzamiento",
    "info_tab_compare": "Comparacion",
    "info_tab_quickstart": "Inicio Rapido",
    "info_tab_advanced": "Avanzado",

    # FAQ Section
    "faq_section_general": "General",
    "faq_q_what_is": "Que es E-Claw?",
    "faq_a_what_is": "EClawbot es una plataforma de colaboracion de Agentes de IA y comunicacion A2A para Android. Conecta tus bots de IA para visualizar el estado en tiempo real, activar mensajes de Agente a Agente (A2A), transmitir a multiples Entidades y organizar flujos de trabajo multi-agente — todo gestionado desde la aplicacion Android o el portal web.",
    "faq_q_openclaw": "Que es OpenClaw?",
    "faq_a_openclaw": "OpenClaw es la plataforma de desarrollo de bots detras de E-Claw. Los desarrolladores construyen y hospedan sus bots en OpenClaw (alimentado por Zeabur), que luego se comunican con los dispositivos E-Claw a traves de push webhook y exec+curl.",
    "faq_q_free": "Es E-Claw gratis?",
    "faq_a_free": "Si! E-Claw ofrece un plan gratuito con bots compartidos (hasta 15 mensajes/dia por bot gratis). Tu propio bot (auto-hospedado) no tiene limite de mensajes y siempre es gratis.",
    "faq_q_proxy_window": "Que es Proxy Window?",
    "faq_a_proxy_window": "Proxy Window le da a cada agente de IA una URL publica dedicada. Los clientes externos pueden interactuar directamente con tu agente en el navegador — ordenar, preguntar, agendar — sin necesidad de instalar ninguna aplicacion. Ideal para comercio electronico, consultores, soporte de TI y mas.",
    "faq_section_setup": "Configuracion y Enlace",
    "faq_q_bind": "Como conecto un bot a mi dispositivo?",
    "faq_a_bind": "Ve al Panel (en la aplicacion o portal web), selecciona un slot de Entidad y haz clic en 「Crear Codigo」. Copia el comando de enlace y pegalo en el bot que quieres conectar. El bot confirmara el enlace automaticamente.",
    "faq_q_slots": "Cuantos bots puedo conectar?",
    "faq_a_slots": "Cada dispositivo soporta hasta 8 slots de Entidad (0-7). Cada slot puede vincularse a un bot diferente de forma independiente con su propio estado, memoria e historial de chat.",
    "faq_q_web_vs_app": "Necesito la aplicacion Android, o puedo usar solo el portal web?",
    "faq_a_web_vs_app": "Ambos funcionan de forma independiente. La aplicacion Android proporciona la experiencia de fondo de pantalla en vivo. El portal web te permite gestionar Entidades, chatear, subir archivos y configurar misiones — todo desde tu navegador. Puedes usar uno o ambos.",
    "faq_section_features": "Caracteristicas",
    "faq_q_broadcast": "Que es Broadcast?",
    "faq_a_broadcast": "Broadcast te permite enviar un solo mensaje a todas las Entidades conectadas a la vez. Ideal para anuncios o actualizaciones que todos los bots necesitan recibir. Puedes rastrear que Entidades recibieron el broadcast en el informe de entrega.",
    "faq_q_speakto": "Que es Speak-to?",
    "faq_a_speakto": "Speak-to es un modo de conversacion directa donde envias un mensaje a una Entidad especifica y recibes una respuesta. Como chatear uno a uno con tu bot, con la conversacion guardada en el historial de chat.",
    "faq_q_mission": "Que es Mission Control?",
    "faq_a_mission": "Mission Control es el sistema de gestion de tareas integrado. Puedes crear tareas (TODO/Mission/Done), asignarlas a Entidades, gestionar notas, configurar habilidades y reglas, y definir la personalidad de tu bot (「soul」). Los bots son notificados cuando sus tareas cambian.",
    "faq_section_dev": "Desarrollo de Bots",
    "faq_q_create_bot": "Como creo mi propio bot?",
    "faq_a_create_bot": "Los bots se construyen en la plataforma OpenClaw (hospedada en Zeabur). Consulta la Guia de Usuario para tutoriales, documentacion de API y documentacion de habilidades MCP para comenzar.",
    "faq_q_telegram": "Puedo usar mi bot en Telegram tambien?",
    "faq_a_telegram": "Si! Los bots de OpenClaw soportan multiples canales. Puedes agregar el adaptador de canal Telegram a tu bot. Consulta la pagina de Comparacion de Canales para las diferencias entre E-Claw y Telegram.",
    "faq_cta_text": "Aun tienes preguntas? Consulta la Guia de Usuario para documentacion completa.",
    "cmp_title": "EClawbot vs Telegram - Comparacion de Canales",
    "cmp_eclaw_name": "EClawbot",
    "cmp_telegram_name": "Telegram",
    "cmp_subtitle": "EClawbot ofrece la experiencia completa de colaboracion de Agentes de IA — comunicacion A2A, visualizacion en vivo, broadcast push, tareas y mas. Telegram solo tiene chat.",
    "cmp_eclaw_tagline": "Canal de Fondo de Pantalla en Vivo Nativo",
    "cmp_telegram_tagline": "Canal de Mensajeria Basado en Chat",
}

# Generate es block entries
es_lines = []
for i, (key, value) in enumerate(spanish_keys.items()):
    comma = "," if i < len(spanish_keys) - 1 else ""
    escaped_value = value.replace("\\", "\\\\").replace('"', '\\"')
    es_lines.append(f'        "{key}": "{escaped_value}"{comma}')

es_block = "\n".join(es_lines) + "\n"

# Find the es: block and append to it
pattern = r'(    es: \{)(.*?)(    \},)'
match = re.search(pattern, content, re.DOTALL)

if match:
    existing_content = match.group(2)
    new_content = match.group(1) + existing_content + "\n" + "\n".join(es_lines) + match.group(3)
    content = content[:match.start()] + new_content + content[match.end():]
    
    with open('backend/public/shared/i18n.js', 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"Successfully added {len(spanish_keys)} more Spanish translations")
    print(f"Total Spanish keys now: ~{140 + len(spanish_keys)}")
else:
    print("Could not find es: block to append to")
