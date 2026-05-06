#!/usr/bin/env node

/**
 * Fix over-escaped quotes in i18n.js
 *
 * Problem: Some quotes are double-escaped (\\") when they should be single-escaped (\")
 * This script fixes the over-escaping while preserving legitimate JSON escaping.
 */

const fs = require('fs');
const path = require('path');

const I18N_FILE = path.join(__dirname, '..', 'backend', 'public', 'shared', 'i18n.js');

function fixI18nQuotes() {
    console.log('Reading i18n.js...');
    let content = fs.readFileSync(I18N_FILE, 'utf-8');

    const originalLength = content.length;

    // Count original instances
    const originalDoubleEscaped = (content.match(/\\\\\"/g) || []).length;
    const originalSingleEscaped = (content.match(/\\\"/g) || []).length;

    console.log(`Original counts:`);
    console.log(`  Double-escaped quotes (\\\\\"): ${originalDoubleEscaped}`);
    console.log(`  Single-escaped quotes (\\\"): ${originalSingleEscaped}`);

    // Fix over-escaped quotes in translation strings
    // Pattern: \\"text\\" -> "text" (within string values)
    // These quotes don't need to be escaped since they're within JavaScript string literals
    content = content.replace(/\\"/g, '"');

    // Count after fix
    const fixedDoubleEscaped = (content.match(/\\\\\"/g) || []).length;
    const fixedSingleEscaped = (content.match(/\\\"/g) || []).length;

    console.log(`After fix:`);
    console.log(`  Double-escaped quotes (\\\\\"): ${fixedDoubleEscaped}`);
    console.log(`  Single-escaped quotes (\\\"): ${fixedSingleEscaped}`);
    console.log(`  Fixed instances: ${originalDoubleEscaped - fixedDoubleEscaped}`);

    // Backup original file
    const backupFile = I18N_FILE + '.backup-' + Date.now();
    fs.writeFileSync(backupFile, fs.readFileSync(I18N_FILE));
    console.log(`Backup created: ${backupFile}`);

    // Write fixed content
    fs.writeFileSync(I18N_FILE, content, 'utf-8');

    console.log(`✅ Fixed i18n quote escaping`);
    console.log(`📁 File: ${I18N_FILE}`);
    console.log(`📊 Size change: ${content.length - originalLength} bytes`);

    return {
        fixedCount: originalDoubleEscaped - fixedDoubleEscaped,
        backupFile: backupFile
    };
}

if (require.main === module) {
    try {
        const result = fixI18nQuotes();
        process.exit(0);
    } catch (error) {
        console.error('❌ Error fixing i18n quotes:', error.message);
        process.exit(1);
    }
}

module.exports = { fixI18nQuotes };