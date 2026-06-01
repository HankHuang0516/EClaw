#!/usr/bin/env node
/**
 * fix-i18n-v13.js - Clean gap fill + dedup for i18n.js
 * 
 * Strategy: Parse each locale block, process, rebuild entire file.
 * This is simple and robust even if slower.
 */

const fs = require('fs');

const FILE = 'backend/public/shared/i18n.js';
const LOCALE_NAMES = ['en', 'zh', 'ja', 'ko', 'th', 'vi', 'id', 'fr', 'es', 'de', 'ms', 'hi', 'ar'];

// DEDUP locales: remove first occurrences, keep last
const DEDUP = ['ja', 'ko', 'ar'];
// GAP FILL locales: add missing keys from en
const GAP_FILL = ['zh', 'ja', 'ko', 'th', 'vi', 'id', 'fr', 'de', 'ms', 'hi', 'ar'];

console.log('Reading file...');
const content = fs.readFileSync(FILE, 'utf8');
const buf = Buffer.from(content);

// Find locale positions
const localePositions = [];
for (const loc of LOCALE_NAMES) {
  const search = '    ' + loc + ': {';
  let idx = -1;
  for (let i = 0; i < buf.length - search.length; i++) {
    let match = true;
    for (let j = 0; j < search.length; j++) {
      if (buf[i + j] !== search.charCodeAt(j)) { match = false; break; }
    }
    if (match) { idx = i; break; }
  }
  if (idx >= 0) localePositions.push({ name: loc, pos: idx });
}
localePositions.push({ name: '__END__', pos: buf.length });

console.log('Found locales:', localePositions.map(l => l.name).join(', '));

// Get EN keys and entries
function getBlockBounds(pos, locName) {
  const bracePos = content.indexOf('{', pos + locName.length + 1);
  let bc = 0, end = bracePos + 1;
  do {
    if (content[end] === '{') bc++;
    else if (content[end] === '}') bc--;
    end++;
  } while (bc > 0);
  return { start: bracePos + 1, end: end - 1 };
}

function extractKeys(block) {
  return new Set([...block.matchAll(/"([^\"]+)"\s*:/g)].map(m => m[1]));
}

function extractEntries(block) {
  const entries = [];
  let i = 0;
  while (i < block.length) {
    while (i < block.length && block[i] !== '"') i++;
    if (i >= block.length) break;
    const keyStart = i + 1;
    while (i + 1 < block.length && block[i + 1] !== '"') i++;
    const key = block.substring(keyStart, i + 1);
    i += 2;
    while (i < block.length && (block[i] === ' ' || block[i] === '\t' || block[i] === ':')) i++;
    // Get value
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
    while (i < block.length && (block[i] === ' ' || block[i] === '\t')) i++;
  }
  return entries;
}

// Get EN data
const enBounds = getBlockBounds(localePositions[0].pos, 'en');
const enBlock = content.substring(enBounds.start, enBounds.end);
const enKeys = extractKeys(enBlock);
const enEntries = extractEntries(enBlock);
const enMap = {};
for (const e of enEntries) enMap[e.key] = e.value;
console.log('EN keys:', enKeys.size);

// Process each locale
const newBlocks = {};
for (let li = 1; li < localePositions.length - 1; li++) {
  const loc = localePositions[li].name;
  const bounds = getBlockBounds(localePositions[li].pos, loc);
  const block = content.substring(bounds.start, bounds.end);
  
  let newBlock = block;
  
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
      console.log(loc + ' gap fill: +' + missing.length);
    }
  }
  
  // Verify
  const finalKeys = extractKeys(newBlock);
  const miss = [...enKeys].filter(k => !finalKeys.has(k)).length;
  const extra = [...finalKeys].filter(k => !enKeys.has(k)).length;
  console.log(loc + ': ' + finalKeys.size + ' keys, missing=' + miss + ', extra=' + extra);
  
  newBlocks[loc] = { bounds, block: newBlock };
}

// Rebuild file
console.log('\nRebuilding file...');
// Extract preamble (before en block) and post-en
const preamble = content.substring(0, enBounds.start - 1); // include newline before en {
const enHeader = content.substring(enBounds.start - 20, enBounds.start).match(/^\n?\s*en:\s*\{/)[0];
const enFooter = '\n\n' + content.substring(enBounds.end + 1, localePositions[1].pos);

// Actually we need to rebuild from all blocks properly
// Each locale has: preamble (newline + spaces + locale name + ': {') + block + footer (',\n')
// The tricky part is getting the whitespace right

// Let's just use the content structure as-is and only modify block contents
let newContent = '';
let pos = 0;

// EN block (keep as-is)
newContent += content.substring(0, enBounds.end + 1);
pos = enBounds.end + 1;

// Other locales
for (let li = 1; li < localePositions.length - 1; li++) {
  const loc = localePositions[li].name;
  const nextPos = localePositions[li + 1].pos;
  const localeLineStart = content.lastIndexOf('\n', localePositions[li].pos);
  const localeLine = content.substring(localeLineStart, nextPos);
  
  if (newBlocks[loc]) {
    // Replace the block portion
    const blockStart = content.indexOf('{', localePositions[li].pos + loc.length + 1);
    const blockEnd = localePositions[li + 1].pos;
    newContent += '\n    ' + loc + ': ' + newBlocks[loc].block + ',\n';
    pos = blockEnd;
  } else {
    // Keep as-is
    newContent += localeLine;
    pos = nextPos;
  }
}

// Append remainder (ar block to end)
newContent += content.substring(pos);

fs.writeFileSync(FILE, newContent);
console.log('Done. Wrote', newContent.length, 'bytes');
console.log('File written. Run check_i18n.js to verify.');