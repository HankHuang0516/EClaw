#!/usr/bin/env node
/**
 * Detects duplicate keys within each locale object in i18n.js.
 *
 * Object literals are last-wins at runtime, so --fix removes earlier
 * duplicate properties and preserves the final property for each key.
 *
 * Run:
 *   node scripts/i18n-lint-dup-keys.js [i18n_path]
 *   node scripts/i18n-lint-dup-keys.js --fix [i18n_path]
 *
 * Exit codes:
 *   0 = clean, or fixed successfully
 *   1 = duplicates found in check mode
 *   2 = parse/file error
 */

'use strict';

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const DEFAULT_I18N_PATH = path.join(__dirname, '../public/shared/i18n.js');
const LOCALE_RE = /^[a-z]{2}(?:[-_][A-Z]{2})?$/;

function parseArgs(argv) {
  const args = argv.slice(2);
  const fix = args.includes('--fix');
  const positional = args.filter(arg => arg !== '--fix');

  return {
    fix,
    filePath: positional[0] || DEFAULT_I18N_PATH,
  };
}

function parseSource(source, filePath) {
  try {
    return acorn.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      locations: true,
    });
  } catch (err) {
    const where = err.loc ? `${filePath}:${err.loc.line}:${err.loc.column + 1}` : filePath;
    throw new Error(`${where}: ${err.message}`);
  }
}

function getStaticKey(prop) {
  if (!prop || prop.type !== 'Property' || prop.computed) return null;
  if (prop.key.type === 'Identifier') return prop.key.name;
  if (prop.key.type === 'Literal') return String(prop.key.value);
  return null;
}

function findTranslationsObject(ast) {
  for (const node of ast.body) {
    if (node.type !== 'VariableDeclaration') continue;
    for (const declarator of node.declarations) {
      if (
        declarator.id &&
        declarator.id.type === 'Identifier' &&
        declarator.id.name === 'TRANSLATIONS' &&
        declarator.init &&
        declarator.init.type === 'ObjectExpression'
      ) {
        return declarator.init;
      }
    }
  }

  throw new Error('No `TRANSLATIONS = { ... }` object found.');
}

function findDuplicateKeys(translationsObject) {
  const locales = [];

  for (const localeProp of translationsObject.properties) {
    const locale = getStaticKey(localeProp);
    if (!locale || !LOCALE_RE.test(locale)) continue;
    if (!localeProp.value || localeProp.value.type !== 'ObjectExpression') continue;

    const occurrences = new Map();
    for (const prop of localeProp.value.properties) {
      const key = getStaticKey(prop);
      if (!key) continue;
      if (!occurrences.has(key)) occurrences.set(key, []);
      occurrences.get(key).push(prop);
    }

    const duplicates = [];
    for (const [key, props] of occurrences) {
      if (props.length < 2) continue;
      duplicates.push({
        key,
        first: props[0],
        removeProps: props.slice(0, -1),
        keep: props[props.length - 1],
      });
    }

    locales.push({
      locale,
      startLine: localeProp.loc.start.line,
      endLine: localeProp.loc.end.line,
      duplicates,
    });
  }

  return locales.sort((a, b) => a.startLine - b.startLine);
}

function skipWhitespace(source, index) {
  let i = index;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  return i;
}

function rewindWhitespace(source, index) {
  let i = index;
  while (i > 0 && /\s/.test(source[i - 1])) i -= 1;
  return i;
}

function removalRangeForProperty(source, prop) {
  const afterWhitespace = skipWhitespace(source, prop.end);
  if (source[afterWhitespace] === ',') {
    return {
      start: prop.start,
      end: skipWhitespace(source, afterWhitespace + 1),
    };
  }

  const beforeWhitespace = rewindWhitespace(source, prop.start);
  if (source[beforeWhitespace - 1] === ',') {
    return {
      start: beforeWhitespace - 1,
      end: prop.end,
    };
  }

  return {
    start: prop.start,
    end: prop.end,
  };
}

