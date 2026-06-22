/**
 * Pure-logic tests for the iOS Settings "update-available" chip decision
 * (ios-app/services/updateChip.ts, card_1771f826).
 *
 * Mirrors the Android reference test:
 *   app/src/test/java/com/hank/clawlive/settings/UpdateChipDecisionTest.kt
 * No React Native / Expo deps — shouldShowChip is a pure module.
 */
import {
  shouldShowChip,
  APP_STORE_ID,
  appStoreDeepLink,
  appStoreHttpsLink,
} from '../updateChip';

describe('shouldShowChip', () => {
  describe('shows ONLY when backend-available AND latest strictly newer', () => {
    test('available + latest strictly newer -> show', () => {
      expect(shouldShowChip(true, '1.0.0', '1.1.0')).toBe(true);
      expect(shouldShowChip(true, '1.2.3', '2.0.0')).toBe(true);
      // suffix-tolerant (mirrors backend/Android comparator)
      expect(shouldShowChip(true, '1.0.0-debug', '1.0.1')).toBe(true);
    });
  });

  describe('hides on any not-confident signal (never a false prompt)', () => {
    test('available not true -> hide', () => {
      expect(shouldShowChip(false, '1.0.0', '2.0.0')).toBe(false);
      expect(shouldShowChip(null, '1.0.0', '2.0.0')).toBe(false);
      expect(shouldShowChip(undefined, '1.0.0', '2.0.0')).toBe(false);
    });

    test('latest equal or older than installed -> hide (clock skew / stale flag)', () => {
      expect(shouldShowChip(true, '2.0.0', '2.0.0')).toBe(false);
      expect(shouldShowChip(true, '2.0.0', '1.5.0')).toBe(false);
      // dotted-equality (1.0 == 1.0.0)
      expect(shouldShowChip(true, '1.0.0', '1.0')).toBe(false);
    });

    test('blank / missing version strings -> hide', () => {
      expect(shouldShowChip(true, '', '2.0.0')).toBe(false);
      expect(shouldShowChip(true, '1.0.0', '')).toBe(false);
      expect(shouldShowChip(true, '   ', '2.0.0')).toBe(false);
      expect(shouldShowChip(true, null, '2.0.0')).toBe(false);
      expect(shouldShowChip(true, '1.0.0', undefined)).toBe(false);
    });
  });
});

describe('App Store links', () => {
  test('APP_STORE_ID matches eas.json ascAppId', () => {
    expect(APP_STORE_ID).toBe('6762198865');
  });
  test('deep link uses itms-apps with the app id', () => {
    expect(appStoreDeepLink).toBe('itms-apps://apps.apple.com/app/id6762198865');
  });
  test('https fallback uses the app id', () => {
    expect(appStoreHttpsLink).toBe('https://apps.apple.com/app/id6762198865');
  });
});
