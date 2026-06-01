#!/usr/bin/env node
/**
 * fix-i18n-v16.js - Clean gap fill + dedup for i18n.js
 * 
 * Approach:
 * - Build proper EN entry map handling inline entries
 * - For each target locale:
 *   - GAP FILL: insert missing "key": value entries just after the last existing entry
 *   - DEDUP: remove first occurrence of each duplicate key
 * 
 * Key fix: Find last entry by scanning backwards, insert after its comma.
 * This preserves the original block structure.
 */

const fs = require('fs');
const FILE = 'backend/public/shared/i18n.js';

const DEDUP_LOCALES = ['zh', 'ja', 'ko', 'ar'];
const GAP_FILL_LOCALES = ['zh', 'ja', 'ko', 'th', 'vi', 'id', 'fr', 'de', 'ms', 'hi', 'ar'];

console.log('Reading file...');
const content = fs.readFileSync(FILE, 'utf8');

const LOCALE_NAMES = ['en', 'zh', 'ja', 'ko', 'th', 'vi', 'id', 'fr', 'es', 'de', 'ms', 'hi', 'ar'];
const localePositions = {};
for (const loc of LOCALE_NAMES) {
  const search = '    ' + loc + ': {';
  const idx = content.indexOf(search);
  if (idx >= 0) localePositions[loc] = idx;
}
console.log('Found:', Object.keys(localePositions).join(', '));

function getBlockBounds(pos, locName) {
  const bracePos = content.indexOf('{', pos + locName.length + 1);
  let bc = 0, end = bracePos;
  do { if (content[end] === '{') bc++; else if (content[end] === '}') bc--; end++; } while (bc > 0);
  return { start: bracePos + 1, end: end - 1 };
}

// Extract EN entries with proper regex that handles inline entries
// Split EN block by ",\n        " to get individual entries
const enBounds = getBlockBounds(localePositions['en'], 'en');
const enBlock = content.substring(enBounds.start, enBounds.end);

// Split on ",\n        " (entry delimiter)
const enParts = enBlock.split(/,\n\s{8}/);
const enMap = {};
let enKeysCount = 0;
for (const part of enParts) {
  const m = part.match(/^\s*"([^"]+)"\s*:\s*(.+)$/s);
  if (m) {
    enMap[m[1]] = ',\n        ' + part; // Keep the delimiter for reconstruction
    enKeysCount++;
  }
}
console.log('EN keys:', enKeysCount);

// Helper: extract entries from a block with their positions
function extractEntries(block) {
  const entries = [];
  let i = 0;
  while (i < block.length) {
    const q1 = block.indexOf('"', i);
    if (q1 < 0) break;
    const q2 = block.indexOf('"', q1 + 1);
    if (q2 < 0) break;
    const key = block.substring(q1 + 1, q2);
    i = q2 + 1;
    while (i < block.length && (block[i] === ' ' || block[i] === '\t' || block[i] === ':')) i++;
    // Get value
    let valueEnd = i, depth = 0, inStr = false, esc = false;
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
    const hasComma = block[valueEnd] === ',';
    entries.push({ key, value, start: q1, end: valueEnd + (hasComma ? 1 : 0) });
    i = valueEnd + 1;
    while (i < block.length && (block[i] === ' ' || block[i] === '\t')) i++;
  }
  return entries;
}

// Process each locale
let newContent = content;
let shifts = {};

for (const loc of LOCALE_NAMES) {
  if (loc === 'en' || !localePositions[loc]) continue;
  
  // Apply accumulated shift
  const pos = localePositions[loc] + (shifts[loc] || 0);
  const bounds = getBlockBounds(pos, loc);
  const block = content.substring(bounds.start, bounds.end);
  let workingBlock = block;
  
  console.log('\n=== ' + loc + ' ===');
  console.log('Block: ' + block.length + ' chars');
  
  // === DEDUP ===
  if (DEDUP_LOCALES.includes(loc)) {
    const entries = extractEntries(workingBlock);
    const seen = {};
    let offset = 0;
    
    // Go through entries, mark first occurrences as "keep", subsequent as "remove"
    // Since entries are in order, we can build a new block by skipping duplicates
    const keepEntries = [];
    const removeRanges = []; // [start, end] ranges to remove
    
    for (const e of entries) {
      if (seen[e.key]) {
        // Duplicate - remove
        removeRanges.push([e.start - offset, e.end - offset]);
        offset += e.end - e.start;
      } else {
        seen[e.key] = true;
        keepEntries.push(e);
      }
    }
    
    if (removeRanges.length > 0) {
      // Build new block by removing ranges (work backwards)
      let result = workingBlock;
      for (let i = removeRanges.length - 1; i >= 0; i--) {
        const [start, end] = removeRanges[i];
        result = result.substring(0, start) + result.substring(end);
      }
      workingBlock = result;
      console.log('Dedup: removed ' + removeRanges.length + ' duplicates');
    } else {
      console.log('Dedup: 0');
    }
  }
  
  // === GAP FILL ===
  if (GAP_FILL_LOCALES.includes(loc)) {
    const entries = extractEntries(workingBlock);
    const existingKeys = new Set(entries.map(e => e.key));
    const missing = [...new Set([...Object.keys(enMap)].filter(k => !existingKeys.has(k)))];
    
    if (missing.length > 0) {
      // Build gap entries string
      const gapStr = missing.map(k => enMap[k]).join('').substring(2); // Remove leading ",\n"
      
      // Find insertion point: after the last entry (just before the trailing whitespace/brace area)
      // Scan backwards from block end to find the last comma
      let insertPos = workingBlock.length;
      let depth = 0, inStr = false, esc = false;
      // Actually, find the last "value", entries are separated by comma
      // The block ends with "...lastValue",\n    " (4 spaces then newline)
      // We want to insert after the last comma
      
      // Alternative: find position after last ",\n" pattern (entry separator)
      const lastEntryEnd = workingBlock.match(/,\n\s{8}[^"]+$/);
      if (lastEntryEnd) {
        insertPos = lastEntryEnd.index + lastEntryEnd[0].length;
      } else {
        // Fallback: find last comma that's after a value
        insertPos = workingBlock.lastIndexOf(',', workingBlock.length - 20);
      }
      
      workingBlock = workingBlock.substring(0, insertPos + 1) + '\n        ' + gapStr + workingBlock.substring(insertPos + 1);
      console.log('Gap fill: +' + missing.length);
    } else {
      console.log('Gap fill: 0');
    }
  }
  
  // Verify
  const finalEntries = extractEntries(workingBlock);
  const finalKeys = new Set(finalEntries.map(e => e.key));
  const enKeySet = new Set(Object.keys(enMap));
  const miss = [...enKeySet].filter(k => !finalKeys.has(k)).length;
  const extra = [...finalKeys].filter(k => !enKeySet.has(k)).length;
  console.log('Result: ' + finalKeys.size + ' keys, missing=' + miss + ', extra=' + extra);
  
  if (workingBlock !== block) {
    const shift = workingBlock.length - block.length;
    newContent = newContent.substring(0, bounds.start) + workingBlock + newContent.substring(bounds.end);
    for (const l of LOCALE_NAMES) {
      const lp = localePositions[l] + (shifts[l] || 0);
      if (lp > bounds.start) shifts[l] = (shifts[l] || 0) + shift;
    }
  }
}

console.log('\n=== Writing ===');
fs.writeFileSync(FILE, newContent);
console.log('Wrote ' + newContent.length + ' bytes');