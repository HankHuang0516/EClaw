#!/usr/bin/env node
/**
 * i18n Gap Fill + Dedup - Optimized version
 * Uses regex-based extraction for performance
 */
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'backend/public/shared/i18n.js');
let content = fs.readFileSync(filePath, 'utf8');

console.log('File size:', content.length);

// === Parse locale blocks ===
const localeRegex = /(?:^|\n)\s+([a-z]{2}(?:-[A-Z]{2})?):\s*\{/gm;
const localeStarts = [];
let m;
while ((m = localeRegex.exec(content)) !== null) localeStarts.push({ name: m[1], pos: m.index });
localeStarts.push({ name: '__END__', pos: content.length });

console.log('Locales found:', localeStarts.slice(0, -1).map(l => l.name).join(', '));

// === Regex-based key extraction (depth-unaware) ===
function extractAllKeys(block) {
  const keys = new Set();
  const matches = block.matchAll(/"([^"]+)":\s*(?:"[^"]*"|\{[^}]*\}|\[[^\]]*\]|true|false|null|-?\d+(?:\.\d+)?)/g);
  for (const match of matches) {
    keys.add(match[1]);
  }
  return keys;
}

// === Extract key:value pairs (for gap fill values) ===
function extractKeyValues(block) {
  const pairs = {};
  const regex = /"([^"]+)":\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g;
  let match;
  while ((match = regex.exec(block)) !== null) {
    pairs[match[1]] = match[2];
  }
  return pairs;
}

// === Build locale block data ===
const localeBlocks = {};
for (let i = 0; i < localeStarts.length - 1; i++) {
  const loc = localeStarts[i].name;
  const bracePos = content.indexOf('{', localeStarts[i].pos + loc.length + 2);
  const blockStart = bracePos + 1;
  const blockEnd = localeStarts[i + 1].pos - 1;
  const block = content.substring(blockStart, blockEnd);
  localeBlocks[loc] = {
    blockStart,
    blockEnd,
    block,
    keys: extractAllKeys(block),
    kvPairs: extractKeyValues(block)
  };
}

const enKeys = localeBlocks.en.keys;
const enKV = localeBlocks.en.kvPairs;
console.log('EN keys:', enKeys.size, '| EN kvPairs:', Object.keys(enKV).length);

// === GAP FILL PHASE ===
console.log('\n=== GAP FILL PHASE ===');
const targetLocales = ['hi', 'ms', 'ko', 'ja', 'ar'];

for (const loc of targetLocales) {
  const lb = localeBlocks[loc];
  const missing = [...enKeys].filter(k => !lb.keys.has(k));
  
  console.log(loc + ': ' + missing.length + ' missing keys');
  
  if (missing.length > 0) {
    const insertionPoint = lb.blockEnd - 1;
    const newEntries = missing.map(key => '    "' + key + '": "' + (enKV[key] || '') + '"').join(',\n');
    const insertions = newEntries + ',\n';
    
    content = content.substring(0, insertionPoint) + insertions + content.substring(insertionPoint);
    
    // Update locale block
    const idx = localeStarts.findIndex(l => l.name === loc);
    const newBracePos = content.indexOf('{', localeStarts[idx].pos + loc.length + 2);
    const newBlockStart = newBracePos + 1;
    const newBlockEnd = localeStarts[idx + 1].pos - 1;
    const newBlock = content.substring(newBlockStart, newBlockEnd);
    localeBlocks[loc] = {
      blockStart: newBlockStart,
      blockEnd: newBlockEnd,
      block: newBlock,
      keys: extractAllKeys(newBlock),
      kvPairs: extractKeyValues(newBlock)
    };
  }
}

// === DEDUP PHASE ===
console.log('\n=== DEDUP PHASE ===');
const dedupLocales = ['zh', 'ja', 'ko', 'ar'];

for (const loc of dedupLocales) {
  const lb = localeBlocks[loc];
  
  // Count occurrences of each key
  const keyCount = {};
  const keyFirstOccurrence = {};
  
  // Find all key occurrences with their positions
  const keyOccurrenceRegex = /"([^"]+)":\s*(?:"[^"]*"|\{[^}]*\}|\[[^\]]*\]|true|false|null|-?\d+(?:\.\d+)?)/g;
  let match;
  let lastIndex = 0;
  
  // Use a manual scan approach
  let inStr = false, escape = false, prevWasColon = false;
  for (let i = 0; i < lb.block.length; i++) {
    const c = lb.block[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') {
      if (!inStr) {
        const keyStart = i + 1;
        let j = i + 1;
        while (j < lb.block.length && lb.block[j] !== '"') j++;
        const key = lb.block.substring(keyStart, j);
        let next = j + 1;
        while (next < lb.block.length && (lb.block[next] === ' ' || lb.block[next] === '\t')) next++;
        if (next < lb.block.length && lb.block[next] === ':' && !prevWasColon) {
          if (!keyCount[key]) {
            keyCount[key] = 0;
            keyFirstOccurrence[key] = lb.blockStart + i;
          }
          keyCount[key]++;
          prevWasColon = true;
        } else { prevWasColon = false; }
        i = j;
      }
      inStr = !inStr;
    } else if (!inStr) {
      if (c === ',') prevWasColon = false;
    }
  }
  
  const dups = Object.entries(keyCount).filter(([, count]) => count > 1);
  console.log(loc + ': ' + dups.length + ' duplicate keys, ' + dups.reduce((s, [, c]) => s + c - 1, 0) + ' extras');
  
  if (dups.length > 0 && dups.length <= 10) {
    dups.forEach(([key, count]) => console.log('  ' + key + ' x' + count));
  }
}

// === Save ===
fs.writeFileSync(filePath, content);
console.log('\n=== Saved ===');
console.log('New file size:', content.length);

// === Verification ===
console.log('\n=== Verification ===');
const updatedLocaleRegex = /(?:^|\n)\s+([a-z]{2}(?:-[A-Z]{2})?):\s*\{/gm;
const updatedLocaleStarts = [];
let um;
while ((um = updatedLocaleRegex.exec(content)) !== null) updatedLocaleStarts.push({ name: um[1], pos: um.index });
updatedLocaleStarts.push({ name: '__END__', pos: content.length });

const enBracePos = content.indexOf('{', updatedLocaleStarts[0].pos + 3);
const enBlockStart = enBracePos + 1;
const enBlockEnd = updatedLocaleStarts[1].pos - 1;
const enBlock = content.substring(enBlockStart, enBlockEnd);
const enKeySet = extractAllKeys(enBlock);

console.log('EN keys after changes:', enKeySet.size);
for (const loc of ['zh', 'ja', 'ko', 'th', 'vi', 'id', 'fr', 'es', 'de', 'ms', 'hi', 'ar']) {
  const idx = updatedLocaleStarts.findIndex(l => l.name === loc);
  if (idx < 0) continue;
  const bracePos = content.indexOf('{', updatedLocaleStarts[idx].pos + loc.length + 2);
  const blockStart = bracePos + 1;
  const blockEnd = updatedLocaleStarts[idx + 1].pos - 1;
  const block = content.substring(blockStart, blockEnd);
  const keys = extractAllKeys(block);
  const missing = [...enKeySet].filter(k => !keys.has(k));
  const extra = [...keys].filter(k => !enKeySet.has(k));
  console.log(loc + ': keys=' + keys.size + ' missing=' + missing.length + ' extra=' + extra.length);
}