function applyRemovals(source, removals) {
  const sorted = [...removals].sort((a, b) => b.start - a.start);
  let fixed = source;

  for (const range of sorted) {
    fixed = fixed.slice(0, range.start) + fixed.slice(range.end);
  }

  return fixed;
}

function formatDuplicate(duplicate) {
  return `"${duplicate.key}": first at L${duplicate.first.loc.start.line}, ` +
    `kept last at L${duplicate.keep.loc.start.line}`;
}

function printReport(locales, mode) {
  let totalDuplicateKeys = 0;
  let totalRemoved = 0;
  let failingLocales = 0;

  for (const entry of locales) {
    const dupCount = entry.duplicates.length;
    const removeCount = entry.duplicates.reduce((sum, dup) => sum + dup.removeProps.length, 0);
    totalDuplicateKeys += dupCount;
    totalRemoved += removeCount;

    const lineRange = `L${entry.startLine}-L${entry.endLine}`;
    if (dupCount === 0) {
      console.log(`PASS: ${entry.locale} (${lineRange}): clean`);
      continue;
    }

    failingLocales += 1;
    const failLog = mode === 'check' ? console.error : console.log;
    failLog(`FAIL: ${entry.locale} (${lineRange}): ${dupCount} duplicate key(s), ${removeCount} earlier propert${removeCount === 1 ? 'y' : 'ies'} ${mode === 'fix' ? 'removed' : 'shadowed'}`);
    for (const duplicate of entry.duplicates.slice(0, 5)) {
      failLog(`  ${formatDuplicate(duplicate)}`);
    }
    if (dupCount > 5) {
      failLog(`  ... and ${dupCount - 5} more (not shown)`);
    }
  }

  console.log('\n=== SUMMARY ===');
  if (totalDuplicateKeys === 0) {
    console.log(`All ${locales.length} locale block(s) are clean.`);
  } else if (mode === 'fix') {
    console.log(`Fixed: removed ${totalRemoved} earlier duplicate propert${totalRemoved === 1 ? 'y' : 'ies'} across ${failingLocales} locale(s); last-wins values preserved.`);
  } else {
    const summaryLog = mode === 'check' ? console.error : console.log;
    summaryLog(`Total: ${totalDuplicateKeys} duplicate key(s) across ${failingLocales} locale(s); runtime uses the last property for each key.`);
  }

  return { totalDuplicateKeys, totalRemoved, failingLocales };
}

function lintSource(source, filePath) {
  const ast = parseSource(source, filePath);
  const translationsObject = findTranslationsObject(ast);
  return findDuplicateKeys(translationsObject);
}

function main() {
  const { fix, filePath } = parseArgs(process.argv);
  let source;

  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(`Error: Cannot read ${filePath}: ${err.message}`);
    process.exit(2);
  }

  let locales;
  try {
    locales = lintSource(source, filePath);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(2);
  }

  if (locales.length === 0) {
    console.error('Error: No locale objects found in TRANSLATIONS.');
    process.exit(2);
  }

  if (!fix) {
    const { totalDuplicateKeys } = printReport(locales, 'check');
    process.exit(totalDuplicateKeys > 0 ? 1 : 0);
  }

  const removals = [];
  for (const entry of locales) {
    for (const duplicate of entry.duplicates) {
      for (const prop of duplicate.removeProps) {
        removals.push(removalRangeForProperty(source, prop));
      }
    }
  }

  const { totalDuplicateKeys } = printReport(locales, 'fix');
  if (totalDuplicateKeys === 0) return;

  const fixed = applyRemovals(source, removals);
  fs.writeFileSync(filePath, fixed, 'utf8');
  console.log(`Wrote ${filePath}`);
}

if (require.main === module) main();

module.exports = {
  findDuplicateKeys,
  lintSource,
  removalRangeForProperty,
};
