#!/usr/bin/env node
/**
 * fix-i18n-v17.js - Targeted gap fill + orphan removal
 * Simpler approach: one locale at a time, targeted edits only
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'backend/public/shared/i18n.js');
let content = fs.readFileSync(FILE, 'utf8');

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

function syntaxCheck(content) {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, content);
  try {
    require('child_process').execSync('node --check ' + tmp, { encoding: 'utf8' });
    fs.unlinkSync(tmp);
    return true;
  } catch (e) {
    fs.unlinkSync(tmp);
    return false;
  }
}

// Parse current state
function getState() {
  const locs = findLocalePositions(content);
  const blocks = locs.map(loc => ({
    name: loc.name,
    openPos: loc.headerEnd,
    closePos: findClosingBrace(content, loc.headerEnd - 1)
  }));
  const enBlock = blocks.find(b => b.name === 'en');
  const enKV = extractKeyValues(content, enBlock.openPos, enBlock.closePos);
  const enKeys = new Set(Object.keys(enKV));
  return { locs, blocks, enKV, enKeys };
}

let { blocks, enKV, enKeys } = getState();
console.log('EN keys:', enKeys.size);

function processLocale(locName) {
  const lb = blocks.find(b => b.name === locName);
  if (!lb) { console.log(locName + ': NOT FOUND'); return false; }
  
  const locKV = extractKeyValues(content, lb.openPos, lb.closePos);
  const locKeys = new Set(Object.keys(locKV));
  const missing = [...enKeys].filter(k => !locKeys.has(k));
  const orphans = [...locKeys].filter(k => !enKeys.has(k));
  
  console.log(locName + ': missing=' + missing.length + ', orphans=' + orphans.length);
  if (missing.length === 0 && orphans.length === 0) return true;
  
  // Step 1: Remove orphans
  for (const orphanKey of orphans) {
    const searchStart = lb.openPos;
    const searchEnd = lb.closePos;
    
    let keyPos = content.indexOf('"' + orphanKey + '":', searchStart);
    if (keyPos === -1 || keyPos > searchEnd) continue;
    
    // Verify depth 0
    let depth = 0, inStr = false, escape = false;
    for (let i = lb.openPos; i < keyPos; i++) {
      if (escape) { escape = false; continue; }
      if (content[i] === '\\') { escape = true; continue; }
      if (content[i] === '"') inStr = !inStr;
      else if (!inStr) {
        if (content[i] === '{') depth++;
        else if (content[i] === '}') depth--;
      }
    }
    if (depth !== 0) continue;
    
    // Find entry boundaries - find start of line
    let entryStart = keyPos;
    const lineStart = content.lastIndexOf('\n', keyPos);
    if (lineStart >= lb.openPos) entryStart = lineStart + 1;
    
    // Find value end
    let colonPos = content.indexOf(':', keyPos);
    let valStart = colonPos + 1;
    while (valStart < searchEnd && (content[valStart] === ' ' || content[valStart] === '\t')) valStart++;
    
    if (content[valStart] === '"') {
      valStart++;
      let valEnd = valStart;
      let esc = false;
      while (valEnd < searchEnd) {
        if (content[valEnd] === '\\') { esc = true; valEnd++; }
        else if (content[valEnd] === '"') break;
        else valEnd++;
      }
      valEnd++;
      
      // Skip trailing whitespace and comma
      let entryEnd = valEnd;
      while (entryEnd < searchEnd && (content[entryEnd] === ' ' || content[entryEnd] === '\t')) entryEnd++;
      if (entryEnd < searchEnd && content[entryEnd] === ',') entryEnd++;
      
      content = content.substring(0, entryStart) + content.substring(entryEnd);
      console.log('  Removed orphan: ' + orphanKey);
    }
  }
  
  // Re-parse after orphan removal
  blocks = findLocalePositions(content).map(loc => ({
    name: loc.name,
    openPos: loc.headerEnd,
    closePos: findClosingBrace(content, loc.headerEnd - 1)
  }));
  const lb2 = blocks.find(b => b.name === locName);
  if (!lb2) return false;
  
  // Step 2: Gap fill
  const locKV2 = extractKeyValues(content, lb2.openPos, lb2.closePos);
  const locKeys2 = new Set(Object.keys(locKV2));
  const stillMissing = [...enKeys].filter(k => !locKeys2.has(k));
  
  if (stillMissing.length > 0) {
    const closePos = lb2.closePos;
    
    // Check if there's a trailing comma by looking at the character before }
    let checkPos = closePos - 1;
    while (checkPos > lb2.openPos && (content[checkPos] === ' ' || content[checkPos] === '\t')) checkPos--;
    
    const hasTrailingComma = content[checkPos] === ',';
    
    // Build insertion
    let insert = '';
    for (const k of stillMissing) {
      const val = enKV[k] || '';
      insert += '        "' + k + '": "' + val + '",\n';
    }
    
    if (hasTrailingComma) {
      // Replace trailing comma with comma + new entries + closing brace
      content = content.substring(0, checkPos) + ',\n' + insert + '    ' + content.substring(closePos);
    } else {
      // Insert comma before } and add new entries
      content = content.substring(0, closePos) + ',\n' + insert + '    ' + content.substring(closePos);
    }
    console.log('  Gap fill: added ' + stillMissing.length + ' entries');
  }
  
  return true;
}

// Process in order: ms, hi first (no orphans), then ko, ja, ar (with orphans), then rest
const order = ['ms', 'hi', 'ko', 'ja', 'ar', 'th', 'vi', 'id', 'fr', 'es', 'de'];

for (const loc of order) {
  const before = content.length;
  if (!processLocale(loc)) {
    console.log('Failed to process ' + loc);
    process.exit(1);
  }
  
  if (!syntaxCheck(content)) {
    console.log('Syntax error after ' + loc + '! Reverting...');
    content = fs.readFileSync(FILE, 'utf8'); // revert to clean
    process.exit(1);
  }
  
  console.log(loc + ': OK (size ' + before + ' -> ' + content.length + ')');
  
  // Re-parse blocks for next iteration
  blocks = findLocalePositions(content).map(loc => ({
    name: loc.name,
    openPos: loc.headerEnd,
    closePos: findClosingBrace(content, loc.headerEnd - 1)
  }));
}

// Final verification
console.log('\n=== Final Verification ===');
const finalState = getState();
console.log('EN keys:', finalState.enKeys.size);

for (const locName of order) {
  const b = finalState.blocks.find(b => b.name === locName);
  if (!b) continue;
  const locKV = extractKeyValues(content, b.openPos, b.closePos);
  const locKeys = new Set(Object.keys(locKV));
  const missing = [...finalState.enKeys].filter(k => !locKeys.has(k));
  const extra = [...locKeys].filter(k => !finalState.enKeys.has(k));
  if (missing.length > 0 || extra.length > 0) {
    console.log(locName + ': keys=' + locKeys.size + ' MISSING=' + missing.length + ' EXTRA=' + extra.length);
  } else {
    console.log(locName + ': OK keys=' + locKeys.size);
  }
}

// Save
fs.writeFileSync(FILE, content);
console.log('\n=== Saved ===');
console.log('Final size:', content.length);