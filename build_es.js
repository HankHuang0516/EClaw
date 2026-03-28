const fs = require('fs');
const content = fs.readFileSync('backend/public/shared/i18n.js', 'utf8');

// Split by language markers
const langs = ['en', 'zh', 'ja', 'ko', 'th', 'vi', 'id', 'es', 'ms', 'hi', 'ar'];

// Find the start position of each language
const langStarts = {};
for (const lang of langs) {
    const regex = new RegExp(`\\n    ${lang}: \\{`);
    const match = content.match(regex);
    if (match) {
        langStarts[lang] = match.index + 1;
    }
}

// Sort by position
const sorted = Object.entries(langStarts).sort((a, b) => a[1] - b[1]);

// Extract each block (as string)
const blocks = {};
for (let i = 0; i < sorted.length; i++) {
    const [lang, start] = sorted[i];
    const end = i + 1 < sorted.length ? sorted[i + 1][1] : content.length;
    blocks[lang] = content.substring(start, end - 1);
}

// Parse EN block to get key order and values
// We need to extract all "key": "value" pairs in order
function extractKeyValues(block) {
    const result = [];
    const lines = block.split('\n');
    let currentKey = null;
    let currentValue = '';
    let braceDepth = 0;
    
    for (const line of lines) {
        // Track brace depth
        for (const char of line) {
            if (char === '{') braceDepth++;
            if (char === '}') braceDepth--;
        }
        
        // Skip lines with nested objects (braceDepth > 0 means we're inside an object)
        if (braceDepth > 0) continue;
        
        // Match "key": or 'key': at the start (possibly with leading whitespace)
        const keyMatch = line.match(/^\s*"([^"]+)":/);
        if (keyMatch && braceDepth === 0) {
            // Save previous key-value if exists
            if (currentKey !== null) {
                result.push({ key: currentKey, value: currentValue });
            }
            currentKey = keyMatch[1];
            currentValue = '';
            
            // Check if there's a value on the same line
            const valueMatch = line.match(/:\s*"(.*)"$/);
            if (valueMatch) {
                currentValue = valueMatch[1];
            }
        } else if (currentKey !== null && braceDepth === 0) {
            // Continuation of previous value
            const valueMatch = line.match(/^\s*"(.*)"[,\s]*$/);
            if (valueMatch) {
                currentValue += valueMatch[1];
            }
        }
    }
    
    // Don't forget the last one
    if (currentKey !== null) {
        result.push({ key: currentKey, value: currentValue });
    }
    
    return result;
}

const enKeyValues = extractKeyValues(blocks['en']);
console.log(`Extracted ${enKeyValues.length} EN key-values`);

// Parse ES block
const esKeyValues = extractKeyValues(blocks['es']);
const esKeySet = new Set(esKeyValues.map(kv => kv.key));
console.log(`Extracted ${esKeyValues.length} ES key-values`);

// Find missing
const missing = enKeyValues.filter(kv => !esKeySet.has(kv.key));
console.log(`Missing ${missing.length} ES translations`);

// Save the missing keys for reference
fs.writeFileSync('missing_translations.json', JSON.stringify(missing.map(kv => ({
    key: kv.key,
    enValue: kv.value
})), null, 2));

console.log('\nFirst 30 missing:');
missing.slice(0, 30).forEach(kv => {
    console.log(`  "${kv.key}": "${kv.value.substring(0, 60)}${kv.value.length > 60 ? '...' : ''}"`);
});
