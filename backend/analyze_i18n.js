const fs = require('fs');
const content = fs.readFileSync('backend/public/shared/i18n.js', 'utf8');
const lines = content.split('\n');

function extractKeys(startLine, endLine) {
  var keys = new Set();
  for (var i = startLine - 1; i < Math.min(endLine, lines.length); i++) {
    var line = lines[i];
    if (!line) continue;
    var idx = line.indexOf('": ');
    if (idx < 0) continue;
    var keyPart = line.substring(0, idx + 1).trim();
    if (keyPart.charAt(0) === '"' && keyPart.charAt(keyPart.length - 1) === '"') {
      keys.add(keyPart.slice(1, -1));
    }
  }
  return keys;
}

var langBounds = {
  en:     {start: 2,     end: 1475},
  zh:     {start: 1477,  end: 2946},
  'zh-CN':{start: 2948,  end: 4387},  // +160 inserted keys
  ja:     {start: 4389,  end: 5828},  // shifted +160, +166 inserted keys
  ko:     {start: 5830,  end: 7268},  // shifted +326, +166 inserted keys
  th:     {start: 7270,  end: 8708},  // shifted +492, +160 inserted keys
  vi:     {start: 8710,  end: 10148}, // shifted +652, +160 inserted keys
  id:     {start: 10150, end: 11588}  // shifted +812, +160 inserted keys
};

var enKeys = extractKeys(langBounds.en.start, langBounds.en.end);
console.log('EN total keys:', enKeys.size);

var langs = ['zh-CN', 'ja', 'ko', 'th', 'vi', 'id'];
langs.forEach(function(lang) {
  var b = langBounds[lang];
  var langKeys = extractKeys(b.start, b.end);
  var missing = [];
  enKeys.forEach(function(k) { if (!langKeys.has(k)) missing.push(k); });
  console.log('\n' + lang.toUpperCase() + ' missing ' + missing.length + ' keys:');
  var byPrefix = {};
  missing.forEach(function(k) {
    var prefix = k.split('_')[0];
    if (!byPrefix[prefix]) byPrefix[prefix] = [];
    byPrefix[prefix].push(k);
  });
  Object.keys(byPrefix).sort().forEach(function(prefix) {
    console.log('  [' + prefix + '] ' + byPrefix[prefix].length + ': ' + byPrefix[prefix].join(', '));
  });
});
