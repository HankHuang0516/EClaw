import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import * as SecureStore from 'expo-secure-store';

const BASE_URL = 'https://eclawbot.com';

// Secure storage keys
export const STORAGE_KEYS = {
  DEVICE_ID: 'device_id',
  DEVICE_SECRET: 'device_secret',
  AUTH_TOKEN: 'auth_token',
  USER_PROFILE: 'user_profile',
} as const;

// Create base axios instance
const apiClient: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor:
//   1. If authToken present → Authorization: Bearer header
//   2. Always inject deviceId + deviceSecret (bot API handlers still need them)
apiClient.interceptors.request.use(async (config) => {
  const [authToken, deviceId, deviceSecret] = await Promise.all([
    SecureStore.getItemAsync(STORAGE_KEYS.AUTH_TOKEN),
    SecureStore.getItemAsync(STORAGE_KEYS.DEVICE_ID),
    SecureStore.getItemAsync(STORAGE_KEYS.DEVICE_SECRET),
  ]);

  if (authToken) {
    config.headers = config.headers ?? {};
    (config.headers as any).Authorization = `Bearer ${authToken}`;
  }

  if (deviceId && deviceSecret) {
    if (config.data && typeof config.data === 'object' && !(config.data instanceof FormData)) {
      config.data = { ...config.data, deviceId, deviceSecret };
    } else if (config.method === 'get' || config.method === 'delete') {
      config.params = { ...config.params, deviceId, deviceSecret };
    }
  }

  return config;
});

// Response interceptor: unified error handling + 401 token refresh hint
apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    // 401 with authToken → token expired, clear it so app re-auths
    if (error.response?.status === 401) {
      const hasToken = await SecureStore.getItemAsync(STORAGE_KEYS.AUTH_TOKEN);
      if (hasToken && !error.config?.url?.includes('/api/auth/')) {
        // Non-auth endpoint returned 401 with a token → token is stale
        await SecureStore.deleteItemAsync(STORAGE_KEYS.AUTH_TOKEN);
        await SecureStore.deleteItemAsync(STORAGE_KEYS.USER_PROFILE);
        // Caller should detect and redirect to login
      }
    }
    const message = error.response?.data?.error || error.message || 'Unknown error';
    return Promise.reject(new Error(message));
  }
);

// ── Device & Entity APIs ──────────────────────────────────────

