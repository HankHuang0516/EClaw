import { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { PaperProvider, MD3DarkTheme, MD3LightTheme } from 'react-native-paper';
import { useColorScheme, View, ActivityIndicator } from 'react-native';
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

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const theme = colorScheme === 'dark' ? MD3DarkTheme : MD3LightTheme;
  const { initialize, deviceId, authToken } = useAuthStore();

  // Initialize auth on startup
  useEffect(() => {
    initialize();
  }, []);

  // Connect Socket.IO and register for notifications when authenticated
  useEffect(() => {
    if (!deviceId && !authToken) return;

    socketService.connect();
    notificationService.registerForPushNotifications();

    return () => {
      socketService.disconnect();
    };
  }, [deviceId, authToken]);

  return (
    <SafeAreaProvider>
      <PaperProvider theme={theme}>
        <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
        <AuthGate>
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(auth)" options={{ headerShown: false }} />
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="chat/[entityId]" options={{ presentation: 'card' }} />
            <Stack.Screen name="entity-manager" options={{ presentation: 'modal' }} />
            <Stack.Screen name="file-manager" options={{ presentation: 'card' }} />
            <Stack.Screen name="ai-chat" options={{ presentation: 'card' }} />
            <Stack.Screen name="official-borrow" options={{ presentation: 'card' }} />
            <Stack.Screen name="feedback" options={{ presentation: 'card' }} />
            <Stack.Screen name="card-holder" options={{ presentation: 'card' }} />
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
