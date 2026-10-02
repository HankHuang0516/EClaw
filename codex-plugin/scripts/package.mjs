import { readFile, lstat, realpath, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';

export const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
export const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
export const RUNTIME_FILES = ['scripts/runtime.mjs', 'scripts/app-server-client.mjs'];
const FIXED_FILES = ['plugin.json', 'mcp.json', 'README.md', 'assets/LICENSE',
  'skills/connect-codex/SKILL.md', 'skills/connect-codex/references/runtime.md', ...RUNTIME_FILES];
const URL_FIELDS = ['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL'];
const EVIDENCE_FLAGS = ['developerVerified', 'domainVerified', 'reviewerAccessConfigured',
  'liveMcpOAuthTested', 'localRuntimeTested', 'reviewCasesExecuted', 'demoAccessible'];

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function textField(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max &&
    !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value);
}

function publicHTTPS(value) {
  if (!textField(value, 2048) || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return url.protocol === 'https:' && !url.username && !url.password &&
      host.includes('.') && !isIP(host) && !host.startsWith('[') &&
      !/(^|\.)(localhost|local|internal|test|invalid|example|example\.com|example\.org|example\.net)$/.test(host);
  } catch { return false; }
}

function assetPath(value) {
  return typeof value === 'string' && /^\.\/assets\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.(png|jpe?g|webp|svg)$/.test(value);
}

function forbiddenMetadata(value) {
  if (!object(value) && !Array.isArray(value)) return false;
  return Object.entries(value).some(([key, child]) =>
    /^(test_credentials|reviewer_instructions|password|secret|client_secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|headers|env)$/i.test(key) ||
    forbiddenMetadata(child));
}

