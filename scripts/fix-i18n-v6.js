#!/usr/bin/env node
/**
 * i18n Gap Fill + Dedup Script v6
 * 
 * CRITICAL FIX: Previous versions inserted at blockEnd-1 which is AFTER the
 * closing brace of the locale block (blockEnd = position of next locale header - 1).
 * 
 * Correct approach:
 * - For each locale block, find the actual closing brace by brace-matching from
 *   the locale's opening `{`.
 * - Insert gap-fill content BEFORE the closing brace (inside the block).
 * - For dedup: identify keys that appear more than once in a locale block (by
 *   counting occurrences in the raw content), keep only the last occurrence.
 * - For orphan removal: keys that don't exist in en at all.
 */

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'backend/public/shared/i18n.js');
let content = fs.readFileSync(filePath, 'utf8');

console.log('File size:', content.length);

// === Regex-based locale block finder ===
// Finds each "  localeName: {" line and match the brace position
function findLocaleBlocks(content) {
  const localeRegex = /(?:^|\n)\s+([a-z]{2}(?:-[A-Z]{2})?):\s*\{/gm;
  const blocks = [];
  let m;
  while ((m = localeRegex.exec(content)) !== null) {
    const name = m[1];
    const headerEnd = m.index + m[0].length; // position after the "{"
    // Find the actual closing "}" by brace matching from headerEnd
    let depth = 0;
    let closePos = -1;
    for (let i = headerEnd; i < content.length; i++) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') {
        depth--;
        if (depth === 0) { closePos = i; break; }
      }
    }
    blocks.push({ name, headerStart: m.index, headerEnd, closePos });
  }
  return blocks;
}

// === Extract keys from a locale block's raw content ===
function extractBlockKeys(blockContent) {
  const keys = new Set();
  // Match top-level "key": value patterns
  // We only match when at depth=1 (directly inside locale block)
  const re = /"([^"]+)":\s*(?="|\d|true|false|null|\[|\{)/g;
  // Better: scan character by character tracking depth
  let depth = 0, inStr = false, escape = false;
  for (let i = 0; i < blockContent.length; i++) {
    const c = blockContent[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') {
      if (!inStr) {
        // Potential key start
        const keyStart = i + 1;
        let j = i + 1;
        while (j < blockContent.length && blockContent[j] !== '"') j++;
        const key = blockContent.substring(keyStart, j);
        // Look ahead for colon at depth=1
        let next = j + 1;
        while (next < blockContent.length && (blockContent[next] === ' ' || blockContent[next] === '\t')) next++;
        if (depth === 1 && next < blockContent.length && blockContent[next] === ':') {
          keys.add(key);
        }
        i = j;
      }
      inStr = !inStr;
    } else if (!inStr) {
      if (c === '{') depth++;
      else if (c === '}') depth--;
    }
  }
  return keys;
}

// === Extract key→value pairs from a locale block ===
function extractBlockKeyValues(blockContent) {
  const pairs = {};
  let depth = 0, inStr = false, escape = false, prevWasColon = false;
  for (let i = 0; i < blockContent.length; i++) {
    const c = blockContent[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') {
      if (!inStr) {
        const keyStart = i + 1;
        let j = i + 1;
        while (j < blockContent.length && blockContent[j] !== '"') j++;
        const key = blockContent.substring(keyStart, j);
        let next = j + 1;
        while (next < blockContent.length && (blockContent[next] === ' ' || blockContent[next] === '\t')) next++;
        if (depth === 1 && next < blockContent.length && blockContent[next] === ':') {
          prevWasColon = true;
        } else { prevWasColon = false; }
        i = j;
      } else {
        if (prevWasColon && depth === 1) {
          pairs[key] = blockContent.substring(i + 1, i); // empty for now
        }
        prevWasColon = false;
        i = j;
      }
      inStr = !inStr;
    } else if (!inStr) {
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === ',') prevWasColon = false;
    }
  }
  return pairs;
}

// === Count occurrences of a key in block content (for dedup) ===
function countKeyOccurrences(blockContent, key) {
  // Match the key at top level by looking for "key": pattern
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp('"' + escapedKey + '":\\s*(?:,|$|\\n|"|\\d|true|false|null|\\[|\\{)', 'g');
  const matches = blockContent.match(pattern);
  return matches ? matches.length : 0;
}

// === MAIN EXECUTION ===

console.log('\n=== Parsing locale blocks ===');
const localeBlocks = findLocaleBlocks(content);
console.log('Found', localeBlocks.length, 'locales:', localeBlocks.map(b => b.name).join(', '));

// Get en block
const enBlock = localeBlocks.find(b => b.name === 'en');
if (!enBlock) { console.error('EN block not found!'); process.exit(1); }
const enContent = content.substring(enBlock.headerEnd, enBlock.closePos);
const enKeys = extractBlockKeys(enContent);
console.log('EN keys:', enKeys.size);

