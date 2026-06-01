#!/usr/bin/env node
/**
 * Generate settings-help-keys.json — the authoritative registry of settings
 * fields that REQUIRE a `<field>_help` i18n key and a `HELP-KEY` annotation
 * at their render site.
 *
 * Per docs/specs/settings-help-icon.md §4.3, this generated file is the
 * scope-limiter for the CI hard gate (child 8) — orphan-check fires ONLY
 * for keys in this registry, NOT every `_help` key in i18n.js (which would
 * false-fail existing non-settings keys like `slash_cmd_help`).
 *
 * Algorithm: scan portal/settings.html (and other settings-related .html
 * under backend/public/) for `data-i18n="<X>_label"` attributes. Each `<X>`
 * becomes a registry entry. Output stable-sorted JSON.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');

// Settings pages to scan. Extend here as new settings surfaces are added.
const SETTINGS_PAGES = [
  'portal/settings.html',
];

function extractLabelKeys(htmlPath) {
  const full = path.join(ROOT, htmlPath);
  if (!fs.existsSync(full)) return [];
  const html = fs.readFileSync(full, 'utf8');
  const matches = [...html.matchAll(/data-i18n="([^"]+)_label"/g)];
  return matches.map((m) => ({
    field_key: m[1],
    label_key: `${m[1]}_label`,
    help_key: `${m[1]}_help`,
  }));
}

function extractHelpIconEntries(htmlPath) {
  const full = path.join(ROOT, htmlPath);
  if (!fs.existsSync(full)) return [];
  const html = fs.readFileSync(full, 'utf8');
  const matches = [...html.matchAll(/data-help-content-key="([^"]+_help)"/g)];
  return matches.map((m) => {
    const helpKey = m[1];
    const nearby = html.slice(Math.max(0, m.index - 800), m.index);
    const labelMatches = [...nearby.matchAll(/data-i18n="([^"]+)"/g)];
    const labelKey = labelMatches.length ? labelMatches[labelMatches.length - 1][1] : helpKey.replace(/_help$/, '_label');
    return {
      field_key: helpKey.replace(/_help$/, ''),
      label_key: labelKey,
      help_key: helpKey,
    };
  });
}

const all = new Map();
for (const page of SETTINGS_PAGES) {
  for (const entry of extractLabelKeys(page)) {
    all.set(entry.help_key, entry);
  }
  for (const entry of extractHelpIconEntries(page)) {
    all.set(entry.help_key, entry);
  }
}

const registry = {
  generated_at: 'GENERATED — do not hand-edit',
  source: SETTINGS_PAGES,
  keys: [...all.values()].sort((a, b) => a.help_key.localeCompare(b.help_key)),
};

const outPath = path.join(__dirname, '..', 'settings-help-keys.json');
fs.writeFileSync(outPath, JSON.stringify(registry, null, 2) + '\n');
console.log(`Wrote ${registry.keys.length} keys to ${outPath}`);
