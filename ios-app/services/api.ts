import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import * as SecureStore from 'expo-secure-store';

const BASE_URL = 'https://eclawbot.com';

// Secure storage keys
export const STORAGE_KEYS = {
  DEVICE_ID: 'device_id',
  DEVICE_SECRET: 'device_secret',
} as const;

// Create base axios instance
const apiClient: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor: auto-inject deviceId + deviceSecret
apiClient.interceptors.request.use(async (config) => {
  const deviceId = await SecureStore.getItemAsync(STORAGE_KEYS.DEVICE_ID);
  const deviceSecret = await SecureStore.getItemAsync(STORAGE_KEYS.DEVICE_SECRET);

  if (deviceId && deviceSecret) {
    if (config.data && typeof config.data === 'object') {
      config.data = { ...config.data, deviceId, deviceSecret };
    } else if (config.method === 'get' || config.method === 'delete') {
      config.params = { ...config.params, deviceId, deviceSecret };
    }
  }

  return config;
});

// Response interceptor: unified error handling
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
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
  getEntities: (deviceId: string) =>
    apiClient.get('/api/entities', { params: { deviceId } }),

  /** Get single entity status */
  getStatus: (deviceId: string, entityIndex: number) =>
    apiClient.get('/api/status', { params: { deviceId, entityIndex } }),

  /** Rename an entity */
  renameEntity: (entityId: string, name: string) =>
    apiClient.put('/api/device/entity/name', { entityId, name }),

  /** Update entity avatar (base64 image) */
  updateAvatar: (entityId: string, avatarBase64: string) =>
    apiClient.put('/api/device/entity/avatar', { entityId, avatar: avatarBase64 }),

  /** Remove/unbind an entity */
  removeEntity: (entityId: string) =>
    apiClient.delete('/api/device/entity', { data: { entityId } }),

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

// ── Schedule APIs ────────────────────────────────────────────

export const scheduleApi = {
  list: () => apiClient.get('/api/schedules'),
  create: (schedule: object) => apiClient.post('/api/schedules', schedule),
  update: (id: string, schedule: object) => apiClient.put(`/api/schedules/${id}`, schedule),
  toggle: (id: string) => apiClient.patch(`/api/schedules/${id}/toggle`),
  delete: (id: string) => apiClient.delete(`/api/schedules/${id}`),
  getExecutions: (scheduleId?: string) =>
    apiClient.get('/api/schedule-executions', { params: { scheduleId } }),
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
  deviceLogin: (deviceId: string) =>
    apiClient.post('/auth/device-login', { deviceId }),
  bindEmail: (email: string, password: string) =>
    apiClient.post('/api/device/bind-email', { email, password }),
  setLanguage: (language: string) =>
    apiClient.patch('/auth/language', { language }),
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
  bindFree: (entityId: string) =>
    apiClient.post('/api/official-borrow/bind-free', { entityId }),
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
  recent: (limit = 20) =>
    apiClient.get('/api/contacts/recent', { params: { limit } }),
  chatHistoryByCode: (publicCode: string, limit = 30) =>
    apiClient.get('/api/chat/history-by-code', { params: { publicCode, limit } }),
};

// ── Misc APIs ────────────────────────────────────────────────

export const miscApi = {
  getVersion: () => apiClient.get('/api/version'),
  getFreeBotTos: () => apiClient.get('/api/free-bot-tos'),
  agreeFreeBotTos: () => apiClient.post('/api/free-bot-tos/agree'),
};

export default apiClient;
