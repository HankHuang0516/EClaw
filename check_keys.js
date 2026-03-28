const fs = require('fs');
const content = fs.readFileSync('backend/public/shared/i18n.js', 'utf8');

// Extract en block - find the block between en: { and the next language or closing
const enStart = content.indexOf('en:');
const afterEn = content.substring(enStart);
const enEndMatch = afterEn.match(/\n\s*\w+:/);
const enEndIdx = enEndMatch.index;
const enBlock = afterEn.substring(4, enEndIdx); // skip "en:"
const enKeyMatches = enBlock.match(/"([^"]+)":/g) || [];
const enKeys = [...new Set(enKeyMatches.map(k => k.replace(/:$/, '').replace(/"/g, '')))];

// Extract es block  
const esStart = content.indexOf('es:');
const afterEs = content.substring(esStart);
const esEndMatch = afterEs.match(/\n\s*\w+:/);
const esEndIdx = esEndMatch ? esEndMatch.index : afterEs.length;
const esBlock = afterEs.substring(4, esEndIdx); // skip "es:"
const esKeyMatches = esBlock.match(/"([^"]+)":/g) || [];
const esKeys = [...new Set(esKeyMatches.map(k => k.replace(/:$/, '').replace(/"/g, '')))];

console.log('EN total keys:', enKeys.length);
console.log('ES total keys:', esKeys.length);

const missing = enKeys.filter(k => !esKeys.includes(k));
console.log('Missing ES keys:', missing.length);
console.log('First 50 missing:', missing.slice(0, 50));

// Save missing keys to file for later use
fs.writeFileSync('missing_es_keys.txt', missing.join('\n'));
console.log('Saved missing keys to missing_es_keys.txt');
