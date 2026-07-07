import { NativeModules, Platform } from 'react-native';

type NeedsYouWidgetStoreModule = {
  setPendingCount?: (count: number) => Promise<boolean>;
};

const nativeModule = NativeModules.NeedsYouWidgetStore as NeedsYouWidgetStoreModule | undefined;

export async function syncNeedsYouWidgetCount(count: number): Promise<boolean> {
  if (Platform.OS !== 'ios' || !nativeModule?.setPendingCount) {
    return false;
  }

  const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  await nativeModule.setPendingCount(safeCount);
  return true;
}
