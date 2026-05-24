#!/usr/bin/env node
/**
 * i18n-lint-dup-keys.js
 *
 * Detects duplicate direct keys within each TRANSLATIONS locale block in
 * i18n.js. With --fix, removes earlier duplicates and keeps the last property,
 * matching JavaScript object literal runtime semantics.
 *
 * Run: node scripts/i18n-lint-dup-keys.js [--fix] [i18n_path]
 * Exit codes: 0 = clean/fixed, 1 = dups found, 2 = file or parse error
 */

'use strict';

const path = require('path');
const fs = require('fs');
const espree = require('espree');

const args = process.argv.slice(2);
const FIX = args.includes('--fix');
const I18N_PATH = args.find(arg => !arg.startsWith('--'))
  || path.join(__dirname, '../public/shared/i18n.js');

const LOCALE_KEY_RE = /^[a-z]{2}(?:[-_][A-Z]{2})?$/;

function parseSource(source, filePath) {
  return espree.parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    range: true,
    loc: true,
    comment: false,
    tokens: false,
    filePath,
  });
}

function getPropertyKey(prop) {
  if (!prop || prop.type !== 'Property' || prop.computed) return null;
  if (!prop.key) return null;

  if (prop.key.type === 'Identifier') return prop.key.name;
  if (prop.key.type === 'Literal') return String(prop.key.value);

  return null;
}

function findTranslationsObject(ast) {
  for (const stmt of ast.body || []) {
    if (stmt.type !== 'VariableDeclaration') continue;
    for (const decl of stmt.declarations || []) {
      if (
        decl.id
        && decl.id.type === 'Identifier'
        && decl.id.name === 'TRANSLATIONS'
        && decl.init
        && decl.init.type === 'ObjectExpression'
      ) {
        return decl.init;
      }
    }
  }
  return null;
}

function collectLocaleReports(translationsObject) {
  const reports = [];

  for (const localeProp of translationsObject.properties || []) {
    const locale = getPropertyKey(localeProp);
    if (!locale || !LOCALE_KEY_RE.test(locale)) continue;
    if (!localeProp.value || localeProp.value.type !== 'ObjectExpression') continue;

    const seen = new Map();
    for (const prop of localeProp.value.properties || []) {
      const key = getPropertyKey(prop);
      if (!key) continue;
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push(prop);
    }

    const duplicates = [];
    for (const [key, props] of seen.entries()) {
      if (props.length <= 1) continue;
      const kept = props[props.length - 1];
      for (const prop of props.slice(0, -1)) {
        duplicates.push({
          key,
          removeLine: prop.loc.start.line,
          keepLine: kept.loc.start.line,
          prop,
        });
      }
    }

    reports.push({
      locale,
      startLine: localeProp.loc.start.line,
      endLine: localeProp.value.loc.end.line,
      duplicates,
    });
  }

  return reports;
}

function propertyRemovalRange(source, prop) {
  let start = source.lastIndexOf('\n', prop.range[0] - 1) + 1;
  let end = prop.range[1];

  while (end < source.length && /[ \t]/.test(source[end])) end++;
  if (source[end] === ',') end++;
  while (end < source.length && /[ \t]/.test(source[end])) end++;

  if (source[end] === '\r' && source[end + 1] === '\n') {
    end += 2;
  } else if (source[end] === '\n' || source[end] === '\r') {
    end += 1;
  } else {
    let before = start - 1;
    while (before >= 0 && /[ \t]/.test(source[before])) before--;
    if (source[before] === ',') start = before;
  }

  return [start, end];
}

function applyFix(source, reports) {
  const ranges = [];

  for (const report of reports) {
    for (const duplicate of report.duplicates) {
      ranges.push({
        range: propertyRemovalRange(source, duplicate.prop),
        duplicate,
      });
    }
  }

  ranges.sort((a, b) => b.range[0] - a.range[0]);

  let fixed = source;
  let previousStart = source.length;
  for (const item of ranges) {
    const [start, end] = item.range;
    if (start < 0 || end < start || end > source.length || end > previousStart) {
      throw new Error(`overlapping removal while fixing "${item.duplicate.key}"`);
    }
    fixed = fixed.slice(0, start) + fixed.slice(end);
    previousStart = start;
  }

  return fixed;
}

function summarize(reports) {
  let totalDups = 0;
  let failCount = 0;

  for (const report of reports) {
    const dups = report.duplicates;
    if (dups.length > 0) {
      totalDups += dups.length;
      failCount++;
      console.error(`FAIL: ${report.locale} (L${report.startLine}-L${report.endLine}): ${dups.length} duplicate key(s)`);
      for (const dup of dups.slice(0, 5)) {
        console.error(`  "${dup.key}": remove L${dup.removeLine}, keep L${dup.keepLine} (last wins)`);
      }
      if (dups.length > 5) {
        console.error(`  ... and ${dups.length - 5} more (not shown)`);
      }
    } else {
      console.log(`PASS: ${report.locale} (L${report.startLine}-L${report.endLine}): clean`);
    }
  }

  console.error('\n=== SUMMARY ===');
  return { totalDups, failCount };
}

function loadReports(source, filePath) {
  const ast = parseSource(source, filePath);
  const translationsObject = findTranslationsObject(ast);
  if (!translationsObject) {
    throw new Error('No TRANSLATIONS object found. Is this the i18n.js file?');
  }
  const reports = collectLocaleReports(translationsObject);
  if (reports.length === 0) {
    throw new Error('No locale blocks found. Is this the i18n.js file?');
  }
  return reports;
}

function main() {
  let content;
  try {
    content = fs.readFileSync(I18N_PATH, 'utf8');
  } catch (err) {
    console.error(`Error: Cannot read ${I18N_PATH}: ${err.message}`);
    process.exit(2);
  }

  let reports;
  try {
    reports = loadReports(content, I18N_PATH);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(2);
  }

  const { totalDups, failCount } = summarize(reports);

  if (totalDups === 0) {
    console.error(`All ${reports.length} locale block(s) are clean.`);
    return;
  }

  if (!FIX) {
    console.error(`Total: ${totalDups} duplicate key(s) across ${failCount} locale(s)`);
    process.exit(1);
  }

  let fixed;
  try {
    fixed = applyFix(content, reports);
    const fixedReports = loadReports(fixed, I18N_PATH);
    const remaining = fixedReports.reduce((sum, report) => sum + report.duplicates.length, 0);
    if (remaining > 0) {
      throw new Error(`${remaining} duplicate key(s) remain after fix`);
    }
  } catch (err) {
    console.error(`Error: --fix failed: ${err.message}`);
    process.exit(2);
  }

  fs.writeFileSync(I18N_PATH, fixed, 'utf8');
  console.error(`Fixed ${totalDups} duplicate key(s) across ${failCount} locale(s); kept last value for each key.`);
}

main();
