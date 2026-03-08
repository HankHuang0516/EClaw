import { setPluginRuntime } from './runtime.js';
import { eclawChannel } from './channel.js';
import { dispatchWebhook } from './webhook-registry.js';

/**
 * E-Claw Channel Plugin for OpenClaw.
 *
 * Installation:
 *   npm install @eclaw/openclaw-channel
 *
 * Configuration (config.yaml):
 *   channels:
 *     eclaw:
 *       accounts:
 *         default:
 *           apiKey: "eck_..."
 *           apiBase: "https://eclawbot.com"
 *           entityId: 0
 *           botName: "My Bot"
 *           webhookUrl: "https://your-openclaw-domain.com"
 *
 * The plugin registers /eclaw-webhook on the main OpenClaw gateway HTTP server,
 * so no separate port is needed. Set webhookUrl to your OpenClaw public URL
 * (e.g. https://eclaw2.zeabur.app) so E-Claw knows where to push messages.
 */

/** Parse JSON body from a raw incoming request */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseBody(req: any): Promise<void> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        req.body = JSON.parse(body);
      } catch {
        req.body = {};
      }
      resolve();
    });
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const plugin = {
  id: 'openclaw-channel',
  name: 'E-Claw',
  description: 'E-Claw AI chat platform channel plugin',

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(api: any) {
    console.log('[E-Claw] Plugin loaded');
    setPluginRuntime(api.runtime);

    // Register /eclaw-webhook on the main OpenClaw gateway HTTP server.
    // Token-based routing is handled in dispatchWebhook() — each account
    // registers its own handler keyed by a random per-session Bearer token.
    api.registerHttpRoute({
      path: '/eclaw-webhook',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (req: any, res: any) => {
        await parseBody(req);
        await dispatchWebhook(req, res);
      },
    });

    api.registerChannel({ plugin: eclawChannel });
  },
};

export default plugin;