export const deviceApi = {
  /** Register a new entity slot, get 6-digit binding code */
  register: (entityIndex: number) =>
    apiClient.post('/api/device/register', { entityIndex }),

  /** Get all bound entities for this device */
  getEntities: (deviceId: string, deviceSecret: string) =>
    apiClient.get('/api/entities', { params: { deviceId, deviceSecret } }),

  /** Get single entity status */
  getStatus: (deviceId: string, deviceSecret: string, entityIndex: number) =>
    apiClient.get('/api/status', { params: { deviceId, deviceSecret, entityIndex } }),

  /** Rename an entity */
  renameEntity: (entityId: string, name: string) =>
    apiClient.put('/api/device/entity/name', { entityId, name }),

  /** Update entity avatar (emoji string or URL) */
  updateAvatar: (entityId: string, avatar: string) =>
    apiClient.put('/api/device/entity/avatar', { entityId, avatar }),

  /** Upload photo as entity avatar (stored on Flickr) */
  uploadAvatar: (entityId: string, imageUri: string) => {
    const formData = new FormData();
    formData.append('file', {
      uri: imageUri,
      type: 'image/jpeg',
      name: 'avatar.jpg',
    } as any);
    formData.append('entityId', entityId);
    return apiClient.post('/api/device/entity/avatar/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },

  /** Add a new entity slot (dynamic entity system) */
  addEntity: () =>
    apiClient.post('/api/device/add-entity', {}),

  /** Permanently delete an entity slot */
  deleteEntityPermanent: (entityId: number) =>
    apiClient.delete(`/api/device/entity/${entityId}/permanent`, {}),

  /** Reorder entities */
  reorderEntities: (order: number[]) =>
    apiClient.post('/api/device/reorder-entities', { order }),

  /** Upload FCM/APNs token */
  uploadPushToken: (token: string, platform: 'fcm' | 'apns') =>
    apiClient.post('/api/device/fcm-token', { token, platform }),

  /** Get A2A Agent Card for an entity */
  getAgentCard: (entityId: string) =>
    apiClient.get('/api/entity/agent-card', { params: { entityId } }),

  /** Create or update Agent Card */
  updateAgentCard: (entityId: string, agentCard: object) =>
    apiClient.put('/api/entity/agent-card', { entityId, agentCard }),

  /** Delete Agent Card */
  deleteAgentCard: (entityId: string) =>
    apiClient.delete('/api/entity/agent-card', { data: { entityId } }),

  /** Refresh entity connection (test webhook) */
  refreshEntity: (entityId: string) =>
    apiClient.post(`/api/device/entity/${entityId}/refresh`, {}),
};

// ── Chat APIs ────────────────────────────────────────────────

export const chatApi = {
  /** Send message to entity (or broadcast) */
  speak: (params: {
    entityId?: string;
    message: string;
    broadcast?: boolean;
    mediaUrl?: string;
    mediaType?: 'image' | 'audio' | 'video';
  }) => apiClient.post('/api/client/speak', params),

  /** Get chat history (paginated) */
  getHistory: (entityId: string, params?: { before?: string; limit?: number }) =>
    apiClient.get('/api/chat/history', { params: { entityId, ...params } }),

  /** Upload media file (multipart) */
  uploadMedia: (entityId: string, formData: FormData) =>
    apiClient.post('/api/chat/upload-media', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      params: { entityId },
    } as AxiosRequestConfig),

  /** Get link preview */
  getLinkPreview: (url: string) =>
    apiClient.get('/api/link-preview', { params: { url } }),
};

// ── Mission Control APIs ─────────────────────────────────────

export const missionApi = {
  /** Get full dashboard data */
  getDashboard: (entityId: string) =>
    apiClient.get('/api/device/dashboard', { params: { entityId } }),

  /** Save dashboard (full replace) */
  saveDashboard: (entityId: string, dashboard: object, version: number) =>
    apiClient.post('/api/device/dashboard', { entityId, dashboard, version }),

  /** Sync local variables */
  syncLocalVars: (entityId: string, vars: Record<string, string>) =>
    apiClient.post('/api/device/sync-local-vars', { entityId, vars }),
};

// ── Template APIs ─────────────────────────────────────────────

export interface TemplateRequiredVar {
  key: string;
  hint?: string;
  description?: string;
}

export interface SkillTemplate {
  id: string;
  label: string;
  icon?: string;
  title?: string;
  url?: string;
  author?: string;
  updatedAt?: string;
  requiredVars: TemplateRequiredVar[];
  steps?: string;
}

export interface SoulTemplate {
  id: string;
  label: string;
  icon?: string;
  name?: string;
  description?: string;
  author?: string;
  updatedAt?: string;
}

export interface RuleTemplate {
  id: string;
  label: string;
  icon?: string;
  name?: string;
  description?: string;
  ruleType?: string;
  author?: string;
  updatedAt?: string;
}

export const templateApi = {
  getSkillTemplates: () =>
    apiClient.get<{ success: boolean; templates: SkillTemplate[] }>('/api/skill-templates'),

  getSoulTemplates: () =>
    apiClient.get<{ success: boolean; templates: SoulTemplate[] }>('/api/soul-templates'),

  getRuleTemplates: () =>
    apiClient.get<{ success: boolean; templates: RuleTemplate[] }>('/api/rule-templates'),
};

// ── File Manager APIs ────────────────────────────────────────

export const fileApi = {
  list: (params?: { type?: 'image' | 'audio'; since?: string; page?: number }) =>
    apiClient.get('/api/device/files', { params }),
  download: (fileId: string) =>
    apiClient.get(`/api/chat/file/${fileId}`, { responseType: 'blob' }),
  delete: (fileId: string) =>
    apiClient.delete(`/api/device/files/${fileId}`),
};

// ── Feedback APIs ────────────────────────────────────────────

export const feedbackApi = {
  submit: (type: string, content: string, logs?: string) =>
    apiClient.post('/api/feedback', { type, content, logs }),
  uploadPhotos: (feedbackId: string, formData: FormData) =>
    apiClient.post(`/api/feedback/${feedbackId}/photos`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    } as AxiosRequestConfig),
  list: () => apiClient.get('/api/feedback'),
  getDetail: (feedbackId: string) => apiClient.get(`/api/feedback/${feedbackId}`),
};

