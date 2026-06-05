const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function forbid(source, needle, message) {
  assert(!source.includes(needle), message);
}

function requireText(source, needle, message) {
  assert(source.includes(needle), message);
}

const wallet = read('app/wallet.tsx');
const webViewScreen = read('components/WebViewScreen.tsx');
const settings = read('app/(tabs)/settings.tsx');
const appJson = JSON.parse(read('app.json'));

forbid(
  wallet,
  "import WebViewScreen from '../components/WebViewScreen'",
  'iOS wallet must not import WebViewScreen as a payment fallback.'
);
forbid(
  wallet,
  'https://eclawbot.com/portal/wallet.html',
  'iOS wallet must not navigate to the web wallet, which exposes non-IAP payment UI.'
);
requireText(
  wallet,
  '/api/wallet/topup/verify-apple',
  'iOS wallet must keep Apple IAP receipt verification wired to the backend.'
);
requireText(
  wallet,
  'iap_unavailable_desc',
  'iOS wallet must show an IAP-unavailable state instead of falling back to web checkout.'
);

requireText(
  webViewScreen,
  "parsed.pathname === '/portal/wallet.html'",
  'Shared WebView must intercept portal wallet links.'
);
requireText(
  webViewScreen,
  "return '/wallet'",
  'Shared WebView must route portal wallet links to the native IAP wallet screen.'
);

forbid(
  settings,
  "t('settings.upgrade')",
  'Settings must not show a paid upgrade CTA until the iOS subscription flow uses Apple IAP.'
);

assert(
  Number(appJson.expo?.ios?.buildNumber || 0) >= 11,
  'iOS buildNumber must stay above rejected App Store Connect build 10.'
);

console.log('iOS IAP compliance checks passed.');
