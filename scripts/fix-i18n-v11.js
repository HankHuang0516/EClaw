#!/usr/bin/env node
/**
 * i18n Gap Fill + Dedup Script v11
 * 
 * Fixed key:value extraction using a proper state machine that correctly
 * distinguishes keys from values at depth=0.
 */

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'backend/public/shared/i18n.js');
const content = fs.readFileSync(filePath, 'utf8');

console.log('File size:', content.length);

// === Find locale positions ===
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

// === Extract key→value pairs from a locale block ===
// State machine approach
function extractKeyValues(content, blockStart, blockEnd) {
  const kv = {};
  let depth = 0, inStr = false, escape = false;
  let state = 'seek_key'; // 'seek_key' | 'seek_colon' | 'seek_value'
  let currentKey = null;
  let keyOpenPos = -1, keyClosePos = -1;
  let valOpenPos = -1, valClosePos = -1;

  for (let i = blockStart; i < blockEnd; i++) {
    const c = content[i];
    
    if (escape) {
      escape = false;
      continue;
    }
    
    if (c === '\\') {
      escape = true;
      continue;
    }
    
    if (c === '"') {
      if (!inStr) {
        // Entering a string
        inStr = true;
        if (state === 'seek_key') {
          keyOpenPos = i;
          keyClosePos = -1;
        } else if (state === 'seek_value') {
          valOpenPos = i;
        }
      } else {
        // Exiting a string
        inStr = false;
        if (state === 'seek_key') {
          keyClosePos = i;
          // Check if this could be a key (look ahead for colon at depth 0)
          let next = i + 1;
          while (next < blockEnd && (content[next] === ' ' || content[next] === '\t')) next++;
          if (next < blockEnd && content[next] === ':' && depth === 0) {
            currentKey = content.substring(keyOpenPos + 1, keyClosePos);
            state = 'seek_colon';
          }
        } else if (state === 'seek_value') {
          valClosePos = i;
          if (depth === 0 && currentKey) {
            kv[currentKey] = content.substring(valOpenPos + 1, valClosePos);
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
      } else if (c === ',' && depth === 0) {
        state = 'seek_key';
        currentKey = null;
      }
    }
  }
  return kv;
}

// === MAIN ===
const locs = findLocalePositions(content);
console.log('Locales:', locs.map(l => l.name).join(', '));

const blocks = locs.map(loc => {
  const openPos = loc.headerEnd; // after the "{"
  const closePos = findClosingBrace(content, openPos - 1);
  return { name: loc.name, openPos, closePos };
});

// Get en key:value pairs
const enBlock = blocks.find(b => b.name === 'en');
const enKV = extractKeyValues(content, enBlock.openPos, enBlock.closePos);
const enKeys = new Set(Object.keys(enKV));
console.log('EN keys:', enKeys.size);

// Target locales
const targetLocales = ['zh', 'ja', 'ko', 'th', 'vi', 'id', 'fr', 'es', 'de', 'ms', 'hi', 'ar'];

// Process each locale
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
    // Find the key's position
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
    // Start: beginning of line
    let start = keyPos;
    let lineStart = newContent.lastIndexOf('\n', keyPos);
    if (lineStart >= lb.openPos) start = lineStart + 1;
    
    // Find value end (closing quote of value)
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
    
    // Find end of entry (comma or newline)
    let end = valEnd + 1;
    while (end < searchEnd && (newContent[end] === ' ' || newContent[end] === '\t')) end++;
    if (end < searchEnd && newContent[end] === ',') end++;
    else if (end < searchEnd && newContent[end] === '\n') end++;
    
    newContent = newContent.substring(0, start) + newContent.substring(end);
    modified = true;
  }
  
  // Step 2: Re-parse blocks after removals
  const updatedLocs = findLocalePositions(newContent);
  const updatedBlocks = updatedLocs.map(loc => {
    const openPos = loc.headerEnd;
    const closePos = findClosingBrace(newContent, openPos - 1);
    return { name: loc.name, openPos, closePos };
  });
  
  const updatedLb = updatedBlocks.find(b => b.name === locName);
  if (!updatedLb) continue;
  
  // Step 3: Insert missing keys before closing brace
  if (missing.length > 0) {
    const insertEntries = missing.map(k => {
      const val = enKV[k] || k.replace(/_/g, ' ');
      return '        "' + k + '": "' + val + '"';
    }).join(',\n');
    
    const insertAt = updatedLb.closePos;
    newContent = newContent.substring(0, insertAt) + insertEntries + ',\n    ' + newContent.substring(insertAt);
    modified = true;
    
    // Re-parse again
    const finalLocs = findLocalePositions(newContent);
    blocks.length = 0;
    for (const loc of finalLocs) {
      blocks.push({ name: loc.name, openPos: loc.headerEnd, closePos: findClosingBrace(newContent, loc.headerEnd - 1) });
    }
  }
}

// === Save ===
if (modified) {
  fs.writeFileSync(filePath, newContent);
  console.log('\n=== Saved ===');
  console.log('New size:', newContent.length);
} else {
  console.log('\n=== No changes ===');
}

// === Verification ===
console.log('\n=== VERIFICATION ===');
const finalLocs = findLocalePositions(newContent);
const finalBlocks = finalLocs.map(loc => {
  const openPos = loc.headerEnd;
  const closePos = findClosingBrace(newContent, openPos - 1);
  return { name: loc.name, openPos, closePos };
});

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
    if (missing.length > 0 && missing.length <= 5) console.log('  Missing:', missing.slice(0, 5).join(', '));
    if (extra.length > 0 && extra.length <= 5) console.log('  Extra:', extra.slice(0, 5).join(', '));
  } else {
    console.log(locName + ': OK keys=' + locKeys.size);
  }
}