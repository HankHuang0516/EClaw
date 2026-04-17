import React, { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import WebViewScreen from '../components/WebViewScreen';
import { useAuthStore } from '../store/authStore';

export default function OrgChartScreen() {
  const { t } = useTranslation();
  const { deviceId, deviceSecret } = useAuthStore();

  const url = useMemo(() => {
    const base = 'https://eclawbot.com/portal/dashboard.html?embed=1&view=orgchart';
    if (deviceId && deviceSecret) {
      return `${base}&deviceId=${encodeURIComponent(deviceId)}&deviceSecret=${encodeURIComponent(deviceSecret)}`;
    }
    return base;
  }, [deviceId, deviceSecret]);

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <Stack.Screen options={{ title: t('home.org_chart') }} />
      <WebViewScreen url={url} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0D0D1A' },
});
