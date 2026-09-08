import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadReportHistory } from './load-report-history.mjs';
import { buildReportModel } from './report-model.mjs';
import { atomicWrite } from './report-storage.mjs';
import { loadReviewCounts } from './report-reviews.mjs';

export async function buildReport({ historyRoot, catalogPath, inventoryPath, output, auditOutput, reviewSnapshot, end, generatedAt = new Date().toISOString() }) {
  if (!output) throw new Error('Explicit staging output required');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const envelope = JSON.parse(await readFile(inventoryPath, 'utf8'));
  const inventory = envelope.inventory || envelope.apps || (Array.isArray(envelope) ? envelope : null);
  if (!Array.isArray(inventory)) throw new Error('Missing AdMob inventory');
  const history = await loadReportHistory(historyRoot, catalog);
  const reviews = reviewSnapshot ? await loadReviewCounts(reviewSnapshot, catalog) : null;
  const report = buildReportModel({ catalog, history, inventory, reviews, end, generatedAt });
  if (auditOutput) await atomicWrite(auditOutput, JSON.stringify(history.audit, null, 2) + '\n');
  // Public artifact contains only explicit aggregate fields, never raw reports.
  await atomicWrite(output, `window.AIHANK_REPORT = ${JSON.stringify(report)};\n`, { mode: 0o644 });
  return { output, apps: report.apps.length, contentHash: report.contentHash, period: report.period };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), options = {};
  const names = { '--history-root': 'historyRoot', '--catalog': 'catalogPath', '--inventory': 'inventoryPath', '--output': 'output', '--audit-output': 'auditOutput', '--end': 'end', '--generated-at': 'generatedAt' };
  try {
    for (let i = 0; i < args.length; i += 2) {
      if (!names[args[i]] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid build arguments');
      options[names[args[i]]] = args[i + 1];
    }
    console.log(JSON.stringify(await buildReport(options)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
