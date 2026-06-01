#!/usr/bin/env node
/**
 * i18n Gap Fill + Dedup Script v7
 * 
 * Key insight from diagnostic:
 * - en block is ~1MB (positions 158 to 1067550)
 * - Regex `match(/\"([^\"]+)\":\s*(?:\"|true|false|null|\d|\[|\{)/g)` finds 5133 keys
 * - Character-by-character scanning fails due to embedded strings
 * 
 * Approach:
 * 1. Use regex to find all locale headers and brace-match each closing }
 * 2. For each locale, use regex to extract top-level key:value pairs
 * 3. For gap fill: add missing keys before the closing brace }
 * 4. For dedup: identify duplicate keys (same key appears >1 time), keep last
 * 5. For orphans: keys in locale but not in en, remove them
 */

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'backend/public/shared/i18n.js');
let content = fs.readFileSync(filePath, 'utf8');

console.log('File size:', content.length);

// === Step 1: Find all locale header positions ===
function findLocaleHeaders(content) {
  const headers = [];
  // Match "  localeName: {" pattern (locale at start of line with indentation)
  const re = /\n\s+([a-z]{2}(?:-[A-Z]{2})?):\s*\{/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    headers.push({ name: m[1], pos: m.index + m[0].length - 1 }); // pos of '{'
  }
  return headers;
}

