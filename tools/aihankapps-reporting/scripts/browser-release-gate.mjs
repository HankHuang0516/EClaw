// Publication gate for the APP 趨勢 report: the browser checks of capture-trends-golden.mjs must have passed on the
// exact release artifacts.
//
// Hank 2026-11-11: 「移除截圖比對」. The Golden screenshot-similarity threshold no longer gates publication (the
// first report-only run scored 0.893 against 0.90 only because the catalog had changed). What still gates it is
// that the real page works: no page errors, no horizontal overflow, every APP selectable and plotted, tooltips,
// zoom, sorting, reviews and the mobile layouts — all measured on the same three files that will be published.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const REQUIRED_BROWSER_CHECKS = [
  'hoverTooltip', 'clickPinsTooltip', 'wheelChangesRange', 'escapeClosesTooltip', 'keyboardAppSwitch', 'keyboardPinsTooltip',
  'dragPansRange', 'fullHistoryAccessible', 'ratesCannotAccumulate', 'stabilityNotMoney', 'allAppsInPicker', 'clearAppsRemovesLines',
  'selectAllRestoresLines', 'allTableFieldsSortable', 'allAppsHitTestingPassed', 'reviewMetadataReadable', 'reviewExpandControlsPassed',
  'tooltipBoundaryPinControl', 'allAppSeriesVisible', 'mobileNavigationSingleLine', 'mobileMetricValuesFit', 'mobileChartLabelsReadable',
  'mobileTapPinsTooltip'
];

export async function requireBrowserChecks(directory, { capturePath = join(directory, 'verification', 'capture.json') } = {}) {
  let capture;
  try { capture = JSON.parse(await readFile(capturePath, 'utf8')); }
  catch { throw new Error('Browser verification is missing; publication stopped'); }
  const checks = capture && capture.checks;
  if (!checks || typeof checks !== 'object' || !Array.isArray(capture.errors)) throw new Error('Browser verification is malformed; publication stopped');
  if (capture.errors.length) throw new Error('The report page raised errors in the browser; publication stopped');
  if (checks.mobileOverflow !== false) throw new Error('The report page overflows horizontally on mobile; publication stopped');
  const failed = REQUIRED_BROWSER_CHECKS.filter(key => checks[key] !== true);
  if (checks.dailyMode !== 'true') failed.push('dailyMode');
  if (failed.length) throw new Error(`Browser checks failed (${failed.join(', ')}); publication stopped`);
  for (const file of ['index.html', 'data.js', 'report-view.js']) {
    if (capture.files?.[file] !== hash(await readFile(join(directory, file)))) throw new Error('Browser verification does not cover the exact release artifacts');
  }
  return capture;
}
