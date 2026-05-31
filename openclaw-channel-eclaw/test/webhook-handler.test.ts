import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebhookHandler } from '../src/webhook-handler.js';
import { setPluginRuntime } from '../src/runtime.js';
import { setClient } from '../src/outbound.js';

describe('createWebhookHandler', () => {
  afterEach(() => {
    delete process.env.ECLAW_SUPPRESS_KANBAN_NOTIFICATIONS;
    delete process.env.ECLAW_SKIP_KANBAN_NOTIFICATIONS;
  });

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
        text: 'ECLAW_HEALTHCHECK abc_123-XYZ',
      },
    }, res);

    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ ok: true }));
    expect(client.sendMessage).toHaveBeenCalledWith('ACK abc_123-XYZ', 'IDLE');
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it('can ack stale kanban nudges without occupying the model reply path', async () => {
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
        text: '⏰ Task nudge: [Fix the bug]\nStuck in "In Progress" for 3h, please continue',
      },
    }, res);

    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ ok: true }));
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it.each([
    ['new assignment', '📋 New task assigned: 🔥 [P0] Fix the bug\nStatus: TODO'],
    ['status move', '➡️ Task status changed: [Fix the bug]\nTODO → In Progress'],
    ['reopen', '♻️ Card reopened: Fix the bug\nDone → TODO\nReason: needs rework'],
    ['review', '🔍 Pending review: [Fix the bug]\nMoved from In Progress to Review. Please review.'],
    ['priority escalation', '⬆️ Card "Fix the bug" has been stuck for 6h and was upgraded to P0'],
    ['block escalation', '🚫 Card "Fix the bug" has been stuck for 24h and was moved to blocked'],
  ])('does not suppress %s kanban notifications', async (_caseName, text) => {
    process.env.ECLAW_SUPPRESS_KANBAN_NOTIFICATIONS = '1';
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
        text,
      },
    }, res);

    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ ok: true }));
    expect(finalizeInboundContext).toHaveBeenCalled();
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
  });
});
