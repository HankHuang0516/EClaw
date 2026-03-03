import type {
  EClawAccountConfig,
  RegisterResponse,
  BindResponse,
  MessageResponse,
} from './types.js';

/**
 * HTTP client for E-Claw Channel API.
 * Handles all communication between the OpenClaw plugin and the E-Claw backend.
 */
export class EClawClient {
  private readonly apiBase: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private deviceId: string | null = null;
  private botSecret: string | null = null;
  private entityId: number;

  constructor(config: EClawAccountConfig) {
    this.apiBase = config.apiBase;
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    this.entityId = config.entityId;
  }

  /** Register callback URL with E-Claw backend */
  async registerCallback(callbackUrl: string, callbackToken: string): Promise<RegisterResponse> {
    const res = await fetch(`${this.apiBase}/api/channel/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel_api_key: this.apiKey,
        channel_api_secret: this.apiSecret,
        callback_url: callbackUrl,
        callback_token: callbackToken,
      }),
    });

    const data = await res.json() as RegisterResponse & { message?: string };
    if (!data.success) {
      throw new Error(data.message || `Registration failed (HTTP ${res.status})`);
    }

    this.deviceId = data.deviceId;
    return data;
  }

  /** Bind an entity via channel API (bypasses 6-digit code) */
  async bindEntity(entityId: number, name?: string): Promise<BindResponse> {
    const res = await fetch(`${this.apiBase}/api/channel/bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel_api_key: this.apiKey,
        channel_api_secret: this.apiSecret,
        entityId,
        name: name || undefined,
      }),
    });

    const data = await res.json() as BindResponse & { message?: string };
    if (!data.success) {
      throw new Error(data.message || `Bind failed (HTTP ${res.status})`);
    }

    this.botSecret = data.botSecret;
    this.deviceId = data.deviceId;
    this.entityId = entityId;
    return data;
  }

  /** Send bot message to user */
  async sendMessage(
    message: string,
    state: string = 'IDLE',
    mediaType?: string,
    mediaUrl?: string
  ): Promise<MessageResponse> {
    if (!this.deviceId || !this.botSecret) {
      throw new Error('Not bound — call bindEntity() first');
    }

    const res = await fetch(`${this.apiBase}/api/channel/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel_api_key: this.apiKey,
        deviceId: this.deviceId,
        entityId: this.entityId,
        botSecret: this.botSecret,
        message,
        state,
        ...(mediaType && { mediaType }),
        ...(mediaUrl && { mediaUrl }),
      }),
    });

    return await res.json() as MessageResponse;
  }

  /** Unregister callback on shutdown */
  async unregisterCallback(): Promise<void> {
    await fetch(`${this.apiBase}/api/channel/register`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel_api_key: this.apiKey,
        channel_api_secret: this.apiSecret,
      }),
    });
  }

  get currentDeviceId(): string | null { return this.deviceId; }
  get currentBotSecret(): string | null { return this.botSecret; }
  get currentEntityId(): number { return this.entityId; }
}
