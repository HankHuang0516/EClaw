#!/usr/bin/env node
/**
 * fix-i18n-clean.js - Gap fill + dedup for i18n.js
 * 
 * Usage: node scripts/fix-i18n-clean.js
 * 
 * Operations (in order):
 * 1. DEDUP: Remove first occurrences of duplicate keys in ja, ko, ar (keep last)
 * 2. GAP FILL: Add missing keys to zh, ja, ko, th, vi, id, fr, de, ms, hi, ar
 * 
 * Does NOT modify: en, zh-TW, fr (no dedup), es (no dedup), de (no dedup)
 * zh only gets gap fill (no dedup per task rules)
 */

const fs = require('fs');

const FILE = 'backend/public/shared/i18n.js';
const LOCALE_NAMES = ['en', 'zh', 'ja', 'ko', 'th', 'vi', 'id', 'fr', 'es', 'de', 'ms', 'hi', 'ar'];

// Locales that need dedup (remove first occurrence, keep last)
const DEDUP_LOCALES = ['ja', 'ko', 'ar'];
// zh has duplicates too but we skip dedup per task rules

// Locales that need gap fill (add keys present in en but missing in this locale)
const GAP_FILL_LOCALES = ['zh', 'ja', 'ko', 'th', 'vi', 'id', 'fr', 'de', 'ms', 'hi', 'ar'];

// Read file
const content = fs.readFileSync(FILE, 'utf8');
const buf = Buffer.from(content);

// Find locale positions by searching for "    locale: {" pattern
const localePositions = [];
for (const loc of LOCALE_NAMES) {
  const search = Buffer.from('    ' + loc + ': {');
  let idx = -1;
  outer: for (let i = 0; i < buf.length - search.length; i++) {
    for (let j = 0; j < search.length; j++) {
      if (buf[i + j] !== search[j]) continue outer;
    }
    idx = i;
    break;
  }
  if (idx >= 0) localePositions.push({ name: loc, pos: idx });
}
localePositions.push({ name: '__END__', pos: buf.length });

// Get block boundaries for a locale
function getBlockBounds(localeIdx) {
  const loc = localePositions[localeIdx];
  const bracePos = buf.indexOf(33, loc.pos + loc.name.length + 2); // '{' = char 123
  let bc = 0, end = bracePos;
  do {
    if (buf[end] === 123) bc++;
    else if (buf[end] === 125) bc--;
    end++;
  } while (bc > 0);
  return { blockStart: bracePos + 1, blockEnd: end - 1 };
}

// Extract keys from a block (using simple regex on string)
function extractKeys(block) {
  return new Set([...block.matchAll(/"([^"]+)"\s*:/g)].map(m => m[1]));
}

// Extract entries from block (key + raw value)
function extractEntries(block) {
  const entries = [];
  let i = 0;
  while (i < block.length) {
    // Find opening quote
    while (i < block.length && block[i] !== '"') i++;
    if (i >= block.length) break;
    i++;
    // Get key
    let keyEnd = i;
    while (keyEnd < block.length && block[keyEnd] !== '"') keyEnd++;
    const key = block.substring(i, keyEnd);
    i = keyEnd + 1;
    // Skip whitespace and colon
    while (i < block.length && (block[i] === 32 || block[i] === 9 || block[i] === 58)) i++;
    // Get value - handle nested structures
    let valueEnd = i;
    let depth = 0;
    let inStr = false;
    let escape = false;
    while (valueEnd < block.length) {
      const c = block[valueEnd];
      if (escape) { escape = false; valueEnd++; continue; }
      if (c === 92) { escape = true; valueEnd++; continue; } // backslash
      if (c === 34) { inStr = !inStr; valueEnd++; continue; } // double quote
      if (inStr) { valueEnd++; continue; }
      if (c === 123 || c === 91) { depth++; valueEnd++; continue; } // { or [
      if (c === 125 || c === 93) { if (depth === 0) break; depth--; valueEnd++; continue; } // } or ]
      if (depth === 0 && (c === 44 || c === 10)) break; // comma or newline
      valueEnd++;
    }
    const value = block.substring(i, valueEnd);
    entries.push({ key, value });
    i = valueEnd;
    // Skip comma and whitespace
    while (i < block.length && (block[i] === 44 || block[i] === 32 || block[i] === 9 || block[i] === 10)) i++;
  }
  return entries;
}

// --- Get EN keys and block ---
const enBounds = getBlockBounds(0);
const enBlock = buf.slice(enBounds.blockStart, enBounds.blockEnd).toString('utf8');
const enKeys = extractKeys(enBlock);
const enEntries = extractEntries(enBlock);
const enMap = {};
for (const e of enEntries) enMap[e.key] = e.value;
console.log('EN keys:', enKeys.size);

// --- Process each locale ---
const newBlocks = {};
let modified = false;

for (let li = 1; li < localePositions.length - 1; li++) {
  const loc = localePositions[li].name;
  const bounds = getBlockBounds(li);
  const block = buf.slice(bounds.blockStart, bounds.blockEnd).toString('utf8');
  
  let newBlock = block;
  
  // Step 1: DEDUP - remove first occurrences, keep last
  if (DEDUP_LOCALES.includes(loc)) {
    const entries = extractEntries(block);
    const seen = {};
    const keep = [];
    // Go in reverse, only keep first seen (which is last in original order)
    for (let i = entries.length - 1; i >= 0; i--) {
      if (!seen[entries[i].key]) {
        seen[entries[i].key] = true;
        keep.push(entries[i]);
      }
    }
    keep.reverse();
    newBlock = keep.map(e => '"' + e.key + '": ' + e.value).join(', ');
    console.log(loc + ' dedup: ' + entries.length + ' -> ' + keep.length + ' entries');
  }
  
  // Step 2: GAP FILL - add missing keys from en
  if (GAP_FILL_LOCALES.includes(loc)) {
    const entries = extractEntries(newBlock);
    const existingKeys = new Set(entries.map(e => e.key));
    const missing = [...enKeys].filter(k => !existingKeys.has(k));
    if (missing.length > 0) {
      const gapEntries = missing.map(k => '"' + k + '": ' + enMap[k]);
      // Add before closing brace
      newBlock = newBlock.trim().replace(/,?\s*$/, '') + ', ' + gapEntries.join(', ');
      console.log(loc + ' gap fill: added ' + missing.length + ' keys');
    }
  }
  
  // Verify final state
  const finalKeys = extractKeys(newBlock);
  const missing = [...enKeys].filter(k => !finalKeys.has(k)).length;
  const extra = [...finalKeys].filter(k => !enKeys.has(k)).length;
  console.log(loc + ': ' + finalKeys.size + ' keys, missing=' + missing + ', extra=' + extra);
  
  newBlocks[loc] = { bounds, block: newBlock };
  
  // Check if actually modified
  if (block !== newBlock) modified = true;
}

console.log('\nModified:', modified);
if (!modified) {
  console.log('No changes needed.');
} else {
  // Write modified file
  console.log('\nWriting changes...');
  // Can't easily do targeted edits on a 14MB file with binary positions
  // without rewriting the whole thing. Let's use a different approach.
  // Build the new file from EN block + modified locale blocks
  
  // Reconstruct: EN block + locale blocks
  // We need to build the entire file from scratch using known boundaries
  console.log('This approach needs full file rebuild. Use the simpler node script approach.');
}