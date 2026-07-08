import { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { PaperProvider, MD3DarkTheme, MD3LightTheme } from 'react-native-paper';
import { useColorScheme, View, ActivityIndicator, LogBox, AppState } from 'react-native';

// Silence dev warnings overlay so it doesn't cover the tab bar.
LogBox.ignoreAllLogs();

// In production, swallow uncaught JS errors so the full-screen red-box
// doesn't land on real users. Dev keeps the native handler so regressions
// stay visible. Replace the console.log with a telemetry call once the
// ios telemetry pipe lands — tracked in #1766.
if (!__DEV__) {
  const errorUtils = (global as unknown as { ErrorUtils?: { setGlobalHandler: (fn: (e: Error, isFatal?: boolean) => void) => void } }).ErrorUtils;
  if (errorUtils?.setGlobalHandler) {
    errorUtils.setGlobalHandler((e, isFatal) => {
      // eslint-disable-next-line no-console
      console.log('[prod-err]', isFatal ? 'fatal' : 'nonfatal', e?.message, e?.stack);
    });
  }
}
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import '../i18n';
import { useAuthStore } from '../store/authStore';
import { socketService } from '../services/socketService';
import { notificationService } from '../services/notificationService';

function AuthGate({ children }: { children: React.ReactNode }) {
  const { isInitialized, isAuthenticated } = useAuthStore();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!isInitialized) return;
    const authed = isAuthenticated();
    const inAuthGroup = segments[0] === '(auth)';

    if (!authed && !inAuthGroup) {
      router.replace('/(auth)/login');
    } else if (authed && inAuthGroup) {
      router.replace('/(tabs)');
    }
  }, [isInitialized, segments, router, isAuthenticated]);

  if (!isInitialized) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return <>{children}</>;
}

function isNeedsYouNotification(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as { category?: unknown; type?: unknown; metadata?: unknown };
  if (p.category === 'rich_card_question' || p.type === 'action_request') return true;
  if (p.metadata && typeof p.metadata === 'object') {
    return (p.metadata as { ownerDecision?: unknown }).ownerDecision === true;
  }
  return false;
}

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const theme = colorScheme === 'dark' ? MD3DarkTheme : MD3LightTheme;
  const { initialize, deviceId, deviceSecret } = useAuthStore();

  // Initialize auth on startup
  useEffect(() => {
    initialize();
  }, []);

  // Connect Socket.IO and register for notifications when authenticated
  useEffect(() => {
    if (!deviceId || !deviceSecret) return;

    socketService.connect();
    notificationService.registerForPushNotifications();
    notificationService.syncNeedsYouBadgeCount();

    const offActionRequest = socketService.on('action_request:changed', () => {
      notificationService.syncNeedsYouBadgeCount();
    });
    const offNotification = socketService.on('notification', (payload) => {
      if (isNeedsYouNotification(payload)) {
        notificationService.syncNeedsYouBadgeCount();
      }
    });
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        notificationService.syncNeedsYouBadgeCount();
      }
    });
    const badgeInterval = setInterval(() => {
      notificationService.syncNeedsYouBadgeCount();
    }, 5 * 60 * 1000);

    return () => {
      offActionRequest();
      offNotification();
      appStateSubscription.remove();
      clearInterval(badgeInterval);
      socketService.disconnect();
    };
  }, [deviceId, deviceSecret]);

  return (
    <SafeAreaProvider>
      <PaperProvider theme={theme}>
        <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
        <AuthGate>
          <Stack screenOptions={{ headerShown: true }}>
            <Stack.Screen name="(auth)" options={{ headerShown: false }} />
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="org-chart" options={{ presentation: 'modal' }} />
            <Stack.Screen name="file-manager" options={{ presentation: 'card' }} />
            <Stack.Screen name="ai-chat" options={{ presentation: 'card' }} />
            <Stack.Screen name="official-borrow" options={{ presentation: 'card' }} />
            <Stack.Screen name="feedback" options={{ presentation: 'card' }} />
            <Stack.Screen name="community" options={{ presentation: 'card' }} />
            <Stack.Screen name="wallet" options={{ presentation: 'card' }} />
            <Stack.Screen name="my-rentals" options={{ presentation: 'card' }} />
            <Stack.Screen name="invite" options={{ presentation: 'card' }} />
            <Stack.Screen name="bind-email" options={{ presentation: 'modal' }} />
          </Stack>
        </AuthGate>
      </PaperProvider>
    </SafeAreaProvider>
  );
}
