import React from 'react';
import { SafeAreaView, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import WebViewScreen from '../components/WebViewScreen';

/**
 * Wallet screen — currently WebView wrapper to /portal/wallet.html
 *
 * TODO (P0): Replace with native UI + Apple IAP integration.
 *
 * IAP integration is tracked in docs/specs/ios-iap-spec.md. The native
 * wallet.tsx code using react-native-iap is preserved in git history at
 * commit e3b52225 — revert and update react-native-iap to v15+ (requires
 * react-native-nitro-modules) when ready to ship IAP.
 *
 * Until then, this WebView wrapper is used so the first TestFlight build
 * can validate Apple Sign-In without IAP blockers. Web Portal wallet page
 * routes any payment attempt to TapPay, which is fine for Android/Web but
 * MUST BE REPLACED before iOS App Store submission (Apple §3.1.1).
 *
 * App Store submission blocker: yes — see ios-iap-spec.md §6.3
 */
export default function WalletScreen() {
  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Wallet' }} />
      <WebViewScreen url="https://eclawbot.com/portal/wallet.html" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0D0D1A' },
});
