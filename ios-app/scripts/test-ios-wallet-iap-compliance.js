#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const walletPath = path.join(appRoot, 'app', 'wallet.tsx');
const settingsPath = path.join(appRoot, 'app', '(tabs)', 'settings.tsx');

const walletSource = fs.readFileSync(walletPath, 'utf8');
const settingsSource = fs.readFileSync(settingsPath, 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(`[ios-wallet-iap-compliance] ${message}`);
    process.exitCode = 1;
  }
}

assert(
  !/WebViewScreen/.test(walletSource),
  'wallet.tsx must not render WebViewScreen as an IAP fallback.'
);

assert(
  !/portal\/wallet\.html/.test(walletSource),
  'wallet.tsx must not navigate to the web wallet, which exposes non-Apple top-up UI.'
);

assert(
  !/params:\s*\{\s*url:/.test(walletSource),
  'wallet.tsx transaction history must stay native instead of routing to a web URL.'
);

assert(
  /router\.push\(['"]\/wallet['"]\)/.test(settingsSource),
  'Settings Upgrade must open the native wallet screen.'
);

assert(
  !/settings\.upgrade[\s\S]{0,180}onPress=\{\(\)\s*=>\s*\{\s*\}\}/.test(settingsSource),
  'Settings Upgrade must not use an empty onPress handler.'
);

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log('[ios-wallet-iap-compliance] ok');
