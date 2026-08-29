import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(root, 'backend', 'public');
const guidesRoot = path.join(publicRoot, 'AiHankApps', 'guides');
const failures = [];
const preservedContent = {
  chumen: [
    'id="full-features"',
    'id="how"',
    'id="commute-widgets"',
    'id="faq"',
    '一句話出門建議',
    '依時段自動切換',
    '公車多久到、',
  ],
  'stray-map': [
    'id="start"',
    'id="full-features"',
    'id="safety"',
    'id="faq"',
    '搜尋與過濾，',
    '嚴禁濫用資訊或傷害動物',
    '8 種語言',
  ],
};

for (const entry of fs.readdirSync(guidesRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const indexPath = path.join(guidesRoot, entry.name, 'index.html');
  if (!fs.existsSync(indexPath)) continue;
  const html = fs.readFileSync(indexPath, 'utf8');

  if (!html.includes('data-intro-toolbar')) {
    failures.push(`${entry.name}: missing persistent introduction toolbar`);
  }
  if (/(?:src|href)=["']\/assets\//.test(html)) {
    failures.push(`${entry.name}: root-relative /assets/ reference is not subpath-safe`);
  }

  for (const marker of preservedContent[entry.name] || []) {
    if (!html.includes(marker)) failures.push(`${entry.name}: missing preserved content ${marker}`);
  }

  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    const reference = match[1].split(/[?#]/, 1)[0];
    if (!reference || reference.startsWith('#') || reference.startsWith('data:') || /^https?:\/\//.test(reference)) continue;
    const target = reference.startsWith('/')
      ? path.join(publicRoot, reference.replace(/^\//, ''))
      : path.resolve(path.dirname(indexPath), reference);
    if (!fs.existsSync(target)) failures.push(`${entry.name}: missing local asset ${reference}`);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log('AiHankApps introduction sites passed subpath and toolbar checks.');
