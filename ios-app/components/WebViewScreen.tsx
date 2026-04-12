import React, { useRef, useState } from 'react';
import { View, StyleSheet, ActivityIndicator, BackHandler } from 'react-native';
import { WebView } from 'react-native-webview';
import * as Linking from 'expo-linking';
import { useAuthStore } from '../store/authStore';

interface WebViewScreenProps {
  url: string;
}

const INJECTED_JS = `
(function() {
  try {
    const params = new URLSearchParams(window.location.search);
    const did = params.get('deviceId');
    const ds  = params.get('deviceSecret');
    if (did && !localStorage.getItem('deviceId')) {
      localStorage.setItem('deviceId', did);
    }
    if (ds && !localStorage.getItem('deviceSecret')) {
      localStorage.setItem('deviceSecret', ds);
    }
  } catch(e) {}
})();
true;
`;

export default function WebViewScreen({ url }: WebViewScreenProps) {
  const { deviceId, deviceSecret } = useAuthStore();
  const webViewRef = useRef<WebView>(null);
  const [loading, setLoading] = useState(true);

  const sep = url.includes('?') ? '&' : '?';
  const fullUrl =
    deviceId && deviceSecret
      ? `${url}${sep}deviceId=${encodeURIComponent(deviceId)}&deviceSecret=${encodeURIComponent(deviceSecret)}&embed=1`
      : `${url}${sep}embed=1`;

  return (
    <View style={styles.container}>
      <WebView
        ref={webViewRef}
        source={{ uri: fullUrl }}
        style={styles.webview}
        injectedJavaScript={INJECTED_JS}
        javaScriptEnabled
        domStorageEnabled
        startInLoadingState
        allowsBackForwardNavigationGestures
        onLoadEnd={() => setLoading(false)}
        userAgent="Mozilla/5.0 EClawIOS"
        onShouldStartLoadWithRequest={(request) => {
          if (request.url.includes('eclawbot.com')) return true;
          Linking.openURL(request.url);
          return false;
        }}
      />
      {loading && (
        <View style={styles.loader}>
          <ActivityIndicator size="large" color="#7C3AED" />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0D0D1A',
  },
  webview: {
    flex: 1,
    backgroundColor: '#0D0D1A',
  },
  loader: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0D0D1A',
  },
});
