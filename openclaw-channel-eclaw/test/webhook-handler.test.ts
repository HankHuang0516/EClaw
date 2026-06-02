import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebhookHandler } from '../src/webhook-handler.js';
import { setPluginRuntime } from '../src/runtime.js';
import { setClient } from '../src/outbound.js';

describe('createWebhookHandler', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.ECLAW_SUPPRESS_KANBAN_NOTIFICATIONS;
    delete process.env.ECLAW_SKIP_KANBAN_NOTIFICATIONS;
    delete process.env.ECLAW_SUPPRESS_BACKGROUND_EVENTS;
  });

  it('acks healthcheck messages without dispatching agent work', async () => {
    vi.useFakeTimers();
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

    const promise = handler({
      method: 'POST',
      body: {
        deviceId: 'device-1',
        entityId: 0,
        text: 'ECLAW_HEALTHCHECK abc_123-XYZ',
      },
    }, res);

    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ ok: true }));
    expect(client.sendMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(client.sendMessage).toHaveBeenCalledWith('ACK abc_123-XYZ', 'IDLE');
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it('can ack kanban notifications without occupying the model reply path', async () => {
    process.env.ECLAW_SUPPRESS_KANBAN_NOTIFICATIONS = '1';
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
        entityId: 1,
        event: 'kanban_notification',
        from: 'kanban',
        text: '📋 New task assigned: 🔥 [P0] Fix the bug\nStatus: TODO',
      },
    }, res);

    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ ok: true }));
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it('can ack org_forward background events without occupying the model reply path', async () => {
    process.env.ECLAW_SUPPRESS_BACKGROUND_EVENTS = '1';
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
        entityId: 1,
        event: 'org_forward',
        from: 'entity:4',
        text: 'Forwarded org update from another entity',
      },
    }, res);

    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ ok: true }));
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it('continues dispatching kanban notifications when suppression is disabled', async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockResolvedValue(undefined);
    const finalizeInboundContext = vi.fn((ctx) => ctx);
    setPluginRuntime({
      channel: {
        reply: {
          finalizeInboundContext,
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
        entityId: 1,
        event: 'kanban_notification',
        from: 'kanban',
        text: '📋 New task assigned: 🔥 [P0] Fix the bug\nStatus: TODO',
      },
    }, res);

    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ ok: true }));
    expect(finalizeInboundContext).toHaveBeenCalled();
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
  });
});
