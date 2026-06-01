#!/usr/bin/env node
/**
 * i18n Gap Fill + Dedup Script v9
 * 
 * Strategy: Work on each locale block independently using targeted edits.
 * For each target locale:
 *   1. Extract block boundaries (find opening { after locale name, brace-match closing })
 *   2. Extract key:value pairs from block
 *   3. Build corrected block content
 *   4. Replace old block with corrected block
 * 
 * This avoids position calculation errors in previous versions.
 */

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'backend/public/shared/i18n.js');
let content = fs.readFileSync(filePath, 'utf8');

console.log('File size:', content.length);

// === Find all locale header positions ===
function findLocaleHeaders(content) {
  const re = /\n\s+([a-z]{2}(?:-[A-Z]{2})?):\s*\{/g;
  const headers = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    headers.push({ name: m[1], pos: m.index + m[0].length - 1 });
  }
  return headers;
}

// === Find closing brace given opening brace position ===
function findClosingBrace(content, openPos) {
  let depth = 0;
  for (let i = openPos; i < content.length; i++) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// === Extract key:value pairs from a block ===
function extractKVPs(block) {
  const pairs = {};
  let depth = 0, inStr = false, escape = false;
  let i = 0;

  while (i < block.length - 2) {
    if (block[i] === '"') {
      let j = i + 1;
      while (j < block.length && block[j] !== '"') j++;
      const key = block.substring(i + 1, j);
      let after = j + 1;
      while (after < block.length && (block[after] === ' ' || block[after] === '\t')) after++;
      if (after < block.length && block[after] === ':' && depth === 0) {
        // Key found, now find string value
        let valStart = after + 1;
        while (valStart < block.length && (block[valStart] === ' ' || block[valStart] === '\t')) valStart++;
        if (valStart < block.length && block[valStart] === '"') {
          valStart++;
          let valEnd = valStart;
          let esc = false;
          while (valEnd < block.length) {
            if (block[valEnd] === '\\') { esc = true; valEnd++; }
            else if (block[valEnd] === '"' && !esc) break;
            else valEnd++;
          }
          pairs[key] = block.substring(valStart, valEnd);
        }
      }
      i = j;
    } else if (block[i] === '{') { depth++; i++; }
    else if (block[i] === '}') { depth--; i++; }
    else { i++; }
  }
  return pairs;
}

// === MAIN ===
const headers = findLocaleHeaders(content);
console.log('Found', headers.length, 'locales:', headers.map(h => h.name).join(', '));

// Build block info
const blocks = headers.map(h => ({
  name: h.name,
  openPos: h.pos,
  closePos: findClosingBrace(content, h.pos)
}));

// Get en key:value pairs
const enBlock = blocks.find(b => b.name === 'en');
const enContent = content.substring(enBlock.openPos + 1, enBlock.closePos);
const enKV = extractKVPs(enContent);
const enKeys = new Set(Object.keys(enKV));
console.log('EN keys:', enKeys.size);

// Target locales
const allLocales = ['zh', 'ja', 'ko', 'th', 'vi', 'id', 'fr', 'es', 'de', 'ms', 'hi', 'ar'];

// === Process each locale ===
console.log('\n=== Processing locales ===');

let modified = false;
for (const loc of allLocales) {
  const lb = blocks.find(b => b.name === loc);
  if (!lb) continue;
  
  const blockContent = content.substring(lb.openPos + 1, lb.closePos);
  const locKV = extractKVPs(blockContent);
  const locKeys = new Set(Object.keys(locKV));
  
  // Find missing keys (in en but not in locale)
  const missing = [...enKeys].filter(k => !locKeys.has(k));
  // Find orphan keys (in locale but not in en)
  const orphans = [...locKeys].filter(k => !enKeys.has(k));
  
  if (missing.length === 0 && orphans.length === 0) {
    console.log(loc + ': OK (keys=' + locKeys.size + ')');
    continue;
  }
  
  console.log(loc + ': missing=' + missing.length + ', orphans=' + orphans.length + ', current keys=' + locKeys.size);
  
  // Build new block content
  let newBlock = '';
  const entries = [];
  
  // First, add all existing entries (but skip orphans)
  for (const [key, value] of Object.entries(locKV)) {
    if (!orphans.includes(key)) {
      entries.push({ key, value, source: 'existing' });
    }
  }
  
  // Then add missing entries
  for (const key of missing) {
    entries.push({ key, value: enKV[key] || '', source: 'new' });
  }
  
  // Sort entries (existing first, then new) - maintain original order for existing
  const existingOrder = Object.keys(locKV).filter(k => !orphans.includes(k));
  const newOrder = missing;
  const finalOrder = [...existingOrder, ...newOrder];
  
  // Build the block string
  // Start with opening brace
  newBlock = '{\n';
  for (const key of finalOrder) {
    const entry = entries.find(e => e.key === key);
    if (entry) {
      newBlock += '        "' + entry.key + '": "' + entry.value + '",\n';
    }
  }
  // End with closing brace
  newBlock += '    }';
  
  // Replace the block in content
  const blockStart = lb.openPos + 1;
  const blockEnd = lb.closePos;
  
  content = content.substring(0, blockStart) + newBlock + content.substring(blockEnd);
  modified = true;
  
  // Re-parse blocks
  const newHeaders = findLocaleHeaders(content);
  blocks.length = 0;
  for (const h of newHeaders) {
    blocks.push({ name: h.name, openPos: h.pos, closePos: findClosingBrace(content, h.pos) });
  }
  
  console.log('  -> Updated, new keys=' + (Object.keys(locKV).length - orphans.length + missing.length));
}

// === DEDUP PHASE ===
console.log('\n=== Dedup Phase ===');
const dedupLocales = ['zh', 'ja', 'ko', 'ar'];

for (const loc of dedupLocales) {
  const lb = blocks.find(b => b.name === loc);
  if (!lb) continue;
  
  const blockContent = content.substring(lb.openPos + 1, lb.closePos);
  const locKV = extractKVPs(blockContent);
  
  // Find keys that appear more than once by scanning block content
  const keyPositions = [];
  let depth = 0, inStr = false, escape = false, currentKey = null;
  
  for (let i = 0; i < blockContent.length; i++) {
    if (blockContent[i] === '"') {
      let j = i + 1;
      while (j < blockContent.length && blockContent[j] !== '"') j++;
      const key = blockContent.substring(i + 1, j);
      let after = j + 1;
      while (after < blockContent.length && (blockContent[after] === ' ' || blockContent[after] === '\t')) after++;
      if (after < blockContent.length && blockContent[after] === ':' && depth === 0) {
        currentKey = key;
      } else {
        currentKey = null;
      }
      i = j;
    } else if (blockContent[i] === '{') { depth++; i++; }
    else if (blockContent[i] === '}') { depth--; i++; }
    else { i++; }
    if (inStr) inStr = !inStr;
  }
  
  // Count occurrences
  const counts = {};
  for (const key of Object.keys(locKV)) {
    // Count how many times this key appears in the block
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = blockContent.match(new RegExp('"' + escapedKey + '":\\s*"', 'g'));
    counts[key] = matches ? matches.length : 1;
  }
  
  const duplicates = Object.entries(counts).filter(([k, v]) => v > 1);
  if (duplicates.length > 0) {
    console.log(loc + ': ' + duplicates.length + ' keys with duplicates');
    
    // For each duplicate key, remove the first occurrence (keep last)
    for (const [dupKey, count] of duplicates) {
      // Find all occurrences of this key in the block
      const escapedKey = dupKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      
      // Find first occurrence position
      let firstPos = -1;
      let depth = 0, inStr = false, escape = false;
      for (let i = 0; i < blockContent.length; i++) {
        if (blockContent[i] === '"') {
          let j = i + 1;
          while (j < blockContent.length && blockContent[j] !== '"') j++;
          const key = blockContent.substring(i + 1, j);
          let after = j + 1;
          while (after < blockContent.length && (blockContent[after] === ' ' || blockContent[after] === '\t')) after++;
          if (after < blockContent.length && blockContent[after] === ':' && depth === 0) {
            if (key === dupKey && firstPos === -1) {
              // Find start of line
              let lineStart = blockContent.lastIndexOf('\n', i);
              lineStart = lineStart >= 0 ? lineStart + 1 : 0;
              firstPos = lineStart;
              break;
            }
          }
          i = j;
        } else if (blockContent[i] === '{') { depth++; }
        else if (blockContent[i] === '}') { depth--; }
        if (inStr) inStr = !inStr;
      }
      
      if (firstPos >= 0) {
        // Find the end of this entry
        // Look for the comma/newline after the value
        let entryStart = firstPos;
        // Find "key": "value"
        let keyStart = blockContent.indexOf('"' + dupKey + '"', entryStart);
        if (keyStart === -1 || keyStart > entryStart + 100) keyStart = entryStart;
        
        // Find the value's closing quote
        let valEnd = -1;
        let depth2 = 0, inStr2 = false, escape2 = false;
        for (let si = keyStart + dupKey.length + 2; si < blockContent.length; si++) {
          if (blockContent[si] === '\\') { escape2 = true; continue; }
          if (blockContent[si] === '"') {
            if (!inStr2) inStr2 = true;
            else {
              valEnd = si;
              break;
            }
          }
        }
        
        if (valEnd !== -1) {
          // Find comma or newline after value
          let entryEnd = valEnd + 1;
          while (entryEnd < blockContent.length && (blockContent[entryEnd] === ' ' || blockContent[entryEnd] === '\t')) entryEnd++;
          if (entryEnd < blockContent.length && blockContent[entryEnd] === ',') entryEnd++;
          if (entryEnd < blockContent.length && blockContent[entryEnd] === '\n') entryEnd++;
          
          // Remove this entry
          const removeFrom = lb.openPos + 1 + entryStart;
          const removeTo = lb.openPos + 1 + entryEnd;
          content = content.substring(0, removeFrom) + content.substring(removeTo);
          
          // Re-parse blocks
          const newHeaders = findLocaleHeaders(content);
          blocks.length = 0;
          for (const h of newHeaders) {
            blocks.push({ name: h.name, openPos: h.pos, closePos: findClosingBrace(content, h.pos) });
          }
          
          modified = true;
        }
      }
    }
  }
}

// === Save ===
if (modified) {
  fs.writeFileSync(filePath, content);
  console.log('\n=== Saved ===');
  console.log('New size:', content.length);
} else {
  console.log('\n=== No changes needed ===');
}

// === Verification ===
console.log('\n=== VERIFICATION ===');
const finalHeaders = findLocaleHeaders(content);
const finalBlocks = finalHeaders.map(h => ({
  name: h.name,
  openPos: h.pos,
  closePos: findClosingBrace(content, h.pos)
}));

const finalEnBlock = finalBlocks.find(b => b.name === 'en');
const finalEnContent = content.substring(finalEnBlock.openPos + 1, finalEnBlock.closePos);
const finalEnKV = extractKVPs(finalEnContent);
const finalEnKeys = new Set(Object.keys(finalEnKV));
console.log('EN keys:', finalEnKeys.size);

for (const loc of allLocales) {
  const b = finalBlocks.find(b => b.name === loc);
  if (!b) continue;
  const blockContent = content.substring(b.openPos + 1, b.closePos);
  const locKV = extractKVPs(blockContent);
  const locKeys = new Set(Object.keys(locKV));
  const missing = [...finalEnKeys].filter(k => !locKeys.has(k));
  const extra = [...locKeys].filter(k => !finalEnKeys.has(k));
  if (missing.length > 0 || extra.length > 0) {
    console.log(loc + ': keys=' + locKeys.size + ' MISSING=' + missing.length + ' EXTRA=' + extra.length);
    if (missing.length > 0 && missing.length <= 5) console.log('  Missing:', missing.slice(0, 5).join(', '));
    if (extra.length > 0 && extra.length <= 5) console.log('  Extra:', extra.slice(0, 5).join(', '));
  } else {
    console.log(loc + ': OK keys=' + locKeys.size);
  }
}