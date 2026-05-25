/**
 * Tests for scripts/i18n-lint-dup-keys.js parser correctness.
 * Covers: string-aware brace counting, indent tolerance, quoted-key acceptance.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '../../scripts/i18n-lint-dup-keys.js');

function runLint(source) {
  const tmp = path.join(os.tmpdir(), `i18n-lint-fixture-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(tmp, source, 'utf8');
  try {
    const out = execFileSync('node', [SCRIPT, tmp], { encoding: 'utf8' });
    return { code: 0, stdout: out, stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
  } finally {
    fs.unlinkSync(tmp);
  }
}

describe('i18n-lint-dup-keys parser', () => {
  test('counts brace depth correctly when locale strings contain { and }', () => {
    const src = [
      'const TRANSLATIONS = {',
      '    en: {',
      '        "greet_user": "Hello {name}, you have (#{count}) items.",',
      '        "msg_orphan_open": "Found unclosed { in raw text",',
      '    },',
      '    de: {',
      '        "greet_user": "Hallo {name}",',
      '    },',
      '};',
      '',
    ].join('\n');
    const res = runLint(src);
    expect(res.stdout).toContain('PASS: en');
    expect(res.stdout).toContain('PASS: de');
    expect(res.code).toBe(0);
  });

  test('detects locale headers with quoted compound keys (e.g. "zh-CN":)', () => {
    const src = [
      'const TRANSLATIONS = {',
      '    en: {',
      '        "hello": "Hello",',
      '    },',
      '"zh-CN": {',
      '        "hello": "你好",',
      '    },',
      '    ja: {',
      '        "hello": "こんにちは",',
      '    },',
      '};',
      '',
    ].join('\n');
    const res = runLint(src);
    expect(res.stdout).toContain('PASS: en');
    expect(res.stdout).toContain('PASS: zh-CN');
    expect(res.stdout).toContain('PASS: ja');
    expect(res.code).toBe(0);
  });

  test('reports real duplicates within a single locale block', () => {
    const src = [
      'const TRANSLATIONS = {',
      '    en: {',
      '        "key_a": "first",',
      '        "key_b": "second",',
      '        "key_a": "duplicate",',
      '    },',
      '    de: {',
      '        "key_a": "Erste",',
      '    },',
      '};',
      '',
    ].join('\n');
    const res = runLint(src);
    expect(res.stderr).toContain('FAIL: en');
    expect(res.stderr).toContain('"key_a"');
    expect(res.stdout).toContain('PASS: de');
    expect(res.code).toBe(1);
  });

  test('does NOT flag same key across different locales as duplicate', () => {
    const src = [
      'const TRANSLATIONS = {',
      '    en: {',
      '        "shared": "English",',
      '    },',
      '    de: {',
      '        "shared": "Deutsch",',
      '    },',
      '    ja: {',
      '        "shared": "日本語",',
      '    },',
      '};',
      '',
    ].join('\n');
    const res = runLint(src);
    expect(res.stdout).toContain('PASS: en');
    expect(res.stdout).toContain('PASS: de');
    expect(res.stdout).toContain('PASS: ja');
    expect(res.code).toBe(0);
  });

  test('handles escaped quotes inside translation strings', () => {
    const src = [
      'const TRANSLATIONS = {',
      '    en: {',
      '        "quoted": "He said \\"hello {name}\\" to her",',
      '    },',
      '    de: {',
      '        "quoted": "Er sagte",',
      '    },',
      '};',
      '',
    ].join('\n');
    const res = runLint(src);
    expect(res.stdout).toContain('PASS: en');
    expect(res.stdout).toContain('PASS: de');
    expect(res.code).toBe(0);
  });

  test('regression: real i18n.js detects all 15 locales (no false-positive es absorption)', () => {
    const realPath = path.resolve(__dirname, '../../public/shared/i18n.js');
    if (!fs.existsSync(realPath)) {
      return;
    }
    let stdout = '', stderr = '', code = 0;
    try {
      stdout = execFileSync('node', [SCRIPT, realPath], { encoding: 'utf8' });
    } catch (err) {
      stdout = err.stdout || '';
      stderr = err.stderr || '';
      code = err.status;
    }
    const allOutput = stdout + stderr;
    for (const locale of ['en', 'zh', 'zh-CN', 'ja', 'ko', 'th', 'vi', 'id', 'fr', 'es', 'de', 'ms', 'hi', 'ar', 'pt']) {
      expect(allOutput).toMatch(new RegExp(`(PASS|FAIL): ${locale.replace('-', '\\-')} `));
    }
  });
});
