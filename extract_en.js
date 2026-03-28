const fs = require('fs');
const content = fs.readFileSync('backend/public/shared/i18n.js', 'utf8');

// Find the EN block
const lines = content.split('\n');
let enStartLine = -1;
let enEndLine = -1;
let zhStartLine = -1;

for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/^    en:\s*\{/)) enStartLine = i;
    if (lines[i].match(/^    zh:\s*\{/)) zhStartLine = i;
}

// Extract EN block (from enStartLine+1 to zhStartLine-1, but need to handle nested braces)
const enBlockLines = [];
let depth = 0;
for (let i = enStartLine + 1; i < lines.length; i++) {
    const line = lines[i];
    for (const char of line) {
        if (char === '{') depth++;
        if (char === '}') depth--;
    }
    enBlockLines.push(line);
    if (i > enStartLine && depth === 0) {
        enEndLine = i;
        break;
    }
}

const enBlock = enBlockLines.join('\n');

// Parse key-value pairs
const enTranslations = {};
const regex = /"([^"]+)":\s*"(.*)?"/g;
let match;
while ((match = regex.exec(enBlock)) !== null) {
    enTranslations[match[1]] = match[2] || '';
}

console.log(`Extracted ${Object.keys(enTranslations).length} EN translations`);

// Now get the ES block
let esStartLine = -1;
let arStartLine = -1;
for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/^    es:\s*\{/)) esStartLine = i;
    if (lines[i].match(/^    ar:\s*\{/)) arStartLine = i;
}

const esBlockLines = [];
depth = 0;
for (let i = esStartLine + 1; i < lines.length; i++) {
    const line = lines[i];
    for (const char of line) {
        if (char === '{') depth++;
        if (char === '}') depth--;
    }
    esBlockLines.push(line);
    if (i > esStartLine && depth === 0) {
        break;
    }
}

const esBlock = esBlockLines.join('\n');

// Parse existing ES key-value pairs
const esTranslations = {};
const esRegex = /"([^"]+)":\s*"(.*)?"/g;
while ((match = esRegex.exec(esBlock)) !== null) {
    esTranslations[match[1]] = match[2] || '';
}

console.log(`Extracted ${Object.keys(esTranslations).length} ES translations`);

// Find missing keys
const missingKeys = Object.keys(enTranslations).filter(k => !esTranslations[k]);
console.log(`Missing ${missingKeys.length} keys in ES`);

// Generate Spanish translations for missing keys
// For now, let's create a simple placeholder approach - copy EN value as placeholder
// In a real scenario, we'd want proper translation

const esMissingEntries = missingKeys.map(key => {
    const enValue = enTranslations[key];
    // Simple approach: use EN value as placeholder (should be replaced with proper ES translation)
    return { key, enValue };
});

// Save for later processing
fs.writeFileSync('en_translations.json', JSON.stringify(enTranslations, null, 2));
fs.writeFileSync('es_translations.json', JSON.stringify(esTranslations, null, 2));
fs.writeFileSync('missing_es_keys.json', JSON.stringify(esMissingEntries, null, 2));

console.log('\nSample missing entries (first 20):');
esMissingEntries.slice(0, 20).forEach(e => {
    console.log(`  "${e.key}": "${e.enValue.substring(0, 50)}..."`);
});
