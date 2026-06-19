'use strict';

/**
 * push-context.js — centralised context inlining for channel callback pushes.
 *
 * The EClaw backend is the single source of truth for what context the
 * receiving bot sees. Channel plugins observe `contextInlined: true` on the
 * wire payload and forward `text` as-is. See `enrichContext`,
 * `materializeChannelText`, and `buildMentionsBlock` below.
 */

const SILENT_TOKEN = '[SILENT]';
const DEFAULT_B2B_MAX = 8;

// Render a [MENTIONS] hint block. Empty input → '' (the trailer is then skipped).
// Wording is deliberately imperative because LLMs tend to fall back to their
// existing conversation partner and ignore soft routing hints — the explicit
// "MUST call speakTo" / "do NOT fall back" language measurably improves the
// odds the receiving bot obeys the user's @-tag intent.
function buildMentionsBlock(mentionsContext) {
    if (!mentionsContext) return '';
    const mentions = Array.isArray(mentionsContext.mentions) ? mentionsContext.mentions : [];
    const hasAll = !!mentionsContext.hasAll;
    if (mentions.length === 0 && !hasAll) return '';

    // Same-device mentions include entityId so bots can use either
    // <@xxxxxx>, <@N>, @#N, or @N — all four formats are recognised
    // by the backend parser. Cross-device mentions only show publicCode
    // because entityId is meaningless across devices.
    const bullets = mentions
        .map(m => {
            const parts = [`publicCode: ${m.publicCode}`];
            if (!m.isCrossDevice && m.entityId != null) parts.push(`entityId: ${m.entityId}`);
            if (m.isCrossDevice) parts.push('cross-device');
            return `  → @${m.name} (${parts.join(', ')})`;
        })
        .join('\n');
    const codes = mentions.map(m => `"${m.publicCode}"`).join(',');
    const count = mentions.length + (hasAll ? 1 : 0);
    const noun = count === 1 ? 'entity' : 'entities';

    let block = `[MENTIONS — IMPORTANT ROUTING HINT] The user explicitly tagged ${count} ${noun}:\n`;
    if (hasAll) block += `  → @all (broadcast to every bound entity on this device)\n`;
    if (bullets) block += `${bullets}\n`;

    block += `\nIf the user's message implies communicating with these entities`;
    block += ` (forwarding, asking, reporting, relaying, etc.), you MUST call`;
    block += ` /api/transform with`;
    if (mentions.length > 0) {
        block += ` speakTo: [${codes}]`;
        if (hasAll) block += ` AND/OR broadcast:true`;
    } else if (hasAll) {
        block += ` broadcast:true`;
    }
    block += `. Do NOT fall back to a previous conversation partner just because`;
    block += ` you spoke with them recently — the user's @-tag is the authoritative`;
    block += ` routing target. /api/transform will echo routing diagnostics;`;
    block += ` if you send explicit speakTo without a matching @-mention,`;
    block += ` routing.warnings includes MENTION_MISSING_FOR_speakTo:<entityId>.`;
    return block;
}

// Fill in any structured fields the caller did not pre-build. Caller-supplied
// values always win. Helpers are injected (rather than required) so this
// module stays unit-testable in isolation and free of import cycles.
//
// NOTE: identity setup hint is intentionally NOT auto-filled here.
// `buildIdentitySetupHint` mutates the entity (`_identityHintCount++`) and is
// rate-limited to 3 deliveries per session — auto-filling on every channel
// push would burn that quota faster than the original webhook path. Callers
// that need the hint must populate `ctx.identityHint` explicitly.
function enrichContext(rawContext, opts = {}) {
    const {
        helpers = {},
        apiBase,
        targetEntity,
        targetDevice,
        targetDeviceId,
        targetEntityId,
        broadcastRecipients,
    } = opts;

    const ctx = { ...(rawContext || {}) };

    if (!ctx.silentToken) ctx.silentToken = SILENT_TOKEN;

    if (ctx.missionHints == null && helpers.getMissionApiHints && targetEntity && targetEntity.botSecret) {
        ctx.missionHints = helpers.getMissionApiHints(
            apiBase,
            targetDeviceId,
            targetEntityId,
            targetEntity.botSecret
        );
    }

    if (
        ctx.recipientBlock == null &&
        helpers.buildBroadcastRecipientBlock &&
        Array.isArray(broadcastRecipients) &&
        broadcastRecipients.length > 1 &&
        targetDevice
    ) {
        ctx.recipientBlock = helpers.buildBroadcastRecipientBlock(
            targetDevice,
            broadcastRecipients,
            targetEntityId
        );
    }

    // Pre-render the mentions block once so materializeChannelText can treat
    // it the same way as recipientBlock / missionHints / identityHint.
    if (ctx.mentionsBlock == null) {
        const block = buildMentionsBlock({ mentions: ctx.mentions, hasAll: ctx.hasAll });
        if (block) ctx.mentionsBlock = block;
    }

    return ctx;
}