// === Step 2: For a given '{' position, find the closing '}' by brace matching ===
function findClosingBrace(content, openPos) {
  let depth = 0;
  for (let i = openPos; i < content.length; i++) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// === Step 3: Extract top-level key:value pairs from a block using regex ===
function extractTopLevelPairs(block) {
  const pairs = {};
  // Pattern: "key": "value" at top level (depth=0 in the block)
  // Strategy: find all "key": occurrences, then for each find the corresponding value
  const keyRe = /\"([^\"]+)\":\s*(?="|\d|true|false|null|\[|\{)/g;
  // Actually: match the full "key": value pattern
  // Values can be: "string", number, true, false, null, [array], {object}
  // We use a simpler approach: find "key": then scan for the value
  
  let match;
  while ((match = keyRe.exec(block)) !== null) {
    const key = match[1];
    const valueStart = match.index + match[0].length;
    // Extract value
    const after = block.substring(valueStart);
    const trimmed = after.match(/^\s*((?:"[^"]*")|(?:\d+(?:\.\d+)?)|(?:true|false|null)|(?:\[[^\]]*\])|(?:\{[^\}]*\}))/);
    if (trimmed) {
      pairs[key] = trimmed[1];
    }
  }
  return pairs;
}

// Simpler: just extract keys using a depth-aware scan
function extractKeys(block) {
  const keys = new Set();
  let depth = 0, inStr = false, escape = false;
  let i = 0;
  while (i < block.length) {
    const c = block[i];
    if (escape) { escape = false; i++; continue; }
    if (c === '\\') { escape = true; i++; continue; }
    if (c === '"') {
      if (!inStr) {
        // Potential key start
        const keyStart = i + 1;
        let j = i + 1;
        while (j < block.length && block[j] !== '"') j++;
        const key = block.substring(keyStart, j);
        // Look for colon at depth 0
        let next = j + 1;
        while (next < block.length && (block[next] === ' ' || block[next] === '\t')) next++;
        if (depth === 0 && next < block.length && block[next] === ':') {
          keys.add(key);
        }
        i = j;
      }
      inStr = !inStr;
    } else if (!inStr) {
      if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    i++;
  }
  return keys;
}

// Extract keys AND values (for en)
function extractKeysAndValues(block) {
  const keys = new Set();
  const kvPairs = {};
  let depth = 0, inStr = false, escape = false, prevWasColon = false, currentKey = null;
  let i = 0;
  while (i < block.length) {
    const c = block[i];
    if (escape) { escape = false; i++; continue; }
    if (c === '\\') { escape = true; i++; continue; }
    if (c === '"') {
      if (!inStr) {
        const keyStart = i + 1;
        let j = i + 1;
        while (j < block.length && block[j] !== '"') j++;
        const key = block.substring(keyStart, j);
        let next = j + 1;
        while (next < block.length && (block[next] === ' ' || block[next] === '\t')) next++;
        if (depth === 0 && next < block.length && block[next] === ':') {
          currentKey = key;
          prevWasColon = true;
        } else {
          prevWasColon = false;
        }
        i = j;
      } else {
        if (prevWasColon && depth === 0 && currentKey) {
          // Extract string value
          const valStart = i + 1;
          let valEnd = valStart;
          let esc = false;
          while (valEnd < block.length) {
            if (esc) { esc = false; valEnd++; continue; }
            if (block[valEnd] === '\\') { esc = true; valEnd++; continue; }
            if (block[valEnd] === '"') break;
            valEnd++;
          }
          kvPairs[currentKey] = block.substring(valStart, valEnd);
          currentKey = null;
        }
        prevWasColon = false;
        i = block.indexOf('"', i + 1);
        if (i === -1) break;
      }
      inStr = !inStr;
    } else if (!inStr) {
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === ',') { prevWasColon = false; currentKey = null; }
      else if (c === ':') { /* skip */ }
    }
    i++;
  }
  return { keys, kvPairs };
}

// === Count occurrences of each key in a block ===
// For dedup: find keys that appear more than once
function countKeyOccurrences(block) {
  const counts = {};
  let depth = 0, inStr = false, escape = false, currentKey = null, keyStart = -1;
  for (let i = 0; i < block.length; i++) {
    const c = block[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') {
      if (!inStr) {
        keyStart = i;
        const keyStartInner = i + 1;
        let j = i + 1;
        while (j < block.length && block[j] !== '"') j++;
        const key = block.substring(keyStartInner, j);
        let next = j + 1;
        while (next < block.length && (block[next] === ' ' || block[next] === '\t')) next++;
        if (depth === 0 && next < block.length && block[next] === ':') {
          currentKey = key;
        } else {
          currentKey = null;
        }
        i = j;
      } else {
        if (currentKey && depth === 0) {
          counts[currentKey] = (counts[currentKey] || 0) + 1;
          currentKey = null;
        }
        i = block.indexOf('"', i + 1);
        if (i === -1) break;
      }
      inStr = !inStr;
    } else if (!inStr) {
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === ',') { currentKey = null; }
    }
  }
  return counts;
}

// === MAIN ===
console.log('\n=== Finding locale headers ===');
const headers = findLocaleHeaders(content);
console.log('Found', headers.length, 'locales:', headers.map(h => h.name).join(', '));

// Build block info
const blocks = headers.map(h => ({
  name: h.name,
  openPos: h.pos,
  closePos: findClosingBrace(content, h.pos)
}));

console.log('Block sizes:');
for (const b of blocks) {
  console.log('  ' + b.name + ': ' + (b.closePos - b.openPos - 1) + ' bytes');
}

// Get en keys
const enBlock = blocks.find(b => b.name === 'en');
const enContent = content.substring(enBlock.openPos + 1, enBlock.closePos);
const { keys: enKeys, kvPairs: enKV } = extractKeysAndValues(enContent);
console.log('\nEN keys:', enKeys.size, '| kvPairs:', Object.keys(enKV).length);

// Target locales
const gapFillLocales = ['hi', 'ms', 'ko', 'ja', 'ar'];
const dedupLocales = ['zh', 'ja', 'ko', 'ar'];

// === GAP FILL ===
console.log('\n=== GAP FILL PHASE ===');
const insertions = {}; // loc → [{key, value}]

for (const loc of gapFillLocales) {
  const b = blocks.find(b => b.name === loc);
  if (!b) { console.log(loc + ': not found'); continue; }
  
  const blockContent = content.substring(b.openPos + 1, b.closePos);
  const { keys: locKeys } = extractKeysAndValues(blockContent);
  const missing = [...enKeys].filter(k => !locKeys.has(k));
  
  console.log(loc + ': ' + missing.length + ' missing');
  if (missing.length > 0) {
    insertions[loc] = missing.map(k => ({ key: k, value: enKV[k] || k.replace(/_/g, ' ') }));
  }
}

// === DEDUP ===
console.log('\n=== DEDUP PHASE ===');
const dupInfo = {}; // loc → [{key, occurrences}]

for (const loc of dedupLocales) {
  const b = blocks.find(b => b.name === loc);
  if (!b) continue;
  
  const blockContent = content.substring(b.openPos + 1, b.closePos);
  const counts = countKeyOccurrences(blockContent);
  const duplicates = Object.entries(counts).filter(([k, v]) => v > 1);
  
  if (duplicates.length > 0) {
    console.log(loc + ': ' + duplicates.length + ' duplicate keys');
    dupInfo[loc] = duplicates;
  }
}

// === APPLY CHANGES ===
console.log('\n=== APPLYING CHANGES ===');

// For each locale:
// 1. Remove orphan keys (exist in locale but not in en)
// 2. Remove duplicate occurrences (keep only the last occurrence of each key)
// 3. Insert missing keys

let newContent = content;

for (const loc of [...gapFillLocales, ...dedupLocales]) {
  const b = blocks.find(b => b.name === loc);
  if (!b) continue;
  
  // Re-parse the block fresh from newContent
  const updatedHeaders = findLocaleHeaders(newContent);
  const updatedB = updatedHeaders.find(h => h.name === loc);
  if (!updatedB) continue;
  
  const openPos = updatedB.pos;
  const closePos = findClosingBrace(newContent, openPos);
  const blockContent = newContent.substring(openPos + 1, closePos);
  
  const { keys: locKeys, kvPairs: locKV } = extractKeysAndValues(blockContent);
  const orphans = [...locKeys].filter(k => !enKeys.has(k));
  const missing = [...enKeys].filter(k => !locKeys.has(k));
  
  if (orphans.length === 0 && missing.length === 0) {
    console.log(loc + ': no changes needed');
    continue;
  }
  
  console.log(loc + ': ' + orphans.length + ' orphans, ' + missing.length + ' missing');
  
  // Step A: Remove orphan keys
  let modifiedBlock = blockContent;
  for (const orphan of orphans) {
    const escapedOrphan = orphan.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match "orphanKey": value, (with possible newlines and indentation)
    const re = new RegExp(
      '"' + escapedOrphan + '":\\s*(?:' +
        '(?:"[^"\\\\]*(?:\\\\.[^"\\\\]*)*")' + // string value
        '|(?:\\d+(?:\\.\\d+)?)' +              // number
        '|(?:true|false|null)' +               // literal
        '|(?:\\[[^\\]]*\\])' +                  // array
        '|(?:\\{[^}]*\\})' +                    // object
      ')\\s*,?\\s*\\n?',
      'g'
    );
    modifiedBlock = modifiedBlock.replace(re, '');
  }
  
  // Step B: Remove duplicate keys (keep last occurrence only)
  // Count occurrences in modifiedBlock
  const counts = {};
  const positions = [];
  let depth = 0, inStr = false, escape = false, currentKey = null, currentKeyStart = -1;
  for (let i = 0; i < modifiedBlock.length; i++) {
    const c = modifiedBlock[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') {
      if (!inStr) {
        const keyStartInner = i + 1;
        let j = i + 1;
        while (j < modifiedBlock.length && modifiedBlock[j] !== '"') j++;
        const key = modifiedBlock.substring(keyStartInner, j);
        let next = j + 1;
        while (next < modifiedBlock.length && (modifiedBlock[next] === ' ' || modifiedBlock[next] === '\t')) next++;
        if (depth === 0 && next < modifiedBlock.length && modifiedBlock[next] === ':') {
          currentKey = key;
          currentKeyStart = i;
        } else {
          currentKey = null;
        }
        i = j;
      } else {
        if (currentKey && depth === 0) {
          counts[currentKey] = (counts[currentKey] || 0) + 1;
          positions.push({ key: currentKey, start: currentKeyStart });
          currentKey = null;
        }
        const nextQuote = modifiedBlock.indexOf('"', i + 1);
        if (nextQuote === -1) break;
        i = nextQuote;
      }
      inStr = !inStr;
    } else if (!inStr) {
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === ',') { currentKey = null; }
    }
  }
  
  // For keys with count > 1, find first occurrences and remove them
  const toRemove = [];
  for (const [key, count] of Object.entries(counts)) {
    if (count > 1) {
      const keyPositions = positions.filter(p => p.key === key);
      // Keep the last one
      const firsts = keyPositions.slice(0, keyPositions.length - 1);
      toRemove.push(...firsts.map(p => p.start));
    }
  }
  
  // Remove from end to start to preserve positions
  toRemove.sort((a, b) => b - a);
  for (const start of toRemove) {
    // Find the entry boundaries - look back for newline+indent and forward for comma/newline
    let entryStart = start;
    // Find the start of the line (last \n before entry)
    let lineStart = modifiedBlock.lastIndexOf('\n', start);
    entryStart = lineStart >= 0 ? lineStart + 1 : 0;
    
    // Find entry end - look for comma, newline after the closing quote of value
    // First find the key's opening quote position in the entry
    const entryStartInBlock = entryStart;
    // Scan from entryStart to find the value's end and the comma after it
    let searchFrom = entryStart;
    // Find the closing quote of the value
    let valEnd = -1;
    let depth2 = 0, inStr2 = false, escape2 = false;
    for (let si = entryStart; si < modifiedBlock.length; si++) {
      const c = modifiedBlock[si];
      if (escape2) { escape2 = false; continue; }
      if (c === '\\') { escape2 = true; continue; }
      if (c === '"') {
        if (!inStr2) {
          inStr2 = true;
        } else {
          valEnd = si;
          inStr2 = false;
        }
      } else if (!inStr2) {
        if (c === '{') depth2++;
        else if (c === '}') { depth2--; if (depth2 < 0) break; }
        else if (c === ',' && depth2 === 0) { valEnd = si; break; }
      }
    }
    
    if (valEnd === -1) valEnd = modifiedBlock.indexOf('\n', entryStart);
    if (valEnd === -1) valEnd = modifiedBlock.length;
    
    // Remove from entryStart to valEnd+1 (inclusive comma/newline)
    modifiedBlock = modifiedBlock.substring(0, entryStart) + modifiedBlock.substring(valEnd + 1);
  }
  
  // Step C: Insert missing keys
  if (missing.length > 0) {
    // Insert before the closing brace (at the end of the block)
    const insertEntries = missing.map(m => {
      const val = enKV[m] !== undefined ? enKV[m] : m.replace(/_/g, ' ');
      return '        "' + m + '": "' + val + '"';
    }).join(',\n');
    
    // Insert at closePos - 1 (before the closing brace)
    const insertAt = closePos - (openPos + 1); // relative to block start
    modifiedBlock = modifiedBlock + '\n' + insertEntries + ',\n    ';
  }
  
  // Replace in newContent
  newContent = newContent.substring(0, openPos + 1) + modifiedBlock + newContent.substring(closePos);
  
  // Re-find blocks for next iteration
  blocks.length = 0;
  const allHeaders = findLocaleHeaders(newContent);
  for (const h of allHeaders) {
    blocks.push({ name: h.name, openPos: h.pos, closePos: findClosingBrace(newContent, h.pos) });
  }
}

// === Save ===
const hasChanges = newContent !== content;
if (hasChanges) {
  fs.writeFileSync(filePath, newContent);
  console.log('\n=== Saved ===');
  console.log('New size:', newContent.length);
} else {
  console.log('\n=== No changes ===');
}

// === Verification ===
console.log('\n=== VERIFICATION ===');
const finalHeaders = findLocaleHeaders(newContent);
const finalBlocks = finalHeaders.map(h => ({
  name: h.name,
  openPos: h.pos,
  closePos: findClosingBrace(newContent, h.pos)
}));

const finalEn = finalBlocks.find(b => b.name === 'en');
const finalEnContent = newContent.substring(finalEn.openPos + 1, finalEn.closePos);
const { keys: finalEnKeys } = extractKeysAndValues(finalEnContent);
console.log('EN keys:', finalEnKeys.size);

for (const loc of ['zh', 'ja', 'ko', 'th', 'vi', 'id', 'fr', 'es', 'de', 'ms', 'hi', 'ar']) {
  const b = finalBlocks.find(b => b.name === loc);
  if (!b) continue;
  const blockContent = newContent.substring(b.openPos + 1, b.closePos);
  const { keys: locKeys } = extractKeysAndValues(blockContent);
  const missing = [...finalEnKeys].filter(k => !locKeys.has(k));
  const orphans = [...locKeys].filter(k => !finalEnKeys.has(k));
  if (missing.length > 0 || orphans.length > 0) {
    console.log(loc + ': keys=' + locKeys.size + ' MISSING=' + missing.length + ' ORPHANS=' + orphans.length);
    if (missing.length > 0 && missing.length <= 5) console.log('  Missing:', missing.slice(0, 5).join(', '));
    if (orphans.length > 0 && orphans.length <= 5) console.log('  Orphans:', orphans.slice(0, 5).join(', '));
  } else {
    console.log(loc + ': OK keys=' + locKeys.size);
  }
}