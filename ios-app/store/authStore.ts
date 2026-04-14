import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import { STORAGE_KEYS } from '../services/api';

export type AuthProvider = 'apple' | 'google' | 'facebook' | 'email' | 'device';

export interface AuthUser {
  id: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  provider: AuthProvider;
  subscriptionStatus?: string;
  googleLinked?: boolean;
  facebookLinked?: boolean;
  appleLinked?: boolean;
}

interface AuthState {
  // Device identity (always present after first launch)
  deviceId: string | null;
  deviceSecret: string | null;

  // User account (present after user login; null for pure device auth)
  authToken: string | null;
  user: AuthUser | null;

  // Meta
  isInitialized: boolean;
  language: string;

  // Actions
  initialize: () => Promise<void>;
  setDeviceCredentials: (deviceId: string, deviceSecret: string) => Promise<void>;
  setUserSession: (authToken: string, user: AuthUser) => Promise<void>;
  clearUserSession: () => Promise<void>;
  clearAll: () => Promise<void>;
  setLanguage: (lang: string) => void;

  // Computed
  isAuthenticated: () => boolean;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  deviceId: null,
  deviceSecret: null,
  authToken: null,
  user: null,
  isInitialized: false,
  language: 'system',

  initialize: async () => {
    const [deviceId, deviceSecret, authToken, userJson] = await Promise.all([
      SecureStore.getItemAsync(STORAGE_KEYS.DEVICE_ID),
      SecureStore.getItemAsync(STORAGE_KEYS.DEVICE_SECRET),
      SecureStore.getItemAsync(STORAGE_KEYS.AUTH_TOKEN),
      SecureStore.getItemAsync(STORAGE_KEYS.USER_PROFILE),
    ]);

    let user: AuthUser | null = null;
    if (userJson) {
      try {
        user = JSON.parse(userJson);
      } catch {
        // Corrupted user profile — ignore, user will need to re-login
      }
    }

    set({
      deviceId,
      deviceSecret,
      authToken,
      user,
      isInitialized: true,
    });
  },

  setDeviceCredentials: async (deviceId, deviceSecret) => {
    await SecureStore.setItemAsync(STORAGE_KEYS.DEVICE_ID, deviceId);
    await SecureStore.setItemAsync(STORAGE_KEYS.DEVICE_SECRET, deviceSecret);
    set({ deviceId, deviceSecret });
  },

  setUserSession: async (authToken, user) => {
    await SecureStore.setItemAsync(STORAGE_KEYS.AUTH_TOKEN, authToken);
    await SecureStore.setItemAsync(STORAGE_KEYS.USER_PROFILE, JSON.stringify(user));
    set({ authToken, user });
  },

  clearUserSession: async () => {
    await SecureStore.deleteItemAsync(STORAGE_KEYS.AUTH_TOKEN);
    await SecureStore.deleteItemAsync(STORAGE_KEYS.USER_PROFILE);
    set({ authToken: null, user: null });
    // deviceId + deviceSecret retained so next launch isn't a fresh device
  },

  clearAll: async () => {
    await Promise.all([
      SecureStore.deleteItemAsync(STORAGE_KEYS.AUTH_TOKEN),
      SecureStore.deleteItemAsync(STORAGE_KEYS.USER_PROFILE),
      SecureStore.deleteItemAsync(STORAGE_KEYS.DEVICE_ID),
      SecureStore.deleteItemAsync(STORAGE_KEYS.DEVICE_SECRET),
    ]);
    set({ deviceId: null, deviceSecret: null, authToken: null, user: null });
  },

  setLanguage: (lang) => set({ language: lang }),

  isAuthenticated: () => {
    const s = get();
    return !!(s.authToken || (s.deviceId && s.deviceSecret));
  },
}));
