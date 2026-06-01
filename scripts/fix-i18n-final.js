#!/usr/bin/env node
/**
 * fix-i18n-final.js - Targeted gap fill + dedup for i18n.js
 * 
 * Strategy:
 * - DEDUP: For zh, ja, ko, ar - remove FIRST occurrence of each duplicate key
 *          (keeping the last occurrence, which is at the end of the block)
 * - GAP FILL: For zh, ja, ko, th, vi, id, fr, de, ms, hi, ar - add keys that
 *             exist in en but are missing from the locale
 * 
 * Key insight: In this file, duplicate entries are consecutive and appear at
 * the END of a block (after unique entries). So "keep last" means keeping
 * the entries near the end, removing from earlier in the block.
 * 
 * This is a LINE-BASED approach: we convert block to lines, process, convert back.
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
console.log('Found locales:', Object.keys(localePositions).join(', '));

function getBlockBounds(pos, locName) {
  const bracePos = content.indexOf('{', pos + locName.length + 1);
  let bc = 0, end = bracePos;
  do { if (content[end] === '{') bc++; else if (content[end] === '}') bc--; end++; } while (bc > 0);
  return { start: bracePos + 1, end: end - 1 };
}

function extractKeys(block) {
  return new Set([...block.matchAll(/"([^\"]+)"\s*:/g)].map(m => m[1]));
}

// Get EN key entries for gap fill
const enBounds = getBlockBounds(localePositions['en'], 'en');
const enBlock = content.substring(enBounds.start, enBounds.end);
const enKeys = extractKeys(enBlock);

// Build EN key -> entry string map
// Split by lines to get proper entries
const enLines = enBlock.split('\n');
const enEntryMap = {};
for (const line of enLines) {
  const m = line.match(/^\s*"([^"]+)":\s*(.+)/);
  if (m) enEntryMap[m[1]] = m[2];
}
console.log('EN keys:', enKeys.size, '| EN entry map:', Object.keys(enEntryMap).length);

let newContent = content;
const shifts = {};

for (const loc of LOCALE_NAMES) {
  if (loc === 'en' || !localePositions[loc]) continue;
  
  // Apply accumulated shift
  let pos = localePositions[loc] + (shifts[loc] || 0);
  const bounds = getBlockBounds(pos, loc);
  const block = content.substring(bounds.start, bounds.end);
  
  console.log('\n=== ' + loc + ' ===');
  console.log('Block: ' + block.length + ' chars');
  
  let workingBlock = block;
  
  // ===== DEDUP =====
  if (DEDUP_LOCALES.includes(loc)) {
    const lines = workingBlock.split('\n');
    const seen = {};
    const uniqueLines = [];
    const dupeLines = [];
    
    for (const line of lines) {
      const m = line.match(/^\s*"([^"]+)":/);
      if (m) {
        const key = m[1];
        if (seen[key]) {
          dupeLines.push(line);
        } else {
          seen[key] = true;
          uniqueLines.push(line);
        }
      } else {
        uniqueLines.push(line);
      }
    }
    
    if (dupeLines.length > 0) {
      console.log('Dedup: ' + dupeLines.length + ' duplicates removed, ' + uniqueLines.length + ' unique kept');
      workingBlock = uniqueLines.join('\n');
    } else {
      console.log('Dedup: 0 duplicates');
    }
  }
  
  // ===== GAP FILL =====
  if (GAP_FILL_LOCALES.includes(loc)) {
    const keys = extractKeys(workingBlock);
    const missing = [...enKeys].filter(k => !keys.has(k));
    
    if (missing.length > 0) {
      console.log('Gap fill: ' + missing.length + ' missing keys');
      const gapLines = missing.map(k => '        "' + k + '": ' + enEntryMap[k]);
      
      // Find last entry line and insert before closing
      const lines = workingBlock.split('\n');
      // Find last line that looks like an entry (has "key":)
      let insertIdx = lines.length;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].match(/\s*"[^"]+":\s*.+/)) {
          insertIdx = i + 1;
          break;
        }
      }
      
      const newLines = [...lines.slice(0, insertIdx), ...gapLines, ...lines.slice(insertIdx)];
      workingBlock = newLines.join('\n');
    } else {
      console.log('Gap fill: 0 missing');
    }
  }
  
  // Verify
  const finalKeys = extractKeys(workingBlock);
  const miss = [...enKeys].filter(k => !finalKeys.has(k)).length;
  const extra = [...finalKeys].filter(k => !enKeys.has(k)).length;
  console.log('Result: ' + finalKeys.size + ' keys, missing=' + miss + ', extra=' + extra);
  
  if (workingBlock !== block) {
    const shift = workingBlock.length - block.length;
    newContent = newContent.substring(0, bounds.start) + workingBlock + newContent.substring(bounds.end);
    // Update shifts for subsequent locales
    for (const l of LOCALE_NAMES) {
      const lp = localePositions[l] + (shifts[l] || 0);
      if (lp > bounds.start) shifts[l] = (shifts[l] || 0) + shift;
    }
  }
}

console.log('\n=== Writing ===');
fs.writeFileSync(FILE, newContent);
console.log('Written: ' + newContent.length + ' bytes');

// Final verification
console.log('\n=== Final Check ===');
const finalContent = fs.readFileSync(FILE, 'utf8');
const finalPositions = {};
for (const loc of LOCALE_NAMES) {
  const search = '    ' + loc + ': {';
  const idx = finalContent.indexOf(search);
  if (idx >= 0) finalPositions[loc] = idx;
}

for (const loc of LOCALE_NAMES) {
  if (loc === 'en' || !finalPositions[loc]) continue;
  const b = getBlockBounds(finalPositions[loc], loc);
  const block = finalContent.substring(b.start, b.end);
  const keys = extractKeys(block);
  const miss = [...enKeys].filter(k => !keys.has(k)).length;
  const extra = [...keys].filter(k => !enKeys.has(k)).length;
  console.log(loc + ': ' + keys.size + ' keys, missing=' + miss + ', extra=' + extra);
}