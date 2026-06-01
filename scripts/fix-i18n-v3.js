#!/usr/bin/env node
/**
 * i18n Gap Fill + Dedup Implementation
 * Gap fill: add missing keys to hi, ms, ko, ja, ar from en baseline
 * Dedup: remove duplicate keys from zh, ja, ko, ar (keep last occurrence)
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

function findDuplicateKeyOccurrences(block, blockStart) {
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
          positions.push({ key: currentKey, start: blockStart + keyStart, end: blockStart + i });
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
  
  const keyOccurrences = {};
  for (const pos of positions) {
    if (!keyOccurrences[pos.key]) keyOccurrences[pos.key] = [];
    keyOccurrences[pos.key].push(pos);
  }
  
  const dups = {};
  for (const [key, occs] of Object.entries(keyOccurrences)) {
    if (occs.length > 1) {
      dups[key] = occs;
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
console.log('EN keys:', enKeys.size, '| EN kvPairs:', Object.keys(enKV).length);

// === DEDUP PHASE ===
console.log('\n=== DEDUP PHASE ===');
const dedupLocales = ['zh', 'ja', 'ko', 'ar'];
let dedupChanges = 0;

for (const loc of dedupLocales) {
  const lb = localeBlocks[loc];
  const dups = findDuplicateKeyOccurrences(lb.block, lb.blockStart);
  
  if (Object.keys(dups).length === 0) {
    console.log(loc + ': no duplicates');
    continue;
  }
  
  console.log(loc + ': ' + Object.keys(dups).length + ' duplicate keys (' + Object.entries(dups).reduce((s,[,occs])=>s+occs.length-1,0) + ' extras)');
  
  // Remove first occurrence of each duplicate (keep last)
  // Sort occurrences by position descending so we remove from end first
  for (const [key, occurrences] of Object.entries(dups)) {
    const first = occurrences[0];
    
    // Find entry start (beginning of line)
    let entryStart = first.start;
    while (entryStart > lb.blockStart && content[entryStart - 1] !== '\n') entryStart--;
    
    // Find entry end
    let searchPos = first.end + 1;
    while (searchPos < content.length && (content[searchPos] === ' ' || content[searchPos] === '\t')) searchPos++;
    if (content[searchPos] === ':') searchPos++;
    while (searchPos < content.length && (content[searchPos] === ' ' || content[searchPos] === '\t')) searchPos++;
    
    let valueEnd = searchPos;
    if (content[searchPos] === '"') {
      let s = searchPos + 1;
      while (s < content.length) {
        if (content[s] === '\\') { s += 2; continue; }
        if (content[s] === '"') { valueEnd = s + 1; break; }
        s++;
      }
    } else if (content[searchPos] === '{') {
      let depth = 1, s = searchPos + 1, inStr = false;
      while (s < content.length && depth > 0) {
        if (content[s] === '"') inStr = !inStr;
        else if (!inStr && content[s] === '{') depth++;
        else if (!inStr && content[s] === '}') depth--;
        s++;
      }
      valueEnd = s;
    } else if (content[searchPos] === '[') {
      let depth = 1, s = searchPos + 1, inStr = false;
      while (s < content.length && depth > 0) {
        if (content[s] === '"') inStr = !inStr;
        else if (!inStr && content[s] === '[') depth++;
        else if (!inStr && content[s] === ']') depth--;
        s++;
      }
      valueEnd = s;
    } else {
      let s = searchPos;
      while (s < content.length && content[s] !== ',' && content[s] !== '\n' && content[s] !== '}') s++;
      valueEnd = s;
    }
    
    let afterValue = valueEnd;
    while (afterValue < content.length && (content[afterValue] === ' ' || content[afterValue] === '\t')) afterValue++;
    if (afterValue < content.length && content[afterValue] === ',') afterValue++;
    
    const entryEnd = afterValue;
    const entryStr = content.substring(entryStart, entryEnd);
    
    console.log('  ' + loc + '.' + key + ': remove entry at ' + entryStart + '-' + entryEnd);
    console.log('    "' + entryStr.replace(/\n/g, '\\n').substring(0, 60) + '"');
    
    content = content.substring(0, entryStart) + content.substring(entryEnd);
    dedupChanges++;
  }
  
  // Update locale block for next iteration
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

console.log('Dedup changes:', dedupChanges);

// === GAP FILL PHASE ===
console.log('\n=== GAP FILL PHASE ===');
const targetLocales = ['hi', 'ms', 'ko', 'ja', 'ar'];
let gapChanges = 0;

for (const loc of targetLocales) {
  const lb = localeBlocks[loc];
  const missing = [...enKeys].filter(k => !lb.keys.has(k));
  
  console.log(loc + ': ' + missing.length + ' missing keys');
  
  if (missing.length > 0) {
    // Find insertion point: just before the closing } of the locale block
    const insertionPoint = lb.blockEnd - 1;
    
    // Generate new entries
    const newEntries = [];
    for (const key of missing) {
      const enValue = enKV[key] !== undefined ? enKV[key] : '';
      newEntries.push('    "' + key + '": "' + enValue + '"');
    }
    
    const insertions = newEntries.join(',\n') + ',\n';
    
    console.log('  Inserting at position ' + insertionPoint);
    
    content = content.substring(0, insertionPoint) + insertions + content.substring(insertionPoint);
    gapChanges += missing.length;
    
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

console.log('Gap fill changes:', gapChanges);

// === Save ===
fs.writeFileSync(filePath, content);
console.log('\n=== Saved ===');
console.log('New file size:', content.length);

// === Verification ===
console.log('\n=== Verification ===');
const updatedLocaleRegex = /(?:^|\n)\s+([a-z]{2}(?:-[A-Z]{2})?):\s*\{/gm;
const updatedLocaleStarts = [];
let um;
while ((um = updatedLocaleRegex.exec(content)) !== null) {
  updatedLocaleStarts.push({ name: um[1], pos: um.index });
}
updatedLocaleStarts.push({ name: '__END__', pos: content.length });

const enBracePos = content.indexOf('{', updatedLocaleStarts[0].pos + 3);
const enBlockStart = enBracePos + 1;
const enBlockEnd = updatedLocaleStarts[1].pos - 1;
const enBlock = content.substring(enBlockStart, enBlockEnd);
const enKeySet = extractAllKeys(enBlock);

console.log('EN keys after changes:', enKeySet.size);

for (const loc of ['zh', 'ja', 'ko', 'th', 'vi', 'id', 'fr', 'es', 'de', 'ms', 'hi', 'ar']) {
  const idx = updatedLocaleStarts.findIndex(l => l.name === loc);
  if (idx < 0) { console.log(loc + ': not found'); continue; }
  const bracePos = content.indexOf('{', updatedLocaleStarts[idx].pos + loc.length + 2);
  const blockStart = bracePos + 1;
  const blockEnd = updatedLocaleStarts[idx + 1].pos - 1;
  const block = content.substring(blockStart, blockEnd);
  const keys = extractAllKeys(block);
  const missing = [...enKeySet].filter(k => !keys.has(k));
  const extra = [...keys].filter(k => !enKeySet.has(k));
  console.log(loc + ': keys=' + keys.size + ' missing=' + missing.length + ' extra=' + extra.length);
  if (missing.length > 0 && missing.length <= 5) console.log('  MISSING:', missing.join(', '));
  if (extra.length > 0 && extra.length <= 5) console.log('  EXTRA:', extra.join(', '));
}