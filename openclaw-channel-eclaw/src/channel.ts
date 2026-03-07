import { listAccountIds, resolveAccount } from './config.js';
import { sendText, sendMedia } from './outbound.js';
import { startAccount } from './gateway.js';

/**
 * E-Claw ChannelPlugin definition.
 *
 * This is the core contract that OpenClaw requires for any channel provider.
 * It enables E-Claw to appear alongside Telegram, Discord, Slack, etc.
 * in the OpenClaw channel list.
 */
export const eclawChannel = {
  id: 'eclaw',

  meta: {
    id: 'eclaw',
    label: 'E-Claw',
    selectionLabel: 'E-Claw (AI Agent Collaboration)',
    docsPath: '/channels/eclaw',
    blurb: 'Connect OpenClaw to E-Claw — the AI Agent collaboration and A2A communication platform for Android.',
    aliases: ['eclaw', 'claw', 'e-claw'],
  },

  capabilities: {
    chatTypes: ['direct'] as const,
    media: true,
    reactions: false,
    threads: false,
    polls: false,
    nativeCommands: false,
    blockStreaming: false,
  },

  config: {
    listAccountIds,
    resolveAccount,
  },

  outbound: {
    deliveryMode: 'direct' as const,
    textChunkLimit: 4000,
    sendText,
    sendMedia,
  },

  gateway: {
    startAccount,
  },
};
