#!/usr/bin/env node
/**
 * i18n-deduplicate-keys.js
 * Safely remove duplicate keys from i18n.js while preserving runtime behavior
 * Strategy: Remove earlier duplicates, keep later occurrences (maintains runtime behavior)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const I18N_PATH = path.join(__dirname, '../public/shared/i18n.js');
const BACKUP_PATH = I18N_PATH + '.backup-before-dedup';

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

// Find duplicate keys and return removal plan
function findDuplicateRemovalPlan(lines, startLine, endLine) {
  const keyPositions = {};
  const toRemove = [];
  const keyRe = /^\s+"([a-zA-Z0-9_-]+)":/;

  for (let i = startLine - 1; i < Math.min(endLine - 1, lines.length); i++) {
    const m = lines[i].match(keyRe);
    if (m) {
      const key = m[1];
      if (key in keyPositions) {
        // This is a duplicate - mark the EARLIER occurrence for removal
        toRemove.push({
          key,
          lineToRemove: keyPositions[key],
          keptLine: i + 1
        });
        // Update to keep the later occurrence
        keyPositions[key] = i + 1;
      } else {
        keyPositions[key] = i + 1;
      }
    }
  }

  return toRemove;
}

// Remove lines from content
function removeLines(lines, linesToRemove) {
  const toRemoveSet = new Set(linesToRemove.map(r => r.lineToRemove - 1)); // Convert to 0-based
  return lines.filter((line, index) => !toRemoveSet.has(index));
}

function main() {
  console.log('=== i18n Duplicate Key Cleanup ===\n');

  // Read original file
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

  // Create backup
  fs.writeFileSync(BACKUP_PATH, content);
  console.log(`✅ Backup created: ${BACKUP_PATH}`);

  const sorted = Object.entries(blocks).sort((a, b) => a[1] - b[1]);

  // Calculate end lines
  const localeEnds = {};
  for (let i = 0; i < sorted.length; i++) {
    localeEnds[sorted[i][0]] = i + 1 < sorted.length ? sorted[i + 1][1] - 1 : lines.length + 1;
  }

  // Find all duplicates and create removal plan
  const allRemovals = [];
  const dupesByLocale = {};

  for (const [locale, startLine] of sorted) {
    const endLine = localeEnds[locale];
    const removals = findDuplicateRemovalPlan(lines, startLine, endLine);

    if (removals.length > 0) {
      dupesByLocale[locale] = removals.length;
      allRemovals.push(...removals);
      console.log(`${locale.toUpperCase()}: ${removals.length} duplicate keys to remove`);

      // Show sample removals
      removals.slice(0, 3).forEach(r => {
        console.log(`  - Remove "${r.key}" at L${r.lineToRemove} (keep L${r.keptLine})`);
      });
      if (removals.length > 3) {
        console.log(`  ... and ${removals.length - 3} more`);
      }
    } else {
      console.log(`${locale.toUpperCase()}: clean (no duplicates)`);
    }
  }

  if (allRemovals.length === 0) {
    console.log('\n✅ No duplicates found - file is already clean!');
    fs.unlinkSync(BACKUP_PATH);
    return;
  }

  // Sort removals by line number (descending to avoid offset issues)
  allRemovals.sort((a, b) => b.lineToRemove - a.lineToRemove);

  console.log(`\n📊 Summary:`);
  console.log(`  Total duplicate lines to remove: ${allRemovals.length}`);
  Object.entries(dupesByLocale).forEach(([locale, count]) => {
    console.log(`  ${locale}: ${count} lines`);
  });

  // Apply removals
  console.log('\n🔄 Applying removals...');
  const cleanedLines = removeLines(lines, allRemovals);

  // Write cleaned file
  const cleanedContent = cleanedLines.join('\n');
  fs.writeFileSync(I18N_PATH, cleanedContent);

  console.log(`✅ Cleanup complete!`);
  console.log(`  Original: ${lines.length} lines`);
  console.log(`  Cleaned:  ${cleanedLines.length} lines`);
  console.log(`  Removed:  ${lines.length - cleanedLines.length} lines`);

  console.log(`\n🔍 Verification:`);
  console.log(`  Run: node backend/scripts/i18n-lint-dup-keys.js`);
  console.log(`  Backup: ${BACKUP_PATH}`);
  console.log(`  Restore: mv "${BACKUP_PATH}" "${I18N_PATH}"`);
}

if (require.main === module) {
  main();
}

module.exports = { findLocaleBlocks, findDuplicateRemovalPlan, removeLines };