#!/usr/bin/env node
// Diagnostic: verify en key extraction
const fs = require('fs');
const content = fs.readFileSync('backend/public/shared/i18n.js', 'utf8');

// Find en header
const enMatch = content.match(/\n\s+en:\s*\{/);
const enHeaderEnd = enMatch.index + enMatch[0].length; // position after '{'
const openPos = enHeaderEnd - 1; // position of '{'

// Find closing brace
let depth = 0, closePos = -1;
for (let i = openPos; i < content.length; i++) {
  if (content[i] === '{') depth++;
  else if (content[i] === '}') { depth--; if (depth === 0) { closePos = i; break; } }
}

console.log('en block: openPos=' + openPos + ', closePos=' + closePos);
console.log('open char:', content[openPos], 'close char:', content[closePos]);

const enContent = content.substring(openPos + 1, closePos);
console.log('en content length:', enContent.length);
console.log('first 200 chars:', enContent.substring(0, 200));

// Extract key:value pairs
const kv = {};
let depth2 = 0, inStr = false, escape = false, currentKey = null, prevWasColon = false;

for (let i = 0; i < enContent.length; i++) {
  const c = enContent[i];
  if (escape) { escape = false; continue; }
  if (c === '\\') { escape = true; continue; }
  if (c === '"') {
    if (!inStr) {
      // Opening quote - could be key
      const keyStart = i + 1;
      let j = keyStart;
      while (j < enContent.length && enContent[j] !== '"') j++;
      const key = keyStart < enContent.length ? enContent.substring(keyStart, j) : '';
      let next = j + 1;
      while (next < enContent.length && (enContent[next] === ' ' || enContent[next] === '\t')) next++;
      if (next < enContent.length && enContent[next] === ':' && depth2 === 0) {
        currentKey = key;
        prevWasColon = true;
      } else {
        prevWasColon = false;
      }
      i = j; // Move to closing quote position
    } else {
      // Closing quote
      if (prevWasColon && depth2 === 0 && currentKey) {
        const valStart = i + 1;
        let valEnd = valStart;
        let esc = false;
        while (valEnd < enContent.length) {
          if (enContent[valEnd] === '\\') { esc = true; valEnd++; }
          else if (enContent[valEnd] === '"') break;
          else valEnd++;
        }
        kv[currentKey] = enContent.substring(valStart, valEnd);
        currentKey = null;
        prevWasColon = false;
        // Jump to after this quote to avoid re-processing
        const nextQuote = enContent.indexOf('"', i + 1);
        if (nextQuote === -1) break;
        i = nextQuote;
      }
      i = enContent.indexOf('"', i + 1);
      if (i === -1) break;
    }
    inStr = !inStr;
  } else if (!inStr) {
    if (c === '{') depth2++;
    else if (c === '}') depth2--;
    else if (c === ',') { prevWasColon = false; currentKey = null; }
    else if (c === ':') { /* skip */ }
  }
}

console.log('\nKeys found:', Object.keys(kv).length);
console.log('First 10 keys:', Object.keys(kv).slice(0, 10));
console.log('Sample entries:', Object.entries(kv).slice(0, 3).map(e => e[0] + '=' + e[1].substring(0, 40)));