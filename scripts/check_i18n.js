#!/usr/bin/env node
const fs = require('fs');
const { execSync } = require('child_process');

// Check file status
try {
  const stat = fs.statSync('backend/public/shared/i18n.js');
  console.log('File size:', stat.size);
  console.log('Modified:', stat.mtime);
} catch(e) {
  console.log('File error:', e.message);
}

// Check git status
try {
  const gitStatus = execSync('git status --short', { encoding: 'utf8', timeout: 10000 });
  console.log('Git status:', gitStatus);
} catch(e) {
  console.log('Git error:', e.message);
}

// Read and analyze file
try {
  const content = fs.readFileSync('backend/public/shared/i18n.js', 'utf8');
  console.log('Content length:', content.length);
  
  const localeRegex = /(?:^|\n)\s+([a-z]{2}(?:-[A-Z]{2})?):\s*\{/gm;
  const localeStarts = [];
  let m;
  while ((m = localeRegex.exec(content)) !== null) localeStarts.push({ name: m[1], pos: m.index });
  localeStarts.push({ name: '__END__', pos: content.length });
  
  console.log('Locales found:', localeStarts.slice(0,-1).map(l=>l.name).join(', '));
  
  function extractAllKeys(block) {
    const keys = new Set();
    let inStr = false, escape = false, prevWasColon = false;
    for (let i = 0; i < block.length; i++) {
      const c = block[i];
      if (escape) { escape = false; i++; continue; }
      if (c === '\\') { escape = true; i++; continue; }
      if (c === '"') {
        if (!inStr) {
          let j = i + 1;
          while (j < block.length && block[j] !== '"') j++;
          let next = j + 1;
          while (next < block.length && (block[next] === ' ' || block[next] === '\t')) next++;
          if (next < block.length && block[next] === ':' && !prevWasColon) {
            keys.add(block.substring(i + 1, j));
            prevWasColon = true;
          } else { prevWasColon = false; }
          i = j;
        }
        inStr = !inStr;
      } else if (!inStr) {
        if (c === ',') prevWasColon = false;
      }
    }
    return keys;
  }
  
  const enBrace = content.indexOf('{', localeStarts[0].pos + 3);
  const enBlock = content.substring(enBrace + 1, localeStarts[1].pos - 1);
  const enKeys = extractAllKeys(enBlock);
  console.log('EN keys:', enKeys.size);
  
  console.log('\nVerification:');
  for (const loc of ['zh', 'ja', 'ko', 'th', 'vi', 'id', 'fr', 'es', 'de', 'ms', 'hi', 'ar']) {
    const idx = localeStarts.findIndex(l => l.name === loc);
    if (idx < 0) continue;
    const bracePos = content.indexOf('{', localeStarts[idx].pos + loc.length + 2);
    const blockStart = bracePos + 1;
    const blockEnd = localeStarts[idx + 1].pos - 1;
    const block = content.substring(blockStart, blockEnd);
    const keys = extractAllKeys(block);
    const missing = [...enKeys].filter(k => !keys.has(k));
    const extra = [...keys].filter(k => !enKeys.has(k));
    console.log(loc + ': keys=' + keys.size + ' missing=' + missing.length + ' extra=' + extra.length);
  }
} catch(e) {
  console.log('Read error:', e.message);
}