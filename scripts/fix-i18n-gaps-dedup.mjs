#!/usr/bin/env node
/**
 * i18n.js Gap Fill + Dedup Script
 * 
 * Task A: Add missing keys to hi, ms, ko, ja, ar from en baseline
 * Task B: Remove duplicate keys from zh, ja, ko, ar (keep last occurrence)
 * 
 * Uses targeted block editing - never wholesale rewrite
 */
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'backend/public/shared/i18n.js');
let content = fs.readFileSync(filePath, 'utf8');

// === Step 1: Parse all locale blocks ===
const NL = '\n';
const localeRegex = /(?:^|\n)\s+([a-z]{2}(?:-[A-Z]{2})?):\s*\{/gm;
const localeStarts = [];
let m;
while ((m = localeRegex.exec(content)) !== null) {
  localeStarts.push({ name: m[1], pos: m.index });
}
localeStarts.push({ name: '__END__', pos: content.length });

console.log('Found locales:', localeStarts.map(l => l.name).join(', '));

// === Step 2: Extract EN key:value pairs (all depths, for gap filling) ===
function extractKeyValues(block) {
  const result = {};
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
        const key = enBlock.substring(keyStart, j);
        let next = j + 1;
        while (next < block.length && (block[next] === ' ' || block[next] === '\t')) next++;
        if (next < block.length && block[next] === ':' && !prevWasColon) {
          currentKey = key;
          prevWasColon = true;
        } else {
          currentKey = null;
          prevWasColon = false;
        }
        i = j;
      } else {
        if (currentKey) {
          result[currentKey] = block.substring(i + 1, block.indexOf('"', i + 1));
          currentKey = null;
        }
      }
      inStr = !inStr;
    } else if (!inStr) {
      if (c === ',') { prevWasColon = false; currentKey = null; }
      else if (c === '{') { depth++; currentKey = null; }
      else if (c === '}') { depth--; currentKey = null; }
    }
  }
  return result;
}

const enBrace = content.indexOf('{', localeStarts[0].pos + 3);
const enBlock = content.substring(enBrace + 1, localeStarts[1].pos - 1);
const enKeyValues = extractKeyValues(enBlock);
console.log('EN key:value pairs:', Object.keys(enKeyValues).length);

// === Step 3: For each target locale, find missing keys ===
const targets = ['hi', 'ms', 'ko', 'ja', 'ar'];

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

const localeBlocks = {};
for (let i = 0; i < localeStarts.length - 1; i++) {
  const loc = localeStarts[i].name;
  const bracePos = content.indexOf('{', localeStarts[i].pos + loc.length + 2);
  const blockStart = bracePos + 1;
  const blockEnd = localeStarts[i + 1].pos - 1;
  const block = content.substring(blockStart, blockEnd);
  localeBlocks[loc] = { blockStart, blockEnd, block, keys: extractAllKeys(block) };
}

// === Step 4: Calculate gaps ===
console.log('\n=== Gap Analysis ===');
const gaps = {};
for (const loc of targets) {
  const missing = [...localeBlocks.en.keys].filter(k => !localeBlocks[loc].keys.has(k));
  gaps[loc] = missing;
  console.log(loc + ': missing ' + missing.length + ' keys');
}

// === Step 5: Dedup analysis for zh, ja, ko, ar ===
console.log('\n=== Dedup Analysis ===');
function findDuplicateKeys(block) {
  const keyPositions = []; // [{key, start, end}]
  let inStr = false, escape = false, prevWasColon = false, currentKey = null, currentStart = 0;
  let depth = 0;
  
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
        } else {
          currentKey = null;
          prevWasColon = false;
        }
        i = j;
      } else {
        if (currentKey) {
          keyPositions.push({ key: currentKey, start: currentStart, end: i });
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
  
  // Find duplicates (keys appearing more than once at depth=1)
  const keyFirst = {};
  const keyLast = {};
  for (const { key, start, end } of keyPositions) {
    if (!keyFirst[key]) keyFirst[key] = { start, end };
    keyLast[key] = { start, end };
  }
  
  const duplicates = {};
  for (const [key, first] of Object.entries(keyFirst)) {
    const occurrences = keyPositions.filter(p => p.key === key);
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

const dedupLocales = ['zh', 'ja', 'ko', 'ar'];
const duplicateKeys = {};
for (const loc of dedupLocales) {
  if (!localeBlocks[loc]) continue;
  const dups = findDuplicateKeys(localeBlocks[loc].block);
  duplicateKeys[loc] = dups;
  console.log(loc + ': ' + Object.keys(dups).length + ' duplicate keys');
  if (Object.keys(dups).length > 0 && Object.keys(dups).length <= 10) {
    for (const [key, info] of Object.entries(dups)) {
      console.log('  ' + key + ': ' + info.all.length + ' occurrences');
    }
  }
}

console.log('\n=== Summary ===');
console.log('Gaps to fill:', Object.entries(gaps).map(([loc, keys]) => loc + '=' + keys.length).join(', '));
console.log('Duplicate key sets to clean:', Object.entries(duplicateKeys).map(([loc, d]) => loc + '=' + Object.keys(d).length).join(', '));
console.log('\nThis script is a dry-run. Implementing changes...');