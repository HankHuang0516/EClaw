import type { EClawAccountConfig } from './types.js';

/** List all configured account IDs from OpenClaw config */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function listAccountIds(cfg: any): string[] {
  const accounts = cfg?.channels?.eclaw?.accounts;
  if (!accounts || typeof accounts !== 'object') return [];
  return Object.keys(accounts);
}

/** Resolve a specific account's config, with defaults */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function resolveAccount(cfg: any, accountId?: string): EClawAccountConfig {
  const accounts = cfg?.channels?.eclaw?.accounts ?? {};
  const id = accountId ?? Object.keys(accounts)[0] ?? 'default';
  const account = accounts[id];

  return {
    enabled: account?.enabled ?? true,
    apiKey: account?.apiKey ?? '',
    apiSecret: account?.apiSecret ?? '',
    apiBase: (account?.apiBase ?? 'https://eclawbot.com').replace(/\/$/, ''),
    entityId: account?.entityId ?? 0,
    botName: account?.botName,
  };
}
