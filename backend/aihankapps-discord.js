/**
 * AiHankApps 作品集 Discord 社群機器人.
 *
 * Hank, 2026-11-25: 作品集內的所有 APP 用 Discord 經營模式跟用戶互動，三個階段一次到位；改用機器人（不再模擬點擊帳號）。
 *
 * One bot account in the "AiHank 作品集" server, talking to Discord's REST API only (no gateway, no message content intent):
 *   1. Setup, once per SETUP_VERSION: forum tags and guidelines on #問題回報, a topic on every app channel, the community
 *      rules in #rules (pinned), and a short intro in each announcement channel.
 *   2. Problem reports: every new post in the #問題回報 forum becomes a hub problem report (aihankapps_hub_feedback, source
 *      `discord`, notification ID `fb-discord-<thread id>`), so it shows on the hub and goes through the alert schedule like
 *      every other app's reports. Polled every POLL_MINUTES.
 *   3. Replies: when the alert schedule writes a note on that ID, the bot answers in the post with a fixed public sentence and
 *      sets the 處理中 / 已處理 tag (done also archives the post). The schedule's own words never leave the hub.
 *   4. Announcements: a new App Store version or a new store listing in app-catalog.json goes to #新版本; an approved holiday
 *      gift campaign goes to #活動禮包 when it is announced and again when sending starts. The first run only records what
 *      already exists, so nothing old is re-announced.
 *
 * Configuration: AIHANKAPPS_DISCORD_BOT_TOKEN (Railway variable, set by Hank; never logged or returned), optional
 * AIHANKAPPS_DISCORD_GUILD_ID. Without a token the module stays off. AIHANKAPPS_DISCORD=0 turns it off.
 * State lives in aihankapps_discord_state (one JSON row per key).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const API = 'https://discord.com/api/v10';
const DEFAULT_GUILD_ID = '1574788250583957615';
const SETUP_VERSION = 1;
const POLL_MINUTES = 2;
const ANNOUNCE_MINUTES = 10;
const DISCORD_EPOCH = 1420070400000n;
const PORTFOLIO = path.join(__dirname, 'public', 'AiHankApps');

const CHANNELS = {
    rules: 'rules', releases: '新版本', gifts: '活動禮包', recruit: '內測招募', reports: '問題回報',
};
// Forum tag → catalog communityId (the hub's app key). 其他作品 has no single app.
const APP_TAGS = [
    ['紙上彈兵', 'paper-flick-soldiers'], ['元素戰機350', 'rebound'], ['活字戰紀', 'typeforge-twin-cities'], ['Vibe帝國', 'vibe-empire'],
    ['螞蟻王國', 'anthill'], ['拾光相簿', 'timehut'], ['這樣出門', 'chumen'], ['浪浪地圖', 'stray-map'], ['睡公園', 'sleep-park'],
    ['Weesh', 'weesh'], ['夢話夥伴', 'dreambuddy'], ['其他作品', null],
];
const OTHER_APP = 'portfolio';
const STATUS_TAGS = { working: '處理中', done: '已處理' };
const CHANNEL_TOPICS = {
    紙上彈兵: '紙上彈兵：攻略、心得、截圖分享。遇到問題請到 #問題回報 開一串。',
    元素戰機350: 'REBOUND：元素戰機（元素戰機350）：攻略、配裝、禮包討論。遇到問題請到 #問題回報。',
    活字戰紀: '活字戰紀：雙城烽火、巔峰之戰：守城、天梯、組隊討論。遇到問題請到 #問題回報。',
    vibe帝國: 'Vibe帝國：30 秒同步回合的網頁策略遊戲（開發中）。',
    螞蟻王國: '螞蟻王國：築巢拓境（Anthill，開發中）：歡迎分享想法。',
    組隊天梯: '找隊友、約天梯、分享戰績。',
    拾光相簿: '拾光AI雲端相簿：使用技巧、功能許願。帳號或照片問題請到 #問題回報（不要貼帳號密碼）。',
    這樣出門: '這樣出門：公車、YouBike、天氣一頁掌握（台北市、新北市）。',
    浪浪地圖: '浪浪地圖：流浪動物目擊與協尋。',
    睡公園: '睡公園：免費生存地圖（公園、飲水機、公廁、WiFi）。',
    weesh: 'Weesh／Wishlist.ai：願望清單、二手面交。交易請注意安全。',
    夢話夥伴: '夢話夥伴：陪你入眠的 AI 夥伴。',
    其他作品: '世界末日了沒、房東投報快算、錢錢長大了、EClawbot、模擬器分配器等作品的討論。',
    自我介紹: '說說你是誰、在玩哪款作品。',
    作品許願池: '想要什麼新 APP、新功能？在這裡許願。',
};
const FORUM_GUIDE = '回報問題請開一篇貼文並選一個作品標籤：寫上 APP 版本、手機型號、發生經過，有截圖更好。不要貼帳號密碼或序號。開發者看過後會在貼文裡回覆，處理完會標成「已處理」。';
const RULES = [
    '📜 **AiHank 作品集 社群守則**',
    '1. 友善互動：不人身攻擊、不歧視、不騷擾。',
    '2. 不洗版、不廣告、不貼詐騙或投資拉人連結（系統會自動攔截）。',
    '3. 不公開自己或他人的個資、帳號密碼、序號。',
    '4. 遇到問題請到 #問題回報 開一篇貼文：選作品標籤，寫上版本、手機型號、發生經過，有截圖更好。',
    '5. 討論請到對應作品的頻道；劇透請用 ||隱藏文字||。',
    '6. 遵守 Discord 社群守則與服務條款；違規者管理員可禁言或停權。',
].join('\n');
const INTROS = {
    releases: '📢 這裡會自動公告每款 APP 的新版本與新上架（App Store、Google Play）。按頻道名稱旁的「追蹤」就能收到通知。',
    gifts: '🎁 節日禮包、限時活動會在這裡公告：開始寄送時間、領取方式和截止日。',
    recruit: '🧪 新作品與新版本的內測招募會在這裡公告。想當內測者可以在這裡留言，入選後會開放 🧪 內測專區。',
};
const REPLY = {
    working: '👀 已收到這則回報，開發者正在處理，有進度會在這裡更新。',
    done: '✅ 這則回報已處理完成，謝謝你的回報！如果問題還在，直接在這篇回覆就好。',
};

const SCHEMA = [`CREATE TABLE IF NOT EXISTS aihankapps_discord_state (
    key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`];

const snowflakeTime = id => Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clean = (value, max) => (typeof value === 'string' ? value.replace(CONTROL, ' ').trim().slice(0, max) : '');

function createClient({ token, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
    if (!token) throw new Error('DISCORD_TOKEN_MISSING');
    async function request(method, route, body) {
        for (let attempt = 0; attempt < 3; attempt++) {
            const response = await fetchImpl(API + route, {
                method,
                headers: Object.assign({ Authorization: 'Bot ' + token, 'User-Agent': 'AiHankAppsBot (https://eclawbot.com/AiHankApps/, 1)' },
                    body === undefined ? {} : { 'Content-Type': 'application/json' }),
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            if (response.status === 429) {
                const info = await response.json().catch(() => ({}));
                await sleep(Math.min(10000, Math.ceil((Number(info.retry_after) || 1) * 1000)));
                continue;
            }
            if (response.status === 204) return null;
            const data = await response.json().catch(() => null);
            if (!response.ok) {
                const error = new Error('DISCORD_' + response.status);
                error.status = response.status;
                error.discordCode = data && data.code;
                throw error;
            }
            return data;
        }
        throw new Error('DISCORD_RATE_LIMITED');
    }
    return { request };
}

async function prepare(pool) { for (const sql of SCHEMA) await pool.query(sql); }
async function loadState(pool) {
    const rows = (await pool.query('SELECT key, value FROM aihankapps_discord_state')).rows;
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
}
async function saveState(pool, key, value) {
    await pool.query(`INSERT INTO aihankapps_discord_state (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [key, JSON.stringify(value)]);
}

function findChannels(channels) {
    const byName = name => channels.find(c => c.name === name && [0, 5, 15].includes(c.type));
    return Object.fromEntries(Object.entries(CHANNELS).map(([key, name]) => [key, byName(name) || null]));
}

// Tags the forum must have (names ≤ 20 characters, at most 20 tags); existing tags and their ids are kept.
function forumTags(existing) {
    const tags = (existing || []).map(t => ({ id: t.id, name: t.name, moderated: t.moderated === true, emoji_id: t.emoji_id || null, emoji_name: t.emoji_name || null }));
    const names = new Set(tags.map(t => t.name));
    for (const [name] of APP_TAGS) if (!names.has(name)) tags.push({ name, moderated: false });
    for (const name of Object.values(STATUS_TAGS)) if (!names.has(name)) tags.push({ name, moderated: true });
    return tags.slice(0, 20);
}

async function runSetup(client, guildId, state) {
    if (state.setup && state.setup.version >= SETUP_VERSION) return { skipped: true };
    const channels = await client.request('GET', `/guilds/${guildId}/channels`);
    const found = findChannels(channels);
    const done = Object.assign({ version: 0 }, state.setup || {});
    if (found.reports) {
        await client.request('PATCH', `/channels/${found.reports.id}`, { available_tags: forumTags(found.reports.available_tags), topic: FORUM_GUIDE });
    }
    for (const channel of channels) {
        const topic = CHANNEL_TOPICS[channel.name];
        if (topic && channel.type === 0 && !channel.topic) await client.request('PATCH', `/channels/${channel.id}`, { topic });
    }
    if (found.rules && !done.rulesMessageId) {
        const message = await client.request('POST', `/channels/${found.rules.id}/messages`, { content: RULES, allowed_mentions: { parse: [] } });
        done.rulesMessageId = message.id;
        await client.request('PUT', `/channels/${found.rules.id}/pins/${message.id}`).catch(() => {});
    }
    done.intros = done.intros || {};
    for (const key of Object.keys(INTROS)) {
        if (found[key] && !done.intros[key]) {
            const message = await client.request('POST', `/channels/${found[key].id}/messages`, { content: INTROS[key], allowed_mentions: { parse: [] } });
            done.intros[key] = message.id;
        }
    }
    done.version = SETUP_VERSION;
    done.at = Date.now();
    return { skipped: false, state: done, channels: Object.fromEntries(Object.entries(found).map(([k, c]) => [k, c ? c.id : null])) };
}

// A forum post → one hub problem report. The first message of a forum post has the post's own id.
function reportFromThread(thread, starter, tagsById) {
    const tagNames = (thread.applied_tags || []).map(id => tagsById[id]).filter(Boolean);
    const appTag = APP_TAGS.find(([name]) => tagNames.includes(name));
    const app = appTag ? (appTag[1] || OTHER_APP) : OTHER_APP;
    const title = clean(thread.name, 100);
    const body = starter ? clean(starter.content, 3800) : '';
    const author = starter && starter.author ? clean(starter.author.global_name || starter.author.username, 60) : '';
    const hasImage = !!(starter && Array.isArray(starter.attachments) && starter.attachments.some(a => /^image\//.test(a.content_type || '') || /\.(png|jpe?g|gif|webp|heic)$/i.test(a.filename || '')));
    return { id: thread.id, app, message: [title, body].filter(Boolean).join('\n') || '（沒有文字）', reporter: author ? author + '（Discord）' : 'Discord',
        hasImage, createdAt: snowflakeTime(thread.id), category: 'discord', channel: 'discord' };
}

async function pollReports(client, pool, guildId, forumId, { now = Date.now(), inbox }) {
    const forum = await client.request('GET', `/channels/${forumId}`);
    const tagsById = Object.fromEntries((forum.available_tags || []).map(t => [t.id, t.name]));
    const active = await client.request('GET', `/guilds/${guildId}/threads/active`);
    const archived = await client.request('GET', `/channels/${forumId}/threads/archived/public?limit=50`).catch(() => ({ threads: [] }));
    const threads = [...(active.threads || []), ...(archived.threads || [])].filter(t => t.parent_id === forumId);
    const since = now - inbox.FEEDBACK_DAYS * 86400000;
    await inbox.prepare(pool);
    const known = new Set((await pool.query(`SELECT ext_id FROM aihankapps_hub_feedback WHERE source = 'discord'`)).rows.map(r => r.ext_id));
    let added = 0;
    for (const thread of threads) {
        if (known.has(thread.id) || snowflakeTime(thread.id) < since) continue;
        const starter = await client.request('GET', `/channels/${thread.id}/messages/${thread.id}`).catch(() => null);
        const report = reportFromThread(thread, starter, tagsById);
        const r = await pool.query(`INSERT INTO aihankapps_hub_feedback (source, ext_id, app_id, channel, category, message, version, reporter, has_image, created_at)
            VALUES ('discord', $1, $2, $3, $4, $5, NULL, $6, $7, $8) ON CONFLICT (source, ext_id) DO NOTHING`,
        [report.id, report.app, report.channel, report.category, report.message, report.reporter, report.hasImage, new Date(report.createdAt)]);
        added += r.rowCount || 0;
    }
    // Receipt: the hub warns when a feedback source has not been read for a long time.
    await pool.query(`INSERT INTO aihankapps_hub_sources (id, collected_at, detail) VALUES ('feedback-discord', $1, $2::jsonb)
        ON CONFLICT (id) DO UPDATE SET collected_at = EXCLUDED.collected_at, imported_at = NOW(), detail = EXCLUDED.detail`,
    [new Date(now), JSON.stringify({ values: threads.length, facts: 0, notes: [] })]);
    return { threads: threads.length, added, tagsById };
}

// The schedule's judgement → a fixed public reply and a status tag. Replied states are remembered per post.
async function syncReplies(client, pool, replied, tagsById) {
    const rows = (await pool.query(`SELECT ref, state FROM aihankapps_hub_notes WHERE ref LIKE 'fb-discord-%'`)).rows;
    const tagId = name => Object.keys(tagsById).find(id => tagsById[id] === name);
    const next = Object.assign({}, replied);
    let sent = 0;
    for (const row of rows) {
        const threadId = row.ref.slice('fb-discord-'.length);
        if (!/^\d{5,25}$/.test(threadId)) continue;
        const kind = row.state === 'done' ? 'done' : 'working';
        if (next[threadId] === kind) continue;
        try {
            const thread = await client.request('GET', `/channels/${threadId}`);
            if (thread.archived) await client.request('PATCH', `/channels/${threadId}`, { archived: false });
            await client.request('POST', `/channels/${threadId}/messages`, { content: REPLY[kind], allowed_mentions: { parse: [] } });
            const statusIds = Object.values(STATUS_TAGS).map(tagId).filter(Boolean);
            const keep = (thread.applied_tags || []).filter(id => !statusIds.includes(id));
            const add = tagId(STATUS_TAGS[kind]);
            await client.request('PATCH', `/channels/${threadId}`, Object.assign({ applied_tags: (add ? [...keep, add] : keep).slice(0, 5) }, kind === 'done' ? { archived: true } : {}));
            next[threadId] = kind;
            sent += 1;
        } catch (error) {
            if (error.status === 404) next[threadId] = kind;   // the post was deleted; nothing to answer
            else throw error;
        }
    }
    return { replied: next, sent };
}

function readCatalog(file = path.join(PORTFOLIO, 'app-catalog.json')) {
    return JSON.parse(fs.readFileSync(file, 'utf8')).apps || [];
}
function readCampaigns(file = path.join(PORTFOLIO, 'gift-campaigns.js')) {
    if (!fs.existsSync(file)) return [];
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { timeout: 1000 });
    return Array.isArray(sandbox.window.AIHANK_GIFT_CAMPAIGNS) ? sandbox.window.AIHANK_GIFT_CAMPAIGNS : [];
}

const releaseKey = app => ({ ios: app.publicApple ? app.iosVersion || 'listed' : null, google: app.publicGoogle ? 'listed' : null });

// What changed in the catalog since the last run → release messages. The first run returns no messages.
function releaseMessages(apps, previous) {
    const current = Object.fromEntries(apps.filter(a => a.communityId).map(a => [a.communityId, releaseKey(a)]));
    if (!previous) return { messages: [], current };
    const messages = [];
    for (const app of apps) {
        const id = app.communityId, now = current[id], before = previous[id] || { ios: null, google: null };
        if (!id) continue;
        if (now.ios && now.ios !== before.ios) {
            messages.push(before.ios ? `📱 **${app.name}** iOS 版更新到 ${app.iosVersion}\n${app.iosUrl || ''}`.trim()
                : `🎉 **${app.name}** 已在 App Store 上架！\n${app.iosUrl || ''}`.trim());
        }
        if (now.google && !before.google) messages.push(`🎉 **${app.name}** 已在 Google Play 上架！\n${app.googleUrl || ''}`.trim());
    }
    return { messages, current };
}

// Approved gift campaigns → one post when announced and one when sending starts. The first run records only.
function giftMessages(campaigns, previous, now = Date.now()) {
    const first = !previous;
    const seen = Object.assign({}, previous || {});
    const messages = [];
    for (const c of campaigns) {
        const copy = c && c.copy && c.copy['zh-TW'];
        if (!c || !c.id || !copy) continue;
        const entry = Object.assign({}, seen[c.id] || {});
        const announceAt = Date.parse(c.announceAt), startsAt = Date.parse(c.startsAt), deliveryEndsAt = Date.parse(c.deliveryEndsAt || c.claimEndsAt);
        if (!entry.announced && now >= announceAt) {
            entry.announced = true;
            if (!first && now < startsAt) messages.push(`🎁 **${copy.title}** 即將開始\n` + (copy.upcoming || []).map(l => '• ' + l).join('\n'));
        }
        if (!entry.started && now >= startsAt) {
            entry.started = true;
            if (!first && now < deliveryEndsAt) messages.push(`🎁 **${copy.title}** 開始寄送了！\n` + (copy.active || copy.upcoming || []).map(l => '• ' + l).join('\n'));
        }
        seen[c.id] = entry;
    }
    return { messages, seen };
}

async function post(client, channelId, content) {
    const chunks = [];
    for (let rest = content; rest.length; rest = rest.slice(1900)) chunks.push(rest.slice(0, 1900));
    for (const chunk of chunks) await client.request('POST', `/channels/${channelId}/messages`, { content: chunk, allowed_mentions: { parse: [] } });
}

function createBot({ token, guildId = DEFAULT_GUILD_ID, getPool, isReady = () => true, fetchImpl, inbox = require('./aihankapps-hub-inbox'),
    catalog = readCatalog, campaigns = readCampaigns, log = console } = {}) {
    const status = { enabled: !!token, guildId, lastCycle: null, lastError: null, lastAnnounce: null, setup: null, reports: null, replies: null };
    const client = token ? createClient({ token, fetchImpl }) : null;
    let busy = false;

    async function withState(work) {
        const pool = getPool();
        if (!pool || !isReady()) return null;
        await prepare(pool);
        return work(pool, await loadState(pool));
    }

    async function cycle(now = Date.now()) {
        if (!client || busy) return status;
        busy = true;
        try {
            await withState(async (pool, state) => {
                const setup = await runSetup(client, guildId, state);
                if (!setup.skipped) { await saveState(pool, 'setup', setup.state); state.setup = setup.state; }
                status.setup = { version: (state.setup || {}).version || 0, at: (state.setup || {}).at || null };
                const channels = (setup.channels && setup.channels.reports) ? setup.channels : Object.fromEntries(Object.entries(findChannels(await client.request('GET', `/guilds/${guildId}/channels`))).map(([k, c]) => [k, c ? c.id : null]));
                if (channels.reports) {
                    const reports = await pollReports(client, pool, guildId, channels.reports, { now, inbox });
                    status.reports = { threads: reports.threads, added: reports.added, at: now };
                    const replies = await syncReplies(client, pool, state.replied || {}, reports.tagsById);
                    if (replies.sent) await saveState(pool, 'replied', replies.replied);
                    status.replies = { sent: replies.sent, at: now };
                }
                await saveState(pool, 'channels', channels);
            });
            status.lastCycle = now;
            status.lastError = null;
        } catch (error) {
            status.lastError = { at: now, message: String(error.message || error).slice(0, 120) };
            log.warn('[aihankapps-discord] cycle failed:', status.lastError.message);
        } finally {
            busy = false;
        }
        return status;
    }

    async function announce(now = Date.now()) {
        if (!client) return status;
        try {
            await withState(async (pool, state) => {
                const channels = state.channels || {};
                const releases = releaseMessages(catalog(), state.releases);
                if (channels.releases) for (const m of releases.messages) await post(client, channels.releases, m);
                if (channels.releases || !state.releases) await saveState(pool, 'releases', releases.current);
                const gifts = giftMessages(campaigns(), state.gifts, now);
                if (channels.gifts) for (const m of gifts.messages) await post(client, channels.gifts, m);
                if (channels.gifts || !state.gifts) await saveState(pool, 'gifts', gifts.seen);
                status.lastAnnounce = { at: now, releases: releases.messages.length, gifts: gifts.messages.length };
            });
        } catch (error) {
            status.lastError = { at: now, message: String(error.message || error).slice(0, 120) };
            log.warn('[aihankapps-discord] announce failed:', status.lastError.message);
        }
        return status;
    }

    function start({ cron = require('node-cron') } = {}) {
        if (!client) { log.log('[aihankapps-discord] AIHANKAPPS_DISCORD_BOT_TOKEN not set; Discord bot is off'); return null; }
        const jobs = [cron.schedule(`*/${POLL_MINUTES} * * * *`, () => { cycle(); }), cron.schedule(`*/${ANNOUNCE_MINUTES} * * * *`, () => { announce(); })];
        setTimeout(() => { cycle().then(() => announce()); }, 15000);
        return { stop: () => jobs.forEach(j => j.stop()) };
    }

    // Admin-only status: no token, no message text, no user names.
    const snapshot = () => JSON.parse(JSON.stringify(status));
    return { cycle, announce, start, status: snapshot };
}

module.exports = { createBot, createClient, forumTags, reportFromThread, releaseMessages, giftMessages, runSetup, syncReplies, snowflakeTime,
    APP_TAGS, STATUS_TAGS, REPLY, RULES, SETUP_VERSION, DEFAULT_GUILD_ID };
