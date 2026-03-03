import { setPluginRuntime } from './runtime.js';
import { eclawChannel } from './channel.js';

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
 *           apiSecret: "ecs_..."
 *           apiBase: "https://eclawbot.com"
 *           entityId: 0
 *           botName: "My Bot"
 *
 * Environment variables:
 *   ECLAW_WEBHOOK_URL  - Public URL for receiving callbacks (required for production)
 *   ECLAW_WEBHOOK_PORT - Port for webhook server (default: random)
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const plugin = {
  id: 'eclaw',
  name: 'E-Claw',
  description: 'E-Claw AI chat platform channel plugin',

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(api: any) {
    console.log('[E-Claw] Plugin loaded');
    setPluginRuntime(api.runtime);
    api.registerChannel({ plugin: eclawChannel });
  },
};

export default plugin;
