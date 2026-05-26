import React, { useEffect, useRef, useState } from 'react';
import { View, StyleSheet, ActivityIndicator, BackHandler } from 'react-native';
import { WebView } from 'react-native-webview';
import * as Linking from 'expo-linking';
import { router } from 'expo-router';
import { useAuthStore } from '../store/authStore';

interface WebViewScreenProps {
  url: string;
  tabId?: 'chat' | 'mission' | 'home' | 'cards' | 'settings';
}

// Short-term chrome-hide for #1770 — the full native rewrite is a separate
// roadmap item. This CSS closes the most jarring seams (portal navbar,
// light background, non-system fonts) when portal pages are hosted inside
// the iOS WebView. Scoped via html.eclaw-ios-chrome so it cannot leak to
// browser users.
const CHROME_HIDE_CSS = `
  html.eclaw-ios-chrome,
  html.eclaw-ios-chrome body {
    background-color: #0D0D1A !important;
    color: #E5E5EA !important;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif !important;
  }
  html.eclaw-ios-chrome .nav,
  html.eclaw-ios-chrome nav.nav,
  html.eclaw-ios-chrome header.nav,
  html.eclaw-ios-chrome .public-nav,
  html.eclaw-ios-chrome .page-nav,
  html.eclaw-ios-chrome .site-footer,
  html.eclaw-ios-chrome footer.footer {
    display: none !important;
  }
  html.eclaw-ios-chrome button,
  html.eclaw-ios-chrome .btn,
  html.eclaw-ios-chrome input[type="submit"] {
    accent-color: #7C3AED;
  }
`;

function buildInjectedJs(tabId?: string) {
  return `
(function() {
  try {
    // Block AI chat widget in app WebView (same as Android EClawAndroid UA check)
    window.__blockAiChatWidget = true;
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
    // Chrome-hide — tag root + inject CSS so portal pages visually align
    // with the native deep-purple container. Tracked in #1770.
    if (params.get('hideChrome') === '1') {
      try { document.documentElement.classList.add('eclaw-ios-chrome'); } catch (_) {}
      try {
        const style = document.createElement('style');
        style.setAttribute('data-eclaw-ios-chrome', '1');
        style.textContent = ${JSON.stringify(CHROME_HIDE_CSS)};
        (document.head || document.documentElement).appendChild(style);
      } catch (_) {}
    }
  } catch(e) {
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'auth-diag-error', err: String(e) }));
    }
  }
  try {
    window.EClawNativeNav = {
      navigate: function(intent) {
        if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'eclaw:navigate-tab', intent: intent || {} }));
          return true;
        }
        return false;
      }
    };
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'eclaw:webview-ready', tabId: ${JSON.stringify(tabId || null)}, href: String(window.location.href || '') }));
    }
  } catch (_) {}
})();
true;
`;
}

type NativeNavIntent = {
  targetTab?: 'chat' | 'mission';
  target?: 'thread' | 'message' | 'card' | 'quote';
  threadId?: string;
  messageId?: string;
  cardId?: string;
  quote?: { source?: string; title?: string; excerpt?: string; messageId?: string };
};

type RegisteredWebView = { ref: React.RefObject<WebView | null>; ready: boolean };

const registeredWebViews: Partial<Record<string, RegisteredWebView>> = {};
let pendingIntent: NativeNavIntent | null = null;
let pendingIntentTimer: ReturnType<typeof setTimeout> | null = null;

function routeForTab(tab: string) {
  return tab === 'chat' ? '/(tabs)/chat' : tab === 'mission' ? '/(tabs)/mission' : '/(tabs)';
}

function intentScript(intent: NativeNavIntent) {
  return `
    (function(){
      try {
        var intent = ${JSON.stringify(intent)};
        if (typeof window.eclawHandleNativeNavigateIntent === 'function') {
          window.eclawHandleNativeNavigateIntent(intent);
        } else if (intent.targetTab === 'chat' && (intent.messageId || (intent.quote && intent.quote.messageId))) {
          window.location.href = '/portal/chat.html?messageId=' + encodeURIComponent(intent.messageId || intent.quote.messageId);
        } else if (intent.targetTab === 'mission' && intent.cardId) {
          window.location.href = '/portal/kanban.html?card=' + encodeURIComponent(intent.cardId) + '#' + encodeURIComponent(intent.cardId);
        }
      } catch (e) { console.warn('[EClawNativeNav] consume failed', e); }
    })();
    true;
  `;
}

function deliverIntent(intent: NativeNavIntent) {
  const targetTab = intent.targetTab;
  if (!targetTab) return false;
  const entry = registeredWebViews[targetTab];
  if (!entry || !entry.ready || !entry.ref.current) return false;
  entry.ref.current.injectJavaScript(intentScript(intent));
  return true;
}

function queueIntent(intent: NativeNavIntent) {
  pendingIntent = intent; // last navigation wins; avoids stale multi-tap races
  if (pendingIntentTimer) clearTimeout(pendingIntentTimer);
  pendingIntentTimer = setTimeout(() => { pendingIntent = null; pendingIntentTimer = null; }, 15000);
}

function consumePendingIntent(tabId?: string) {
  if (!tabId || !pendingIntent || pendingIntent.targetTab !== tabId) return;
  if (deliverIntent(pendingIntent)) {
    pendingIntent = null;
    if (pendingIntentTimer) { clearTimeout(pendingIntentTimer); pendingIntentTimer = null; }
  }
}

function handleNativeNavigate(intent: NativeNavIntent) {
  if (!intent || !intent.targetTab) return;
  queueIntent(intent);
  router.navigate(routeForTab(intent.targetTab) as never);
  setTimeout(() => consumePendingIntent(intent.targetTab), 80);
}

export default function WebViewScreen({ url, tabId }: WebViewScreenProps) {
  const { deviceId, deviceSecret, authToken } = useAuthStore();
  const webViewRef = useRef<WebView>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!tabId) return;
    registeredWebViews[tabId] = { ref: webViewRef, ready: false };
    return () => {
      if (registeredWebViews[tabId]?.ref === webViewRef) delete registeredWebViews[tabId];
    };
  }, [tabId]);

  const sep = url.includes('?') ? '&' : '?';
  const qs: string[] = ['embed=1', 'hideChrome=1'];
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
        injectedJavaScript={buildInjectedJs(tabId)}
        javaScriptEnabled
        domStorageEnabled
        startInLoadingState
        allowsBackForwardNavigationGestures
        webviewDebuggingEnabled={__DEV__}
        onLoadEnd={() => {
          setLoading(false);
          if (tabId && registeredWebViews[tabId]) {
            registeredWebViews[tabId]!.ready = true;
            setTimeout(() => consumePendingIntent(tabId), 30);
          }
        }}
        onMessage={(event) => {
          // Bridge console.log from WebView to RN logs (visible via Expo Go / Metro)
          try {
            const data = JSON.parse(event.nativeEvent.data);
            console.log('[WebView]', data);
            if (data && data.type === 'eclaw:webview-ready' && tabId && registeredWebViews[tabId]) {
              // Handshake observed. The intent is consumed after onLoadEnd so
              // portal handlers (e.g. eclawHandleNativeNavigateIntent) are installed.
            }
            if (data && data.type === 'eclaw:navigate-tab') {
              handleNativeNavigate(data.intent || {});
            }
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
