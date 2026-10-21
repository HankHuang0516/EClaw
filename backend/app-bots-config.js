// ============================================
// App-Bot Registry (情緒價值 App pipeline — card I2)
//
// Server-side ONLY. The mobile client sends just an { appId, personaId } pair;
// the persona system prompts (and the ANTHROPIC_API_KEY that consumes them)
// NEVER leave the server. Keep this file free of secrets — it is the prompt
// registry, not a credential store.
// ============================================

const APP_BOTS = {
    'vibe-empire': {
        name: 'Vibe帝國',
        dailyQuota: 100,
        adBonus: 0,
        maxMessageLength: 5000,
        // The game server uses an existing official bot binding. It chooses
        // that entity with device credentials; no free-bot onboarding occurs.
        boundOfficialEntityFromRequest: true,
        personas: {
            'strategy-agent': {
                systemPrompt: '你是 Vibe帝國的策略參謀。只根據這次請求提供的玩家可見戰況與軍令提出組合策略，不推測迷霧內的情報，不擴大玩家授權。請遵守訊息內的策略類型、數值和 JSON 格式限制。若條件不足，JSON 內容只保留 question 欄位。回覆必須以這次請求給你的 VIBE_PLAN 識別碼開頭，接著只輸出一行 JSON；不要加 Markdown 或其他文字。'
            }
        }
    },
    'dream-buddy': {
        name: '夢話夥伴',
        dailyQuota: 8,
        adBonus: 6,
        // Dream Buddy shipped before the shared app shell and already binds
        // its per-install free bot to slot 0. Preserve that binding so existing
        // installs gain persona injection without a destructive migration.
        entityId: 0,
        personas: {
            'dream-buddy': {
                systemPrompt: '你是「夢話夥伴」，一位異想天開、半夢半醒的陪伴者。你會接住使用者記得不完整的夢並延伸想像。使用繁體中文，以簡短、夢幻的片段回覆，每次回覆不超過 30 個中文字；每一輪只問一個超現實的延伸問題；永遠維持夢境框架，不要跳出角色。'
            }
        }
    },
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

// ============================================
// Inference routing (Dream Buddy local worker migration, 2026-10-21)
//
// Dream Buddy supports DREAM_BUDDY_AI_PROVIDER=local-minimax via its durable
// outbound-only Mac worker queue (dream-buddy-inference.js). In that mode an
// official bot binding is unnecessary and no message is relayed to that bot.
// Other apps retain the existing official-bot relay. Local-worker failure does
// not silently change providers. See docs/dream-buddy-local-minimax.md.
// ============================================

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
    getPersona,
};
