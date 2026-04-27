#!/usr/bin/env node
/**
 * i18n-lint-dup-keys.js
 * Detects duplicate top-level keys within each locale block in i18n.js.
 * Run: node scripts/i18n-lint-dup-keys.js [i18n_path]
 * Exit codes: 0 = clean, 1 = dups found, 2 = file error
 */

'use strict';

const path = require('path');
const fs = require('fs');

const I18N_PATH = process.argv[2] || path.join(__dirname, '../public/shared/i18n.js');

function findLocaleBlocks(content, lines) {
  const blocks = {};
  let braceDepth = 0;
  let inTranslations = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    // Check locale header BEFORE updating brace depth for this line
    const m = trimmed.match(/^([a-z]{2}(?:[-_][A-Z]{2})?):\s*\{/);
    if (m && indent === 4 && braceDepth === 1 && inTranslations) {
      blocks[m[1]] = i + 1; // 1-indexed
    }

    // Update brace depth AFTER the check (depth at start of this line)
    if (!inTranslations) {
      if (line.includes('TRANSLATIONS') && line.includes('=')) {
        inTranslations = true;
      }
    }
    braceDepth += (line.match(/\{/g) || []).length;
    braceDepth -= (line.match(/\}/g) || []).length;
  }

  return blocks;
}

function findDuplicateKeys(lines, startLine, endLine) {
  const keyPositions = {};
  const dups = [];
  const keyRe = /^\s+"([a-zA-Z_]+)":/;

  for (let i = startLine - 1; i < Math.min(endLine - 1, lines.length); i++) {
    const m = lines[i].match(keyRe);
    if (m) {
      const key = m[1];
      if (key in keyPositions) {
        dups.push({ key, first: keyPositions[key], dup: i + 1 });
      } else {
        keyPositions[key] = i + 1;
      }
    }
  }

  return dups;
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
  const blocks = findLocaleBlocks(content, lines);

  if (Object.keys(blocks).length === 0) {
    console.error('Error: No locale blocks found. Is this the i18n.js file?');
    process.exit(2);
  }

  const sorted = Object.entries(blocks).sort((a, b) => a[1] - b[1]);

  const localeEnds = {};
  for (let i = 0; i < sorted.length; i++) {
    localeEnds[sorted[i][0]] = i + 1 < sorted.length ? sorted[i + 1][1] - 1 : lines.length + 1;
  }

  let hasErrors = false;

  for (const [locale, startLine] of sorted) {
    const endLine = localeEnds[locale];
    const dups = findDuplicateKeys(lines, startLine, endLine);

    if (dups.length > 0) {
      hasErrors = true;
      console.error(`FAIL: ${locale} (L${startLine}–L${endLine}): ${dups.length} duplicate key(s)`);
      for (const dup of dups.slice(0, 5)) {
        console.error(`  "${dup.key}": first at L${dup.first}, duplicate at L${dup.dup}`);
      }
      if (dups.length > 5) {
        console.error(`  ... and ${dups.length - 5} more (not shown)`);
      }
    } else {
      console.log(`PASS: ${locale} (L${startLine}–L${endLine}): clean`);
    }
  }

  console.error('\n=== SUMMARY ===');
  if (hasErrors) {
    const totalDups = sorted.reduce((sum, [l]) => sum + findDuplicateKeys(lines, blocks[l], localeEnds[l]).length, 0);
    const failCount = sorted.filter(([l]) => findDuplicateKeys(lines, blocks[l], localeEnds[l]).length > 0).length;
    console.error(`Total: ${totalDups} duplicate key(s) across ${failCount} locale(s)`);
    process.exit(1);
  } else {
    console.error(`All ${sorted.length} locale block(s) are clean.`);
    process.exit(0);
  }
}

main();
