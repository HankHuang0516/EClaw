import { EClawClient } from './client.js';

/** Client instances keyed by accountId */
const clients = new Map<string, EClawClient>();

/** Track current inbound event type per account to suppress duplicate sendMessage calls */
const activeEvent = new Map<string, string>();

export function setActiveEvent(accountId: string, event: string): void {
  activeEvent.set(accountId, event);
}

export function clearActiveEvent(accountId: string): void {
  activeEvent.delete(accountId);
}

export function setClient(accountId: string, client: EClawClient): void {
  clients.set(accountId, client);
}

export function getClient(accountId: string): EClawClient | undefined {
  return clients.get(accountId);
}

/** OpenClaw outbound: send text message to E-Claw user */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function sendText(ctx: any): Promise<any> {
  const accountId: string = ctx.accountId ?? 'default';
  // Suppress duplicate delivery for bot-to-bot events — webhook-handler's deliver handles these
  const event = activeEvent.get(accountId) ?? 'message';
  if (event === 'entity_message' || event === 'broadcast') {
    return { channel: 'eclaw', messageId: '', chatId: '' };
  }
  const client = clients.get(accountId);
  if (!client) {
    return { channel: 'eclaw', messageId: '', chatId: '' };
  }

  try {
    const result = await client.sendMessage(ctx.text, 'IDLE');
    return {
      channel: 'eclaw',
      messageId: `eclaw-${Date.now()}`,
      chatId: ctx.to ?? ctx.conversationId ?? '',
      ok: result.success,
    };
  } catch (err) {
    console.error('[E-Claw] sendText failed:', err);
    return { channel: 'eclaw', messageId: '', chatId: '' };
  }
}

/** OpenClaw outbound: send media message to E-Claw user */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function sendMedia(ctx: any): Promise<any> {
  const accountId: string = ctx.accountId ?? 'default';
  // Suppress duplicate delivery for bot-to-bot events — webhook-handler's deliver handles these
  const event = activeEvent.get(accountId) ?? 'message';
  if (event === 'entity_message' || event === 'broadcast') {
    return { channel: 'eclaw', messageId: '', chatId: '' };
  }
  const client = clients.get(accountId);
  if (!client) {
    return { channel: 'eclaw', messageId: '', chatId: '' };
  }

  try {
    // Map OpenClaw media types to E-Claw types
    const mediaType = ctx.mediaType === 'image' ? 'photo'
      : ctx.mediaType === 'audio' ? 'voice'
      : ctx.mediaType ?? 'file';

    const result = await client.sendMessage(
      ctx.text || `[${mediaType}]`,
      'IDLE',
      mediaType,
      ctx.mediaUrl
    );

    return {
      channel: 'eclaw',
      messageId: `eclaw-${Date.now()}`,
      chatId: ctx.to ?? ctx.conversationId ?? '',
      ok: result.success,
    };
  } catch (err) {
    console.error('[E-Claw] sendMedia failed:', err);
    return { channel: 'eclaw', messageId: '', chatId: '' };
  }
}
