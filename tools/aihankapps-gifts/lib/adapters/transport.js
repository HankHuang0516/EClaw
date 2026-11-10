'use strict';

// Delivery runs inside the game's own container (`railway ssh`), using the game's own mail
// code, database connection and configuration. This tool never reads a game's secrets or
// database URL; it only receives the one-line JSON result the script prints.
const { spawnSync } = require('child_process');

const RESULT_MARK = 'GIFT_RESULT ';

// Wraps a Node script so it runs from the game's application directory. GIFT_APP_DIR lets a
// rehearsal point at a local copy of the game server.
function shellFor(nodeScript, appDirs) {
  if (appDirs.some(dir => !/^\/[\w./-]*$/.test(dir))) throw new Error('invalid_app_dir');
  return [
    'set -e',
    `for d in "\${GIFT_APP_DIR:-}" ${appDirs.join(' ')}; do`,
    '  if [ -n "$d" ] && [ -d "$d" ]; then cd "$d"; break; fi',
    'done',
    // A remote shell may not have the image's Node on PATH; borrow it from the running server.
    'if ! command -v node >/dev/null 2>&1; then',
    '  for exe in /proc/[0-9]*/exe; do',
    '    target=$(readlink "$exe" 2>/dev/null || true)',
    '    case "$target" in */node) PATH="$PATH:${target%/node}"; break ;; esac',
    '  done',
    'fi',
    "node --input-type=commonjs - <<'GIFT_NODE_SCRIPT'",
    nodeScript,
    'GIFT_NODE_SCRIPT',
    ''
  ].join('\n');
}

// base64 keeps the script intact through the remote shell, whatever quotes it contains.
function encode(script) {
  return `echo ${Buffer.from(script, 'utf8').toString('base64')} | base64 -d | sh`;
}

function finish(result) {
  const stdout = result.stdout || '';
  const line = stdout.split(/\r?\n/).filter(text => text.startsWith(RESULT_MARK)).pop();
  let value = null;
  if (line) {
    try { value = JSON.parse(line.slice(RESULT_MARK.length)); } catch (_error) { value = null; }
  }
  return {
    value,
    exitCode: result.status,
    // Shown only when no result line came back, to explain why.
    detail: value ? null : [result.error ? String(result.error.message) : '', result.stderr || '', stdout].join('\n').trim().slice(-600)
  };
}

function runRailway(target, script, { spawn = spawnSync, timeoutMs = 180000 } = {}) {
  return finish(spawn('railway', ['ssh', '-p', target.projectId, '-e', target.environment, '-s', target.service, encode(script)],
    { encoding: 'utf8', timeout: timeoutMs }));
}

function runLocal(script, { env = {}, spawn = spawnSync, timeoutMs = 180000 } = {}) {
  return finish(spawn('sh', ['-c', script], { encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, ...env } }));
}

module.exports = { RESULT_MARK, shellFor, encode, finish, runRailway, runLocal };
