import { create } from 'zustand';

export interface Entity {
  entityId: string;
  entityIndex: number;
  name: string;
  character: string;
  state: string;
  message: string;
  isBound: boolean;
  publicCode?: string;
  avatarUrl?: string;
  lastActive?: number;
  encryptionStatus?: 'e2ee' | 'transport' | null;
  // Fields for Android-parity entity card display
  xp?: number;
  level?: number;
  xpForNextLevel?: number;
  channelBound?: boolean;
  messageTime?: number; // timestamp ms of last message
  // True while the backend passive health-check/repair runs for this entity
  // (held visible >=4.5s). Drives the avatar pulse + 健檢中 label (Web parity).
  healthChecking?: boolean;
  healthCheckingAt?: number; // epoch ms the health-check flag was set (server-provided)
}

interface EntityState {
  entities: Entity[];
  isLoading: boolean;
  lastUpdated: number | null;
  bindingCodes: Record<number, string>; // entityIndex -> binding code

  // Actions
  setEntities: (entities: Entity[]) => void;
  updateEntity: (entityId: string, updates: Partial<Entity>) => void;
  setLoading: (loading: boolean) => void;
  setBindingCode: (entityIndex: number, code: string) => void;
  clearBindingCode: (entityIndex: number) => void;
  removeEntity: (entityId: string) => void;
}

export const useEntityStore = create<EntityState>((set) => ({
  entities: [],
  isLoading: false,
  lastUpdated: null,
  bindingCodes: {},

  setEntities: (entities) =>
    set({ entities, lastUpdated: Date.now() }),

  updateEntity: (entityId, updates) =>
    set((state) => ({
      entities: state.entities.map((e) =>
        e.entityId === entityId ? { ...e, ...updates } : e
      ),
    })),

  setLoading: (isLoading) => set({ isLoading }),

  setBindingCode: (entityIndex, code) =>
    set((state) => ({
      bindingCodes: { ...state.bindingCodes, [entityIndex]: code },
    })),

  clearBindingCode: (entityIndex) =>
    set((state) => {
      const codes = { ...state.bindingCodes };
      delete codes[entityIndex];
      return { bindingCodes: codes };
    }),

  removeEntity: (entityId) =>
    set((state) => ({
      entities: state.entities.filter((e) => e.entityId !== entityId),
    })),
}));
