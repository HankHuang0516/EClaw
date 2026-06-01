#!/usr/bin/env node
/**
 * fix-i18n-v18.js - Gap fill with correct last-comma detection
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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
  let keyOpenPos = -1, keyClosePos = -1, valOpenPos = -1;

  for (let i = blockStart; i < blockEnd; i++) {
    const c = content[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') {
      if (!inStr) { inStr = true; if (state === 'seek_key') keyOpenPos = i; }
      else {
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
      else if (c === ':' && depth === 0 && state === 'seek_colon') { state = 'seek_value'; valOpenPos = i; }
      else if (c === ',' && depth === 0) { state = 'seek_key'; currentKey = null; }
    }
  }
  return kv;
}

function syntaxCheck(content) {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, content);
  try {
    execSync('node --check ' + tmp, { encoding: 'utf8', stdio: 'pipe' });
    fs.unlinkSync(tmp);
    return true;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return false;
  }
}

// Find last comma in a block (scanning backwards, not tracking depth)
function findLastComma(content, headerEnd, closePos) {
  let inStr = false, escape = false;
  for (let i = closePos - 1; i >= headerEnd; i--) {
    const c = content[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === ',') return i;
  }
  return -1;
}

// Parse state
let locs = findLocalePositions(content);
let blocks = locs.map(loc => ({
  name: loc.name,
  openPos: loc.headerEnd,
  closePos: findClosingBrace(content, loc.headerEnd - 1)
}));

const enBlock = blocks.find(b => b.name === 'en');
const enKV = extractKeyValues(content, enBlock.openPos, enBlock.closePos);
const enKeys = new Set(Object.keys(enKV));
console.log('EN keys:', enKeys.size);

function processGapFill(locName) {
  const lb = blocks.find(b => b.name === locName);
  if (!lb) { console.log(locName + ': NOT FOUND'); return false; }
  
  const locKV = extractKeyValues(content, lb.openPos, lb.closePos);
  const locKeys = new Set(Object.keys(locKV));
  const missing = [...enKeys].filter(k => !locKeys.has(k));
  
  if (missing.length === 0) {
    console.log(locName + ': OK (no missing)');
    return true;
  }
  
  console.log(locName + ': filling ' + missing.length + ' gaps');
  
  // Find last comma before the closing brace
  const commaPos = findLastComma(content, lb.openPos, lb.closePos);
  if (commaPos === -1) {
    console.log(locName + ': No trailing comma found - cannot insert');
    return false;
  }
  
  console.log(locName + ': last comma at ' + commaPos);
  console.log('  Around comma:', JSON.stringify(content.substring(commaPos - 30, commaPos + 30)));
  
  // Build insertion string
  let insert = '';
  for (const k of missing) {
    const val = enKV[k] || '';
    insert += '        "' + k + '": "' + val + '",\n';
  }
  
  // Insert after the comma (commaPos + 1)
  content = content.substring(0, commaPos + 1) + '\n' + insert + content.substring(lb.closePos);
  
  console.log(locName + ': inserted after comma');
  return true;
}

// Process only hi first (63 missing, no orphans)
const result = processGapFill('hi');
if (!result) {
  console.log('Failed');
  process.exit(1);
}

// Syntax check
if (!syntaxCheck(content)) {
  console.log('SYNTAX ERROR after hi gap fill!');
  content = fs.readFileSync(FILE, 'utf8');
  process.exit(1);
}

console.log('hi: syntax OK, size:', content.length);

// Save
fs.writeFileSync(FILE, content);
console.log('Saved');

console.log('\n=== Final Verification ===');
locs = findLocalePositions(content);
blocks = locs.map(loc => ({
  name: loc.name,
  openPos: loc.headerEnd,
  closePos: findClosingBrace(content, loc.headerEnd - 1)
}));

const finalEnBlock = blocks.find(b => b.name === 'en');
const finalEnKV = extractKeyValues(content, finalEnBlock.openPos, finalEnBlock.closePos);
const finalEnKeys = new Set(Object.keys(finalEnKV));
console.log('EN keys:', finalEnKeys.size);

for (const locName of ['hi']) {
  const b = blocks.find(b => b.name === locName);
  if (!b) continue;
  const locKV = extractKeyValues(content, b.openPos, b.closePos);
  const locKeys = new Set(Object.keys(locKV));
  const missing = [...finalEnKeys].filter(k => !locKeys.has(k));
  if (missing.length > 0) {
    console.log(locName + ': MISSING=' + missing.length);
  } else {
    console.log(locName + ': OK keys=' + locKeys.size);
  }
}