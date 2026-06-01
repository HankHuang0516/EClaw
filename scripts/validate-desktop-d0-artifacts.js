const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

const checks = [
  {
    file: 'docs/desktop-app-adr-001-framework.md',
    sections: [
      '## Context',
      '## Decision',
      '## Comparison',
      '## Consequences',
      '## Threat Model',
      '## Rollback And Uninstall Spec',
      '## PoC Scope Plan',
      '## Source Notes',
    ],
    patterns: [
      /Use \*\*Tauri 2\*\*/,
      /Authorization Code \+ PKCE/,
      /OS-backed credential storage/,
      /signed update artifacts|Updates are signed/,
      /Windows VM install\/update\/uninstall proof/,
      /install -> OAuth -> bind one agent -> uninstall/,
    ],
  },
  {
    file: 'docs/desktop/d0-architecture-artifacts.md',
    sections: [
      '## Gate Decision',
      '## Submitted Artifacts',
      '## D1 Entry Criteria',
      '## Follow-Up Scope',
      '## Review Checklist',
      '## CI Evidence',
    ],
    patterns: [
      /card_b0568b17e0380ad25effe79b/,
      /card_1434b0534bfb8a9871276c7f/,
      /Framework: Tauri 2/,
      /CI artifact guard/,
      /install -> OAuth -> bind ->\n  uninstall evidence/,
      /Desktop D0 CI/,
    ],
  },
  {
    file: '.github/workflows/desktop-d0-ci.yml',
    sections: [
      'name: Desktop D0 CI',
      'pull_request:',
      'push:',
      'node scripts/validate-desktop-d0-artifacts.js',
    ],
    patterns: [],
  },
];

const errors = [];

for (const check of checks) {
  const absolute = path.join(root, check.file);
  if (!fs.existsSync(absolute)) {
    errors.push(`${check.file}: file is missing`);
    continue;
  }

  const text = fs.readFileSync(absolute, 'utf8');

  for (const section of check.sections) {
    if (!text.includes(section)) {
      errors.push(`${check.file}: missing required section or line: ${section}`);
    }
  }

  for (const pattern of check.patterns) {
    if (!pattern.test(text)) {
      errors.push(`${check.file}: missing required pattern: ${pattern}`);
    }
  }
}

if (errors.length > 0) {
  console.error('Desktop D0 artifact validation failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('Desktop D0 artifact validation passed.');
