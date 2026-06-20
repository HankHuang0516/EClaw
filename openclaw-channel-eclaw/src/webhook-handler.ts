import type { EClawInboundMessage } from './types.js';
import { getPluginRuntime } from './runtime.js';
import { getClient, setActiveEvent, clearActiveEvent } from './outbound.js';

function envFlagEnabled(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || '').trim());
}

function envListIncludes(name: string, value: string, defaults: readonly string[] = []): boolean {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return false;
  if (/^(1|true|yes|on)$/i.test(raw)) return defaults.includes(value);
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .includes(value);
}

// Kanban notifications are task nudges and must stay model-routed by default.
// Only explicit ECLAW_SUPPRESS_KANBAN_NOTIFICATIONS should turn them into
// notification-only ACKs.
const DEFAULT_BACKGROUND_EVENTS = ['org_forward'] as const;

function shouldSuppressInboundEvent(event: string): boolean {
  if (
    event === 'kanban_notification'
    && (envFlagEnabled('ECLAW_SUPPRESS_KANBAN_NOTIFICATIONS') || envFlagEnabled('ECLAW_SKIP_KANBAN_NOTIFICATIONS'))
  ) {
    return true;
  }
  return envListIncludes('ECLAW_SUPPRESS_BACKGROUND_EVENTS', event, DEFAULT_BACKGROUND_EVENTS);
}

/**
 * Create an HTTP request handler for inbound messages from E-Claw.
 *
 * Handles three event types:
 *   - 'message'        → Normal human message; reply via sendMessage()
 *   - 'entity_message' → Bot-to-bot speak-to; reply via sendMessage(text, state, { speakTo })
 *   - 'broadcast'      → Broadcast from another entity; reply via sendMessage(text, state, { speakTo })
 *
 * The `deliver` callback routes AI response to the correct E-Claw endpoint
 * based on the inbound event type.
 *
 * EClaw backend v1.363+ centralised context inlining: when `msg.contextInlined`
 * is true, `msg.text` is already fully materialised (event prefix, quota line,
 * recipients, [MENTIONS], mission/identity hints, media labels) and we forward
 * it as-is. The `else` branch is a compatibility shim for older EClaw backends;
 * remove it once all consumers run v1.400+.
 *
 * `silentToken` is the only `eclaw_context` field still consulted locally
 * because it governs outbound suppression in the deliver() callback below
 * (a bot replying with this token must not actually send anything), and that
 * decision lives in the plugin.
 *
 * Outbound: bot-to-bot / broadcast replies use sendMessage() with speakTo so
 * a single API call updates the wallpaper and delivers the reply.
 */
export function createWebhookHandler(
  _expectedToken: string,   // kept for API compat; auth is handled by webhook-registry
  accountId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cfg: any    // full openclaw config (ctx.cfg from startAccount)
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (req: any, res: any): Promise<void> => {
    // Token verification is handled by webhook-registry dispatch.
    // No additional auth check needed here.

    const msg: EClawInboundMessage = req.body;

    // ACK immediately so E-Claw doesn't time out
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));

    console.log(`[E-Claw] Webhook received: event=${msg?.event || 'message'}, entity=${msg?.entityId}, from=${msg?.from}, hasText=${!!(msg?.text)}, method=${req.method}`);

    // Dispatch to OpenClaw agent
    try {
      const rt = getPluginRuntime();
      const client = getClient(accountId);
      const conversationId = msg.conversationId || `${msg.deviceId}:${msg.entityId}`;

      const directAck = String(msg.text || '').match(/^ECLAW_HEALTHCHECK\s+([A-Za-z0-9_-]+)(?=\s|$)/m);
      if (directAck) {
        if (client) {
          // /api/client/speak writes a "Received" echo around webhook delivery.
          // A short delay keeps the synthetic ACK as the final visible state
          // without occupying the model reply path.
          await new Promise((resolve) => setTimeout(resolve, 3000));
          await client.sendMessage(`ACK ${directAck[1]}`, 'IDLE');
        }
        return;
      }

      // Universal self-repair directive: when the version-aware /self-repair and
      // /restart channel endpoints are unavailable, EClaw delivers this directive
      // over the normal inbound push so the channel restarts itself in-place.
      // The openclaw container runs `restart: unless-stopped`, so exiting here
      // relaunches the process and re-binds via gateway.ts startAccount.
      const selfRepair = String(msg.text || '').match(/\bECLAW_SELF_REPAIR\s+([A-Za-z0-9_-]+)/);
      if (selfRepair) {
        if (client) {
          await client.sendMessage(`ACK ${selfRepair[1]}`, 'IDLE');
        }
        setTimeout(() => process.exit(0), 400);
        return;
      }

      // Capture event context for deliver routing
      const event = msg.event || 'message';
      const fromEntityId = msg.fromEntityId;
      const fromCharacter = msg.fromCharacter;

      const eclawCtx = msg.eclaw_context;
      const silentToken = eclawCtx?.silentToken ?? '[SILENT]';

      if (shouldSuppressInboundEvent(event)) {
        console.log(`[E-Claw] Background event ${event} suppressed by runtime policy; webhook ACKed without occupying the model reply path`);
        return;
      }

      // Map E-Claw media type to OpenClaw media type
      const ocMediaType = msg.mediaType === 'photo' ? 'image'
        : msg.mediaType === 'voice' ? 'audio'
        : msg.mediaType === 'video' ? 'video'
        : msg.mediaType ? 'file'
        : undefined;

      // Body assembly. Backend v1.363+ inlines everything; legacy branch
      // below is the pre-v1.363 fallback (TODO: remove once all consumers
      // run v1.400+).
      let body: string;
      if (msg.contextInlined) {
        body = msg.text || '';
      } else {
        body = msg.text || '';
        if (msg.mediaUrl && msg.mediaType) {
          const mediaLabel = msg.mediaType === 'photo' ? 'Image'
            : msg.mediaType === 'voice' ? 'Voice'
            : msg.mediaType === 'video' ? 'Video'
            : 'File';
          const urlToAppend = msg.backupUrl || msg.mediaUrl;
          body = body
            ? `${body}\n[${mediaLabel}: ${urlToAppend}]`
            : `[${mediaLabel}: ${urlToAppend}]`;
        }
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
        } else if (event === 'kanban_notification') {
          const missionBlock = eclawCtx?.missionHints ?? '';
          body = [msg.text || '', missionBlock].filter(Boolean).join('\n');
        }
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
                // Bot-to-bot / broadcast: update wallpaper + deliver reply in one API call
                await client.sendMessage(text, 'IDLE', { speakTo: [String(fromEntityId)] });
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
                  await client.sendMessage('', 'IDLE', { mediaType, mediaUrl: payload.mediaUrl });
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