// Extract en key-values
const enKV = {};
let depth = 0, inStr = false, escape = false, prevWasColon = false, currentKey = null;
for (let i = 0; i < enContent.length; i++) {
  const c = enContent[i];
  if (escape) { escape = false; continue; }
  if (c === '\\') { escape = true; continue; }
  if (c === '"') {
    if (!inStr) {
      const keyStart = i + 1;
      let j = i + 1;
      while (j < enContent.length && enContent[j] !== '"') j++;
      const key = enContent.substring(keyStart, j);
      let next = j + 1;
      while (next < enContent.length && (enContent[next] === ' ' || enContent[next] === '\t')) next++;
      if (depth === 0 && next < enContent.length && enContent[next] === ':') {
        currentKey = key;
        prevWasColon = true;
      } else { prevWasColon = false; }
      i = j;
    } else {
      if (prevWasColon && depth === 0 && currentKey) {
        enKV[currentKey] = enContent.substring(i + 1, i);
        currentKey = null;
      }
      prevWasColon = false;
      i = enContent.indexOf('"', i + 1);
      if (i === -1) break;
    }
    inStr = !inStr;
  } else if (!inStr) {
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === ',') prevWasColon = false;
  }
}
console.log('EN kvPairs:', Object.keys(enKV).length);

// === TARGET LOCALES ===
const targetLocales = ['hi', 'ms', 'ko', 'ja', 'ar'];

// === GAP FILL PHASE ===
console.log('\n=== GAP FILL PHASE ===');
const insertions = {}; // locale name → [{key, value}]

for (const loc of targetLocales) {
  const lb = localeBlocks.find(b => b.name === loc);
  if (!lb) { console.log(loc + ': block not found'); continue; }
  
  const blockContent = content.substring(lb.headerEnd, lb.closePos);
  const keys = extractBlockKeys(blockContent);
  const missing = [...enKeys].filter(k => !keys.has(k));
  
  console.log(loc + ': ' + missing.length + ' missing keys');
  
  if (missing.length > 0) {
    // Prepare insertions - these will be added before the closing brace
    insertions[loc] = missing.map(key => ({
      key,
      value: enKV[key] || key.replace(/_/g, ' ')
    }));
  }
}

// === DEDUP TARGETS ===
const dedupLocales = ['zh', 'ja', 'ko', 'ar'];

// === Perform insertions and removals ===
// For each target locale, we need to:
// 1. Find the closing brace position accurately  
// 2. Insert missing keys before the closing brace
// 3. Remove orphan/duplicate keys

console.log('\n=== APPLYING CHANGES ===');

let modified = false;
for (const loc of targetLocales) {
  const lb = localeBlocks.find(b => b.name === loc);
  if (!lb) continue;
  
  const blockContent = content.substring(lb.headerEnd, lb.closePos);
  const keys = extractBlockKeys(blockContent);
  const missing = [...enKeys].filter(k => !keys.has(k));
  const orphans = [...keys].filter(k => !enKeys.has(k));
  
  if (missing.length > 0 || orphans.length > 0) {
    console.log(loc + ': inserting ' + missing.length + ', removing ' + orphans.length + ' orphans');
    
    // Build new entries for missing keys
    let newEntries = '';
    for (const m of (insertions[loc] || [])) {
      newEntries += '        "' + m.key + '": "' + m.value + '",\n';
    }
    
    // Find the actual closing brace position
    const closeBracePos = lb.closePos;
    
    // Build the replacement: insert new entries before the closing brace
    // Also remove orphan keys from the block
    let blockBefore = content.substring(lb.headerEnd, closeBracePos);
    
    // Remove orphan keys from blockBefore
    for (const orphan of orphans) {
      const escapedOrphan = orphan.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Match the entire entry: "orphanKey": "value" or "orphanKey": {...},
      const entryRe = new RegExp('        "' + escapedOrphan + '":\\s*(?:' +
        '(?:"[^"]*")|(?:\\{[^}]*\\})|(?:\\[[^\\]]*\\])|(?:true|false|null|\\d+)' +
        ')\\s*,?\n?', 'g');
      blockBefore = blockBefore.replace(entryRe, '');
    }
    
    // Insert new entries before the closing brace
    const insertPos = closeBracePos;
    content = content.substring(0, insertPos) + newEntries + blockBefore.substring(lb.headerEnd) + content.substring(insertPos);
    modified = true;
  }
}

