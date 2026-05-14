#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'public', 'portal', 'kanban.html');
const html = fs.readFileSync(file, 'utf8');

const checks = [
  {
    name: 'detail modal uses flex column and hides outer overflow',
    re: /\.kb-modal\s*\{[^}]*display:flex;[^}]*flex-direction:column;[^}]*overflow:hidden;[^}]*\}/s,
  },
  {
    name: 'comments tab marks modal as comments-active',
    re: /classList\.toggle\('kb-modal-comments-active',\s*tab\s*===\s*'comments'\)/,
  },
  {
    name: 'comments-active modal reserves tall reading area',
    re: /\.kb-modal\.kb-modal-comments-active\s*\{[^}]*height:min\(85dvh,\s*760px\);[^}]*\}/s,
  },
  {
    name: 'comments panel flexes to fill available space',
    re: /#panel-comments\.active\s*\{[^}]*display:flex;[^}]*flex:1\s+1\s+auto;[^}]*overflow:hidden;[^}]*\}/s,
  },
  {
    name: 'comments list is flex scroll area with no fixed max-height cap',
    re: /\.kb-comments-list\s*\{[^}]*flex:1\s+1\s+auto;[^}]*max-height:none;[^}]*overflow-y:auto;[^}]*\}/s,
  },
  {
    name: 'mobile modal does not scroll the whole dialog behind composer',
    re: /@media \(max-width: 768px\)[\s\S]*?\.kb-modal\s*\{[^}]*height:100dvh;[^}]*overflow:hidden;[^}]*\}/s,
  },
  {
    name: 'webview modal does not scroll the whole dialog behind composer',
    re: /body\.app-webview \.kb-modal\s*\{[^}]*height:100dvh;[^}]*overflow:hidden;[^}]*\}/s,
  },
];

const failed = checks.filter(({ re }) => !re.test(html));
if (failed.length) {
  console.error('[kanban-comments-layout] FAILED');
  for (const f of failed) console.error(`- ${f.name}`);
  process.exit(1);
}
console.log(`[kanban-comments-layout] PASS (${checks.length} checks)`);
