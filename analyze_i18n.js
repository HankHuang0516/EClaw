const fs = require('fs');
const content = fs.readFileSync('backend/public/shared/i18n.js', 'utf8');

// Find all language blocks by finding patterns like "    xx: {" at start of line
const lines = content.split('\n');
const langPositions = [];
for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^    (\w+):\s*\{/);
    if (match) {
        langPositions.push({ lang: match[1], line: i, pos: content.indexOf(line) });
    }
}

console.log('Found languages:');
for (const { lang, line } of langPositions) {
    console.log(`  ${lang}: line ${line + 1}`);
}

// For each language, extract its block (from its opening { to the next language's start)
const blocks = {};
for (let i = 0; i < langPositions.length; i++) {
    const { lang, line, pos } = langPositions[i];
    const startLine = line + 1; // skip the "xx: {" line
    
    // Find the end by counting braces
    let depth = 1;
    let endLine = startLine;
    for (let j = startLine; j < lines.length; j++) {
        for (const char of lines[j]) {
            if (char === '{') depth++;
            if (char === '}') depth--;
        }
        if (depth === 0) {
            endLine = j;
            break;
        }
    }
    
    const block = lines.slice(startLine, endLine).join('\n');
    blocks[lang] = block;
}

// Extract keys for each language
const langKeys = {};
for (const lang of langPositions.map(l => l.lang)) {
    const block = blocks[lang];
    if (!block) continue;
    const keyMatches = block.match(/"([^"]+)":/g) || [];
    langKeys[lang] = new Set(keyMatches.map(k => k.replace(/:$/, '').replace(/"/g, '')));
    console.log(`${lang}: ${langKeys[lang].size} keys`);
}

// Find missing ES keys
const enKeys = langKeys['en'];
const esKeys = langKeys['es'];
const missingEs = [...enKeys].filter(k => !esKeys.has(k));

console.log(`\nEN has ${enKeys.size} keys`);
console.log(`ES has ${esKeys.size} keys`);
console.log(`Missing ES keys: ${missingEs.length}`);
console.log('\nFirst 50 missing:');
console.log(missingEs.slice(0, 50).join('\n'));

// Save missing keys list
fs.writeFileSync('missing_es_keys.txt', missingEs.join('\n'));
console.log('\nSaved to missing_es_keys.txt');
