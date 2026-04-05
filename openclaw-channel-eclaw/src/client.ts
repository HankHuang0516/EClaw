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

  private deviceId: string | null = null;
  private botSecret: string | null = null;
  private entityId: number | undefined;

  constructor(config: EClawAccountConfig) {
    this.apiBase = config.apiBase;
    this.apiKey = config.apiKey;
  }

  /** Register callback URL with E-Claw backend */
  async registerCallback(callbackUrl: string, callbackToken: string): Promise<RegisterResponse> {
    const res = await fetch(`${this.apiBase}/api/channel/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel_api_key: this.apiKey,
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

  /** Bind an entity via channel API (bypasses 6-digit code).
   *  If entityId is omitted, the backend auto-selects the first free slot.
   */
  async bindEntity(entityId?: number, name?: string): Promise<BindResponse> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: Record<string, any> = { channel_api_key: this.apiKey };
    if (entityId !== undefined) body.entityId = entityId;
    if (name) body.name = name;

    const res = await fetch(`${this.apiBase}/api/channel/bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await res.json() as BindResponse & { message?: string; entities?: any[] };
    if (!data.success) {
      // Build a detailed error message when all slots are full
      if (res.status === 409 && data.entities) {
        const list = data.entities
          .map((e: { entityId: number; character: string; name?: string | null }) =>
            `  slot ${e.entityId} (${e.character})${e.name ? ` "${e.name}"` : ''}`
          )
          .join('\n');
        throw new Error(
          `${data.message}\nCurrent entities:\n${list}\n` +
          'Add entityId to your channel config to target a specific slot after unbinding it.'
        );
      }
      throw new Error(data.message || `Bind failed (HTTP ${res.status})`);
    }

    this.botSecret = data.botSecret;
    this.deviceId = data.deviceId;
    this.entityId = data.entityId;  // Use server-assigned slot
    return data;
  }

  /**
   * Send bot message — unified endpoint for status update + optional delivery.
   *
   * @param message - Text message (also used as delivery content)
   * @param state - Entity state (IDLE, BUSY, etc.)
   * @param opts.mediaType - Optional media type
   * @param opts.mediaUrl - Optional media URL
   * @param opts.speakTo - Array of target identifiers (entityId or publicCode) to deliver message to
   * @param opts.broadcast - If true, deliver message to all other bound entities
   */
  async sendMessage(
    message: string,
    state: string = 'IDLE',
    opts?: {
      mediaType?: string;
      mediaUrl?: string;
      speakTo?: (string | number)[];
      broadcast?: boolean;
    }
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
        ...(opts?.mediaType && { mediaType: opts.mediaType }),
        ...(opts?.mediaUrl && { mediaUrl: opts.mediaUrl }),
        ...(opts?.speakTo && { speakTo: opts.speakTo.map(String) }),
        ...(opts?.broadcast && { broadcast: true }),
      }),
    });

    return await res.json() as MessageResponse;
  }

  /**
   * @deprecated Use sendMessage(text, state, { speakTo: [targetId] }) instead.
   * Kept for backward compatibility — calls sendMessage internally.
   */
  async speakTo(toEntityId: number, text: string, expectsReply: boolean = false): Promise<void> {
    await this.sendMessage(text, 'IDLE', { speakTo: [String(toEntityId)] });
  }

  /**
   * @deprecated Use sendMessage(text, state, { broadcast: true }) instead.
   * Kept for backward compatibility — calls sendMessage internally.
   */
  async broadcastToAll(text: string, expectsReply: boolean = false): Promise<void> {
    await this.sendMessage(text, 'IDLE', { broadcast: true });
  }

  /** Unregister callback on shutdown */
  async unregisterCallback(): Promise<void> {
    await fetch(`${this.apiBase}/api/channel/register`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel_api_key: this.apiKey,
      }),
    });
  }

  get currentDeviceId(): string | null { return this.deviceId; }
  get currentBotSecret(): string | null { return this.botSecret; }
  get currentEntityId(): number | undefined { return this.entityId; }
}
