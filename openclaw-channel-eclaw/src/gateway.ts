import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveAccount } from './config.js';
import type { EClawAccountConfig } from './types.js';
import { EClawClient } from './client.js';
import { setClient } from './outbound.js';
import { createWebhookHandler } from './webhook-handler.js';
import { registerWebhookToken, unregisterWebhookToken } from './webhook-registry.js';

/**
 * Resolve account from ctx.
 *
 * OpenClaw may pass a pre-resolved account object in ctx.account,
 * or an empty config. Fall back to reading openclaw.json from disk.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveAccountFromCtx(ctx: any): EClawAccountConfig {
  // Preferred: OpenClaw passes the resolved account in ctx.account
  if (ctx.account?.apiKey) {
    return {
      enabled: ctx.account.enabled ?? true,
      apiKey: ctx.account.apiKey,
      apiSecret: ctx.account.apiSecret,
      apiBase: (ctx.account.apiBase ?? 'https://eclawbot.com').replace(/\/$/, ''),
      botName: ctx.account.botName,
      webhookUrl: ctx.account.webhookUrl,
    };
  }

  // Fallback: read config from disk (OpenClaw passes empty config object)
  const configPath = process.env.OPENCLAW_CONFIG_PATH
    || join(homedir(), '.openclaw', 'openclaw.json');
  let fullConfig: unknown = {};
  try {
    fullConfig = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch { /* ignore */ }
  return resolveAccount(fullConfig, ctx.accountId ?? ctx.account?.accountId);
}

/**
 * Gateway lifecycle: start an E-Claw account.
 *
 * 1. Resolve credentials from ctx.account or disk
 * 2. Register a per-session handler in the webhook-registry (served by the
 *    main OpenClaw gateway HTTP server at /eclaw-webhook — no separate port)
 * 3. Register callback URL with E-Claw backend
 * 4. Auto-bind entity if not already bound
 * 5. Keep the promise alive until abort signal fires
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function startAccount(ctx: any): Promise<void> {
  const accountId: string = ctx.accountId ?? ctx.account?.accountId ?? 'default';
  const account = resolveAccountFromCtx(ctx);

  if (!account.enabled || !account.apiKey) {
    console.log(`[E-Claw] Account ${accountId} disabled or missing credentials, skipping`);
    return;
  }

  // Initialize HTTP client
  const client = new EClawClient(account);
  setClient(accountId, client);

  // Generate per-session callback token
  const callbackToken = randomBytes(32).toString('hex');

  // Webhook URL: account config > env var > warn
  let publicUrl = account.webhookUrl?.replace(/\/$/, '')
    || process.env.ECLAW_WEBHOOK_URL?.replace(/\/$/, '');

  // Auto-upgrade HTTP to HTTPS for non-localhost URLs to avoid
  // 301/302 redirects that convert POST→GET and lose the request body
  if (publicUrl && publicUrl.startsWith('http://') && !publicUrl.includes('localhost') && !publicUrl.includes('127.0.0.1')) {
    publicUrl = publicUrl.replace('http://', 'https://');
  }

  if (!publicUrl) {
    console.warn(
      '[E-Claw] Webhook URL not configured. ' +
      'Run "openclaw configure" and enter your OpenClaw public URL, ' +
      'or set ECLAW_WEBHOOK_URL env var. ' +
      'Example: https://your-openclaw-domain.com'
    );
  }

  // The callback URL points to /eclaw-webhook on the main gateway HTTP server
  const callbackUrl = `${publicUrl || 'http://localhost'}/eclaw-webhook`;

  // Register handler in the per-token registry
  // Pass ctx.cfg so the handler can dispatch to the correct OpenClaw agent
  const handler = createWebhookHandler(callbackToken, accountId, ctx.cfg);
  registerWebhookToken(callbackToken, accountId, handler);
  console.log(`[E-Claw] Webhook registered at: ${callbackUrl}`);

  try {
    // Register callback with E-Claw backend
    const regData = await client.registerCallback(callbackUrl, callbackToken);
    console.log(`[E-Claw] Registered with E-Claw. Device: ${regData.deviceId}, Entities: ${regData.entities.length}`);

    // Debug: log entity slot status
    for (const e of regData.entities) {
      console.log(`[E-Claw]   slot ${e.entityId}: ${e.character}${e.name ? ` "${e.name}"` : ''} bound=${e.isBound} bindingType=${e.bindingType ?? 'none'}`);
    }

    // Bind entity via channel API (always auto-select — server picks first free slot).
    // entityId is NOT stored in config because slots are dynamic.
    // /api/channel/bind without entityId is idempotent:
    //   - Not bound → binds fresh, returns new botSecret
    //   - Already bound via this channel account → returns existing botSecret (reconnect)
    const bindData = await client.bindEntity(undefined, account.botName);
    const assignedEntityId = bindData.entityId;
    const entityInfo = regData.entities.find(e => e.entityId === assignedEntityId);
    const wasAlreadyBound = entityInfo?.isBound ?? false;
    console.log(
      wasAlreadyBound
        ? `[E-Claw] Entity ${assignedEntityId} reconnected (existing channel binding), publicCode: ${bindData.publicCode}`
        : `[E-Claw] Entity ${assignedEntityId} bound, publicCode: ${bindData.publicCode}`
    );

    console.log(`[E-Claw] Account ${accountId} ready!`);
  } catch (err) {
    console.error(`[E-Claw] Setup failed for account ${accountId}:`, err);
    unregisterWebhookToken(callbackToken);
    return;
  }

  // Keep the promise alive until abort signal fires
  return new Promise<void>((resolve) => {
    const signal: AbortSignal | undefined = ctx.abortSignal;
    if (signal) {
      signal.addEventListener('abort', () => {
        console.log(`[E-Claw] Shutting down account ${accountId}`);
        client.unregisterCallback().catch(() => {});
        unregisterWebhookToken(callbackToken);
        resolve();
      });
    } else {
      resolve();
    }
  });
}
