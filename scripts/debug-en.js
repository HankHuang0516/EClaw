#!/usr/bin/env node
// Debug: why does fix-i18n-v11 show different en key count than expected?

const fs = require('fs');
const content = fs.readFileSync('backend/public/shared/i18n.js', 'utf8');

// Find locale positions
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
        inStr = true;
        if (state === 'seek_key') {
          keyOpenPos = i;
        }
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

const locs = findLocalePositions(content);
const blocks = locs.map(loc => {
  const openPos = loc.headerEnd;
  const closePos = findClosingBrace(content, openPos - 1);
  return { name: loc.name, openPos, closePos };
});

const enBlock = blocks.find(b => b.name === 'en');
console.log('en block:', enBlock.openPos, enBlock.closePos);

const enKV = extractKeyValues(content, enBlock.openPos, enBlock.closePos);
console.log('EN keys from extractKeyValues:', Object.keys(enKV).length);
console.log('First 5 keys:', Object.keys(enKV).slice(0, 5));
console.log('Last 5 keys:', Object.keys(enKV).slice(-5));

// Also try simple count approach
const enContent = content.substring(enBlock.openPos, enBlock.closePos + 1);
let depth = 0, inStr = false, escape = false, count = 0, lastKey = null;
for (let i = 0; i < enContent.length; i++) {
  const c = enContent[i];
  if (escape) { escape = false; continue; }
  if (c === '\\') { escape = true; continue; }
  if (c === '"') {
    if (!inStr) {
      // potential key
      let j = i + 1;
      while (j < enContent.length && enContent[j] !== '"') j++;
      let next = j + 1;
      while (next < enContent.length && (enContent[next] === ' ' || enContent[next] === '\t')) next++;
      if (next < enContent.length && enContent[next] === ':' && depth === 0) {
        count++;
        lastKey = enContent.substring(i + 1, j);
      }
      i = j;
    }
    inStr = !inStr;
  } else if (!inStr) {
    if (c === '{') depth++;
    else if (c === '}') depth--;
  }
}
console.log('Simple count:', count, 'last key:', lastKey);