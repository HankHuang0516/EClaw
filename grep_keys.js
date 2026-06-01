const fs = require('fs');
const data = fs.readFileSync('backend/public/shared/i18n.js', 'utf8');

// Count occurrences of key patterns in each locale block
// We'll use a simple regex to extract keys from each locale

const locales = ['en', 'zh-CN', 'es'];
const results = {};

for (const loc of locales) {
  // Find the block for this locale
  const regex = new RegExp(loc + ':\\s*\\{([\\s\\S]+?)^\\s*\\}', 'm');
  const match = data.match(regex);
  if (!match) {
    results[loc] = { keys: [], count: 0 };
    continue;
  }
  
  // Extract all "key": "value" pairs
  const keyRegex = /"([^"]+)":\s*"([^"]*)"/g;
  const keys = [];
  let m;
  while ((m = keyRegex.exec(match[1])) !== null) {
    keys.push(m[1]);
  }
  results[loc] = { keys, count: keys.length };
}

console.log('Key counts:');
for (const [loc, data] of Object.entries(results)) {
  console.log(`  ${loc}: ${data.count} keys`);
}

// Find missing keys by comparing en vs others
const enKeys = new Set(results.en.keys);
for (const loc of ['zh-CN', 'es']) {
  const present = new Set(results[loc].keys);
  const missing = [...enKeys].filter(k => !present.has(k));
  console.log(`\n${loc} missing ${missing.length} keys:`);
  console.log(missing.join('\n'));
}