const fs = require('fs');
const data = fs.readFileSync('backend/public/shared/i18n.js', 'utf8');

// Extract just the TRANSLATIONS object by evaluating the file
// The file defines TRANSLATIONS = { ... }; at top level
// We need to mock browser globals

const mock = {
  document: {
    addEventListener: () => {},
    createElement: () => ({ style: {}, appendChild: () => {}, setAttribute: () => {} }),
    getElementById: () => null,
    querySelector: () => null,
  },
  navigator: { language: 'en', userLanguage: 'en' },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  console
};

const fn = new Function('setTimeout', 'clearTimeout', data + '\nreturn TRANSLATIONS;');
const TRANSLATIONS = fn(mock.setTimeout, mock.clearTimeout);

const enKeys = Object.keys(TRANSLATIONS.en || {});
const zhCNKeys = Object.keys(TRANSLATIONS['zh-CN'] || {});
const esKeys = Object.keys(TRANSLATIONS['es'] || {});

const missingZHCN = enKeys.filter(k => !(k in (TRANSLATIONS['zh-CN'] || {})));
const missingES = enKeys.filter(k => !(k in (TRANSLATIONS['es'] || {})));

console.log('=== zh-CN missing keys (' + missingZHCN.length + ') ===');
console.log(missingZHCN.join('\n'));
console.log('\n=== es missing keys (' + missingES.length + ') ===');
console.log(missingES.join('\n'));