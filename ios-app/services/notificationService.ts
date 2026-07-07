import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { actionRequestApi, deviceApi } from './api';

// Configure notification display behavior
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export interface PushNotificationPayload {
  type: 'bot_reply' | 'broadcast' | 'speak_to' | 'feedback_reply' | 'app_update' | 'action_request';
  entityId?: string;
  message?: string;
  title?: string;
}

class NotificationService {
  private expoPushToken: string | null = null;

  /** Request permission and register for push notifications */
  async registerForPushNotifications(): Promise<string | null> {
    if (!Device.isDevice) {
      console.log('[NOTIF] Physical device required for push notifications');
      return null;
    }

    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') {
      console.log('[NOTIF] Push notification permission denied');
      return null;
    }

    // Get APNs token for iOS
    if (Platform.OS === 'ios') {
      const apnsToken = await Notifications.getDevicePushTokenAsync();
      if (apnsToken.data) {
        await this.uploadToken(apnsToken.data, 'apns');
        return apnsToken.data;
      }
    }

    // Get Expo push token (cross-platform)
    try {
      const { data: token } = await Notifications.getExpoPushTokenAsync();
      this.expoPushToken = token;
      await this.uploadToken(token, 'fcm');
      console.log('[NOTIF] Push token registered:', token);
      return token;
    } catch (error) {
      console.error('[NOTIF] Failed to get push token:', error);
      return null;
    }
  }

  /** Upload token to backend */
  private async uploadToken(token: string, platform: 'fcm' | 'apns'): Promise<void> {
    try {
      await deviceApi.uploadPushToken(token, platform);
      console.log('[NOTIF] Token uploaded to backend:', platform);
    } catch (error) {
      console.error('[NOTIF] Failed to upload token:', error);
    }
  }

  /** Set up notification response handler (when user taps notification) */
  setNotificationResponseHandler(
    handler: (payload: PushNotificationPayload, notificationId: string) => void
  ): () => void {
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as unknown as PushNotificationPayload;
      const notificationId = response.notification.request.identifier;
      handler(data, notificationId);
    });

    return () => subscription.remove();
  }

  /** Set up foreground notification listener */
  setForegroundNotificationHandler(
    handler: (payload: PushNotificationPayload) => void
  ): () => void {
    const subscription = Notifications.addNotificationReceivedListener((notification) => {
      const data = notification.request.content.data as unknown as PushNotificationPayload;
      handler(data);
    });

    return () => subscription.remove();
  }

  /** Set app badge count */
  async setBadgeCount(count: number): Promise<void> {
    await Notifications.setBadgeCountAsync(count);
  }

  /** Sync launcher badge to the unresolved 需要你 inbox count. */
  async syncNeedsYouBadgeCount(): Promise<number | null> {
    try {
      const res = await actionRequestApi.getPendingCount();
      const raw = Number(res.data?.count ?? 0);
      const count = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
      await this.setBadgeCount(count);
      return count;
    } catch (error) {
      console.warn('[NOTIF] Failed to sync Needs-you badge count:', error);
      return null;
    }
  }

  /** Clear all notifications */
  async clearAllNotifications(): Promise<void> {
    await Notifications.dismissAllNotificationsAsync();
    await Notifications.setBadgeCountAsync(0);
  }
}

export const notificationService = new NotificationService();
export default notificationService;