// ── Auth APIs ────────────────────────────────────────────────

export const authApi = {
  /** Email + password login */
  login: (email: string, password: string) =>
    apiClient.post('/api/auth/login', { email, password }),

  /** Register new account with email + password */
  register: (email: string, password: string, displayName?: string, signupSource = 'ios_app') =>
    apiClient.post('/api/auth/register', { email, password, displayName, signupSource }),

  /** Login with device credentials (returns JWT) */
  deviceLogin: (deviceId: string, deviceSecret: string) =>
    apiClient.post('/api/auth/device-login', { deviceId, deviceSecret }),

  /** Forgot password — sends reset email */
  forgotPassword: (email: string) =>
    apiClient.post('/api/auth/forgot-password', { email }),

  /** Reset password with token from email */
  resetPassword: (token: string, newPassword: string) =>
    apiClient.post('/api/auth/reset-password', { token, newPassword }),

  /** Bind email to current device account */
  bindEmail: (email: string, password: string) =>
    apiClient.post('/api/auth/bind-email', { email, password }),

  /** Get current user profile (validates JWT) */
  me: () => apiClient.get('/api/auth/me'),

  /** Logout — invalidates JWT on server */
  logout: () => apiClient.post('/api/auth/logout'),

  /** Permanently delete account */
  deleteAccount: () => apiClient.delete('/api/auth/account'),

  /** OAuth: Sign in with Apple */
  oauthApple: (params: {
    identityToken: string;
    authorizationCode?: string;
    fullName?: { givenName?: string | null; familyName?: string | null };
    email?: string;
    deviceId?: string;
    deviceSecret?: string;
  }) => apiClient.post('/api/auth/oauth/apple', params),

  /** OAuth: Google */
  oauthGoogle: (params: {
    idToken?: string;
    accessToken?: string;
    deviceId?: string;
    deviceSecret?: string;
  }) => apiClient.post('/api/auth/oauth/google', params),

  /** OAuth: Facebook */
  oauthFacebook: (params: {
    accessToken: string;
    deviceId?: string;
    deviceSecret?: string;
  }) => apiClient.post('/api/auth/oauth/facebook', params),

  /** Get OAuth config (client IDs) */
  oauthConfig: () => apiClient.get('/api/auth/oauth/config'),

  /** Change app language */
  setLanguage: (language: string) =>
    apiClient.patch('/api/auth/language', { language }),
};

// ── Notification APIs ────────────────────────────────────────

export const notificationApi = {
  list: (params?: { page?: number }) =>
    apiClient.get('/api/notifications', { params }),
  getCount: () => apiClient.get('/api/notifications/count'),
  markRead: (notificationId: string) =>
    apiClient.post('/api/notifications/read', { notificationId }),
  markAllRead: () => apiClient.post('/api/notifications/read-all'),
  getPreferences: () => apiClient.get('/api/notification-preferences'),
  updatePreferences: (prefs: object) =>
    apiClient.put('/api/notification-preferences', prefs),
};

// ── Subscription APIs ────────────────────────────────────────

export const subscriptionApi = {
  getStatus: () => apiClient.get('/api/subscription/status'),
  verifyAppleIAP: (receiptData: string, productId: string) =>
    apiClient.post('/api/subscription/verify-apple', { receiptData, productId }),
  cancel: () => apiClient.post('/api/subscription/cancel'),
};

// ── Official Bot Borrow APIs ─────────────────────────────────

export const officialBorrowApi = {
  getStatus: () => apiClient.get('/api/official-borrow/status'),
  getFreeBots: () => apiClient.get('/api/official-borrow/free-bots'),
  bindFree: (entityId: string, botId?: string) =>
    apiClient.post('/api/official-borrow/bind-free', { entityId, ...(botId ? { botId } : {}) }),
  bindPersonal: (entityId: string, receiptData?: string) =>
    apiClient.post('/api/official-borrow/bind-personal', { entityId, receiptData }),
  unbind: (entityId: string) =>
    apiClient.post('/api/official-borrow/unbind', { entityId }),
};

