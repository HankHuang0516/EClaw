#!/usr/bin/env node
/**
 * i18n Gap Fill + Dedup Script v12
 * 
 * Key fixes from v11:
 * - Don't leave trailing commas after removal
 * - When inserting before closing brace, don't add extra comma if one already exists
 * - Use state machine key extractor that correctly handles depth
 */

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'backend/public/shared/i18n.js');
let content = fs.readFileSync(filePath, 'utf8');

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
            // valOpenPos is the colon. Find the opening quote after it.
            let actualValStart = valOpenPos + 1;
            // Skip whitespace
            while (actualValStart < blockEnd && content[actualValStart] === ' ') actualValStart++;
            // Expect opening quote
            if (content[actualValStart] === '"') {
              actualValStart++; // skip opening quote
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
      continue;
    }
    if (!inStr) {
      if (c === '{') depth++;
      else if (c === '}') depth--;
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

function extractKeys(content, blockStart, blockEnd) {
  const keys = new Set();
  let depth = 0, inStr = false, escape = false;
  for (let i = blockStart; i < blockEnd; i++) {
    const c = content[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') {
      if (!inStr) {
        const keyStart = i + 1;
        let j = i + 1;
        while (j < blockEnd && content[j] !== '"') j++;
        const key = content.substring(keyStart, j);
        let next = j + 1;
        while (next < blockEnd && (content[next] === ' ' || content[next] === '\t')) next++;
        if (next < blockEnd && content[next] === ':' && depth === 0) {
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

const locs = findLocalePositions(content);
console.log('Locales:', locs.map(l => l.name).join(', '));

const blocks = locs.map(loc => {
  const openPos = loc.headerEnd;
  const closePos = findClosingBrace(content, openPos - 1);
  return { name: loc.name, openPos, closePos };
});

const enBlock = blocks.find(b => b.name === 'en');
const enKV = extractKeyValues(content, enBlock.openPos, enBlock.closePos);
const enKeys = new Set(Object.keys(enKV));
console.log('EN keys:', enKeys.size);

const targetLocales = ['zh', 'ja', 'ko', 'th', 'vi', 'id', 'fr', 'es', 'de', 'ms', 'hi', 'ar'];
let modified = false;
let newContent = content;

for (const locName of targetLocales) {
  const lb = blocks.find(b => b.name === locName);
  if (!lb) continue;
  
  const locKV = extractKeyValues(newContent, lb.openPos, lb.closePos);
  const locKeys = new Set(Object.keys(locKV));
  const missing = [...enKeys].filter(k => !locKeys.has(k));
  const orphans = [...locKeys].filter(k => !enKeys.has(k));
  
  if (missing.length === 0 && orphans.length === 0) {
    console.log(locName + ': OK');
    continue;
  }
  
  console.log(locName + ': missing=' + missing.length + ', orphans=' + orphans.length);
  
  // Step 1: Remove orphan entries
  for (const orphanKey of orphans) {
    const searchStart = lb.openPos;
    const searchEnd = lb.closePos;
    
    let keyPos = newContent.indexOf('"' + orphanKey + '":', searchStart);
    if (keyPos === -1 || keyPos > searchEnd) continue;
    
    // Verify top-level
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
    
    // Find entry boundaries
    let entryStart = keyPos;
    let lineStart = newContent.lastIndexOf('\n', keyPos);
    if (lineStart >= lb.openPos) entryStart = lineStart + 1;
    
    // Find value end
    let colonPos = newContent.indexOf(':', keyPos);
    let valStart = colonPos + 1;
    while (valStart < searchEnd && (newContent[valStart] === ' ' || newContent[valStart] === '\t')) valStart++;
    if (newContent[valStart] === '"') valStart++;
    
    let valEnd = valStart;
    let esc = false;
    while (valEnd < searchEnd) {
      if (newContent[valEnd] === '\\') { esc = true; valEnd++; }
      else if (newContent[valEnd] === '"') break;
      else valEnd++;
    }
    
    // Find comma or newline after value
    let entryEnd = valEnd + 1;
    while (entryEnd < searchEnd && (newContent[entryEnd] === ' ' || newContent[entryEnd] === '\t')) entryEnd++;
    if (entryEnd < searchEnd && newContent[entryEnd] === ',') entryEnd++;
    else if (entryEnd < searchEnd && newContent[entryEnd] === '\n') entryEnd++;
    
    newContent = newContent.substring(0, entryStart) + newContent.substring(entryEnd);
    modified = true;
  }
  
  // Re-parse blocks after removals
  const updatedLocs = findLocalePositions(newContent);
  const updatedBlocks = updatedLocs.map(loc => ({
    name: loc.name,
    openPos: loc.headerEnd,
    closePos: findClosingBrace(newContent, loc.headerEnd - 1)
  }));
  
  const updatedLb = updatedBlocks.find(b => b.name === locName);
  if (!updatedLb) continue;
  
  // Step 2: Insert missing keys before closing brace
  if (missing.length > 0) {
    // Look at the content right before the closing brace to determine comma handling
    const closePos = updatedLb.closePos;
    const beforeClose = newContent.substring(closePos - 10, closePos);
    const hasTrailingComma = beforeClose.includes(',');
    
    let insertEntries = '';
    for (const k of missing) {
      const val = enKV[k] || '';
      insertEntries += '        "' + k + '": "' + val + '",\n';
    }
    
    if (hasTrailingComma) {
      // Already has comma before }, remove the comma and re-add with new entries
      // Find the last comma before }
      let commaPos = closePos - 1;
      while (commaPos > updatedLb.openPos && newContent[commaPos] !== ',') commaPos--;
      if (newContent[commaPos] === ',') {
        // Remove trailing comma, add new entries with comma at end
        newContent = newContent.substring(0, commaPos) + ',\n' + insertEntries + '    ' + newContent.substring(closePos);
      } else {
        newContent = newContent.substring(0, closePos) + insertEntries + '    ' + newContent.substring(closePos);
      }
    } else {
      newContent = newContent.substring(0, closePos) + insertEntries + '    ' + newContent.substring(closePos);
    }
    modified = true;
    
    // Re-parse again
    const finalLocs = findLocalePositions(newContent);
    blocks.length = 0;
    for (const loc of finalLocs) {
      blocks.push({ name: loc.name, openPos: loc.headerEnd, closePos: findClosingBrace(newContent, loc.headerEnd - 1) });
    }
  }
}

if (modified) {
  fs.writeFileSync(filePath, newContent);
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