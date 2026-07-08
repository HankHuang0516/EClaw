/**
 * Needs-you badge sync: iOS launcher badge should mirror
 * GET /api/action-requests/pending-count while the app is active.
 */

const mockGet = jest.fn(() => Promise.resolve({ data: { success: true, count: 0 } }));
const mockInstance = {
  get: mockGet,
  post: jest.fn(() => Promise.resolve({ data: {} })),
  put: jest.fn(() => Promise.resolve({ data: {} })),
  patch: jest.fn(() => Promise.resolve({ data: {} })),
  delete: jest.fn(() => Promise.resolve({ data: {} })),
  interceptors: {
    request: { use: jest.fn() },
    response: { use: jest.fn() },
  },
};

jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn(() => mockInstance) },
  create: jest.fn(() => mockInstance),
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

const mockSetBadgeCountAsync = jest.fn(() => Promise.resolve(true));
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  setBadgeCountAsync: mockSetBadgeCountAsync,
  dismissAllNotificationsAsync: jest.fn(() => Promise.resolve()),
  getPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
  requestPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
  getDevicePushTokenAsync: jest.fn(() => Promise.resolve({ data: 'apns-token' })),
  getExpoPushTokenAsync: jest.fn(() => Promise.resolve({ data: 'expo-token' })),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
}));

jest.mock('expo-device', () => ({ isDevice: true }));
const mockSetPendingCount = jest.fn(() => Promise.resolve(true));
jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  NativeModules: {
    NeedsYouWidgetStore: {
      setPendingCount: mockSetPendingCount,
    },
  },
}));

import fs from 'fs';
import path from 'path';
import { actionRequestApi } from '../api';
import { notificationService } from '../notificationService';

describe('Needs-you pending badge sync', () => {
  beforeEach(() => {
    mockGet.mockClear();
    mockSetBadgeCountAsync.mockClear();
    mockSetPendingCount.mockClear();
  });

  test('actionRequestApi uses the pending-count endpoint', async () => {
    await actionRequestApi.getPendingCount();
    expect(mockGet).toHaveBeenCalledWith('/api/action-requests/pending-count');
  });

  test('syncNeedsYouBadgeCount writes the launcher badge count', async () => {
    mockGet.mockResolvedValueOnce({ data: { success: true, count: 7 } });
    await expect(notificationService.syncNeedsYouBadgeCount()).resolves.toBe(7);
    expect(mockSetBadgeCountAsync).toHaveBeenCalledWith(7);
    expect(mockSetPendingCount).toHaveBeenCalledWith(7);
  });

  test('syncNeedsYouBadgeCount clamps invalid counts to zero', async () => {
    mockGet.mockResolvedValueOnce({ data: { success: true, count: -4 } });
    await expect(notificationService.syncNeedsYouBadgeCount()).resolves.toBe(0);
    expect(mockSetBadgeCountAsync).toHaveBeenCalledWith(0);
    expect(mockSetPendingCount).toHaveBeenCalledWith(0);
  });

  test('RootLayout refreshes badge on socket, notification, foreground, and interval', () => {
    const root = fs.readFileSync(path.join(__dirname, '../../app/_layout.tsx'), 'utf8');
    expect(root).toContain('deviceSecret');
    expect(root).toContain('if (!deviceId || !deviceSecret) return;');
    expect(root).toContain("socketService.on('action_request:changed'");
    expect(root).toContain("socketService.on('notification'");
    expect(root).toContain("AppState.addEventListener('change'");
    expect(root).toContain('setInterval');
    expect(root).toContain('syncNeedsYouBadgeCount');
  });
});
