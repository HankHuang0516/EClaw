import { afterEach, describe, expect, it, vi } from 'vitest';
import { EClawClient } from '../src/client.js';

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

async function boundClient(fetchMock: ReturnType<typeof vi.fn>): Promise<EClawClient> {
  const client = new EClawClient({
    apiBase: 'https://example.invalid',
    apiKey: 'test-channel-key',
  });
  fetchMock.mockResolvedValueOnce(jsonResponse(200, {
    success: true,
    deviceId: 'device-1',
    entityId: 4,
    botSecret: 'bot-secret',
  }));
  await client.bindEntity(4, 'Eclaw_Office');
  return client;
}

describe('EClawClient message delivery retries', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('retries transient channel message network failures', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = await boundClient(fetchMock);

    fetchMock
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(jsonResponse(200, { success: true }));

    const promise = client.sendMessage('ACK HC4abc', 'IDLE');
    await vi.advanceTimersByTimeAsync(250);

    await expect(promise).resolves.toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries transient server starting responses', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = await boundClient(fetchMock);

    fetchMock
      .mockResolvedValueOnce(jsonResponse(503, { success: false, message: 'Server starting up — please retry in a few seconds' }))
      .mockResolvedValueOnce(jsonResponse(200, { success: true }));

    const promise = client.sendMessage('MODEL_HEALTH MH4abc entity=#4', 'IDLE');
    await vi.advanceTimersByTimeAsync(250);

    await expect(promise).resolves.toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
