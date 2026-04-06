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
function buildMentionsBlock(mentionsContext) {
    if (!mentionsContext) return '';
    const mentions = Array.isArray(mentionsContext.mentions) ? mentionsContext.mentions : [];
    const hasAll = !!mentionsContext.hasAll;
    if (mentions.length === 0 && !hasAll) return '';

    const taggedLabels = mentions
        .map(m => `@${m.name}#${m.publicCode}${m.isCrossDevice ? '(cross-device)' : ''}`)
        .join(', ');
    const allLabel = hasAll ? '@all (broadcast) ' : '';
    const codes = mentions.map(m => `"${m.publicCode}"`).join(',');

    let block = `[MENTIONS] User tagged: ${allLabel}${taggedLabels}`;
    block += `\nTo relay this message to the tagged entities, use the speakTo field in /api/transform with the publicCodes: [${codes}]`;
    if (hasAll) {
        block += `\nOr set broadcast:true to send to every bound entity on this device.`;
    }
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
        const sender = payload.fromCharacter
            ? `Entity ${payload.fromEntityId} (${payload.fromCharacter})`
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
