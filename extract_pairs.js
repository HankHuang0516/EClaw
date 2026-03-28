const fs = require('fs');
const content = fs.readFileSync('backend/public/shared/i18n.js', 'utf8');

// Get EN section
const enStart = content.indexOf('\n    en: {');
const zhStart = content.indexOf('\n    zh: {');
const enSection = content.substring(enStart + 1, zhStart);

// Get ES section
const esStart = content.indexOf('\n    es: {');
const msStart = content.indexOf('\n    ms: {');
const esSection = content.substring(esStart + 1, msStart);

function extractPairs(section) {
    const lines = section.split('\n');
    const pairs = {};
    
    for (const line of lines) {
        // Skip empty lines and comments
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('//')) continue;
        
        // Match "key": "value" pattern
        // Value can contain escaped quotes but we're capturing up to the closing quote
        const match = line.match(/^\s+"([^"]+)":\s*"(.*)"/);
        if (match) {
            pairs[match[1]] = match[2];
        }
    }
    
    return pairs;
}

const enPairs = extractPairs(enSection);
console.log('Extracted', Object.keys(enPairs).length, 'EN pairs');

const esPairs = extractPairs(esSection);
console.log('Extracted', Object.keys(esPairs).length, 'ES pairs');

// Find missing keys
const missingKeys = Object.keys(enPairs).filter(k => !esPairs[k]);
console.log('Missing', missingKeys.length, 'ES translations');

if (missingKeys.length > 0) {
    console.log('\nFirst 20 missing:');
    missingKeys.slice(0, 20).forEach(k => {
        console.log(`  "${k}": "${enPairs[k]}"`);
    });
    
    // Save for later use
    const missingData = missingKeys.map(k => ({ key: k, en: enPairs[k] }));
    fs.writeFileSync('missing_pairs.json', JSON.stringify(missingData, null, 2));
    console.log('\nSaved to missing_pairs.json');
}
