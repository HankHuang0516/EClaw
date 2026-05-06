#!/usr/bin/env node
/**
 * Comprehensive i18n audit script
 * Counts keys, identifies duplicates, and provides quality metrics
 */

'use strict';

const fs = require('fs');
const path = require('path');

const I18N_PATH = path.join(__dirname, '../public/shared/i18n.js');

// Match `xx:` or `xx-XX:` locale headers
const LOCALE_HEADER_RE = /^"?([a-z]{2}(?:[-_][A-Z]{2})?)"?:\s*\{/;

// Count braces outside string literals
function countBracesOutsideStrings(line, startInString) {
  let opens = 0;
  let closes = 0;
  let inString = startInString;
  let escape = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = false; continue; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') opens++;
    else if (ch === '}') closes++;
  }
  return { opens, closes, inString };
}

// Find all locale blocks
function findLocaleBlocks(lines) {
  const blocks = {};
  let braceDepth = 0;
  let inTranslations = false;
  let inString = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    if (!inString && braceDepth === 1 && inTranslations && indent <= 4) {
      const m = trimmed.match(LOCALE_HEADER_RE);
      if (m) blocks[m[1]] = i + 1;
    }

    if (!inTranslations && line.includes('TRANSLATIONS') && line.includes('=')) {
      inTranslations = true;
    }

    const counts = countBracesOutsideStrings(line, inString);
    braceDepth += counts.opens - counts.closes;
    inString = counts.inString;
  }

  return blocks;
}

// Extract keys from a locale block
function extractKeys(lines, startLine, endLine) {
  const keys = new Set();
  const duplicates = [];
  const keyPositions = {};
  const keyRe = /^\s+"([a-zA-Z0-9_-]+)":/;

  for (let i = startLine - 1; i < Math.min(endLine - 1, lines.length); i++) {
    const m = lines[i].match(keyRe);
    if (m) {
      const key = m[1];
      if (key in keyPositions) {
        duplicates.push({ key, first: keyPositions[key], dup: i + 1 });
      } else {
        keyPositions[key] = i + 1;
        keys.add(key);
      }
    }
  }

  return { keys, duplicates };
}

function main() {
  let content;
  try {
    content = fs.readFileSync(I18N_PATH, 'utf8');
  } catch (err) {
    console.error(`Error: Cannot read ${I18N_PATH}: ${err.message}`);
    process.exit(2);
  }

  const lines = content.split('\n');
  const blocks = findLocaleBlocks(lines);

  if (Object.keys(blocks).length === 0) {
    console.error('Error: No locale blocks found.');
    process.exit(2);
  }

  const sorted = Object.entries(blocks).sort((a, b) => a[1] - b[1]);

  // Calculate end lines
  const localeEnds = {};
  for (let i = 0; i < sorted.length; i++) {
    localeEnds[sorted[i][0]] = i + 1 < sorted.length ? sorted[i + 1][1] - 1 : lines.length + 1;
  }

  console.log('=== i18n Quality Audit ===\n');

  const results = {};
  let enKeys = null;

  for (const [locale, startLine] of sorted) {
    const endLine = localeEnds[locale];
    const { keys, duplicates } = extractKeys(lines, startLine, endLine);

    results[locale] = {
      keyCount: keys.size,
      duplicateCount: duplicates.length,
      startLine,
      endLine,
      keys,
      duplicates
    };

    if (locale === 'en') {
      enKeys = keys;
    }

    console.log(`${locale.toUpperCase()}:`);
    console.log(`  Keys: ${keys.size}`);
    console.log(`  Duplicates: ${duplicates.length}`);
    console.log(`  Lines: L${startLine}–L${endLine}`);
    console.log('');
  }

  // Missing key analysis
  if (enKeys) {
    console.log('=== Missing Key Analysis ===\n');
    for (const [locale, startLine] of sorted) {
      if (locale === 'en') continue;

      const { keys } = results[locale];
      const missing = [];
      enKeys.forEach(key => {
        if (!keys.has(key)) missing.push(key);
      });

      console.log(`${locale.toUpperCase()}: missing ${missing.length} keys`);

      if (missing.length > 0) {
        const byPrefix = {};
        missing.forEach(key => {
          const prefix = key.split('_')[0];
          if (!byPrefix[prefix]) byPrefix[prefix] = [];
          byPrefix[prefix].push(key);
        });

        Object.keys(byPrefix).sort().forEach(prefix => {
          console.log(`  [${prefix}] ${byPrefix[prefix].length}: ${byPrefix[prefix].slice(0, 3).join(', ')}${byPrefix[prefix].length > 3 ? '...' : ''}`);
        });
      }
      console.log('');
    }
  }

  // Summary
  console.log('=== Summary ===');
  console.log(`Total locales: ${sorted.length}`);
  const withDuplicates = sorted.filter(([l]) => results[l].duplicateCount > 0);
  console.log(`Locales with duplicates: ${withDuplicates.length}`);

  withDuplicates.forEach(([locale]) => {
    console.log(`  ${locale}: ${results[locale].duplicateCount} duplicates`);
  });

  if (enKeys) {
    console.log(`\nEN baseline: ${enKeys.size} keys`);
    sorted.forEach(([locale]) => {
      if (locale === 'en') return;
      const missing = enKeys.size - results[locale].keys.size + results[locale].duplicateCount;
      const coverage = ((results[locale].keys.size / enKeys.size) * 100).toFixed(1);
      console.log(`${locale}: ${results[locale].keys.size} keys (${coverage}% coverage, ${missing > 0 ? '+' : ''}${missing} vs EN)`);
    });
  }
}

main();