// === DEDUP PHASE ===
console.log('\n=== DEDUP PHASE ===');
for (const loc of dedupLocales) {
  const lb = localeBlocks.find(b => b.name === loc);
  if (!lb) continue;
  
  // Re-parse after modifications
  const updatedBlocks = findLocaleBlocks(content);
  const updatedLb = updatedBlocks.find(b => b.name === loc);
  if (!updatedLb) continue;
  
  const blockContent = content.substring(updatedLb.headerEnd, updatedLb.closePos);
  const keys = extractBlockKeys(blockContent);
  
  // Find keys that appear more than once (duplicates)
  // For each key, count occurrences in the raw block content
  const seen = new Map();
  const allMatches = [];
  
  // Use a regex to find all top-level key occurrences
  let depth = 0, inStr = false, escape = false;
  let i = updatedLb.headerEnd;
  let currentKey = null, keyStart = -1;
  
  while (i < updatedLb.closePos) {
    const c = content[i];
    if (escape) { escape = false; i++; continue; }
    if (c === '\\') { escape = true; i++; continue; }
    if (c === '"') {
      if (!inStr) {
        keyStart = i + 1;
        let j = i + 1;
        while (j < updatedLb.closePos && content[j] !== '"') j++;
        const key = content.substring(keyStart, j);
        let next = j + 1;
        while (next < updatedLb.closePos && (content[next] === ' ' || content[next] === '\t')) next++;
        if (next < updatedLb.closePos && content[next] === ':' && depth === 0) {
          currentKey = key;
        } else {
          currentKey = null;
        }
        i = j;
      } else {
        if (currentKey && depth === 0) {
          // Found value end for a top-level key
          const valueEnd = i;
          const valueStart = i + 1;
          allMatches.push({ key: currentKey, keyPos: keyStart - 1, valueEnd });
          currentKey = null;
        }
        i = content.indexOf('"', i + 1);
        if (i === -1 || i >= updatedLb.closePos) break;
      }
      inStr = !inStr;
    } else if (!inStr) {
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === ',') { currentKey = null; }
    }
    i++;
  }
  
  // Count occurrences of each key
  const keyCount = {};
  for (const m of allMatches) {
    keyCount[m.key] = (keyCount[m.key] || 0) + 1;
  }
  
  const duplicates = Object.entries(keyCount).filter(([k, v]) => v > 1);
  if (duplicates.length > 0) {
    console.log(loc + ': ' + duplicates.length + ' duplicate keys');
    // For each duplicate key, keep only the last occurrence
    for (const [dupKey, count] of duplicates) {
      const matches = allMatches.filter(m => m.key === dupKey);
      // Keep the last match, remove others (first occurrences)
      const toRemove = matches.slice(0, matches.length - 1);
      for (const rem of toRemove) {
        // Find the entry start (going back to find the opening quote of the key)
        // and the entry end (comma or closing brace after value)
        let entryStart = rem.keyPos;
        // Find end: look for comma after the closing quote of value
        let valEnd = rem.valueEnd;
        // Find the closing " of the value
        let searchFrom = content.indexOf('"', rem.valueEnd + 1);
        let entryEnd = searchFrom + 1;
        // Look for comma after
        let afterComma = content.indexOf(',', entryEnd);
        let afterBrace = content.indexOf('}', entryEnd);
        if (afterComma !== -1 && afterComma < afterBrace) {
          entryEnd = afterComma + 1;
        } else if (afterBrace !== -1) {
          entryEnd = afterBrace;
        }
        // Check for newline
        let nl = content.lastIndexOf('\n', entryEnd);
        if (nl > entryStart) {
          entryEnd = nl + 1;
        }
        // Remove this entry from content
        content = content.substring(0, entryStart) + content.substring(entryEnd);
      }
    }
    modified = true;
  }
}

// === Save ===
if (modified) {
  fs.writeFileSync(filePath, content);
  console.log('\n=== Saved ===');
  console.log('New file size:', content.length);
}

// === Re-verify ===
console.log('\n=== VERIFICATION ===');
const finalBlocks = findLocaleBlocks(content);
const finalEn = finalBlocks.find(b => b.name === 'en');
const finalEnContent = content.substring(finalEn.headerEnd, finalEn.closePos);
const finalEnKeys = extractBlockKeys(finalEnContent);
console.log('EN keys:', finalEnKeys.size);

const allLocs = ['zh', 'ja', 'ko', 'th', 'vi', 'id', 'fr', 'es', 'de', 'ms', 'hi', 'ar'];
for (const loc of allLocs) {
  const lb = finalBlocks.find(b => b.name === loc);
  if (!lb) continue;
  const block = content.substring(lb.headerEnd, lb.closePos);
  const keys = extractBlockKeys(block);
  const missing = [...finalEnKeys].filter(k => !keys.has(k));
  const extra = [...keys].filter(k => !finalEnKeys.has(k));
  console.log(loc + ': keys=' + keys.size + ' missing=' + missing.length + ' extra=' + extra.length);
}