/** Validate the supported portable package contract, without inferring live readiness. */
export function validateManifest(manifest, mcp, { submission = false, evidence } = {}) {
  const errors = [];
  const requireThat = (condition, label) => { if (!condition) errors.push(label); };
  if (!object(manifest) || !object(mcp)) throw new Error('plugin.json and mcp.json must be JSON objects');
  requireThat(manifest.$schema === PLUGIN_SCHEMA, 'plugin.json: portable schema required');
  requireThat(manifest.name === 'eclawbot', 'plugin.json: stable name must be eclawbot');
  requireThat(typeof manifest.version === 'string' &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/.test(manifest.version),
  'plugin.json: explicit semantic version required');
  requireThat(textField(manifest.description, 4000), 'plugin.json: description required (max 4000)');
  requireThat(object(manifest.author) && textField(manifest.author.name, 120), 'plugin.json: author.name required');
  for (const field of ['homepage', 'repository']) {
    if (manifest[field] !== undefined) requireThat(publicHTTPS(manifest[field]), `plugin.json: ${field} must be public HTTPS`);
  }
  if (manifest.author?.url !== undefined) requireThat(publicHTTPS(manifest.author.url), 'plugin.json: author.url must be public HTTPS');
  requireThat(!forbiddenMetadata(manifest) && !forbiddenMetadata(mcp), 'package metadata must not contain credentials, reviewer instructions, headers, or environment secrets');
  requireThat(manifest.apps === undefined && manifest.hooks === undefined,
    'plugin.json: app references and lifecycle hooks are not supported for public ZIP submission');
  const ext = manifest.extensions?.['com.openai'];
  requireThat(object(ext), 'plugin.json: extensions.com.openai required');
  requireThat(ext?.apps === undefined && ext?.hooks === undefined,
    'plugin.json: OpenAI app references and lifecycle hooks are not supported');
  const ui = ext?.interface;
  requireThat(object(ui), 'plugin.json: OpenAI interface required');
  for (const [field, max] of Object.entries({ displayName: 30, shortDescription: 30, longDescription: 4000, developerName: 80, category: 120 })) {
    requireThat(textField(ui?.[field], max) && (field === 'longDescription' || !ui[field].includes('\n')),
      `plugin.json: interface.${field} required (max ${max})`);
  }
  requireThat(Array.isArray(ui?.capabilities) && ui.capabilities.length <= 20 &&
    ui.capabilities.every(x => textField(x, 120)), 'plugin.json: capabilities must be at most 20 labels (max 120 each)');
  if (ui?.defaultPrompt !== undefined) {
    const prompts = Array.isArray(ui.defaultPrompt) ? ui.defaultPrompt : [ui.defaultPrompt];
    requireThat(prompts.length >= 1 && prompts.length <= 3 && new Set(prompts).size === prompts.length &&
      prompts.every(x => textField(x, 128) && !x.includes('\n')), 'plugin.json: defaultPrompt needs 1–3 unique single-line prompts (max 128 each)');
  }
  for (const field of URL_FIELDS) {
    if (submission || ui?.[field] !== undefined) requireThat(textField(ui?.[field], 1024) && publicHTTPS(ui[field]),
      `plugin.json: interface.${field} needs a real public HTTPS URL`);
  }
  const files = new Set(FIXED_FILES);
  for (const field of ['logo', 'composerIcon', 'logoDark', 'composerIconDark']) {
    if (['logo', 'composerIcon'].includes(field) || ui?.[field] !== undefined) {
      requireThat(assetPath(ui?.[field]), `plugin.json: interface.${field} needs a safe ./assets/ image path`);
      if (assetPath(ui?.[field])) files.add(ui[field].slice(2));
    }
  }
  if (ui?.screenshots !== undefined) {
    requireThat(Array.isArray(ui.screenshots) && ui.screenshots.every(assetPath), 'plugin.json: screenshots must reference safe ./assets/ image paths');
    if (Array.isArray(ui.screenshots)) for (const file of ui.screenshots.filter(assetPath)) files.add(file.slice(2));
  }
  requireThat(ext?.onboardingSkill === './skills/connect-codex/SKILL.md', 'plugin.json: onboardingSkill must reference the bundled connect-codex skill');
  requireThat(mcp.$schema === MCP_SCHEMA, 'mcp.json: portable MCP schema required');
  requireThat(object(mcp.mcpServers) && Object.keys(mcp.mcpServers).length === 1 && object(mcp.mcpServers.eclawbot),
    'mcp.json: exactly one eclawbot server required');
  const server = mcp.mcpServers?.eclawbot;
  requireThat(server?.type === 'streamable-http' && server?.url === 'https://eclawbot.com/mcp',
    'mcp.json: eclawbot must use streamable-http at https://eclawbot.com/mcp');
  requireThat(object(server) && Object.keys(server).every(k => ['type', 'url'].includes(k)),
    'mcp.json: server must declare only type and url; OAuth is discovered by the host');
  const review = ext?.review;
  const cases = review?.test_cases;
  if (submission || cases !== undefined) {
    requireThat(object(cases), 'plugin.json: review.test_cases required');
    for (const [kind, count] of [['positive', 5], ['negative', 3]]) {
      const list = cases?.[kind];
      requireThat(Array.isArray(list) && list.length === count, `plugin.json: exactly ${count} ${kind} review cases required`);
      if (Array.isArray(list)) list.forEach((entry, index) => {
        requireThat(object(entry) && textField(entry.description, 4000) && textField(entry.prompt, 4000) &&
          textField(entry.expected_behavior, 4000) && (kind !== 'positive' || textField(entry.tools_triggered, 4000)),
        `plugin.json: ${kind} review case ${index + 1} needs scenario, prompt, expected result${kind === 'positive' ? ', and tools' : ''}`);
        for (const field of ['file_attachment_urls', 'expected_output_url']) {
          if (entry?.[field] !== undefined) {
            const urls = field === 'file_attachment_urls' ? entry[field] : [entry[field]];
            requireThat(Array.isArray(urls) && urls.every(publicHTTPS), `plugin.json: ${kind} review case ${index + 1} has an invalid ${field}`);
          }
        }
      });
    }
  }
  if (submission || review?.demo_recording_url !== undefined) {
    requireThat(publicHTTPS(review?.demo_recording_url), 'plugin.json: review.demo_recording_url needs an accessible real video URL');
  }
  if (submission) {
    requireThat(textField(ext?.publication?.release_notes, 4000), 'plugin.json: publication.release_notes required');
    requireThat(object(evidence), 'submission requires non-secret external --evidence JSON with completed live review checks');
    for (const flag of EVIDENCE_FLAGS) requireThat(evidence?.[flag] === true, `submission evidence: ${flag} must be confirmed`);
    requireThat(typeof evidence?.verifiedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(evidence.verifiedAt) &&
      Number.isFinite(Date.parse(evidence.verifiedAt)), 'submission evidence: verifiedAt must be an ISO timestamp');
    for (const field of URL_FIELDS) requireThat(publicHTTPS(evidence?.verifiedURLs?.[field]) &&
      evidence.verifiedURLs[field] === ui?.[field], `submission evidence: verifiedURLs.${field} must match the verified manifest URL`);
    requireThat(publicHTTPS(evidence?.verifiedURLs?.demo_recording_url) &&
      evidence.verifiedURLs.demo_recording_url === review?.demo_recording_url, 'submission evidence: verified video URL must match the manifest');
    requireThat(!forbiddenMetadata(evidence), 'submission evidence must not contain credentials or reviewer instructions');
  }
  if (errors.length) throw new Error(`Package validation failed:\n- ${errors.join('\n- ')}`);
  return [...files].sort();
}

