#!/usr/bin/env python3
# Use Node.js to parse the JS file and reserialize it with proper escaping
import subprocess

script = r"""
const fs = require('fs');
const path = '/home/node/eclaw-i18n/backend/public/shared/i18n.js';
let code = fs.readFileSync(path, 'utf8');

// The file has syntax errors due to unescaped inner quotes in string values.
// Strategy: parse the object using a simple state machine, then output as JSON.

try {
    // Use vm.Script to just check syntax without execution
    new vm.Script(code, {filename: path});
    console.log('File is valid JS');
} catch(e) {
    console.log('Syntax error:', e.message);
    // Try to find the error position
    const match = e.message.match(/at position (\d+)/);
    if (match) {
        const pos = parseInt(match[1]);
        const lines = code.split('\n');
        let lineNum = 1;
        let posInLine = pos;
        for (const line of lines) {
            if (posInLine <= line.length) {
                console.log('Error around line', lineNum, 'column', posInLine);
                console.log('Line content:', line.slice(Math.max(0, posInLine-50), posInLine+50));
                break;
            }
            posInLine -= line.length + 1;
            lineNum++;
        }
    }
}
"""

result = subprocess.run(['node', '-e', script], capture_output=True, text=True, 
                       cwd='/home/node/eclaw-i18n')
print(result.stdout)
print(result.stderr)
