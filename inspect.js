// Strip the bottom of the file (after TRANSLATIONS = {)
const fs = require('fs');
const data = fs.readFileSync('backend/public/shared/i18n.js', 'utf8');

// Find where TRANSLATIONS = { ... }; ends
// The file ends with: ... }; // bottom-of-file marker
// Let's find the actual end: the last "}; // bottom-of-file"
const match = data.match(/^(.+?依靠[^{]+)/s);
console.log('File length:', data.length);
console.log('Last 200 chars:', data.slice(-200));