#!/usr/bin/env node
/**
 * i18n Gap Fill + Dedup Script v8
 * 
 * Key fix: insertion point must be at closePos (before the '}'), not blockEnd-1
 * Also fixes key extraction to work with embedded strings
 */

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'backend/public/shared/i18n.js');
let content = fs.readFileSync(filePath, 'utf8');

console.log('File size:', content.length);

// === Find locale headers and brace-match each closing } ===
function findLocaleBlocks(content) {
  const re = /\n\s+([a-z]{2}(?:-[A-Z]{2})?):\s*\{/g;
  const blocks = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    const name = m[1];
    const openPos = m.index + m[0].length - 1; // position of '{'
    // Find closing brace by depth counting
    let depth = 0;
    let closePos = -1;
    for (let i = openPos; i < content.length; i++) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') { depth--; if (depth === 0) { closePos = i; break; } }
    }
    blocks.push({ name, openPos, closePos });
  }
  return blocks;
}

// === Extract key:value pairs from a locale block (works with embedded strings) ===
function extractKeysAndValues(blockContent) {
  const pairs = {};
  let depth = 0, inStr = false, escape = false;
  let i = 0;

  while (i < blockContent.length - 2) {
    if (blockContent[i] === '"') {
      // Find closing quote
      let j = i + 1;
      while (j < blockContent.length && blockContent[j] !== '"') j++;
      const keyOrValue = blockContent.substring(i + 1, j);
      // Look for colon after key
      let after = j + 1;
      while (after < blockContent.length && (blockContent[after] === ' ' || blockContent[after] === '\t')) after++;
      if (after < blockContent.length && blockContent[after] === ':' && depth === 0) {
        // This is a top-level key - now find value
        let valStart = after + 1;
        while (valStart < blockContent.length && (blockContent[valStart] === ' ' || blockContent[valStart] === '\t')) valStart++;
        if (valStart < blockContent.length && blockContent[valStart] === '"') {
          valStart++;
          let valEnd = valStart;
          let esc = false;
          while (valEnd < blockContent.length) {
            if (blockContent[valEnd] === '\\') { esc = true; valEnd++; }
            else if (blockContent[valEnd] === '"' && !esc) break;
            else valEnd++;
          }
          pairs[keyOrValue] = blockContent.substring(valStart, valEnd);
        }
      }
      i = j;
    } else if (blockContent[i] === '{') {
      depth++;
      i++;
    } else if (blockContent[i] === '}') {
      depth--;
      i++;
    } else {
      i++;
    }
  }
  return pairs;
}

// === Extract just keys from a locale block ===
function extractKeys(blockContent) {
  const keys = new Set();
  let depth = 0, inStr = false, escape = false;
  let i = 0;

  while (i < blockContent.length - 2) {
    if (blockContent[i] === '"') {
      let j = i + 1;
      while (j < blockContent.length && blockContent[j] !== '"') j++;
      const key = blockContent.substring(i + 1, j);
      let after = j + 1;
      while (after < blockContent.length && (blockContent[after] === ' ' || blockContent[after] === '\t')) after++;
      if (after < blockContent.length && blockContent[after] === ':' && depth === 0) {
        keys.add(key);
      }
      i = j;
    } else if (blockContent[i] === '{') {
      depth++;
      i++;
    } else if (blockContent[i] === '}') {
      depth--;
      i++;
    } else {
      i++;
    }
  }
  return keys;
}

