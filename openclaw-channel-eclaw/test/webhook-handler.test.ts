import { describe, expect, it, vi } from 'vitest';
import { createWebhookHandler } from '../src/webhook-handler.js';
import { setPluginRuntime } from '../src/runtime.js';
import { setClient } from '../src/outbound.js';

describe('createWebhookHandler', () => {
  it('acks healthcheck messages without dispatching agent work', async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn();
    setPluginRuntime({
      channel: {
        reply: {
          finalizeInboundContext: vi.fn(),
          dispatchReplyWithBufferedBlockDispatcher,
        },
      },
    });

    const client = {
      sendMessage: vi.fn().mockResolvedValue({ success: true }),
    };
    setClient('default', client as any);

    const handler = createWebhookHandler('token', 'default', {});
    const res = {
      writeHead: vi.fn(),
      end: vi.fn(),
    };

    await handler({
      method: 'POST',
      body: {
        deviceId: 'device-1',
        entityId: 0,
        text: 'ECLAW_HEALTHCHECK abc123',
      },
    }, res);

    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ ok: true }));
    expect(client.sendMessage).toHaveBeenCalledWith('ACK abc123', 'IDLE');
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });
});
