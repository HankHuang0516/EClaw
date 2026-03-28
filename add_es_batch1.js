const fs = require('fs');
const content = fs.readFileSync('backend/public/shared/i18n.js', 'utf8');
const lines = content.split('\n');

// ES block: starts at line 21315 (0-indexed), which is "    es: {"
// MS block starts at line 21570 (0-indexed: ms: {)
// ES block ends at line 21569 (0-indexed), which is "    },"

// Find actual line numbers
let esStartIdx = -1;
let msStartIdx = -1;
for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === 'es: {') esStartIdx = i;
    if (lines[i].trim() === 'ms: {') msStartIdx = i;
}

console.log(`ES block starts at line ${esStartIdx + 1}`);
console.log(`MS block starts at line ${msStartIdx + 1}`);

// ES block end is one line before MS start
const esEndIdx = msStartIdx - 1;
console.log(`ES block ends at line ${esEndIdx + 1}: "${lines[esEndIdx].trim()}"`);

// First 50 missing translations
const esTranslations = {
    "mc_note_page_public": "Hacer página pública",
    "mc_note_page_public_hint": "Las páginas públicas pueden ser vistas sin iniciar sesión en /p/CÓDIGO/ID_NOTA",
    "landing_faq_q1": "¿Qué es EClawbot?",
    "landing_faq_a1": "EClawbot es una plataforma de comunicación A2A y asistente de IA empresarial personal. Ayuda a individuos y pequeñas empresas a construir, gestionar y desplegar agentes de IA para colaboración entre agentes, envío de tareas y automatización. Cada agente puede tener una URL pública dedicada (Proxy Window) para servicios orientados al cliente. Gestiona todo a través del Portal Web, aplicación Android o aplicación iOS.",
    "landing_faq_q2": "¿EClawbot es lo mismo que ELAUT EClawbot?",
    "landing_faq_a2": "No. EClawbot (eclawbot.com) es una plataforma de comunicación A2A para orquestación de agentes de IA y colaboración entre agentes. El EClawbot de ELAUT es una marca de máquina de garra de arcade física de Bélgica. Son productos completamente diferentes.",
    "landing_faq_q3": "¿Cuál es la relación entre EClawbot y OpenClaw?",
    "landing_faq_a3": "EClawbot es la plataforma de infraestructura que impulsa el ecosistema OpenClaw. Los usuarios de OpenClaw pueden conectar sus agentes de IA a EClawbot para comunicación entre agentes a través del protocolo A2A, envío de tareas y automatización colaborativa.",
    "landing_faq_q4": "¿Qué plataformas soporta EClawbot?",
    "landing_faq_a4": "EClawbot soporta tres plataformas: un Portal Web (eclawbot.com/portal), una aplicación nativa Android y una aplicación iOS construida con React Native (Expo). Todas las plataformas comparten la misma API de backend y conexiones Socket.IO en tiempo real.",
    "landing_faq_q5": "¿Qué es el protocolo A2A en EClawbot?",
    "landing_faq_a5": "A2A (Agente-a-Agente) es un protocolo de comunicación que permite a los agentes de IA en EClawbot enviar tareas estructuradas entre sí. Permite colaboración entre agentes, envío de tareas y flujos de trabajo automatizados entre dispositivos.",
    "landing_faq_q6": "¿EClawbot es gratis?",
    "landing_faq_a6": "EClawbot ofrece un nivel gratuito que incluye gestión básica de dispositivos y vinculación de entidades. Las funciones premium como ranuras de entidad adicionales y capacidades A2A avanzadas están disponibles a través de planes de suscripción.",
    "ent_page_title": "EClawbot para Empresas - Plataforma de Agentes de IA para Negocios",
    "ent_badge": "Empresas",
    "ent_hero_title": "Equipos de Agentes de IA para tu Negocio",
    "ent_hero_subtitle": "Despliega, gestiona y orquesta equipos de agentes de IA con seguridad de nivel empresarial, control de acceso y monitoreo en tiempo real. Tu asistente de IA empresarial personal.",
    "ent_get_started": "Comenzar Gratis",
    "ent_api_docs": "Documentación de API",
    "ent_usecases_title": "Casos de Uso Empresarial",
    "ent_usecases_subtitle": "Desde atención al cliente hasta automatización interna, EClawbot se adapta a las necesidades de tu negocio.",
    "ent_uc_cs_title": "IA de Atención al Cliente",
    "ent_uc_cs_desc": "Despliega agentes orientados al cliente con URLs públicas de Proxy Window. Cada agente tiene su propia identidad, tono y límites — listo para servir a clientes 24/7.",
    "ent_uc_auto_title": "Automatización de Flujos de Trabajo",
    "ent_uc_auto_desc": "Automatiza flujos de trabajo internos con Mission Control. Programa tareas, define reglas y deja que los agentes colaboren a través del protocolo A2A para completar operaciones complejas.",
    "ent_uc_pub_title": "Publicación Multi-Canal",
    "ent_uc_pub_desc": "Publica contenido en más de 12 plataformas simultáneamente — Blogger, X, DEV.to, WordPress, LinkedIn, Reddit, Mastodon y más con una única llamada API.",
    "ent_uc_collab_title": "Colaboración Entre Equipos",
    "ent_uc_collab_desc": "Permite comunicación de agentes entre dispositivos. Agentes de diferentes equipos pueden intercambiar tareas, compartir contexto y coordinar acciones automáticamente.",
    "ent_features_title": "Seguridad de Nivel Empresarial",
    "ent_features_subtitle": "Construido para organizaciones que exigen seguridad, cumplimiento y control.",
    "ent_feat_rbac_title": "Control de Acceso RBAC",
    "ent_feat_rbac_desc": "Acceso basado en roles con 4 roles predeterminados (Admin, Desarrollador, Operador, Visor). Middleware de permisos detallados para cada endpoint de API.",
    "ent_feat_sso_title": "SSO / OAuth 2.0 / OIDC",
    "ent_feat_sso_desc": "Conecta tu proveedor de identidad a través de OIDC genérico. Google, Facebook OAuth integrado. Servidor OAuth 2.0 completo para credenciales de cliente y gestión de tokens.",
    "ent_feat_audit_title": "Registro de Auditoría",
    "ent_feat_audit_desc": "Cada acción registrada — eventos de autenticación, llamadas API, cambios de entidad. Consulta registros por categoría, rango de tiempo, usuario. Endpoint de auditoría solo para administradores para cumplimiento.",
    "ent_feat_e2ee_title": "Conciencia E2EE",
    "ent_feat_e2ee_desc": "Banderas de capacidad de cifrado de extremo a extremo por canal y entidad. Almacenamiento de variables de entorno cifradas con AES-256-GCM.",
    "ent_feat_mission_title": "Centro de Misiones",
    "ent_feat_mission_desc": "Panel centralizado con tareas, misiones, notas, reglas y coordinación de agentes. Sincronización en tiempo real entre Web, Android e iOS.",
    "ent_feat_a2a_title": "Protocolo A2A",
    "ent_feat_a2a_desc": "Envío de tareas estructuradas Agente-a-Agente. Los agentes colaboran, delegan e informan entre dispositivos con cargas tipadas y seguimiento de entrega.",
    "ent_how_title": "Cómo Funciona",
    "ent_how_subtitle": "Pon tu equipo de agentes de IA en marcha en minutos.",
    "ent_step1_title": "Desplegar Agentes",
    "ent_step1_desc": "Crea identidades de agentes con roles, habilidades y personalidades. Asigna URLs públicas de Proxy Window para servicios orientados al cliente.",
    "ent_step2_title": "Conectar vía A2A",
    "ent_step2_desc": "Vincula agentes entre equipos y dispositivos. Usa el protocolo A2A para envío de tareas estructuradas y colaboración en tiempo real.",
};

// Sort keys alphabetically for consistency
const sortedEntries = Object.entries(esTranslations).sort((a, b) => a[0].localeCompare(b[0]));

// Create new translation lines
const newLines = sortedEntries.map(([key, value]) => {
    // Escape backslashes and quotes in the value
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `        "${key}": "${escaped}",`;
});

console.log(`Generated ${newLines.length} new translation lines`);

// Build output: lines before ES end, new lines, lines from ES end onwards
const outputLines = [
    ...lines.slice(0, esEndIdx),
    ...newLines,
    ...lines.slice(esEndIdx)
];

fs.writeFileSync('backend/public/shared/i18n.js', outputLines.join('\n'));
console.log('Done!');

// Verify structure
const newContent = fs.readFileSync('backend/public/shared/i18n.js', 'utf8');
const newEsStart = newContent.indexOf('\n    es: {');
const newMsStart = newContent.indexOf('\n    ms: {');
console.log(`New ES block: lines ${newEsStart + 1} to ${newMsStart}`);
