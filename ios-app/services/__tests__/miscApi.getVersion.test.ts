/**
 * Regression for card_1771f826 — the iOS Settings "update-available" chip never
 * triggered because `miscApi.getVersion()` called `/api/version` WITHOUT an
 * `appVersion` query param. The backend only returns the `update` block (and
 * thus `update.available`) when `?appVersion=` is present
 * (backend/index.js app.get('/api/version')), so `res.data.update` was always
 * undefined and `shouldShowChip` could never be true.
 *
 * This locks in that getVersion forwards the installed appVersion to the backend.
 */

// Mock axios so api.ts's `axios.create()` returns a stable stub instance we can
// assert against. The request interceptor never runs here (get is stubbed), so
// SecureStore is not exercised, but we mock it to keep the import graph clean.
const mockGet = jest.fn(() => Promise.resolve({ data: {} }));
const mockInstance = {
  get: mockGet,
  post: jest.fn(() => Promise.resolve({ data: {} })),
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

import { miscApi } from '../api';

describe('miscApi.getVersion (card_1771f826)', () => {
  beforeEach(() => {
    mockGet.mockClear();
  });

  test('forwards the installed appVersion so backend returns the update block', async () => {
    await miscApi.getVersion('1.0.0');
    expect(mockGet).toHaveBeenCalledWith('/api/version', {
      params: { appVersion: '1.0.0' },
    });
  });

  test('omits appVersion (undefined) when none is supplied — no false param', async () => {
    await miscApi.getVersion();
    expect(mockGet).toHaveBeenCalledWith('/api/version', {
      params: { appVersion: undefined },
    });
  });

  test('null installed version is normalised to undefined, not sent as "null"', async () => {
    await miscApi.getVersion(null);
    expect(mockGet).toHaveBeenCalledWith('/api/version', {
      params: { appVersion: undefined },
    });
  });
});
