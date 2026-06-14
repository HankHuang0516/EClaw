import { io, Socket } from 'socket.io-client';
import * as SecureStore from 'expo-secure-store';
import { STORAGE_KEYS } from './api';

const SOCKET_URL = 'https://eclawbot.com';

// Socket event types (matching Android SocketManager)
export type SocketEvent =
  | 'entity:update'
  | 'chat:message'
  | 'notification'
  | 'screen:request'
  | 'control:command';

export interface ChatMessage {
  id: string;
  entityId: string;
  sender: 'user' | 'bot';
  content: string;
  timestamp: number;
  mediaUrl?: string;
  mediaType?: 'image' | 'audio' | 'video';
}

export interface EntityUpdate {
  entityId: string;
  name?: string;
  character?: string;
  state?: string;
  message?: string;
  // Passive health-check flag toggling on/off (drives avatar pulse + 健檢中 label).
  healthChecking?: boolean;
  healthCheckingAt?: number;
}

type EventCallback<T = unknown> = (data: T) => void;

class SocketService {
  private socket: Socket | null = null;
  private listeners: Map<string, Set<EventCallback>> = new Map();
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT = 5;

  async connect(): Promise<void> {
    if (this.socket?.connected) return;

    const deviceId = await SecureStore.getItemAsync(STORAGE_KEYS.DEVICE_ID);
    const deviceSecret = await SecureStore.getItemAsync(STORAGE_KEYS.DEVICE_SECRET);

    if (!deviceId || !deviceSecret) {
      console.warn('[SOCKET] Cannot connect: missing credentials');
      return;
    }

    this.socket = io(SOCKET_URL, {
      query: { deviceId, deviceSecret },
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: this.MAX_RECONNECT,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    this.socket.on('connect', () => {
      console.log('[SOCKET] Connected:', this.socket?.id);
      this.reconnectAttempts = 0;
    });

    this.socket.on('disconnect', (reason) => {
      console.log('[SOCKET] Disconnected:', reason);
    });

    this.socket.on('connect_error', (error) => {
      console.error('[SOCKET] Connection error:', error.message);
      this.reconnectAttempts++;
    });

    // Forward all domain events to registered listeners
    const domainEvents: SocketEvent[] = [
      'entity:update',
      'chat:message',
      'notification',
    ];

    domainEvents.forEach((event) => {
      this.socket!.on(event, (data: unknown) => {
        this.emit(event, data);
      });
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  /** Register a listener for a socket event */
  on<T = unknown>(event: SocketEvent, callback: EventCallback<T>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback as EventCallback);

    // Return unsubscribe function
    return () => {
      this.listeners.get(event)?.delete(callback as EventCallback);
    };
  }

  /** Emit event to local listeners (used internally) */
  private emit(event: string, data: unknown): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.forEach((cb) => cb(data));
    }
  }

}

// Singleton instance
export const socketService = new SocketService();
export default socketService;
