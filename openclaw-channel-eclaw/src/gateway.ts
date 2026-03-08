import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { resolveAccount } from './config.js';
import { EClawClient } from './client.js';
import { setClient } from './outbound.js';
import { createWebhookHandler } from './webhook-handler.js';

// ── Reconnect / health-check constants ───────────────────────────────────────
const HEALTH_CHECK_INTERVAL_MS = 60_000;  // re-register every 60 s to stay live
const BACKOFF_INITIAL_MS       =  5_000;  // first retry after 5 s
const BACKOFF_MAX_MS           = 300_000; // cap at 5 min
const BACKOFF_MULTIPLIER       = 2;

/** Build callbackUrl fresh from env every time — never use a stale closure value. */
function buildCallbackUrl(actualPort: number): string {
  const publicUrl = process.env.ECLAW_WEBHOOK_URL?.replace(/\/$/, '');
  const base = publicUrl || `http://localhost:${actualPort}`;
  return `${base}/eclaw-webhook`;
}

/** Sleep ms, but resolve early if abortSignal fires. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** Add ±20 % random jitter to reduce thundering-herd on reconnect. */
function jitter(ms: number): number {
  return Math.floor(ms * (0.8 + Math.random() * 0.4));
}

/**
 * Gateway lifecycle: start an E-Claw account.
 *
 * 1. Initialize HTTP client with channel API credentials
 * 2. Start a local HTTP server to receive webhook callbacks
 * 3. Register callback URL with E-Claw backend (with exponential-backoff retry)
 * 4. Auto-bind entity if not already bound
 * 5. Periodically re-register to keep callback URL live (health check)
 * 6. On health-check failure, reconnect with exponential backoff
 * 7. Keep the promise alive until abort signal fires
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function startAccount(ctx: any): Promise<void> {
  const { accountId, config } = ctx;
  const account = resolveAccount(config, accountId);

  if (!account.enabled || !account.apiKey || !account.apiSecret) {
    console.log(`[E-Claw] Account ${accountId} disabled or missing credentials, skipping`);
    return;
  }

  // Initialize HTTP client
  const client = new EClawClient(account);
  setClient(accountId, client);

  // Generate per-session callback token
  const callbackToken = randomBytes(32).toString('hex');

  // Determine webhook configuration
  const webhookPort = parseInt(process.env.ECLAW_WEBHOOK_PORT || '0') || 0;
  const publicUrl = process.env.ECLAW_WEBHOOK_URL;

  if (!publicUrl) {
    console.warn(
      '[E-Claw] ECLAW_WEBHOOK_URL not set. Set this to your public-facing URL ' +
      'so E-Claw can send messages to this plugin. Example: https://my-openclaw.example.com'
    );
  }

  // Create webhook handler
  const handler = createWebhookHandler(callbackToken, accountId);

  // Parse JSON body for incoming requests
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const requestHandler = (req: IncomingMessage, res: ServerResponse & { end: any }) => {
    if (req.method === 'POST' && req.url?.startsWith('/eclaw-webhook')) {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (req as any).body = JSON.parse(body);
        } catch {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (req as any).body = {};
        }
        handler(req, res);
      });
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  };

  const server = createServer(requestHandler);

  return new Promise<void>((resolve) => {
    server.listen(webhookPort, async () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : webhookPort;

      console.log(`[E-Claw] Webhook server listening on port ${actualPort}`);

      const signal: AbortSignal | undefined = ctx.abortSignal;

      // ── Core setup: register callback + bind entity ─────────────────────
      /**
       * One full register+bind cycle. Returns true on success, false on failure.
       * Reads ECLAW_WEBHOOK_URL fresh every call so a corrected env var takes
       * effect automatically on the next reconnect.
       */
      async function attemptSetup(): Promise<boolean> {
        const callbackUrl = buildCallbackUrl(actualPort);
        console.log(`[E-Claw][${accountId}] Registering callback: ${callbackUrl}`);
        try {
          const regData = await client.registerCallback(callbackUrl, callbackToken);
          console.log(`[E-Claw][${accountId}] Registered. Device: ${regData.deviceId}, Entities: ${regData.entities.length}`);

          const entity = regData.entities.find(e => e.entityId === account.entityId);
          if (!entity?.isBound) {
            console.log(`[E-Claw][${accountId}] Entity ${account.entityId} not bound, binding...`);
            const bindData = await client.bindEntity(account.entityId, account.botName);
            console.log(`[E-Claw][${accountId}] Bound entity ${account.entityId}, publicCode: ${bindData.publicCode}`);
          } else {
            console.log(`[E-Claw][${accountId}] Entity ${account.entityId} already bound`);
            // For already-bound entities, retrieve credentials via bind endpoint
            const bindData = await client.bindEntity(account.entityId, account.botName);
            console.log(`[E-Claw][${accountId}] Retrieved credentials for entity ${account.entityId}`);
            void bindData; // credentials stored in client
          }
          return true;
        } catch (err) {
          console.error(`[E-Claw][${accountId}] Setup attempt failed:`, err);
          return false;
        }
      }

      // ── Initial connect with exponential backoff ────────────────────────
      let backoffMs = BACKOFF_INITIAL_MS;
      let attempt = 0;

      while (!signal?.aborted) {
        attempt++;
        const ok = await attemptSetup();
        if (ok) {
          console.log(`[E-Claw][${accountId}] Account ready! (attempt #${attempt})`);
          break;
        }
        const delay = jitter(Math.min(backoffMs, BACKOFF_MAX_MS));
        console.warn(`[E-Claw][${accountId}] Retrying in ${Math.round(delay / 1000)}s (attempt #${attempt})...`);
        await sleep(delay, signal);
        backoffMs = Math.min(backoffMs * BACKOFF_MULTIPLIER, BACKOFF_MAX_MS);
      }

      if (signal?.aborted) return;

      // ── Periodic health check + auto-reconnect ──────────────────────────
      // Re-register every 60 s. If it fails, enter a reconnect backoff loop.
      // Guard flag prevents concurrent reconnect loops from stacking.
      let isReconnecting = false;

      async function runHealthCheck(): Promise<void> {
        if (isReconnecting) return; // already reconnecting, skip this tick

        const callbackUrl = buildCallbackUrl(actualPort);
        try {
          await client.registerCallback(callbackUrl, callbackToken);
          // Silent success — no log spam when healthy
        } catch (err) {
          if (isReconnecting) return;
          isReconnecting = true;
          console.warn(`[E-Claw][${accountId}] Health check failed — starting reconnect loop:`, err);

          let reconnBackoff = BACKOFF_INITIAL_MS;
          let reconnAttempt = 0;

          while (!signal?.aborted) {
            reconnAttempt++;
            const delay = jitter(Math.min(reconnBackoff, BACKOFF_MAX_MS));
            console.warn(`[E-Claw][${accountId}] Reconnect attempt #${reconnAttempt} in ${Math.round(delay / 1000)}s...`);
            await sleep(delay, signal);
            if (signal?.aborted) break;

            const recovered = await attemptSetup();
            if (recovered) {
              console.log(`[E-Claw][${accountId}] Reconnected successfully after ${reconnAttempt} attempt(s)!`);
              break;
            }
            reconnBackoff = Math.min(reconnBackoff * BACKOFF_MULTIPLIER, BACKOFF_MAX_MS);
          }

          isReconnecting = false;
        }
      }

      const healthTimer = setInterval(() => { void runHealthCheck(); }, HEALTH_CHECK_INTERVAL_MS);

      // ── Cleanup on abort ────────────────────────────────────────────────
      if (signal) {
        signal.addEventListener('abort', () => {
          console.log(`[E-Claw][${accountId}] Shutting down account`);
          clearInterval(healthTimer);
          client.unregisterCallback().catch(() => {});
          server.close();
          resolve();
        });
      }
    });
  });
}
