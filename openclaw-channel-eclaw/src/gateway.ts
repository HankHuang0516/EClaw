import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { resolveAccount } from './config.js';
import { EClawClient } from './client.js';
import { setClient } from './outbound.js';
import { createWebhookHandler } from './webhook-handler.js';

/**
 * Gateway lifecycle: start an E-Claw account.
 *
 * 1. Initialize HTTP client with channel API credentials
 * 2. Start a local HTTP server to receive webhook callbacks
 * 3. Register callback URL with E-Claw backend
 * 4. Auto-bind entity if not already bound
 * 5. Keep the promise alive until abort signal fires
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
      const baseUrl = publicUrl || `http://localhost:${actualPort}`;
      const callbackUrl = `${baseUrl}/eclaw-webhook`;

      console.log(`[E-Claw] Webhook server listening on port ${actualPort}`);
      console.log(`[E-Claw] Callback URL: ${callbackUrl}`);

      try {
        // Register callback with E-Claw backend
        const regData = await client.registerCallback(callbackUrl, callbackToken);
        console.log(`[E-Claw] Registered with E-Claw. Device: ${regData.deviceId}, Entities: ${regData.entities.length}`);

        // Auto-bind entity if not already bound
        const entity = regData.entities.find(e => e.entityId === account.entityId);
        if (!entity?.isBound) {
          console.log(`[E-Claw] Entity ${account.entityId} not bound, binding...`);
          const bindData = await client.bindEntity(account.entityId, account.botName);
          console.log(`[E-Claw] Bound entity ${account.entityId}, publicCode: ${bindData.publicCode}`);
        } else {
          console.log(`[E-Claw] Entity ${account.entityId} already bound`);
          // For already-bound entities, we need to get the botSecret
          // The bind endpoint returns existing credentials for channel-bound entities
          const bindData = await client.bindEntity(account.entityId, account.botName);
          console.log(`[E-Claw] Retrieved credentials for entity ${account.entityId}`);
          void bindData; // credentials stored in client
        }

        console.log(`[E-Claw] Account ${accountId} ready!`);
      } catch (err) {
        console.error(`[E-Claw] Setup failed for account ${accountId}:`, err);
      }
    });

    // Cleanup on abort
    const signal: AbortSignal | undefined = ctx.abortSignal;
    if (signal) {
      signal.addEventListener('abort', () => {
        console.log(`[E-Claw] Shutting down account ${accountId}`);
        client.unregisterCallback().catch(() => {});
        server.close();
        resolve();
      });
    }
  });
}
