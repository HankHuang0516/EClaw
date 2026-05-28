const fs = require('fs');
const path = require('path');

const portalDir = path.join(__dirname, '../../public/portal');

function extractScriptSrcs(html) {
  return [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => match[1]);
}

describe('portal shared script dependency order', () => {
  test('api.js loads before auth.js and telemetry on every portal page', () => {
    const failures = [];
    const pages = fs.readdirSync(portalDir)
      .filter((entry) => entry.endsWith('.html'))
      .sort();

    for (const page of pages) {
      const html = fs.readFileSync(path.join(portalDir, page), 'utf8');
      const srcs = extractScriptSrcs(html);
      const apiIdx = srcs.findIndex((src) => /shared\/api\.js$/i.test(src));
      const authIdx = srcs.findIndex((src) => /shared\/auth\.js$/i.test(src));
      const telemetryIdx = srcs.findIndex((src) => /telemetry\.js$/i.test(src));
      const pageFailures = [];

      if (apiIdx !== -1 && authIdx !== -1 && apiIdx > authIdx) {
        pageFailures.push('api.js loads after auth.js');
      }
      if (authIdx !== -1 && telemetryIdx !== -1 && authIdx > telemetryIdx) {
        pageFailures.push('auth.js loads after telemetry.js');
      }
      if (apiIdx !== -1 && telemetryIdx !== -1 && apiIdx > telemetryIdx) {
        pageFailures.push('api.js loads after telemetry.js');
      }

      if (pageFailures.length > 0) {
        failures.push(`${page}: ${pageFailures.join(', ')}`);
      }
    }

    expect(failures).toEqual([]);
  });
});
