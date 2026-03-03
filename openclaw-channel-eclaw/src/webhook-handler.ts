import type { EClawInboundMessage } from './types.js';
import { getPluginRuntime } from './runtime.js';

/**
 * Create an HTTP request handler for inbound messages from E-Claw.
 *
 * When a user sends a message on E-Claw, the backend POSTs structured JSON
 * to this webhook. We normalize it and dispatch to the OpenClaw agent.
 */
export function createWebhookHandler(
  expectedToken: string,
  accountId: string
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
      const conversationId = msg.conversationId || `${msg.deviceId}:${msg.entityId}`;

      // Map E-Claw media types to OpenClaw types
      let media: { type: string; url: string } | undefined;
      if (msg.mediaType && msg.mediaUrl) {
        const type = msg.mediaType === 'photo' ? 'image'
          : msg.mediaType === 'voice' ? 'audio'
          : msg.mediaType === 'video' ? 'video'
          : 'file';
        media = { type, url: msg.mediaUrl };
      }

      const inboundCtx = {
        channelId: 'eclaw',
        accountId,
        conversationId,
        senderId: msg.from,
        text: msg.text || '',
        ...(media ? { media } : {}),
        metadata: {
          deviceId: msg.deviceId,
          entityId: msg.entityId,
          event: msg.event,
          fromEntityId: msg.fromEntityId,
          fromCharacter: msg.fromCharacter,
          isBroadcast: msg.isBroadcast,
          timestamp: msg.timestamp,
        },
      };

      // OpenClaw inbound dispatch pipeline
      const ctx = await rt.channel.reply.finalizeInboundContext(inboundCtx);
      await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher(ctx);
    } catch (err) {
      console.error('[E-Claw] Webhook dispatch error:', err);
    }
  };
}
