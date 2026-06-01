#!/usr/bin/env node
/**
 * i18n Gap Fill + Dedup Script v10
 * 
 * Memory-efficient approach:
 * 1. Load content once (14MB is fine)
 * 2. For each locale, compute exact positions for inserts/removes
 * 3. Use single content string, apply modifications via substring replacement
 * 4. Write once at the end
 */

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'backend/public/shared/i18n.js');
const content = fs.readFileSync(filePath, 'utf8');

console.log('File size:', content.length);

// === Find locale header positions ===
function findLocales(content) {
  const re = /\n\s+([a-z]{2}(?:-[A-Z]{2})?):\s*\{/g;
  const locs = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    locs.push({ name: m[1], headerEnd: m.index + m[0].length });
  }
  return locs;
}

// === Find closing brace for a given position ===
function findClose(content, openPos) {
  let depth = 0;
  for (let i = openPos; i < content.length; i++) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// === Extract keys from a locale block (no values, just keys) ===
function extractKeys(content, start, end) {
  const keys = new Set();
  let depth = 0, inStr = false, escape = false;
  for (let i = start; i < end; i++) {
    const c = content[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') {
      if (!inStr) {
        const keyStart = i + 1;
        let j = i + 1;
        while (j < end && content[j] !== '"') j++;
        const key = content.substring(keyStart, j);
        let next = j + 1;
        while (next < end && (content[next] === ' ' || content[next] === '\t')) next++;
        if (next < end && content[next] === ':' && depth === 0) {
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

// === Extract key→value map from a locale block ===
function extractKV(content, start, end) {
  const kv = {};
  let depth = 0, inStr = false, escape = false, currentKey = null;
  for (let i = start; i < end; i++) {
    const c = content[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') {
      if (!inStr) {
        const keyStart = i + 1;
        let j = i + 1;
        while (j < end && content[j] !== '"') j++;
        const key = content.substring(keyStart, j);
        let next = j + 1;
        while (next < end && (content[next] === ' ' || content[next] === '\t')) next++;
        if (next < end && content[next] === ':' && depth === 0) {
          currentKey = key;
        } else {
          currentKey = null;
        }
        i = j;
      } else {
        if (currentKey && depth === 0) {
          const valStart = i + 1;
          let valEnd = valStart;
          let esc = false;
          while (valEnd < end) {
            if (content[valEnd] === '\\') { esc = true; valEnd++; }
            else if (content[valEnd] === '"') break;
            else valEnd++;
          }
          kv[currentKey] = content.substring(valStart, valEnd);
          currentKey = null;
        }
        i = content.indexOf('"', i + 1);
        if (i === -1 || i >= end) break;
      }
      inStr = !inStr;
    } else if (!inStr) {
      if (c === '{') depth++;
      else if (c === '}') depth--;
    }
  }
  return kv;
}

// === Find entry boundaries for removal ===
function findEntry(content, keyPos) {
  // keyPos is the position of the opening " of the key
  // Find start of line and end of entry (comma or newline after value)
  let start = keyPos;
  let lineStart = content.lastIndexOf('\n', keyPos);
  if (lineStart < 0) start = 0;
  else start = lineStart + 1;
  
  // Find value end
  let searchFrom = keyPos + keyPos + content.substring(keyPos).indexOf('": "') + 3;
  // Actually, find the colon after the key
  let colon = keyPos;
  while (colon < content.length && content[colon] !== ':') colon++;
  let valStart = colon + 1;
  while (valStart < content.length && (valStart === ' ' || valStart === '\t')) valStart++;
  if (content[valStart] === '"') valStart++;
  
  // Find closing quote of value
  let valEnd = valStart;
  let esc = false;
  while (valEnd < content.length) {
    if (content[valEnd] === '\\') { esc = true; valEnd++; }
    else if (content[valEnd] === '"') break;
    else valEnd++;
  }
  
  // Find comma or newline after valEnd
  let end = valEnd + 1;
  while (end < content.length && (content[end] === ' ' || content[end] === '\t')) end++;
  if (content[end] === ',') end++;
  else if (content[end] === '\n') end++;
  
  return { start, end };
}

// === MAIN ===
const locs = findLocales(content);
console.log('Locales:', locs.map(l => l.name).join(', '));

// Find each locale's block boundaries
const blocks = locs.map(loc => {
  const openPos = loc.headerEnd; // position after the "{"
  const closePos = findClose(content, openPos - 1);
  return { name: loc.name, openPos, closePos };
});

// Get en keys
const enBlock = blocks.find(b => b.name === 'en');
const enKV = extractKV(content, enBlock.openPos, enBlock.closePos);
const enKeys = new Set(Object.keys(enKV));
console.log('EN keys:', enKeys.size);

// Process each locale
const targetLocales = ['zh', 'ja', 'ko', 'th', 'vi', 'id', 'fr', 'es', 'de', 'ms', 'hi', 'ar'];
let modified = false;
let newContent = content;

for (const locName of targetLocales) {
  const lb = blocks.find(b => b.name === locName);
  if (!lb) continue;
  
  const locKV = extractKV(newContent, lb.openPos, lb.closePos);
  const locKeys = new Set(Object.keys(locKV));
  
  const missing = [...enKeys].filter(k => !locKeys.has(k));
  const orphans = [...locKeys].filter(k => !enKeys.has(k));
  
  if (missing.length === 0 && orphans.length === 0) {
    console.log(locName + ': OK');
    continue;
  }
  
  console.log(locName + ': missing=' + missing.length + ', orphans=' + orphans.length);
  
  // Step 1: Remove orphan entries
  // For each orphan, find its position and remove it
  let removePositions = []; // [{start, end}, ...]
  
  for (const orphanKey of orphans) {
    // Find the key's position in the block
    const searchStart = lb.openPos;
    const searchEnd = lb.closePos;
    
    let keyPos = newContent.indexOf('"' + orphanKey + '":', searchStart);
    if (keyPos === -1 || keyPos > searchEnd) continue;
    
    // Verify it's a top-level key (check depth)
    let depth = 0, inStr = false, escape = false;
    let isTopLevel = false;
    for (let i = lb.openPos; i < keyPos; i++) {
      if (escape) { escape = false; continue; }
      if (newContent[i] === '\\') { escape = true; continue; }
      if (newContent[i] === '"') inStr = !inStr;
      else if (!inStr) {
        if (newContent[i] === '{') depth++;
        else if (newContent[i] === '}') depth--;
      }
    }
    if (depth === 0) isTopLevel = true;
    
    if (!isTopLevel) continue;
    
    // Find entry boundaries
    const entry = findEntry(newContent, keyPos);
    removePositions.push(entry);
  }
  
  // Remove from end to start
  removePositions.sort((a, b) => b.start - a.start);
  for (const pos of removePositions) {
    newContent = newContent.substring(0, pos.start) + newContent.substring(pos.end);
    modified = true;
  }
  
  // Step 2: Re-parse blocks after removals
  const updatedLocs = findLocales(newContent);
  const updatedBlocks = updatedLocs.map(loc => {
    const openPos = loc.headerEnd;
    const closePos = findClose(newContent, openPos - 1);
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
const finalLocs = findLocales(newContent);
const finalBlocks = finalLocs.map(loc => {
  const openPos = loc.headerEnd;
  const closePos = findClose(newContent, openPos - 1);
  return { name: loc.name, openPos, closePos };
});

const finalEnBlock = finalBlocks.find(b => b.name === 'en');
const finalEnKV = extractKV(newContent, finalEnBlock.openPos, finalEnBlock.closePos);
const finalEnKeys = new Set(Object.keys(finalEnKV));
console.log('EN keys:', finalEnKeys.size);

for (const locName of targetLocales) {
  const b = finalBlocks.find(b => b.name === locName);
  if (!b) continue;
  const locKV = extractKV(newContent, b.openPos, b.closePos);
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