import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { PaperProvider, MD3DarkTheme, MD3LightTheme } from 'react-native-paper';
import { useColorScheme } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import '../i18n';
import { useAuthStore } from '../store/authStore';
import { socketService } from '../services/socketService';
import { notificationService } from '../services/notificationService';

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const theme = colorScheme === 'dark' ? MD3DarkTheme : MD3LightTheme;
  const { initialize, deviceId } = useAuthStore();

  // Initialize auth on startup
  useEffect(() => {
    initialize();
  }, []);

  // Connect Socket.IO and register for notifications when authenticated
  useEffect(() => {
    if (!deviceId) return;

    socketService.connect();
    notificationService.registerForPushNotifications();

    return () => {
      socketService.disconnect();
    };
  }, [deviceId]);

  return (
    <SafeAreaProvider>
      <PaperProvider theme={theme}>
        <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="chat/[entityId]" options={{ presentation: 'card' }} />
          <Stack.Screen name="entity-manager" options={{ presentation: 'modal' }} />
          <Stack.Screen name="schedule" options={{ presentation: 'card' }} />
          <Stack.Screen name="file-manager" options={{ presentation: 'card' }} />
          <Stack.Screen name="ai-chat" options={{ presentation: 'card' }} />
          <Stack.Screen name="official-borrow" options={{ presentation: 'card' }} />
          <Stack.Screen name="feedback" options={{ presentation: 'card' }} />
          <Stack.Screen name="card-holder" options={{ presentation: 'card' }} />
        </Stack>
      </PaperProvider>
    </SafeAreaProvider>
  );
}
