const fs = require('fs');
const path = require('path');

// PowerShell Set-Content on Windows with non-ASCII chars can produce
// Windows-1252 or other encodings. The safest fix: read as latin1 (which
// preserves all bytes), then re-encode as UTF-8.
// But actually the issue is likely that PowerShell wrote UTF-16LE without BOM
// or wrote in the system's default encoding (often Windows-1252/CP1252).
// Let's try: read the file, detect if it has replacement chars, and fix.

const filesToFix = [
  // 'backend/E-claw_mcp_skill.md', // removed: content merged into eclaw-a2a-toolkit
  'backend/monitor_messages.js',
  'backend/TEST-README.md',
  'backend/tests/test_device_isolation.js',
  'backend/tests/test_entity_delete.js',
  'backend/tests/test_ux_improvements.js',
  'backend/test_chat_widget.js',
  'backend/test_e2e_chat.js',
  'backend/test_emotions.js',
  'backend/test_emotions_v2.js',
  'backend/test_entity_communication.js',
  'backend/test_multi_tenant.js',
  'backend/test_name_feature.js',
  'BUG-FIXES-SUMMARY.md',
];

for (const file of filesToFix) {
  // Read as raw bytes
  const buf = fs.readFileSync(file);

  // Try reading as UTF-8 first - if it has replacement characters (U+FFFD),
  // that means there are invalid sequences
  const utf8str = buf.toString('utf8');

  // The issue: PowerShell's Set-Content uses the system's default encoding
  // which on Chinese Windows is often Big5 or CP950
  // But these files originally had UTF-8 content with some emojis/special chars

  // Strategy: The corrupted bytes are likely where multi-byte UTF-8 sequences
  // got truncated. Let's try reading as latin1 first which preserves all bytes.
  // Then the content that was originally UTF-8 will need proper handling.

  // Actually, the simplest approach: use git to restore the original content
  // and then re-apply just the URL replacement
  console.log('Will fix:', file);
}

console.log('\nBest approach: restore from git and re-apply URL change with Node.js');
