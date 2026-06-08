#!/usr/bin/env node
/**
 * i18n-insert-locale-keys.js
 *
 * Inserts a batch of {key: value} pairs into a specified locale block
 * inside TRANSLATIONS in backend/public/shared/i18n.js, using AST parsing
 * (espree) to find the exact byte position of the locale's closing brace.
 *
 * Why this exists: regex+depth-walker approaches mis-count braces when
 * string values contain literal '{' or '}', leading to keys being inserted
 * at outer TRANSLATIONS scope (see PR #3253 revert post-mortem).
 *
 * Usage:
 *   node backend/scripts/i18n-insert-locale-keys.js <locale> <translations.json> [i18n_path]
 *
 * Exit codes:
 *   0 = inserted OK
 *   1 = locale block not found
 *   2 = parse error / IO error
 *   3 = key collision (one of the new keys already exists in the block)
 */

'use strict';

const path = require('path');
const fs = require('fs');
const espree = require('espree');

const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error('usage: i18n-insert-locale-keys.js <locale> <translations.json> [i18n_path]');
  process.exit(2);
}

const locale = argv[0];
const trPath = argv[1];
const i18nPath = argv[2] || path.join(__dirname, '..', 'public', 'shared', 'i18n.js');

let source, translations;
try {
  source = fs.readFileSync(i18nPath, 'utf8');
} catch (e) {
  console.error(`READ i18n.js failed: ${e.message}`);
  process.exit(2);
}
try {
  translations = JSON.parse(fs.readFileSync(trPath, 'utf8'));
} catch (e) {
  console.error(`READ/PARSE ${trPath} failed: ${e.message}`);
  process.exit(2);
}

const newKeys = Object.keys(translations);
if (newKeys.length === 0) {
  console.error('Empty translations object — nothing to do.');
  process.exit(2);
}

// Parse the entire i18n.js with ranges enabled.
let ast;
try {
  ast = espree.parse(source, {
    ecmaVersion: 'latest',
    range: true,
    loc: false,
    comment: false,
  });
} catch (e) {
  console.error(`espree parse failed: ${e.message}`);
  process.exit(2);
}

// Find: const TRANSLATIONS = { ... };
let translationsObject = null;
for (const stmt of ast.body) {
  if (
    stmt.type === 'VariableDeclaration' &&
    stmt.declarations.length === 1 &&
    stmt.declarations[0].id.name === 'TRANSLATIONS' &&
    stmt.declarations[0].init &&
    stmt.declarations[0].init.type === 'ObjectExpression'
  ) {
    translationsObject = stmt.declarations[0].init;
    break;
  }
}
if (!translationsObject) {
  console.error('Could not locate `const TRANSLATIONS = {...};` declaration.');
  process.exit(2);
}

// Find the property whose key matches `locale`.
function propertyKeyName(prop) {
  if (prop.key.type === 'Identifier') return prop.key.name;
  if (prop.key.type === 'Literal') return String(prop.key.value);
  return null;
}

let localeProperty = null;
for (const prop of translationsObject.properties) {
  if (prop.type !== 'Property') continue;
  if (propertyKeyName(prop) === locale) {
    localeProperty = prop;
    break;
  }
}
if (!localeProperty) {
  console.error(`Locale "${locale}" not found at top of TRANSLATIONS object.`);
  process.exit(1);
}
if (localeProperty.value.type !== 'ObjectExpression') {
  console.error(`Locale "${locale}" value is not an ObjectExpression (got ${localeProperty.value.type}).`);
  process.exit(2);
}

// Detect collisions: keys already present in the locale block.
const existingKeys = new Set();
for (const prop of localeProperty.value.properties) {
  if (prop.type !== 'Property') continue;
  const k = propertyKeyName(prop);
  if (k != null) existingKeys.add(k);
}
const collisions = newKeys.filter((k) => existingKeys.has(k));
if (collisions.length) {
  console.error(`Collision: ${collisions.length} key(s) already in ${locale}: ${collisions.slice(0, 5).join(', ')}${collisions.length > 5 ? ', ...' : ''}`);
  process.exit(3);
}

// localeProperty.value.range[1] is the position of the closing '}' + 1.
// We insert just before the closing '}', i.e. at range[1] - 1.
const closeBracePos = localeProperty.value.range[1] - 1; // index of '}'
if (source[closeBracePos] !== '}') {
  console.error(`Sanity check failed: char at locale close offset ${closeBracePos} is ${JSON.stringify(source[closeBracePos])} not '}'.`);
  process.exit(2);
}

// Determine inner indent by sampling an existing property in the block, fall back to 8 spaces.
let innerIndent = '        ';
if (localeProperty.value.properties.length > 0) {
  const firstProp = localeProperty.value.properties[0];
  // Walk back from firstProp.range[0] to start of its line.
  const propStart = firstProp.range[0];
  const lineStart = source.lastIndexOf('\n', propStart - 1) + 1;
  const candidate = source.slice(lineStart, propStart);
  // Only accept if it's purely whitespace (otherwise something funky; fall back).
  if (/^[ \t]+$/.test(candidate)) innerIndent = candidate;
}

// Build the insert text. Each key: `<indent>"key": "value",`.
const insertLines = newKeys.map(
  (k) => `${innerIndent}${JSON.stringify(k)}: ${JSON.stringify(translations[k])},`
);

// We need to make sure the last existing property's trailing punctuation is a comma so the new ones chain cleanly.
// Walk back from closeBracePos through whitespace; if we hit a non-comma non-'{' char, we need to add a comma.
let scan = closeBracePos - 1;
while (scan >= 0 && /\s/.test(source[scan])) scan--;
let needLeadingComma = false;
if (scan >= 0 && source[scan] !== ',' && source[scan] !== '{') {
  // E.g. `"foo": "bar"` (no trailing comma). We add a comma + newline.
  needLeadingComma = true;
}

const insertText = (needLeadingComma ? ',\n' : '\n') + insertLines.join('\n') + '\n';

// Splice insertText in just before closeBracePos. Preserve any whitespace before closeBracePos.
// Actually simplest: insert at exact closeBracePos position.
const newSource = source.slice(0, closeBracePos) + insertText + source.slice(closeBracePos);

fs.writeFileSync(i18nPath, newSource);

const delta = newSource.length - source.length;
console.log(`OK ${locale}: inserted ${newKeys.length} keys; size +${delta} bytes; close-brace was at byte ${closeBracePos}.`);
process.exit(0);
