#!/usr/bin/env node
/**
 * i18n Gap Fill + Dedup Script
 * 
 * State: clean HEAD file
 * Gap analysis:
 *   en: 5102 keys (verified with grep)
 *   zh: 2726 keys (missing ~2376)
 *   ja: 1756 keys (missing ~3346)
 *   etc.
 *
 * Strategy:
 *   1. Extract actual en keys (fix extraction bug in check_i18n.js)
 *   2. For each locale, find missing keys (exist in en but not in locale)
 *   3. For each locale, find orphan keys (exist in locale but not in en)
 *   4. Add missing keys from en (use en value as placeholder)
 *   5. Remove orphan keys
 *   6. Save and verify
 */

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'backend/public/shared/i18n.js');
let content = fs.readFileSync(filePath, 'utf8');

console.log('File size:', content.length);

// === State machine key extractor ===
function extractAllKeys(block) {
  const keys = new Set();
  let inStr = false, escape = false, prevWasColon = false, braceDepth = 0;
  for (let i = 0; i < block.length; i++) {
    const c = block[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') {
      if (!inStr) {
        // Start of key
        const keyStart = i + 1;
        let j = i + 1;
        while (j < block.length && block[j] !== '"') j++;
        const key = block.substring(keyStart, j);
        let next = j + 1;
        while (next < block.length && (block[next] === ' ' || block[next] === '\t')) next++;
        if (next < block.length && block[next] === ':' && braceDepth === 0 && !prevWasColon) {
          keys.add(key);
          prevWasColon = true;
        } else { prevWasColon = false; }
        i = j;
      }
      inStr = !inStr;
    } else if (!inStr) {
      if (c === ':') { /* colon seen */ }
      if (c === '{') braceDepth++;
      if (c === '}') braceDepth--;
      if (c === ',') prevWasColon = false;
    }
  }
  return keys;
}

// === Extract key:value string pairs for gap fill values ===
function extractKeyValues(block) {
  const pairs = {};
  let inStr = false, escape = false, prevWasColon = false, braceDepth = 0;
  for (let i = 0; i < block.length; i++) {
    const c = block[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') {
      if (!inStr) {
        const keyStart = i + 1;
        let j = i + 1;
        while (j < block.length && block[j] !== '"') j++;
        const key = block.substring(keyStart, j);
        let next = j + 1;
        while (next < block.length && (block[next] === ' ' || block[next] === '\t')) next++;
        if (next < block.length && block[next] === ':' && braceDepth === 0 && !prevWasColon) {
          // Now extract the value (string only)
          let valStart = next + 1;
          while (valStart < block.length && (block[valStart] === ' ' || block[valStart] === '\t')) valStart++;
          if (block[valStart] === '"') {
            valStart++;
            let valEnd = valStart;
            let esc = false;
            while (valEnd < block.length) {
              if (esc) { esc = false; valEnd++; continue; }
              if (block[valEnd] === '\\') { esc = true; valEnd++; continue; }
              if (block[valEnd] === '"') break;
              valEnd++;
            }
            pairs[key] = block.substring(valStart, valEnd);
          }
          prevWasColon = true;
        } else { prevWasColon = false; }
        i = j;
      }
      inStr = !inStr;
    } else if (!inStr) {
      if (c === '{') braceDepth++;
      if (c === '}') braceDepth--;
      if (c === ',') prevWasColon = false;
    }
  }
  return pairs;
}

// === Parse locale blocks ===
const localeRegex = /(?:^|\n)\s+([a-z]{2}(?:-[A-Z]{2})?):\s*\{/gm;
const localeStarts = [];
let m;
while ((m = localeRegex.exec(content)) !== null) localeStarts.push({ name: m[1], pos: m.index });
localeStarts.push({ name: '__END__', pos: content.length });

console.log('Locales found:', localeStarts.slice(0, -1).map(l => l.name).join(', '));

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
const allLocales = ['zh', 'ja', 'ko', 'th', 'vi', 'id', 'fr', 'es', 'de', 'ms', 'hi', 'ar'];

for (const loc of allLocales) {
  const lb = localeBlocks[loc];
  if (!lb) continue;
  const missing = [...enKeys].filter(k => !lb.keys.has(k));
  
  console.log(loc + ': ' + missing.length + ' missing keys');
  
  if (missing.length > 0) {
    // Find insertion point (before the closing brace of this locale)
    const insertionPoint = lb.blockEnd - 1;
    const newEntries = missing.map(key => '        "' + key + '": "' + (enKV[key] || '') + '"').join(',\n');
    const insertions = '    // gap-filled\n' + newEntries + ',\n    ';
    
    content = content.substring(0, insertionPoint) + insertions + content.substring(insertionPoint);
    
    // Re-parse this block
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
for (const loc of allLocales) {
  const lb = localeBlocks[loc];
  if (!lb) continue;
  const extra = [...lb.keys].filter(k => !enKeys.has(k));
  
  if (extra.length > 0) {
    console.log(loc + ': ' + extra.length + ' orphan keys to remove');
    // Remove orphan keys from content
    // We'll do targeted regex replacement
    let block = lb.block;
    for (const orphanKey of extra) {
      // Pattern: "orphanKey": "value" or "orphanKey": {object} etc.
      // Remove the key-entry (comma-separated)
      const pattern = new RegExp(
        '        "' + orphanKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '": [^\n,]+,\n',
        'g'
      );
      block = block.replace(pattern, '');
      content = content.replace(
        new RegExp(
          '        "' + orphanKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '": [^\n,]+,\n',
          'g'
        ),
        ''
      );
    }
    
    // Re-parse
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

// === Save ===
fs.writeFileSync(filePath, content);
console.log('\n=== Saved ===');
console.log('New file size:', content.length);

// === Verification ===
console.log('\n=== Verification ===');
// Re-parse after save
const updatedLocaleRegex = /(?:^|\n)\s+([a-z]{2}(?:-[A-Z]{2})?):\s*\{/gm;
const updatedLocaleStarts = [];
let um;
while ((um = updatedLocaleRegex.exec(content)) !== null) updatedLocaleStarts.push({ name: um[1], pos: um.index });
updatedLocaleStarts.push({ name: '__END__', pos: content.length });

const updatedBlocks = {};
for (let i = 0; i < updatedLocaleStarts.length - 1; i++) {
  const loc = updatedLocaleStarts[i].name;
  const bracePos = content.indexOf('{', updatedLocaleStarts[i].pos + loc.length + 2);
  const blockStart = bracePos + 1;
  const blockEnd = updatedLocaleStarts[i + 1].pos - 1;
  const block = content.substring(blockStart, blockEnd);
  updatedBlocks[loc] = { keys: extractAllKeys(block) };
}

const newEnKeys = updatedBlocks.en ? updatedBlocks.en.keys : new Set();
console.log('EN keys after changes:', newEnKeys.size);
for (const loc of allLocales) {
  if (!updatedBlocks[loc]) continue;
  const keys = updatedBlocks[loc].keys;
  const missing = [...newEnKeys].filter(k => !keys.has(k));
  const extra = [...keys].filter(k => !newEnKeys.has(k));
  console.log(loc + ': keys=' + keys.size + ' missing=' + missing.length + ' extra=' + extra.length);
}