// Materialise a push payload into a single `text` blob for a channel plugin.
// Channel mode omits the `[ACTION REQUIRED]` curl reply template — channel
// plugins have their own reply mechanism (eclaw_reply MCP tool, OpenClaw
// outbound.sendText, etc.) and don't need the bot to build a curl command.
//
// Layout (each section separated by a blank line):
//
//   [Bot-to-Bot from ...] / [Broadcast from ...]      ┐  header — single \n
//   [Quota: N/M bot-to-bot remaining ...]             ┘  between the two
//   [BROADCAST RECIPIENTS] ...
//   <baseText + media label>
//   [MENTIONS] ...
//   [AVAILABLE TOOLS — Mission Dashboard] ...
//   [IDENTITY_SETUP_REQUIRED] ...
function materializeChannelText(payload, ctx = {}) {
    if (!ctx) ctx = {}; // default param does not catch explicit null
    const event = payload.event || 'message';
    const sections = [];

    // Header: prefix + quota grouped into a single section so they sit on
    // adjacent lines (matches the legacy openclaw-channel-eclaw format).
    if ((event === 'entity_message' || event === 'broadcast') && payload.fromEntityId != null) {
        const senderLabel = payload.fromName || payload.fromCharacter;
        const sender = senderLabel
            ? `Entity ${payload.fromEntityId} (${senderLabel})`
            : `Entity ${payload.fromEntityId}`;
        const headerLines = [event === 'broadcast'
            ? `[Broadcast from ${sender}]`
            : `[Bot-to-Bot message from ${sender}]`];
        if (ctx.b2bRemaining != null) {
            const max = ctx.b2bMax || DEFAULT_B2B_MAX;
            const silent = ctx.silentToken || SILENT_TOKEN;
            headerLines.push(`[Quota: ${ctx.b2bRemaining}/${max} bot-to-bot remaining — output "${silent}" if no new info worth replying to]`);
        }
        sections.push(headerLines.join('\n'));
    }

    if (ctx.recipientBlock) sections.push(String(ctx.recipientBlock).trim());

    // Body: text + media attachment label.
    let body = payload.text || '';
    if (payload.mediaUrl && payload.mediaType) {
        const label = payload.mediaType === 'photo' ? 'Image'
            : payload.mediaType === 'voice' ? 'Voice'
            : payload.mediaType === 'video' ? 'Video'
            : 'File';
        const url = payload.backupUrl || payload.mediaUrl;
        body = body ? `${body}\n[${label}: ${url}]` : `[${label}: ${url}]`;
    }
    if (body) sections.push(body);

    // Trailer.
    if (ctx.mentionsBlock) sections.push(String(ctx.mentionsBlock).trim());
    if (ctx.referencesBlock) sections.push(String(ctx.referencesBlock).trim());
    if (ctx.missionHints) sections.push(String(ctx.missionHints).trim());
    if (ctx.identityHint) sections.push(String(ctx.identityHint).trim());

    return sections.join('\n\n');
}

module.exports = {
    SILENT_TOKEN,
    buildMentionsBlock,
    enrichContext,
    materializeChannelText,
};
