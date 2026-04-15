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
          const u = request.url || '';
          // Allow internal WebView navigations (blank, data, intra-page anchors, OAuth iframes etc).
          // Only hand off to the system browser for http(s) URLs that are outside our own domain —
          // otherwise iOS throws "Unable to open URL: about:blank" on the WebView's own internal loads.
          if (u.startsWith('http://') || u.startsWith('https://')) {
            if (u.includes('eclawbot.com')) return true;
            Linking.openURL(u).catch(() => { /* swallow — URL may be unsupported */ });
            return false;
          }
          return true;
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
