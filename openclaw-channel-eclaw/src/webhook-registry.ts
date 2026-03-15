/**
 * Per-session webhook token registry.
 *
 * Each account generates a random callbackToken when it starts.
 * The token is sent to E-Claw as part of the callback URL registration,
 * and E-Claw echoes it back as `Authorization: Bearer <token>` on every push.
 *
 * The main route handler (registered on the gateway HTTP server) looks up
 * the correct per-account handler by matching the Bearer token.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WebhookHandler = (req: any, res: any) => Promise<void>;

interface WebhookEntry {
  accountId: string;
  handler: WebhookHandler;
}

const registry = new Map<string, WebhookEntry>();

export function registerWebhookToken(
  callbackToken: string,
  accountId: string,
  handler: WebhookHandler
): void {
  registry.set(callbackToken, { accountId, handler });
}

export function unregisterWebhookToken(callbackToken: string): void {
  registry.delete(callbackToken);
}

/**
 * Dispatch an incoming webhook request to the correct account handler.
 * Verifies the Bearer token and routes to the matching handler.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function dispatchWebhook(req: any, res: any): Promise<void> {
  // Support two auth modes:
  // 1. Standard: Authorization: Bearer <token>
  // 2. Basic Auth gateway (Railway WEB_PASSWORD): X-Callback-Token header
  const authHeader = req.headers?.authorization as string | undefined;
  const customToken = req.headers?.['x-callback-token'] as string | undefined;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : customToken;

  if (!token) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Auth required' }));
    return;
  }

  const entry = registry.get(token);
  if (!entry) {
    // Unknown token — likely a stale push after a server restart
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unknown token' }));
    return;
  }

  await entry.handler(req, res);
}
