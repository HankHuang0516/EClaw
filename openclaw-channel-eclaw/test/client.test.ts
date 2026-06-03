import { afterEach, describe, expect, it, vi } from 'vitest';
import { EClawClient } from '../src/client.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('EClawClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('retries transient channel message rate limits before succeeding', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(429, { success: false, message: 'Too many requests — try again shortly' }))
      .mockResolvedValueOnce(jsonResponse(200, { success: true }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new EClawClient({
      enabled: true,
      apiBase: 'https://eclawbot.test',
      apiKey: 'key',
    });
    (client as unknown as { deviceId: string; botSecret: string; entityId: number }).deviceId = 'device-1';
    (client as unknown as { deviceId: string; botSecret: string; entityId: number }).botSecret = 'bot-secret';
    (client as unknown as { deviceId: string; botSecret: string; entityId: number }).entityId = 1;

    const pending = client.sendMessage('ACK HC123', 'IDLE');
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(pending).resolves.toMatchObject({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('throws when channel message returns a non-transient failure', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValue(jsonResponse(403, { success: false, message: 'Invalid botSecret' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new EClawClient({
      enabled: true,
      apiBase: 'https://eclawbot.test',
      apiKey: 'key',
    });
    (client as unknown as { deviceId: string; botSecret: string; entityId: number }).deviceId = 'device-1';
    (client as unknown as { deviceId: string; botSecret: string; entityId: number }).botSecret = 'bot-secret';
    (client as unknown as { deviceId: string; botSecret: string; entityId: number }).entityId = 1;

    await expect(client.sendMessage('hello')).rejects.toThrow('Message send failed: Invalid botSecret');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