// === Find entries to remove (orphans or duplicate first occurrences) ===
// Returns array of {start, end} positions in the content string
function findEntryPositions(blockContent, keysToRemove) {
  const positions = [];
  let depth = 0, inStr = false, escape = false;
  let i = 0;

  while (i < blockContent.length) {
    if (blockContent[i] === '"') {
      let j = i + 1;
      while (j < blockContent.length && blockContent[j] !== '"') j++;
      const key = blockContent.substring(i + 1, j);
      let after = j + 1;
      while (after < blockContent.length && (blockContent[after] === ' ' || blockContent[after] === '\t')) after++;
      if (after < blockContent.length && blockContent[after] === ':' && depth === 0 && keysToRemove.has(key)) {
        // Found start of entry to remove
        // Find start of line (last \n or start of block)
        let lineStart = blockContent.lastIndexOf('\n', i);
        lineStart = lineStart >= 0 ? lineStart + 1 : 0;
        
        // Find end of entry (comma or end of block)
        // First find the value closing quote
        let valEnd = -1;
        let searchFrom = j + 1;
        let inStr2 = false, escape2 = false;
        for (let si = searchFrom; si < blockContent.length; si++) {
          if (blockContent[si] === '\\') { escape2 = true; continue; }
          if (blockContent[si] === '"') {
            if (!inStr2) {
              inStr2 = true;
            } else {
              valEnd = si;
              break;
            }
          }
        }
        
        if (valEnd === -1) {
          i = j;
          inStr = !inStr;
          continue;
        }
        
        // Find comma or newline after value
        let entryEnd = valEnd + 1;
        while (entryEnd < blockContent.length && (blockContent[entryEnd] === ' ' || blockContent[entryEnd] === '\t')) entryEnd++;
        if (entryEnd < blockContent.length) {
          if (blockContent[entryEnd] === ',') {
            entryEnd++;
          } else if (blockContent[entryEnd] === '\n') {
            // Also consume the newline
            entryEnd++;
          }
        }
        
        positions.push({ start: lineStart, end: entryEnd, key });
      }
      i = j;
    } else if (blockContent[i] === '{') {
      depth++;
      i++;
    } else if (blockContent[i] === '}') {
      depth--;
      i++;
    } else {
      i++;
    }
    if (inStr) inStr = !inStr;
  }
  return positions;
}

// === MAIN ===
const blocks = findLocaleBlocks(content);
console.log('Found', blocks.length, 'locales:', blocks.map(b => b.name).join(', '));

// Get en keys
const enBlock = blocks.find(b => b.name === 'en');
const enContent = content.substring(enBlock.openPos + 1, enBlock.closePos);
const enKV = extractKeysAndValues(enContent);
const enKeys = new Set(Object.keys(enKV));
console.log('EN keys:', enKeys.size);

// Target locales
const gapFillLocales = ['hi', 'ms', 'ko', 'ja', 'ar'];
const dedupLocales = ['zh', 'ja', 'ko', 'ar'];

// === GAP FILL ===
console.log('\n=== GAP FILL PHASE ===');
for (const loc of gapFillLocales) {
  const lb = blocks.find(b => b.name === loc);
  if (!lb) continue;
  
  const blockContent = content.substring(lb.openPos + 1, lb.closePos);
  const locKeys = extractKeys(blockContent);
  const missing = [...enKeys].filter(k => !locKeys.has(k));
  
  console.log(loc + ': ' + missing.length + ' missing');
  
  if (missing.length > 0) {
    // Insert missing keys before the closing brace
    const insertEntries = missing.map(k => {
      const val = enKV[k] || k.replace(/_/g, ' ');
      return '        "' + k + '": "' + val + '"';
    }).join(',\n');
    
    // Insert at closePos - insert before the closing brace
    const insertAt = lb.closePos;
    content = content.substring(0, insertAt) + insertEntries + ',\n    ' + content.substring(insertAt);
    modified = true;
  }
}

// Re-parse blocks after insertions
const blocks2 = findLocaleBlocks(content);

