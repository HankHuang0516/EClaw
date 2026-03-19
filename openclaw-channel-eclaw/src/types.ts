/** E-Claw account configuration from OpenClaw config.yaml */
export interface EClawAccountConfig {
  enabled: boolean;
  apiKey: string;
  apiSecret?: string;
  apiBase: string;
  botName?: string;
  webhookUrl?: string;
}

/** Context block injected by E-Claw server for Channel Bot parity with Traditional Bot */
export interface EClawContext {
  b2bRemaining?: number;   // Remaining bot-to-bot quota for receiving entity
  b2bMax?: number;         // Max quota (currently 8)
  expectsReply?: boolean;  // Whether sender expects a reply
  missionHints?: string;   // Output of getMissionApiHints() for receiving entity
  silentToken?: string;    // AI outputs this exact string to stay silent (e.g. "[SILENT]")
}

/** Inbound message from E-Claw callback webhook */
export interface EClawInboundMessage {
  event: 'message' | 'entity_message' | 'broadcast' | 'cross_device_message';
  deviceId: string;
  entityId: number;
  conversationId: string;
  from: string;
  text: string;
  mediaType?: 'photo' | 'voice' | 'video' | 'file' | null;
  mediaUrl?: string | null;
  backupUrl?: string | null;
  timestamp: number;
  isBroadcast: boolean;
  broadcastRecipients?: number[] | null;
  fromEntityId?: number;
  fromCharacter?: string;
  fromPublicCode?: string;
  eclaw_context?: EClawContext;
}

/** Entity info returned by channel register */
export interface EClawEntityInfo {
  entityId: number;
  isBound: boolean;
  name: string | null;
  character: string;
  bindingType: string | null;
}

/** Response from POST /api/channel/register */
export interface RegisterResponse {
  success: boolean;
  deviceId: string;
  entities: EClawEntityInfo[];
  maxEntities: number;
}

/** Response from POST /api/channel/bind */
export interface BindResponse {
  success: boolean;
  deviceId: string;
  entityId: number;  // Assigned slot (may differ from requested if auto-selected)
  botSecret: string;
  publicCode: string;
  bindingType: string;
}

/** Error response when all entity slots are full */
export interface SlotsFullError {
  success: false;
  message: string;
  entities: EClawEntityInfo[];
  hint: string;
}

/** Response from POST /api/channel/message */
export interface MessageResponse {
  success: boolean;
  currentState?: {
    name: string;
    state: string;
    message: string;
    xp: number;
    level: number;
  };
}
