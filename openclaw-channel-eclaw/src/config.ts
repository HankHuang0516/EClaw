import type { EClawAccountConfig } from './types.js';

/** Extract accounts map from full openclaw config or eclaw-specific config */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getAccounts(cfg: any): Record<string, any> {
  // Full openclaw config: { channels: { eclaw: { accounts: {...} } } }
  if (cfg?.channels?.eclaw?.accounts) return cfg.channels.eclaw.accounts;
  // Eclaw channel config: { accounts: {...} }
  if (cfg?.accounts && typeof cfg.accounts === 'object') return cfg.accounts;
  return {};
}

/** List all configured account IDs from OpenClaw config */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function listAccountIds(cfg: any): string[] {
  const accounts = getAccounts(cfg);
  if (!accounts || typeof accounts !== 'object') return [];
  return Object.keys(accounts);
}

/** Resolve a specific account's config, with defaults */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function resolveAccount(cfg: any, accountId?: string): EClawAccountConfig {
  const accounts = getAccounts(cfg);
  const id = accountId ?? Object.keys(accounts)[0] ?? 'default';
  const account = accounts[id];

  return {
    enabled: account?.enabled ?? true,
    apiKey: account?.apiKey ?? '',
    apiSecret: account?.apiSecret,
    apiBase: (account?.apiBase ?? 'https://eclawbot.com').replace(/\/$/, ''),
    botName: account?.botName,
    webhookUrl: account?.webhookUrl,
  };
}
