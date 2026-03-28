const fs = require('fs');
const content = fs.readFileSync('backend/public/shared/i18n.js', 'utf8');
const lines = content.split('\n');

// Find ES and MS block boundaries
let esStartIdx = -1, msStartIdx = -1;
for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === 'es: {') esStartIdx = i;
    if (t === 'ms: {') msStartIdx = i;
}

const esEndIdx = msStartIdx - 1;

// Batch 2 translations (keys 51-100) - using curly quotes to match EN style
const esTranslations = {
    "landing_demo_placeholder": "Ingresa la URL de tu sitio web o sube un archivo, luego comienza a chatear con el agente de IA.",
    "landing_demo_url_placeholder": "https://tu-empresa.com",
    "landing_demo_load": "Cargar",
    "landing_demo_upload": "Subir Archivo",
    "landing_demo_price": "Precio",
    "landing_demo_rating": "Calificación",
    "landing_demo_product_catalog": "Catálogo de Productos",
    "landing_demo_ai_generated": "Página de producto generada por IA · ",
    "landing_demo_open_new_tab": "Abrir en nueva pestaña",
    "landing_demo_setup_time": "Esta demo tomó 10 minutos en configurarse — usando el sistema de Entidades de EClaw + Páginas de Notas + Proxy Window",
    "landing_demo_10_messages": "10 mensajes/hora",
    "landing_demo_powered_by": "Potenciado por EClaw Entidad #2",
    "landing_demo_thinking": "Pensando...",
    "landing_demo_loading_website": "Cargando sitio web...",
    "landing_demo_website_loaded": "Sitio web cargado",
    "landing_demo_file_loaded": "Archivo cargado",
    "landing_demo_file_too_large": "Archivo muy grande (máx 500KB)",
    "landing_demo_invalid_url": "Por favor ingresa una URL válida",
    "landing_demo_failed_to_load": "Error al cargar",
    "landing_demo_connection_error": "Error de conexión. Por favor intenta de nuevo.",
    "landing_demo_ai_ecommerce_support": "Demo en Vivo: Soporte de IA para E-Commerce",
    "landing_demo_ai_desc": "Este es un bot de atención al cliente de IA en tiempo real \u201CXia Support\u201D. ¡Pregunta sobre productos, política de envío o obtén recomendaciones!",
    "landing_demo_ai_chat_title": "Demo de Servicio al Cliente con IA",
    "landing_demo_ai_chat": "Chatea con Soporte de IA",
    "landing_faq_title": "Preguntas Frecuentes",
    "landing_faq_subtitle": "Todo lo que necesitas saber sobre EClawbot",
    "landing_compare_title": "Comparar",
    "landing_compare_free": "Gratis",
    "landing_compare_paid": "Pro",
    "landing_compare_ent": "Empresa",
    "landing_compare_price_free": "$0",
    "landing_compare_price_paid": "$9.9",
    "landing_compare_price_ent": "Personalizado",
    "landing_compare_period": "/mes",
    "landing_compare_period_ent": "/año",
    "landing_compare_feature_entities": "Entidades",
    "landing_compare_feature_entities_free": "1",
    "landing_compare_feature_entities_paid": "5",
    "landing_compare_feature_entities_ent": "Ilimitado",
    "landing_compare_feature_messages": "Mensajes/mes",
    "landing_compare_feature_messages_free": "100",
    "landing_compare_feature_messages_paid": "10,000",
    "landing_compare_feature_messages_ent": "Ilimitado",
    "landing_compare_feature_channels": "Canales",
    "landing_compare_feature_channels_free": "2",
    "landing_compare_feature_channels_paid": "10",
    "landing_compare_feature_channels_ent": "Ilimitado",
    "landing_compare_feature_a2a": "Protocolo A2A",
    "landing_compare_feature_a2a_free": "❌",
    "landing_compare_feature_a2a_paid": "✅",
    "landing_compare_feature_a2a_ent": "✅",
    "landing_compare_feature_mission": "Centro de Misiones",
    "landing_compare_feature_mission_free": "❌",
    "landing_compare_feature_mission_paid": "✅",
    "landing_compare_feature_mission_ent": "✅",
    "landing_compare_feature_sso": "SSO / OAuth",
    "landing_compare_feature_sso_free": "❌",
    "landing_compare_feature_sso_paid": "❌",
    "landing_compare_feature_sso_ent": "✅",
    "landing_compare_feature_audit": "Registro de Auditoría",
    "landing_compare_feature_audit_free": "❌",
    "landing_compare_feature_audit_paid": "❌",
    "landing_compare_feature_audit_ent": "✅",
    "landing_compare_feature_support": "Soporte",
    "landing_compare_feature_support_free": "Comunidad",
    "landing_compare_feature_support_paid": "Email",
    "landing_compare_feature_support_ent": "Prioritario 24/7",
    "landing_get_started": "Comenzar",
    "landing_get_started_free": "Prueba Gratis",
    "landing_get_started_paid": "Suscribirse",
    "landing_get_started_ent": "Contactar Ventas",
    "landing_hero2_title": "Pon tu equipo de agentes de IA en marcha en minutos",
    "landing_hero2_subtitle": "No se requiere tarjeta de crédito",
    "landing_hero2_feature1_title": "Despliegue en segundos",
    "landing_hero2_feature1_desc": "Crea agentes de IA en segundos. Configura identidad, tono y comportamientos sin código.",
    "landing_hero2_feature2_title": "Integraciones potentes",
    "landing_hero2_feature2_desc": "Conecta con más de 100 herramientas — Slack, Discord, Notion, Google Calendar, y más.",
    "landing_hero2_feature3_title": "A2A nativo",
    "landing_hero2_feature3_desc": "Comunicación agente-a-agente integrada. Los agentes colaboran de forma autónoma.",
    "landing_footer_product": "Producto",
    "landing_footer_features": "Funciones",
    "landing_footer_pricing": "Precios",
    "landing_footer_docs": "Documentación",
    "landing_footer_legal": "Legal",
    "landing_footer_privacy": "Privacidad",
    "landing_footer_terms": "Términos",
    "landing_footer_company": "Empresa",
    "landing_footer_about": "Acerca de",
    "landing_footer_blog": "Blog",
    "landing_footer_careers": "Carreras",
    "landing_footer_contact": "Contacto",
    "landing_footer_resource": "Recursos",
    "landing_footer_help": "Centro de Ayuda",
    "landing_footer_community": "Comunidad",
    "landing_footer_status": "Estado del Sistema",
    "landing_footer_newsletter": "Boletín",
    "landing_footer_newsletter_desc": "Recibe noticias y actualizaciones",
    "landing_footer_email_placeholder": "Tu email",
    "landing_footer_subscribe": "Suscribirse",
    "landing_footer_rights": "Todos los derechos reservados.",
    "landing_footer_language": "Idioma",
};

// Sort alphabetically
const sortedEntries = Object.entries(esTranslations).sort((a, b) => a[0].localeCompare(b[0]));

const newLines = sortedEntries.map(([key, value]) => {
    // Escape backslashes only - don't escape curly quotes or regular quotes inside the value
    const escaped = value.replace(/\\/g, '\\\\');
    return `        "${key}": "${escaped}",`;
});

console.log(`Generated ${newLines.length} translation lines`);

// Build output
const outputLines = [
    ...lines.slice(0, esEndIdx),
    ...newLines,
    ...lines.slice(esEndIdx)
];

fs.writeFileSync('backend/public/shared/i18n.js', outputLines.join('\n'));
console.log('Done!');
