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
    const tok = params.get('authToken');
    if (did && !localStorage.getItem('deviceId')) {
      localStorage.setItem('deviceId', did);
    }
    if (ds && !localStorage.getItem('deviceSecret')) {
      localStorage.setItem('deviceSecret', ds);
    }
    if (tok) {
      try { localStorage.setItem('authToken', tok); } catch (_) {}
      try { document.cookie = 'eclaw_session=' + tok + '; path=/; SameSite=Lax; Secure'; } catch (_) {}
    }
    // Render a visible diag banner so we can confirm what the WebView sees
    // without needing Safari Web Inspector.
    var diag = {
      urlAuth: !!tok,
      urlDid: !!did,
      urlDs: !!ds,
      lsAuth: !!localStorage.getItem('authToken'),
      lsDid: !!localStorage.getItem('deviceId'),
      lsDs: !!localStorage.getItem('deviceSecret'),
      cookie: document.cookie.indexOf('eclaw_session=') !== -1
    };
    function renderDiag() {
      if (!document.body) { setTimeout(renderDiag, 50); return; }
      var bar = document.createElement('div');
      bar.id = '__eclaw_diag__';
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#222;color:#0f0;font:11px monospace;padding:6px 8px;white-space:pre-wrap;line-height:1.3;border-bottom:1px solid #0f0';
      bar.textContent = 'DIAG url=' + location.pathname +
        '\n  urlToken='+diag.urlAuth+' urlDid='+diag.urlDid+' urlDs='+diag.urlDs +
        '\n  lsToken='+diag.lsAuth+' lsDid='+diag.lsDid+' lsDs='+diag.lsDs +
        '\n  cookie_eclaw_session='+diag.cookie;
      document.body.insertBefore(bar, document.body.firstChild);
    }
    renderDiag();
  } catch(e) {
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'auth-diag-error', err: String(e) }));
    }
  }
})();
true;
`;

export default function WebViewScreen({ url }: WebViewScreenProps) {
  const { deviceId, deviceSecret, authToken } = useAuthStore();
  const webViewRef = useRef<WebView>(null);
  const [loading, setLoading] = useState(true);

  const sep = url.includes('?') ? '&' : '?';
  const qs: string[] = ['embed=1'];
  if (deviceId) qs.push(`deviceId=${encodeURIComponent(deviceId)}`);
  if (deviceSecret) qs.push(`deviceSecret=${encodeURIComponent(deviceSecret)}`);
  if (authToken) qs.push(`authToken=${encodeURIComponent(authToken)}`);
  const fullUrl = `${url}${sep}${qs.join('&')}`;

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
        webviewDebuggingEnabled={__DEV__}
        onLoadEnd={() => setLoading(false)}
        onMessage={(event) => {
          // Bridge console.log from WebView to RN logs (visible via Expo Go / Metro)
          try {
            const data = JSON.parse(event.nativeEvent.data);
            console.log('[WebView]', data);
          } catch { /* ignore */ }
        }}
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
