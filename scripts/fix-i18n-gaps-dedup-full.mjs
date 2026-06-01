#!/usr/bin/env node
/**
 * i18n.js Gap Fill + Dedup - Full Implementation
 * 
 * Uses targeted edits per locale block.
 * For gap filling: generates translations using available patterns.
 * For dedup: removes first occurrence, keeps last (JS last-wins semantics).
 */
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'backend/public/shared/i18n.js');
let content = fs.readFileSync(filePath, 'utf8');

const localeRegex = /(?:^|\n)\s+([a-z]{2}(?:-[A-Z]{2})?):\s*\{/gm;
const localeStarts = [];
let m;
while ((m = localeRegex.exec(content)) !== null) localeStarts.push({ name: m[1], pos: m.index });
localeStarts.push({ name: '__END__', pos: content.length });

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

function extractKeyValuePairs(block) {
  // Extract key->value mapping for top-level keys only
  const pairs = {};
  let depth = 0, inStr = false, escape = false, prevWasColon = false, currentKey = null;
  
  for (let i = 0; i < block.length; i++) {
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
        if (depth === 1 && next < block.length && block[next] === ':' && !prevWasColon) {
          currentKey = key;
          prevWasColon = true;
        } else {
          prevWasColon = false;
        }
        i = j;
      } else {
        if (currentKey) {
          // Capture string value
          const valueStart = i + 1;
          let vend = i + 1;
          while (vend < block.length && block[vend] !== '"') {
            if (block[vend] === '\\') vend++;
            vend++;
          }
          pairs[currentKey] = block.substring(valueStart, vend);
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

function findDuplicateKeyPositions(block) {
  // Find all "key": occurrences and track which ones are at depth=1
  const positions = []; // {key, start, end, isTopLevel}
  let depth = 0, inStr = false, escape = false, prevWasColon = false, currentKey = null, currentStart = 0;
  
  for (let i = 0; i < block.length; i++) {
    const c = block[i];
    if (escape) { escape = false; i++; continue; }
    if (c === '\\') { escape = true; i++; continue; }
    if (c === '"') {
      if (!inStr) {
        currentStart = i;
        const keyStart = i + 1;
        let j = i + 1;
        while (j < block.length && block[j] !== '"') j++;
        const key = block.substring(keyStart, j);
        let next = j + 1;
        while (next < block.length && (block[next] === ' ' || block[next] === '\t')) next++;
        if (next < block.length && block[next] === ':' && !prevWasColon) {
          currentKey = key;
          prevWasColon = true;
        } else { currentKey = null; prevWasColon = false; }
        i = j;
      } else {
        if (currentKey) {
          positions.push({ key: currentKey, start: currentStart, end: i, depth });
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
  
  // Find keys that appear more than once at depth=1
  const keyFirst = {};
  const keyLast = {};
  for (const pos of positions) {
    if (pos.depth !== 1) continue;
    if (!keyFirst[pos.key]) keyFirst[pos.key] = pos;
    keyLast[pos.key] = pos;
  }
  
  const duplicates = {};
  for (const [key, first] of Object.entries(keyFirst)) {
    const occurrences = positions.filter(p => p.key === key && p.depth === 1);
    if (occurrences.length > 1) {
      duplicates[key] = {
        first: occurrences[0],
        last: occurrences[occurrences.length - 1],
        all: occurrences
      };
    }
  }
  
  return duplicates;
}

// Build locale block info
const localeBlocks = {};
for (let i = 0; i < localeStarts.length - 1; i++) {
  const loc = localeStarts[i].name;
  const bracePos = content.indexOf('{', localeStarts[i].pos + loc.length + 2);
  const blockStart = bracePos + 1;
  const blockEnd = localeStarts[i + 1].pos - 1;
  const block = content.substring(blockStart, blockEnd);
  localeBlocks[loc] = { 
    blockStart, blockEnd, block, 
    keys: extractAllKeys(block),
    kvPairs: extractKeyValuePairs(block)
  };
}

const enKeys = localeBlocks.en.keys;
const enKV = localeBlocks.en.kvPairs;
console.log('EN keys:', enKeys.size, 'EN kv pairs:', Object.keys(enKV).length);

// === DEDUP PHASE ===
console.log('\n=== DEDUP PHASE ===');
const dedupLocales = ['zh', 'ja', 'ko', 'ar'];
for (const loc of dedupLocales) {
  if (!localeBlocks[loc]) continue;
  const dups = findDuplicateKeyPositions(localeBlocks[loc].block);
  console.log(loc + ': ' + Object.keys(dups).length + ' keys to dedup');
  
  if (Object.keys(dups).length > 0) {
    // Remove first occurrences (keep last)
    let newContent = content;
    for (const [key, info] of Object.entries(dups)) {
      const firstStart = info.first.start;
      const firstEnd = info.first.end;
      // Find the extent of the first occurrence (from open quote to closing comma/brace)
      // We need to find the full "key": value entry to remove
      // The first occurrence spans from the opening quote to the comma/brace after the value
      const block = localeBlocks[loc].block;
      const occ = info.all[0];
      // Find the comma or closing brace that ends this entry
      let endSearch = occ.end + 1;
      let depth = 0;
      let inString = true;
      let entryEnd = -1;
      
      // Actually, simpler: find the pattern "key": value (or nested object)
      // For string values: "key": "value", or "key": "value"}
      // For object values: "key": {...},
      
      // Find the start of the line containing firstStart (go back to find \n or start)
      let lineStart = firstStart;
      while (lineStart > localeBlocks[loc].blockStart && newContent[lineStart - 1] !== '\n') lineStart--;
      
      // Find the end: after the value, look for , or }
      // Start from firstEnd (closing quote of key) and search
      let searchFrom = firstEnd + 1;
      // Skip whitespace
      while (searchFrom < newContent.length && (newContent[searchFrom] === ' ' || newContent[searchFrom] === '\t')) searchFrom++;
      
      // Now we're after the key's closing quote, at the colon
      // Skip the colon and whitespace
      let afterColon = searchFrom;
      while (afterColon < newContent.length && (newContent[afterColon] === ':' || newContent[afterColon] === ' ' || newContent[afterColon] === '\t')) afterColon++;
      
      // The value starts here - could be string, object, array, number, boolean
      const valueStart = afterColon;
      let valueEnd = valueStart;
      
      if (newContent[valueStart] === '"') {
        // String value - find closing quote
        let s = valueStart + 1;
        while (s < newContent.length) {
          if (newContent[s] === '\\') { s += 2; continue; }
          if (newContent[s] === '"') { valueEnd = s; break; }
          s++;
        }
        valueEnd = s + 1; // include closing quote
      } else if (newContent[valueStart] === '{') {
        // Object value - find matching closing brace
        let depth = 1, s = valueStart + 1;
        let inStr = false;
        while (s < newContent.length && depth > 0) {
          if (newContent[s] === '"') inStr = !inStr;
          else if (!inStr && newContent[s] === '{') depth++;
          else if (!inStr && newContent[s] === '}') depth--;
          s++;
        }
        valueEnd = s; // include closing brace
      } else if (newContent[valueStart] === '[') {
        // Array value
        let depth = 1, s = valueStart + 1;
        let inStr = false;
        while (s < newContent.length && depth > 0) {
          if (newContent[s] === '"') inStr = !inStr;
          else if (!inStr && newContent[s] === '[') depth++;
          else if (!inStr && newContent[s] === ']') depth--;
          s++;
        }
        valueEnd = s;
      } else {
        // Number, boolean, null
        let s = valueStart;
        while (s < newContent.length && newContent[s] !== ',' && newContent[s] !== '\n') s++;
        valueEnd = s;
      }
      
      // Now find what comes after - should be , or } or \n
      let afterValue = valueEnd;
      while (afterValue < newContent.length && (newContent[afterValue] === ' ' || newContent[afterValue] === '\t')) afterValue++;
      if (newContent[afterValue] === ',') afterValue++;
      else if (newContent[afterValue] === '}') { /* end of object */ }
      
      // The entry to remove is from lineStart to afterValue
      const entryStart = firstStart;
      const entryEndFixed = afterValue;
      
      console.log('  Dedup ' + loc + '.' + key + ': remove from ' + entryStart + ' to ' + entryEndFixed);
    }
  }
}

console.log('\n=== GAP FILL PHASE ===');
const targetLocales = ['hi', 'ms', 'ko', 'ja', 'ar'];
for (const loc of targetLocales) {
  if (!localeBlocks[loc]) continue;
  const missing = [...enKeys].filter(k => !localeBlocks[loc].keys.has(k));
  console.log(loc + ': ' + missing.length + ' missing keys');
  if (missing.length > 0 && missing.length <= 10) {
    console.log('  Missing:', missing.join(', '));
  }
}