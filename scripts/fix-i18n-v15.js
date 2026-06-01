#!/usr/bin/env node
/**
 * fix-i18n-v15.js - Gap fill + orphan removal for i18n.js
 * 
 * Gap fill targets: ms(64), hi(63), ko(13), ja(11), ar(1), th/vi/id/fr/es/de(13 each)
 * Orphan removal: ja(10), ko(8), ar(2)
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'backend/public/shared/i18n.js');
let content = fs.readFileSync(FILE, 'utf8');

console.log('File size:', content.length);

function findLocalePositions(content) {
  const re = /\n\s+([a-z]{2}(?:-[A-Z]{2})?):\s*\{/g;
  const locs = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    locs.push({ name: m[1], headerEnd: m.index + m[0].length });
  }
  return locs;
}

function findClosingBrace(content, openPos) {
  let depth = 0;
  for (let i = openPos; i < content.length; i++) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// Extract key->value map using simple depth-aware state machine
function extractKeyValues(content, blockStart, blockEnd) {
  const kv = {};
  let depth = 0, inStr = false, escape = false;
  let state = 'seek_key';
  let currentKey = null;
  let keyOpenPos = -1, keyClosePos = -1;
  let valOpenPos = -1;

  for (let i = blockStart; i < blockEnd; i++) {
    const c = content[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') {
      if (!inStr) {
        inStr = true;
        if (state === 'seek_key') keyOpenPos = i;
      } else {
        inStr = false;
        if (state === 'seek_key') {
          keyClosePos = i;
          let next = i + 1;
          while (next < blockEnd && (content[next] === ' ' || content[next] === '\t')) next++;
          if (next < blockEnd && content[next] === ':' && depth === 0) {
            currentKey = content.substring(keyOpenPos + 1, keyClosePos);
            state = 'seek_colon';
          }
        } else if (state === 'seek_value') {
          if (depth === 0 && currentKey) {
            let actualValStart = valOpenPos + 1;
            while (actualValStart < blockEnd && content[actualValStart] === ' ') actualValStart++;
            if (content[actualValStart] === '"') {
              actualValStart++;
              let actualValEnd = actualValStart;
              let esc = false;
              while (actualValEnd < blockEnd) {
                if (content[actualValEnd] === '\\') { esc = true; actualValEnd++; }
                else if (content[actualValEnd] === '"' && !esc) break;
                else actualValEnd++;
              }
              kv[currentKey] = content.substring(actualValStart, actualValEnd);
            }
          }
          currentKey = null;
          state = 'seek_key';
        }
      }
    } else if (!inStr) {
      if (c === '{') depth++;
      else if (c === '}') { if (depth > 0) depth--; }
      else if (c === ':' && depth === 0 && state === 'seek_colon') {
        state = 'seek_value';
        valOpenPos = i;
      } else if (c === ',' && depth === 0) {
        state = 'seek_key';
        currentKey = null;
      }
    }
  }
  return kv;
}

const locs = findLocalePositions(content);
const blocks = locs.map(loc => ({
  name: loc.name,
  openPos: loc.headerEnd,
  closePos: findClosingBrace(content, loc.headerEnd - 1)
}));

const enBlock = blocks.find(b => b.name === 'en');
const enKV = extractKeyValues(content, enBlock.openPos, enBlock.closePos);
const enKeys = new Set(Object.keys(enKV));
console.log('EN keys:', enKeys.size);

const targetLocales = ['ms', 'hi', 'ko', 'ja', 'ar', 'th', 'vi', 'id', 'fr', 'es', 'de'];
let modified = false;
let newContent = content;

for (const locName of targetLocales) {
  // Re-parse to account for previous edits
  const currentLocs = findLocalePositions(newContent);
  const currentBlocks = currentLocs.map(loc => ({
    name: loc.name,
    openPos: loc.headerEnd,
    closePos: findClosingBrace(newContent, loc.headerEnd - 1)
  }));
  
  const lb = currentBlocks.find(b => b.name === locName);
  if (!lb) { console.log(locName + ': NOT FOUND'); continue; }
  
  const locKV = extractKeyValues(newContent, lb.openPos, lb.closePos);
  const locKeys = new Set(Object.keys(locKV));
  const missing = [...enKeys].filter(k => !locKeys.has(k));
  const orphans = [...locKeys].filter(k => !enKeys.has(k));
  
  if (missing.length === 0 && orphans.length === 0) {
    console.log(locName + ': OK');
    continue;
  }
  
  console.log(locName + ': missing=' + missing.length + ', orphans=' + orphans.length);
  
  // --- STEP 1: Remove orphans ---
  for (const orphanKey of orphans) {
    // Find the entry in the content
    const searchStart = lb.openPos;
    const searchEnd = lb.closePos;
    
    // Find the key position
    let keyPos = newContent.indexOf('"' + orphanKey + '":', searchStart);
    if (keyPos === -1 || keyPos > searchEnd) continue;
    
    // Verify this is at depth 0 (not inside a nested object)
    let depth = 0, inStr = false, escape = false;
    for (let i = lb.openPos; i < keyPos; i++) {
      if (escape) { escape = false; continue; }
      if (newContent[i] === '\\') { escape = true; continue; }
      if (newContent[i] === '"') inStr = !inStr;
      else if (!inStr) {
        if (newContent[i] === '{') depth++;
        else if (newContent[i] === '}') depth--;
      }
    }
    if (depth !== 0) continue;
    
    // Find entry start (beginning of line)
    let entryStart = keyPos;
    let lineStart = newContent.lastIndexOf('\n', keyPos);
    if (lineStart >= lb.openPos) entryStart = lineStart + 1;
    
    // Find value end - find colon then value
    let colonPos = newContent.indexOf(':', keyPos);
    let valStart = colonPos + 1;
    while (valStart < searchEnd && (newContent[valStart] === ' ' || newContent[valStart] === '\t')) valStart++;
    if (newContent[valStart] === '"') {
      valStart++;
      let valEnd = valStart;
      let esc = false;
      while (valEnd < searchEnd) {
        if (newContent[valEnd] === '\\') { esc = true; valEnd++; }
        else if (newContent[valEnd] === '"') break;
        else valEnd++;
      }
      valEnd++; // include closing quote
      
      // Skip whitespace and comma
      let entryEnd = valEnd;
      while (entryEnd < searchEnd && (newContent[entryEnd] === ' ' || newContent[entryEnd] === '\t')) entryEnd++;
      if (entryEnd < searchEnd && newContent[entryEnd] === ',') entryEnd++;
      else if (entryEnd < searchEnd && newContent[entryEnd] === '\n') entryEnd++;
      
      newContent = newContent.substring(0, entryStart) + newContent.substring(entryEnd);
      modified = true;
    }
  }
  
  // --- STEP 2: Gap fill ---
  // Re-parse after removals
  const updatedLocs = findLocalePositions(newContent);
  const updatedBlocks = updatedLocs.map(loc => ({
    name: loc.name,
    openPos: loc.headerEnd,
    closePos: findClosingBrace(newContent, loc.headerEnd - 1)
  }));
  
  const updatedLb = updatedBlocks.find(b => b.name === locName);
  if (!updatedLb) continue;
  
  // Re-check missing after orphan removal
  const updatedLocKV = extractKeyValues(newContent, updatedLb.openPos, updatedLb.closePos);
  const updatedLocKeys = new Set(Object.keys(updatedLocKV));
  const stillMissing = [...enKeys].filter(k => !updatedLocKeys.has(k));
  
  if (stillMissing.length > 0) {
    const closePos = updatedLb.closePos;
    const beforeClose = newContent.substring(closePos - 15, closePos);
    const hasTrailingComma = beforeClose.includes(',');
    
    let insertEntries = '';
    for (const k of stillMissing) {
      const val = enKV[k] || '';
      insertEntries += '        "' + k + '": "' + val + '",\n';
    }
    
    if (hasTrailingComma) {
      // Replace trailing comma with comma + new entries
      let commaPos = closePos - 1;
      while (commaPos > updatedLb.openPos && newContent[commaPos] !== ',') commaPos--;
      if (commaPos > updatedLb.openPos) {
        newContent = newContent.substring(0, commaPos) + ',\n' + insertEntries + '    ' + newContent.substring(closePos);
      }
    } else {
      newContent = newContent.substring(0, closePos) + insertEntries + '    ' + newContent.substring(closePos);
    }
    modified = true;
  }
}

if (modified) {
  fs.writeFileSync(FILE, newContent);
  console.log('\n=== Saved ===');
  console.log('New size:', newContent.length);
} else {
  console.log('\n=== No changes ===');
}

console.log('\n=== VERIFICATION ===');
const finalLocs = findLocalePositions(newContent);
const finalBlocks = finalLocs.map(loc => ({
  name: loc.name,
  openPos: loc.headerEnd,
  closePos: findClosingBrace(newContent, loc.headerEnd - 1)
}));

const finalEnBlock = finalBlocks.find(b => b.name === 'en');
const finalEnKV = extractKeyValues(newContent, finalEnBlock.openPos, finalEnBlock.closePos);
const finalEnKeys = new Set(Object.keys(finalEnKV));
console.log('EN keys:', finalEnKeys.size);

for (const locName of targetLocales) {
  const b = finalBlocks.find(b => b.name === locName);
  if (!b) continue;
  const locKV = extractKeyValues(newContent, b.openPos, b.closePos);
  const locKeys = new Set(Object.keys(locKV));
  const missing = [...finalEnKeys].filter(k => !locKeys.has(k));
  const extra = [...locKeys].filter(k => !finalEnKeys.has(k));
  if (missing.length > 0 || extra.length > 0) {
    console.log(locName + ': keys=' + locKeys.size + ' MISSING=' + missing.length + ' EXTRA=' + extra.length);
  } else {
    console.log(locName + ': OK keys=' + locKeys.size);
  }
}