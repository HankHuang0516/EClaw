#!/usr/bin/env node
/**
 * fix-i18n-v14.js - Clean gap fill + dedup for i18n.js
 * 
 * Uses targeted replacement: find each locale block, extract, process, replace.
 * Only writes the file once at the end. Avoids memory issues by processing
 * locale by locale in-place.
 */

const fs = require('fs');

const FILE = 'backend/public/shared/i18n.js';
const LOCALE_NAMES = ['en', 'zh', 'ja', 'ko', 'th', 'vi', 'id', 'fr', 'es', 'de', 'ms', 'hi', 'ar'];

const DEDUP = ['ja', 'ko', 'ar'];
const GAP_FILL = ['zh', 'ja', 'ko', 'th', 'vi', 'id', 'fr', 'de', 'ms', 'hi', 'ar'];

// Read entire file as string (14MB is fine)
const content = fs.readFileSync(FILE, 'utf8');

// Find locale positions (byte offsets in string)
const localePositions = {};
for (const loc of LOCALE_NAMES) {
  const search = '    ' + loc + ': {';
  const idx = content.indexOf(search);
  if (idx >= 0) localePositions[loc] = idx;
}

console.log('Found locales:', Object.keys(localePositions).join(', '));

// Get block boundaries using brace counting (returns {start, end} byte positions)
function getBlockBounds(pos, locName) {
  const bracePos = content.indexOf('{', pos + locName.length + 1);
  let bc = 0, end = bracePos;
  do {
    if (content[end] === '{') bc++;
    else if (content[end] === '}') bc--;
    end++;
  } while (bc > 0);
  return { start: bracePos + 1, end: end - 1 };
}

// Extract keys from a block string
function extractKeys(block) {
  return new Set([...block.matchAll(/"([^\"]+)"\s*:/g)].map(m => m[1]));
}

// Extract {key, value} entries from block string
function extractEntries(block) {
  const entries = [];
  let i = 0;
  while (i < block.length) {
    // Find opening quote of key
    const q1 = block.indexOf('"', i);
    if (q1 < 0) break;
    const q2 = block.indexOf('"', q1 + 1);
    if (q2 < 0) break;
    const key = block.substring(q1 + 1, q2);
    i = q2 + 1;
    // Skip whitespace and colon
    while (i < block.length && (block[i] === ' ' || block[i] === '\t' || block[i] === ':')) i++;
    // Get value - track string escapes and nested braces
    let valueEnd = i;
    let depth = 0;
    let inStr = false;
    let esc = false;
    while (valueEnd < block.length) {
      const c = block[valueEnd];
      if (esc) { esc = false; valueEnd++; continue; }
      if (c === '\\') { esc = true; valueEnd++; continue; }
      if (c === '"') { inStr = !inStr; valueEnd++; continue; }
      if (inStr) { valueEnd++; continue; }
      if (c === '{' || c === '[') { depth++; valueEnd++; continue; }
      if ((c === '}' || c === ']') && depth > 0) { depth--; valueEnd++; continue; }
      if (depth === 0 && (c === ',' || c === '\n')) break;
      valueEnd++;
    }
    const value = block.substring(i, valueEnd);
    entries.push({ key, value });
    i = valueEnd + 1;
    // Skip whitespace
    while (i < block.length && (block[i] === ' ' || block[i] === '\t')) i++;
  }
  return entries;
}

// Get EN data
const enBounds = getBlockBounds(localePositions['en'], 'en');
const enBlock = content.substring(enBounds.start, enBounds.end);
const enKeys = extractKeys(enBlock);
const enEntries = extractEntries(enBlock);
const enMap = {};
for (const e of enEntries) enMap[e.key] = e.value;
console.log('EN keys:', enKeys.size);

// Process each locale (skip en)
let newContent = content;
let totalChanges = 0;

for (const loc of LOCALE_NAMES) {
  if (loc === 'en') continue;
  if (!localePositions[loc]) { console.log(loc + ': not found'); continue; }
  
  const bounds = getBlockBounds(localePositions[loc], loc);
  const block = content.substring(bounds.start, bounds.end);
  
  let newBlock = block;
  let changes = 0;
  
  // DEDUP
  if (DEDUP.includes(loc)) {
    const entries = extractEntries(block);
    const seen = {};
    const keep = [];
    for (let i = entries.length - 1; i >= 0; i--) {
      if (!seen[entries[i].key]) {
        seen[entries[i].key] = true;
        keep.push(entries[i]);
      }
    }
    keep.reverse();
    newBlock = keep.map(e => '"' + e.key + '": ' + e.value).join(',\n        ');
    changes += entries.length - keep.length;
    console.log(loc + ' dedup: ' + entries.length + ' -> ' + keep.length);
  }
  
  // GAP FILL
  if (GAP_FILL.includes(loc)) {
    const entries = extractEntries(newBlock);
    const existingKeys = new Set(entries.map(e => e.key));
    const missing = [...enKeys].filter(k => !existingKeys.has(k));
    if (missing.length > 0) {
      const gapLines = missing.map(k => '"' + k + '": ' + enMap[k]);
      newBlock = newBlock.trim().replace(/,?\s*$/, '') + ',\n        ' + gapLines.join(',\n        ');
      changes += missing.length;
      console.log(loc + ' gap fill: +' + missing.length);
    }
  }
  
  // Verify
  const finalKeys = extractKeys(newBlock);
  const miss = [...enKeys].filter(k => !finalKeys.has(k)).length;
  const extra = [...finalKeys].filter(k => !enKeys.has(k)).length;
  console.log(loc + ': ' + finalKeys.size + ' keys, missing=' + miss + ', extra=' + extra);
  
  // Replace in content
  if (newBlock !== block) {
    newContent = newContent.substring(0, bounds.start) + newBlock + newContent.substring(bounds.end);
    totalChanges += changes;
    // Update bounds for subsequent locales (positions may have shifted)
    const shift = newBlock.length - block.length;
    for (const l of LOCALE_NAMES) {
      if (localePositions[l] > bounds.start) localePositions[l] += shift;
    }
  }
}

console.log('\nTotal entries changed:', totalChanges);
if (totalChanges > 0) {
  fs.writeFileSync(FILE, newContent);
  console.log('Written:', newContent.length, 'bytes');
} else {
  console.log('No changes needed.');
}