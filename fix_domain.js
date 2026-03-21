const fs = require('fs');

const OLD = 'realbot-production.up.railway.app';
const NEW = 'eclawbot.com';

const files = [
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

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  const updated = content.replaceAll(OLD, NEW);
  fs.writeFileSync(file, updated, 'utf8');
  const count = (content.match(new RegExp(OLD, 'g')) || []).length;
  console.log(`${file}: ${count} replacements`);
}

// Verify
console.log('\nVerifying...');
for (const file of files) {
  const buf = fs.readFileSync(file);
  const str = buf.toString('utf8');
  const re = Buffer.from(str, 'utf8');
  if (buf.length !== re.length) {
    console.log('STILL INVALID:', file);
  }
}
console.log('Done.');
