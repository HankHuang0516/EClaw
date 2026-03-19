import { listAccountIds, resolveAccount } from './config.js';
import { sendText, sendMedia } from './outbound.js';
import { startAccount } from './gateway.js';
import { eclawOnboardingAdapter } from './onboarding.js';

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
    selectionLabel: 'E-Claw (AI Live Wallpaper Chat)',
    docsPath: '/channels/eclaw',
    blurb: 'Connect OpenClaw to E-Claw — an AI chat platform for live wallpaper entities on Android.',
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

  onboarding: eclawOnboardingAdapter,
};
