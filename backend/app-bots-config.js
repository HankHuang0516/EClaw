// ============================================
// App-Bot Registry (情緒價值 App pipeline — card I2)
//
// Server-side ONLY. The mobile client sends just an { appId, personaId } pair;
// the persona system prompts (and the ANTHROPIC_API_KEY that consumes them)
// NEVER leave the server. Keep this file free of secrets — it is the prompt
// registry, not a credential store.
// ============================================

const APP_BOTS = {
    'nighthollow': {
        name: '深夜樹洞',
        dailyQuota: 8,
        adBonus: 5,
        personas: {
            'default': {
                systemPrompt: '你是「深夜樹洞」。只溫柔傾聽與輕回應,絕不給建議、說教或正能量口號。回覆簡短。'
            }
        }
    },
    'hypebot': {
        name: '誇誇機',
        dailyQuota: 10,
        adBonus: 5,
        personas: {
            'default': {
                systemPrompt: '你是「誇誇機」。無論多小的事都真誠、熱情、有創意地誇獎使用者,具體不空泛,絕不給建議或轉折。'
            }
        }
    }
};

/**
 * Resolve an (appId, personaId) pair to its server-side config.
 * Returns { app, persona } or null when either the app or the persona is
 * unknown. The caller must NOT disclose which of the two was wrong (avoid
 * leaking the valid appId/persona namespace to probing clients).
 *
 * @param {string} appId
 * @param {string} personaId
 * @returns {{ app: object, persona: object } | null}
 */
function getPersona(appId, personaId) {
    const app = APP_BOTS[appId];
    if (!app) return null;
    const persona = app.personas && app.personas[personaId];
    if (!persona) return null;
    return { app, persona };
}

module.exports = {
    APP_BOTS,
    getPersona
};
