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
  const authHeader = req.headers?.authorization as string | undefined;
  if (!authHeader?.startsWith('Bearer ')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  const token = authHeader.slice(7);
  const entry = registry.get(token);
  if (!entry) {
    // Unknown token — likely a stale push after a server restart
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unknown token' }));
    return;
  }

  await entry.handler(req, res);
}
