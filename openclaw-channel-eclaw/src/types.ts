/** E-Claw account configuration from OpenClaw config.yaml */
export interface EClawAccountConfig {
  enabled: boolean;
  apiKey: string;
  apiSecret: string;
  apiBase: string;
  entityId: number;
  botName?: string;
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
  entityId: number;
  botSecret: string;
  publicCode: string;
  bindingType: string;
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
