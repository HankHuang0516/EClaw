/**
 * SECURITY regression gate (card_9a581f17, Hank 2026-06-27 "為何訊息夾帶全密鑰?").
 *
 * The push middleware (unifiedPush + pushToBot in index.js) used to append to EVERY
 * agent message:
 *     [Local Variables available: <ALL vault key names>]
 *     exec: curl -s ".../api/device-vars?deviceId=...&botSecret=..."
 * i.e. the full secret key-name list + a ready-to-run "dump the entire vault" curl.
 * That handed every agent (and every prompt-injection) a one-tap exfil command.
 *
 * These tests fail on the OLD code and pass once the leak is removed. They must keep
 * passing: the push path must NEVER enumerate vault key names or embed a device-vars
 * dump curl in agent-facing text.
 */
const fs = require('fs');
const path = require('path');

describe('push middleware must not leak the vault to agents (card_9a581f17)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');

  test('no "[Local Variables available:" key-name enumeration in agent messages', () => {
    expect(src).not.toMatch(/\[Local Variables available:/);
  });

  test('no device-vars dump curl appended to pushed agent messages', () => {
    // forbid a push-enrichment line that hands the agent a botSecret device-vars dump
    const dangerous = /(enrichedMessage|messageContent)\s*\+=[^\n]*api\/device-vars[^\n]*botSecret/;
    expect(src).not.toMatch(dangerous);
  });

  test('the safe replacement signals variable COUNT only (no names, no curl)', () => {
    expect(src).toMatch(/Local config: \$\{varsMeta\.var_keys\.length\} device variable/);
  });
});
