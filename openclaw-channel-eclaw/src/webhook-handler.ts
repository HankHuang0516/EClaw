import type { EClawInboundMessage } from './types.js';
import { getPluginRuntime } from './runtime.js';
import { getClient, setActiveEvent, clearActiveEvent } from './outbound.js';

/**
 * Create an HTTP request handler for inbound messages from E-Claw.
 *
 * Handles three event types:
 *   - 'message'        → Normal human message; reply via sendMessage()
 *   - 'entity_message' → Bot-to-bot speak-to; reply via sendMessage() + speakTo(fromEntityId)
 *   - 'broadcast'      → Broadcast from another entity; reply via sendMessage() + speakTo(fromEntityId)
 *
 * The `deliver` callback routes AI response to the correct E-Claw endpoint
 * based on the inbound event type.
 *
 * Channel Bot Context Parity v1.0.17:
 *   - Bot-to-bot / broadcast now calls sendMessage() to update own wallpaper AND speakTo() to reply
 *   - Quota awareness via eclaw_context.b2bRemaining / b2bMax
 *   - Mission context via eclaw_context.missionHints
 *   - Silent suppression via silentToken (default "[SILENT]")
 */
export function createWebhookHandler(
  expectedToken: string,
  accountId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cfg: any    // full openclaw config (ctx.cfg from startAccount)
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (req: any, res: any): Promise<void> => {
    // Verify callback token
    const authHeader = req.headers?.authorization as string | undefined;
    if (expectedToken && (!authHeader || authHeader !== `Bearer ${expectedToken}`)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const msg: EClawInboundMessage = req.body;

    // ACK immediately so E-Claw doesn't time out
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));

    // Dispatch to OpenClaw agent
    try {
      const rt = getPluginRuntime();
      const client = getClient(accountId);
      const conversationId = msg.conversationId || `${msg.deviceId}:${msg.entityId}`;

      // Capture event context for deliver routing
      const event = msg.event || 'message';
      const fromEntityId = msg.fromEntityId;
      const fromCharacter = msg.fromCharacter;

      // Read server-injected context block (Channel Bot parity)
      const eclawCtx = msg.eclaw_context;
      const silentToken = eclawCtx?.silentToken ?? '[SILENT]';

      // Map E-Claw media type to OpenClaw media type
      const ocMediaType = msg.mediaType === 'photo' ? 'image'
        : msg.mediaType === 'voice' ? 'audio'
        : msg.mediaType === 'video' ? 'video'
        : msg.mediaType ? 'file'
        : undefined;

      // Build body — enrich with event context for bot-to-bot and broadcast
      let body = msg.text || '';
      if ((event === 'entity_message' || event === 'broadcast') && fromEntityId !== undefined) {
        const senderLabel = fromCharacter
          ? `Entity ${fromEntityId} (${fromCharacter})`
          : `Entity ${fromEntityId}`;
        const eventPrefix = event === 'broadcast'
          ? `[Broadcast from ${senderLabel}]`
          : `[Bot-to-Bot message from ${senderLabel}]`;

        const quotaLine = eclawCtx?.b2bRemaining !== undefined
          ? `[Quota: ${eclawCtx.b2bRemaining}/${eclawCtx.b2bMax ?? 8} remaining — output "${silentToken}" if no new info worth replying to]`
          : '';

        const missionBlock = eclawCtx?.missionHints ?? '';

        body = [eventPrefix, quotaLine, missionBlock, msg.text || '']
          .filter(Boolean)
          .join('\n');
      }

      // Build context in OpenClaw's native PascalCase format
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inboundCtx: any = {
        Surface: 'eclaw',
        Provider: 'eclaw',
        OriginatingChannel: 'eclaw',
        AccountId: accountId,
        From: msg.from,
        To: conversationId,
        OriginatingTo: msg.from,
        SessionKey: conversationId,
        Body: body,
        RawBody: body,
        CommandBody: body,
        ChatType: 'direct',
        ...(ocMediaType && msg.mediaUrl ? {
          MediaType: ocMediaType,
          MediaUrl: msg.mediaUrl,
        } : {}),
      };

      const ctxPayload = rt.channel.reply.finalizeInboundContext(inboundCtx);

      // Track event type so outbound.sendText() can suppress duplicate delivery
      setActiveEvent(accountId, event);
      try {
        await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: ctxPayload,
          cfg,
          dispatcherOptions: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            deliver: async (payload: any) => {
              if (!client) return;
              const text = typeof payload.text === 'string' ? payload.text.trim() : '';

              // [SILENT] token or empty → skip all API calls
              if (!text || text === silentToken) return;

              if ((event === 'entity_message' || event === 'broadcast') && fromEntityId !== undefined) {
                // Bot-to-bot / broadcast: update own wallpaper AND reply to sender
                await client.sendMessage(text, 'IDLE');
                await client.speakTo(fromEntityId, text, false);
              } else {
                // Normal human message: reply via channel message
                if (text) {
                  await client.sendMessage(text, 'IDLE');
                } else if (payload.mediaUrl) {
                  const rawType = typeof payload.mediaType === 'string' ? payload.mediaType : '';
                  const mediaType = rawType === 'image' ? 'photo'
                    : rawType === 'audio' ? 'voice'
                    : rawType === 'video' ? 'video'
                    : 'file';
                  await client.sendMessage('', 'IDLE', mediaType, payload.mediaUrl);
                }
              }
            },
            onError: (err: unknown) => {
              console.error('[E-Claw] Reply delivery error:', err);
            },
          },
        });
      } finally {
        clearActiveEvent(accountId);
      }
    } catch (err) {
      console.error('[E-Claw] Webhook dispatch error:', err);
    }
  };
}