async function readSafeFile(root, relative) {
  // lstat every component: rejecting links also rejects links that point inside the root.
  let current = root;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = await lstat(current); } catch { throw new Error(`Required package file missing: ${relative}`); }
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error(`Package paths must be regular files without symlinks: ${relative}`);
    }
    if (stat.size > 8 * 1024 * 1024) throw new Error(`Package file exceeds 8 MiB: ${relative}`);
  }
  return readFile(current);
}

function validatePNG(data, file, square) {
  if (data.length < 33 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    data.toString('ascii', 12, 16) !== 'IHDR' || data.readUInt32BE(8) !== 13) throw new Error(`Invalid PNG asset: ${file}`);
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
  if (width < 48 || height < 48 || width > 4096 || height > 4096 || (square && width !== height)) {
    throw new Error(`Asset dimensions must be ${square ? 'square, ' : ''}48–4096 pixels: ${file}`);
  }
}

export async function collectPackageFiles(root, { submission = false, evidence } = {}) {
  const resolvedRoot = await realpath(root);
  let manifest, mcp;
  try {
    manifest = JSON.parse((await readSafeFile(resolvedRoot, 'plugin.json')).toString('utf8'));
    mcp = JSON.parse((await readSafeFile(resolvedRoot, 'mcp.json')).toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('plugin.json or mcp.json contains invalid JSON');
    throw error;
  }
  const names = validateManifest(manifest, mcp, { submission, evidence });
  const files = [];
  const ui = manifest.extensions['com.openai'].interface;
  const icons = new Set(['logo', 'composerIcon', 'logoDark', 'composerIconDark'].map(k => ui[k]?.slice(2)).filter(Boolean));
  for (const name of names) {
    const data = await readSafeFile(resolvedRoot, name);
    if (name.startsWith('assets/') && name !== 'assets/LICENSE') {
      if (data.length > 5 * 1024 * 1024) throw new Error(`Image asset exceeds 5 MiB: ${name}`);
      // Only PNG assets are currently shipped; fail explicitly if format validation is missing.
      if (!name.endsWith('.png')) throw new Error(`Packaging currently validates PNG images only: ${name}`);
      validatePNG(data, name, icons.has(name));
    }
    files.push({ name, data });
  }
  const skill = files.find(x => x.name === 'skills/connect-codex/SKILL.md').data.toString('utf8');
  if (!/^---\nname: connect-codex\ndescription: [^\n]+\n---\n/.test(skill)) throw new Error('connect-codex skill needs valid name and description frontmatter');
  if (files.reduce((n, file) => n + file.data.length, 0) > 32 * 1024 * 1024) throw new Error('Package exceeds 32 MiB');
  return { manifest, files };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n & 1) ? (0xedb88320 ^ (n >>> 1)) : (n >>> 1);
  return n >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** ZIP32, stored files, sorted paths, fixed DOS date, fixed Unix mode; no host metadata. */
export function createZip(files) {
  const locals = [], central = [];
  let offset = 0;
  const sorted = [...files].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (sorted.length > 0xffff || new Set(sorted.map(x => x.name)).size !== sorted.length) throw new Error('ZIP requires unique paths and at most 65535 files');
  for (const file of sorted) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(file.name) || file.name.split('/').some(x => !x || x === '.' || x === '..')) throw new Error('Unsafe ZIP entry path');
    const name = Buffer.from(file.name, 'utf8'), data = file.data;
    if (!Buffer.isBuffer(data) || data.length > 0xffffffff || name.length > 0xffff) throw new Error('ZIP entry exceeds ZIP32 limits');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(33, 12); // 1980-01-01, 00:00:00
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(0x0314, 4); // Unix creator, ZIP 2.0
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(33, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE((0o100644 * 65536) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  if (offset + directory.length > 0xffffffff) throw new Error('Archive exceeds ZIP32 limits');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function isInside(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function canonicalOutput(file) {
  let directory = path.dirname(file);
  const suffix = [path.basename(file)];
  for (;;) {
    try { return path.join(await realpath(directory), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT' || directory === path.dirname(directory)) throw error;
      suffix.unshift(path.basename(directory));
      directory = path.dirname(directory);
    }
  }
}

export async function buildPackage({ root, output, submission = false, evidencePath, check = false } = {}) {
  root = await realpath(root ?? fileURLToPath(new URL('..', import.meta.url)));
  let evidence;
  if (evidencePath !== undefined) {
    const location = await realpath(evidencePath);
    if (isInside(path.dirname(root), location)) throw new Error('Submission evidence must stay outside the repository/package');
    try { evidence = JSON.parse(await readFile(location, 'utf8')); } catch { throw new Error('Cannot read submission evidence JSON'); }
  }
  const { manifest, files } = await collectPackageFiles(root, { submission, evidence });
  if (check) return { name: manifest.name, version: manifest.version, mode: submission ? 'submission' : 'development', files: files.map(x => x.name) };
  output = await canonicalOutput(path.resolve(output ?? path.join(root, 'dist', `${manifest.name}-${manifest.version}${submission ? '' : '-development'}.zip`)));
  if (files.some(x => path.join(root, x.name) === output) || output === path.join(root, 'package.json') || output === path.join(root, 'scripts/package.mjs') || isInside(path.join(root, 'test'), output)) {
    throw new Error('ZIP output must not overwrite source files');
  }
  const zip = createZip(files);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, zip, { flag: 'wx' }); // Never clobber a prior archive or follow an output symlink.
  return { output, mode: submission ? 'submission' : 'development', files: files.map(x => x.name), bytes: zip.length,
    sha256: createHash('sha256').update(zip).digest('hex') };
}

async function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--submission') options.submission = true;
    else if (args[i] === '--check') options.check = true;
    else if (['--output', '--evidence'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) options[args[i++] === '--output' ? 'output' : 'evidencePath'] = args[i];
    else throw new Error('Usage: node scripts/package.mjs [--check] [--submission --evidence /absolute/non-secret.json] [--output /path/plugin.zip]');
  }
  console.log(JSON.stringify(await buildPackage(options), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    // Validation messages name fields/files, never interpolate credential values or source content.
    console.error(error.code === 'EEXIST' ? 'Output already exists; choose a new --output path.' : error.message);
    process.exitCode = 1;
  });
}
