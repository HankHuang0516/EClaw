#!/usr/bin/env node
/**
 * i18n Gap Fill + Dedup Implementation
 * 
 * Gap fill: add missing keys to hi, ms, ko, ja, ar from en baseline
 * Dedup: remove duplicate keys from zh, ja, ko, ar (keep last occurrence)
 * 
 * Uses targeted block editing - one locale at a time
 */
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'backend/public/shared/i18n.js');
let content = fs.readFileSync(filePath, 'utf8');

console.log('File size:', content.length, 'bytes');

// === Parse locale blocks ===
const localeRegex = /(?:^|\n)\s+([a-z]{2}(?:-[A-Z]{2})?):\s*\{/gm;
const localeStarts = [];
let m;
while ((m = localeRegex.exec(content)) !== null) {
  localeStarts.push({ name: m[1], pos: m.index });
}
localeStarts.push({ name: '__END__', pos: content.length });

console.log('Locales:', localeStarts.slice(0, -1).map(l => l.name).join(', '));

// === Helper functions ===

function extractAllKeys(block) {
  const keys = new Set();
  let inStr = false, escape = false, prevWasColon = false;
  for (let i = 0; i < block.length; i++) {
    const c = block[i];
    if (escape) { escape = false; i++; continue; }
    if (c === '\\') { escape = true; i++; continue; }
    if (c === '"') {
      if (!inStr) {
        let j = i + 1;
        while (j < block.length && block[j] !== '"') j++;
        let next = j + 1;
        while (next < block.length && (block[next] === ' ' || block[next] === '\t')) next++;
        if (next < block.length && block[next] === ':' && !prevWasColon) {
          keys.add(block.substring(i + 1, j));
          prevWasColon = true;
        } else { prevWasColon = false; }
        i = j;
      }
      inStr = !inStr;
    } else if (!inStr) {
      if (c === ',') prevWasColon = false;
    }
  }
  return keys;
}

function extractKeyValues(block) {
  // Extract top-level key->value pairs (string values only)
  const pairs = {};
  let depth = 0, inStr = false, escape = false, prevWasColon = false, currentKey = null, strStart = -1;
  
  for (let i = 0; i < block.length; i++) {
    const c = block[i];
    if (escape) { escape = false; i++; continue; }
    if (c === '\\') { escape = true; i++; continue; }
    if (c === '"') {
      if (!inStr) {
        strStart = i;
        const keyStart = i + 1;
        let j = i + 1;
        while (j < block.length && block[j] !== '"') j++;
        const key = block.substring(keyStart, j);
        let next = j + 1;
        while (next < block.length && (block[next] === ' ' || block[next] === '\t')) next++;
        if (depth === 1 && next < block.length && block[next] === ':' && !prevWasColon) {
          currentKey = key;
          prevWasColon = true;
        } else {
          prevWasColon = false;
        }
        i = j;
      } else {
        if (currentKey && depth === 1) {
          pairs[currentKey] = block.substring(strStart + 1, i);
          currentKey = null;
        }
        prevWasColon = false;
      }
      inStr = !inStr;
    } else if (!inStr) {
      if (c === ',') { prevWasColon = false; currentKey = null; }
      else if (c === '{') { depth++; currentKey = null; }
      else if (c === '}') { depth--; currentKey = null; }
    }
  }
  return pairs;
}

function findDuplicateKeyOccurrences(block) {
  // Find all top-level key occurrences with their positions
  const positions = [];
  let depth = 0, inStr = false, escape = false, prevWasColon = false, currentKey = null, keyStart = -1;
  
  for (let i = 0; i < block.length; i++) {
    const c = block[i];
    if (escape) { escape = false; i++; continue; }
    if (c === '\\') { escape = true; i++; continue; }
    if (c === '"') {
      if (!inStr) {
        keyStart = i;
        const ks = i + 1;
        let j = i + 1;
        while (j < block.length && block[j] !== '"') j++;
        const key = block.substring(ks, j);
        let next = j + 1;
        while (next < block.length && (block[next] === ' ' || block[next] === '\t')) next++;
        if (depth === 1 && next < block.length && block[next] === ':' && !prevWasColon) {
          currentKey = key;
          prevWasColon = true;
        } else {
          currentKey = null;
          prevWasColon = false;
        }
        i = j;
      } else {
        if (currentKey && depth === 1) {
          positions.push({ key: currentKey, start: keyStart, end: i });
        }
        currentKey = null;
      }
      inStr = !inStr;
    } else if (!inStr) {
      if (c === ',') { prevWasColon = false; currentKey = null; }
      else if (c === '{') { depth++; currentKey = null; }
      else if (c === '}') { depth--; currentKey = null; }
    }
  }
  
  // Find duplicates
  const keyOccurrences = {};
  for (const pos of positions) {
    if (!keyOccurrences[pos.key]) keyOccurrences[pos.key] = [];
    keyOccurrences[pos.key].push(pos);
  }
  
  const dups = {};
  for (const [key, occs] of Object.entries(keyOccurrences)) {
    if (occs.length > 1) {
      dups[key] = occs; // Array of occurrences, first is earliest, last is latest
    }
  }
  return dups;
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

console.log('\nEN top-level keys:', enKeys.size);
console.log('EN top-level key:value pairs:', Object.keys(enKV).length);

// === DEDUP PHASE ===
console.log('\n=== DEDUP PHASE ===');
const dedupLocales = ['zh', 'ja', 'ko', 'ar'];
for (const loc of dedupLocales) {
  const lb = localeBlocks[loc];
  const dups = findDuplicateKeyOccurrences(lb.block);
  
  if (Object.keys(dups).length === 0) {
    console.log(loc + ': no duplicates');
    continue;
  }
  
  console.log(loc + ': ' + Object.keys(dups).length + ' duplicate keys');
  
  // Remove FIRST occurrence of each duplicate, keeping last
  // Work from end of block backwards to preserve positions
  let newContent = content;
  
  for (const [key, occurrences] of Object.entries(dups)) {
    const first = occurrences[0];
    const last = occurrences[occurrences.length - 1];
    
    // Find the extent of the FIRST occurrence entry
    // Start from first.start (opening quote of key)
    // End at the comma that follows the value (or } if at end of block)
    
    // Find where this entry starts (beginning of line)
    let entryStart = first.start;
    while (entryStart > lb.blockStart && newContent[entryStart - 1] !== '\n') entryStart--;
    
    // Find where this entry ends
    // Start from first.end (closing quote of key)
    // Skip colon and value
    let searchPos = first.end + 1;
    while (searchPos < newContent.length && (newContent[searchPos] === ' ' || newContent[searchPos] === '\t')) searchPos++;
    
    // Skip colon
    if (newContent[searchPos] === ':') searchPos++;
    while (searchPos < newContent.length && (newContent[searchPos] === ' ' || newContent[searchPos] === '\t')) searchPos++;
    
    // Now at value start - find the end
    let valueEnd = searchPos;
    if (newContent[searchPos] === '"') {
      // String value
      let s = searchPos + 1;
      while (s < newContent.length) {
        if (newContent[s] === '\\') { s += 2; continue; }
        if (newContent[s] === '"') { valueEnd = s + 1; break; }
        s++;
      }
    } else if (newContent[searchPos] === '{') {
      // Object value
      let depth = 1, s = searchPos + 1, inStr = false;
      while (s < newContent.length && depth > 0) {
        if (newContent[s] === '"') inStr = !inStr;
        else if (!inStr && newContent[s] === '{') depth++;
        else if (!inStr && newContent[s] === '}') depth--;
        s++;
      }
      valueEnd = s;
    } else if (newContent[searchPos] === '[') {
      // Array value
      let depth = 1, s = searchPos + 1, inStr = false;
      while (s < newContent.length && depth > 0) {
        if (newContent[s] === '"') inStr = !inStr;
        else if (!inStr && newContent[s] === '[') depth++;
        else if (!inStr && newContent[s] === ']') depth--;
        s++;
      }
      valueEnd = s;
    } else {
      // Number, boolean, null
      let s = searchPos;
      while (s < newContent.length && newContent[s] !== ',' && newContent[s] !== '\n' && newContent[s] !== '}') s++;
      valueEnd = s;
    }
    
    // Find trailing comma or closing brace
    let afterValue = valueEnd;
    while (afterValue < newContent.length && (newContent[afterValue] === ' ' || newContent[afterValue] === '\t')) afterValue++;
    if (newContent[afterValue] === ',') afterValue++;
    
    const entryEnd = afterValue;
    const entry = newContent.substring(entryStart, entryEnd);
    
    console.log('  Removing first occurrence of "' + key + '" (entry at ' + entryStart + '-' + entryEnd + '):');
    console.log('    ' + entry.replace(/\n/g, '\\n').substring(0, 80) + '...');
    
    newContent = newContent.substring(0, entryStart) + newContent.substring(entryEnd);
  }
  
  content = newContent;
  // Update locale block data
  const newBlockStart = lb.blockStart;
  const newBlockEnd = lb.blockEnd;
  // Recalculate block
  const updatedLocaleIdx = localeStarts.findIndex(l => l.name === loc);
  const newBracePos = content.indexOf('{', localeStarts[updatedLocaleIdx].pos + loc.length + 2);
  const newBlockStartUpdated = newBracePos + 1;
  const newBlockEndUpdated = localeStarts[updatedLocaleIdx + 1].pos - 1;
  const newBlock = content.substring(newBlockStartUpdated, newBlockEndUpdated);
  localeBlocks[loc] = {
    blockStart: newBlockStartUpdated,
    blockEnd: newBlockEndUpdated,
    block: newBlock,
    keys: extractAllKeys(newBlock),
    kvPairs: extractKeyValues(newBlock)
  };
}

// === GAP FILL PHASE ===
console.log('\n=== GAP FILL PHASE ===');
const targetLocales = ['hi', 'ms', 'ko', 'ja', 'ar'];
for (const loc of targetLocales) {
  const lb = localeBlocks[loc];
  const missing = [...enKeys].filter(k => !lb.keys.has(k));
  const orphans = [...lb.keys].filter(k => !enKeys.has(k));
  
  console.log(loc + ': missing=' + missing.length + ', extra=' + orphans.length);
  
  if (missing.length > 0) {
    // Generate insertions for missing keys
    // For each missing key, we need to find where to insert it in the locale block
    // Strategy: find the position just before the closing brace of the locale block
    // Insert each missing key as "key": "enValue" (using English value as placeholder)
    
    // Find the insertion point (just before the closing } of the locale block)
    const insertionPoint = lb.blockEnd - 1; // Position of closing }
    
    // Generate new entries
    const newEntries = [];
    for (const key of missing) {
      const enValue = enKV[key] !== undefined ? enKV[key] : '';
      newEntries.push('    "' + key + '": "' + enValue + '"');
    }
    
    const insertions = newEntries.join(',\n') + ',\n';
    
    console.log('  Inserting ' + missing.length + ' missing keys at position ' + insertionPoint);
    
    content = content.substring(0, insertionPoint) + insertions + content.substring(insertionPoint);
    
    // Update locale block data
    const updatedLocaleIdx = localeStarts.findIndex(l => l.name === loc);
    const newBracePos = content.indexOf('{', localeStarts[updatedLocaleIdx].pos + loc.length + 2);
    const newBlockStartUpdated = newBracePos + 1;
    const newBlockEndUpdated = localeStarts[updatedLocaleIdx + 1].pos - 1;
    const newBlock = content.substring(newBlockStartUpdated, newBlockEndUpdated);
    localeBlocks[loc] = {
      blockStart: newBlockStartUpdated,
      blockEnd: newBlockEndUpdated,
      block: newBlock,
      keys: extractAllKeys(newBlock),
      kvPairs: extractKeyValues(newBlock)
    };
  }
}

// === Save ===
fs.writeFileSync(filePath, content);
console.log('\n=== Saved changes ===');
console.log('New file size:', content.length, 'bytes');

// === Verification ===
console.log('\n=== Verification ===');
const updatedLocaleRegex = /(?:^|\n)\s+([a-z]{2}(?:-[A-Z]{2})?):\s*\{/gm;
const updatedLocaleStarts = [];
let um;
while ((um = updatedLocaleRegex.exec(content)) !== null) {
  updatedLocaleStarts.push({ name: um[1], pos: um.index });
}
updatedLocaleStarts.push({ name: '__END__', pos: content.length });

for (const loc of ['en', 'zh', 'ja', 'ko', 'th', 'vi', 'id', 'fr', 'es', 'de', 'ms', 'hi', 'ar']) {
  const idx = updatedLocaleStarts.findIndex(l => l.name === loc);
  if (idx < 0) continue;
  const bracePos = content.indexOf('{', updatedLocaleStarts[idx].pos + loc.length + 2);
  const blockStart = bracePos + 1;
  const blockEnd = updatedLocaleStarts[idx + 1].pos - 1;
  const block = content.substring(blockStart, blockEnd);
  const keys = extractAllKeys(block);
  
  if (loc === 'en') {
    console.log(loc + ': ' + keys.size + ' keys');
    continue;
  }
  
  const enUpdatedKeys = extractAllKeys(content.substring(
    content.indexOf('{', updatedLocaleStarts[0].pos + 3) + 1,
    updatedLocaleStarts[1].pos - 1
  ));
  
  const missing = [...enUpdatedKeys].filter(k => !keys.has(k));
  const extra = [...keys].filter(k => !enUpdatedKeys.has(k));
  console.log(loc + ': keys=' + keys.size + ' missing=' + missing.length + ' extra=' + extra.length);
}