// === DEDUP ===
console.log('\n=== DEDUP PHASE ===');
for (const loc of dedupLocales) {
  const lb = blocks2.find(b => b.name === loc);
  if (!lb) continue;
  
  const blockContent = content.substring(lb.openPos + 1, lb.closePos);
  const locKeys = extractKeys(blockContent);
  
  // Find keys that appear more than once (duplicates)
  const seen = new Map();
  let depth = 0, inStr = false, escape = false;
  let i = 0;
  
  while (i < blockContent.length) {
    if (blockContent[i] === '"') {
      let j = i + 1;
      while (j < blockContent.length && blockContent[j] !== '"') j++;
      const key = blockContent.substring(i + 1, j);
      let after = j + 1;
      while (after < blockContent.length && (blockContent[after] === ' ' || blockContent[after] === '\t')) after++;
      if (after < blockContent.length && blockContent[after] === ':' && depth === 0) {
        seen.set(key, (seen.get(key) || 0) + 1);
      }
      i = j;
    } else if (blockContent[i] === '{') {
      depth++;
      i++;
    } else if (blockContent[i] === '}') {
      depth--;
      i++;
    } else {
      i++;
    }
    if (inStr) inStr = !inStr;
  }
  
  const duplicates = [...seen.entries()].filter(([k, v]) => v > 1);
  if (duplicates.length > 0) {
    console.log(loc + ': ' + duplicates.length + ' duplicate keys');
    
    // For each duplicate key, find first occurrences and remove them (keep last)
    const keysToRemove = new Set(duplicates.map(([k]) => k));
    
    // Find all entry positions
    const toRemove = [];
    depth = 0; inStr = false; escape = false; i = 0;
    
    while (i < blockContent.length) {
      if (blockContent[i] === '"') {
        let j = i + 1;
        while (j < blockContent.length && blockContent[j] !== '"') j++;
        const key = blockContent.substring(i + 1, j);
        let after = j + 1;
        while (after < blockContent.length && (blockContent[after] === ' ' || blockContent[after] === '\t')) after++;
        if (after < blockContent.length && blockContent[after] === ':' && depth === 0 && keysToRemove.has(key)) {
          // Entry start
          let lineStart = blockContent.lastIndexOf('\n', i);
          lineStart = lineStart >= 0 ? lineStart + 1 : 0;
          
          // Find value end and comma
          let valEnd = -1, searchFrom = j + 1, inStr2 = false, escape2 = false;
          for (let si = searchFrom; si < blockContent.length; si++) {
            if (blockContent[si] === '\\') { escape2 = true; continue; }
            if (blockContent[si] === '"') {
              if (!inStr2) inStr2 = true;
              else { valEnd = si; break; }
            }
          }
          
          if (valEnd !== -1) {
            let entryEnd = valEnd + 1;
            while (entryEnd < blockContent.length && (blockContent[entryEnd] === ' ' || blockContent[entryEnd] === '\t')) entryEnd++;
            if (entryEnd < blockContent.length && blockContent[entryEnd] === ',') entryEnd++;
            toRemove.push({ start: lineStart, end: entryEnd });
          }
        }
        i = j;
      } else if (blockContent[i] === '{') {
        depth++;
        i++;
      } else if (blockContent[i] === '}') {
        depth--;
        i++;
      } else {
        i++;
      }
      if (inStr) inStr = !inStr;
    }
    
    // Only remove FIRST occurrences - keep last
    // For each duplicate key, remove all but the last occurrence
    const keyLastSeen = {};
    const toRemoveFiltered = [];
    for (const pos of toRemove) {
      // Find which key this is
      let depth3 = 0, inStr3 = false, escape3 = false;
      for (let si = pos.start; si < pos.end; si++) {
        if (blockContent[si] === '"') {
          let j = si + 1;
          while (j < blockContent.length && blockContent[j] !== '"') j++;
          const key = blockContent.substring(si + 1, j);
          let after = j + 1;
          while (after < blockContent.length && (blockContent[after] === ' ' || blockContent[after] === '\t')) after++;
          if (after < blockContent.length && blockContent[after] === ':' && depth3 === 0) {
            if (keyLastSeen[key] !== undefined) {
              // This is a duplicate, remove it
              toRemoveFiltered.push(pos);
            } else {
              keyLastSeen[key] = pos;
            }
            break;
          }
          si = j;
        } else if (blockContent[si] === '{') depth3++;
        else if (blockContent[si] === '}') depth3--;
        if (inStr3) inStr3 = !inStr3;
      }
    }
    
    // Remove entries from end to start
    toRemoveFiltered.sort((a, b) => b.start - a.start);
    for (const pos of toRemoveFiltered) {
      content = content.substring(0, lb.openPos + 1 + pos.start) + 
                content.substring(lb.openPos + 1 + pos.end);
    }
    
    // Re-parse
    const newBlocks = findLocaleBlocks(content);
    const newLb = newBlocks.find(b => b.name === loc);
    if (newLb) {
      blocks2.length = 0;
      blocks2.push(...newBlocks);
    }
  }
}

// === Save ===
fs.writeFileSync(filePath, content);
console.log('\n=== Saved ===');
console.log('New size:', content.length);

// === Verification ===
console.log('\n=== VERIFICATION ===');
const finalBlocks = findLocaleBlocks(content);
const finalEnBlock = finalBlocks.find(b => b.name === 'en');
const finalEnContent = content.substring(finalEnBlock.openPos + 1, finalEnBlock.closePos);
const finalEnKV = extractKeysAndValues(finalEnContent);
const finalEnKeys = new Set(Object.keys(finalEnKV));
console.log('EN keys:', finalEnKeys.size);

for (const loc of ['zh', 'ja', 'ko', 'th', 'vi', 'id', 'fr', 'es', 'de', 'ms', 'hi', 'ar']) {
  const b = finalBlocks.find(b => b.name === loc);
  if (!b) continue;
  const blockContent = content.substring(b.openPos + 1, b.closePos);
  const locKeys = extractKeys(blockContent);
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