// ── AI Support APIs ──────────────────────────────────────────

export const aiSupportApi = {
  chat: (message: string, history: object[], images?: string[]) =>
    apiClient.post('/api/ai-support/admin-chat', { message, history, images }),
  submitAsync: (message: string, history: object[]) =>
    apiClient.post('/api/ai-support/chat/submit', { message, history }),
  pollResult: (requestId: string) =>
    apiClient.get(`/api/ai-support/chat/poll/${requestId}`),
};

// ── Device Vars (JIT) APIs ───────────────────────────────────

export const deviceVarsApi = {
  request: (varKeys: string[]) =>
    apiClient.post('/api/device-vars', { varKeys }),
  approve: (requestId: string, approved: boolean) =>
    apiClient.post('/api/device-vars/approve', { requestId, approved }),
};

// ── Card Holder APIs (replaces Contacts) ────────────────────

export const contactsApi = {
  list: (params?: { pinned?: boolean; category?: string; limit?: number; offset?: number; includeBlocked?: boolean }) =>
    apiClient.get('/api/contacts', { params }),
  add: (publicCode: string) =>
    apiClient.post('/api/contacts', { publicCode }),
  remove: (publicCode: string) =>
    apiClient.delete('/api/contacts', { data: { publicCode } }),
  getDetail: (publicCode: string) =>
    apiClient.get(`/api/contacts/${publicCode}`),
  update: (publicCode: string, data: { notes?: string; pinned?: boolean; category?: string | null; blocked?: boolean }) =>
    apiClient.patch(`/api/contacts/${publicCode}`, data),
  refresh: (publicCode: string) =>
    apiClient.post(`/api/contacts/${publicCode}/refresh`),
  search: (q: string) =>
    apiClient.get('/api/contacts/search', { params: { q } }),
  crossSpeak: (toPublicCode: string, message: string) =>
    apiClient.post('/api/client/cross-speak', { toPublicCode, message }),
  myCards: () =>
    apiClient.get('/api/contacts/my-cards'),
  publishPlaza: (entityId: number, isPublic: boolean) =>
    apiClient.post('/api/community/publish', { entityId, public: isPublic }),
  recent: (limit = 20) =>
    apiClient.get('/api/contacts/recent', { params: { limit } }),
  chatHistoryByCode: (publicCode: string, limit = 30) =>
    apiClient.get('/api/chat/history-by-code', { params: { publicCode, limit } }),
};

// ── Settings Manifest (auto-sync seam, Stage 2) ──────────────
// Public GET — pure capability descriptor, no auth (mirrors /api/version).
// Sending appVersion + platform lets the backend apply the minAppVersion gate.
// See backend/lib/settings-manifest.js + docs/specs/settings-manifest-spec.md and
// the Android ClawApiService.getSettingsManifest reference.

import type { SettingsManifestResponse } from './settingsManifest';

export const settingsManifestApi = {
  /** Fetch the settings manifest at launch (Stage 2 consume). */
  get: (appVersion?: string | null, platform: 'ios' | 'android' = 'ios') =>
    apiClient.get<SettingsManifestResponse>('/api/settings-manifest', {
      params: { appVersion: appVersion ?? undefined, platform },
    }),
};

// ── Misc APIs ────────────────────────────────────────────────

export const miscApi = {
  // Pass the installed appVersion so the backend returns the `update` block.
  // /api/version only computes `update.available` when `?appVersion=` is present
  // (backend/index.js app.get('/api/version')); without it res.data.update is
  // undefined and the Settings update-chip can never trigger (card_1771f826).
  getVersion: (appVersion?: string | null) =>
    apiClient.get('/api/version', { params: { appVersion: appVersion ?? undefined } }),
  getFreeBotTos: () => apiClient.get('/api/free-bot-tos'),
  agreeFreeBotTos: () => apiClient.post('/api/free-bot-tos/agree'),
};

export default apiClient;
