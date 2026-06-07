// OODA-R Phase 0 #1 — Episode schema + pain taxonomy.
// Card: card_e9de7607cd9a838462148328
// Parent: card_be59aa034883fe36d3645a27
//
// An "episode" is one durable record of an agent task outcome that we can
// later mine for preflight lessons (Phase 1 #3) and rule promotion (Phase 4 #9).
// The taxonomy below is the closed set of pain categories every episode is
// classified into; downstream consumers (preflight lint, dashboards, rule
// promotion) read this constant — never hard-code their own copy.

'use strict';

/**
 * Closed set of pain-category tags. Adding a tag is a roadmap-level decision;
 * Phase 1 #3 preflight prompts pivot off these strings directly.
 * @type {readonly string[]}
 */
const PAIN_TAXONOMY = Object.freeze([
  'delivery_reliability',   // message delivery, offline queue, push failures
  'auth_session',           // login persistence, token refresh, silent kicks
  'redirect_deeplink',      // app↔web routing, universal links, deep links
  'ux_feedback',            // user-visible feedback quality, delivery state surfacing
  'agent_ownership',        // agent slacking off, unclear who-owns-what, handoff drops
  'task_context',           // agent not knowing what to do, missing scope context
  'test_coverage',          // missing/insufficient test cases, no E2E, mock-only
  'scope_completeness',     // feature shipped partial / not-first-time-right
]);

const PAIN_TAXONOMY_SET = new Set(PAIN_TAXONOMY);

/**
 * Closed set of severity levels. Mirrors Kanban priority terminology.
 * @type {readonly string[]}
 */
const SEVERITY_LEVELS = Object.freeze(['P0', 'P1', 'P2', 'P3']);
const SEVERITY_SET = new Set(SEVERITY_LEVELS);

/**
 * @typedef {Object} EpisodeEvidence
 * @property {string} kind       e.g. 'pr', 'screenshot', 'log', 'comment', 'chat'
 * @property {string} ref        opaque pointer (URL, file path, PR number, chat msg id)
 * @property {string} [note]     short human-readable description, no secrets
 */

/**
 * @typedef {Object} Episode
 * @property {string} cardId                 Kanban card id this episode is anchored to
 * @property {number} entityId               EClaw entity that owned the task
 * @property {string} taskType               short slug: e.g. 'pr_review', 'feature_impl', 'bugfix', 'spec_draft'
 * @property {string[]} painTags             non-empty subset of PAIN_TAXONOMY
 * @property {string} deliverable            one-line description of what was supposed to ship
 * @property {string} userVisibleResult      one-line description of what the user actually saw
 * @property {EpisodeEvidence[]} evidence    pointers to PRs / screenshots / logs (no inline secrets)
 * @property {string[]} missedChecks         preflight items that should have caught this, in retrospect
 * @property {string} [userFeedback]         redacted snippet of user-side correction, if any
 * @property {('P0'|'P1'|'P2'|'P3')} severity
 * @property {string} occurredAt             ISO-8601 timestamp
 */

/**
 * Hex-32+ rule catches Railway tokens, raw bot secrets, db connection ids.
 * The literal strings catch human-written secret labels even if the value is masked.
 */
const SECRET_PATTERNS = Object.freeze([
  /\bbot[_-]?secret\b/i,
  /\bdevice[_-]?secret\b/i,
  /\bBearer\s+[A-Za-z0-9._\-]+/,
  /\bsk-[A-Za-z0-9]{16,}/,
  /\bRAILWAY_[A-Z_]+\s*[:=]/,
  /\bJWT_SECRET[A-Z_]*\s*[:=]/,
  /\bpassword\s*[:=]\s*\S+/i,
  /\b[a-f0-9]{32,}\b/i,
]);

/**
 * Scan a string for any secret-shaped substring. Returns the first matched
 * pattern's source for easy error messages, or null when clean.
 * @param {string} text
 * @returns {string|null}
 */
function findSecret(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) return re.source;
  }
  return null;
}

/**
 * Walk an Episode and assert no string field — including nested evidence
 * fields — contains a secret-shaped substring. Throws on first hit.
 * @param {Episode} ep
 */
function assertNoSecrets(ep) {
  const visit = (val, path) => {
    if (typeof val === 'string') {
      const hit = findSecret(val);
      if (hit) {
        throw new Error(`episode contains secret-shaped substring at ${path}: pattern=${hit}`);
      }
    } else if (Array.isArray(val)) {
      val.forEach((item, i) => visit(item, `${path}[${i}]`));
    } else if (val && typeof val === 'object') {
      for (const k of Object.keys(val)) visit(val[k], `${path}.${k}`);
    }
  };
  visit(ep, 'episode');
}

/**
 * Validate that an arbitrary object satisfies the Episode shape. Returns a
 * list of validation errors; empty array means valid.
 * @param {unknown} obj
 * @returns {string[]}
 */
function validateEpisode(obj) {
  const errs = [];
  if (!obj || typeof obj !== 'object') {
    return ['episode is not an object'];
  }
  const ep = /** @type {Record<string, unknown>} */ (obj);

  const required = [
    ['cardId', 'string'],
    ['entityId', 'number'],
    ['taskType', 'string'],
    ['painTags', 'array'],
    ['deliverable', 'string'],
    ['userVisibleResult', 'string'],
    ['evidence', 'array'],
    ['missedChecks', 'array'],
    ['severity', 'string'],
    ['occurredAt', 'string'],
  ];
  for (const [field, kind] of required) {
    const v = ep[field];
    if (v === undefined || v === null) {
      errs.push(`missing required field: ${field}`);
      continue;
    }
    if (kind === 'array' && !Array.isArray(v)) errs.push(`${field} must be array`);
    else if (kind !== 'array' && typeof v !== kind) errs.push(`${field} must be ${kind}`);
  }

  if (Array.isArray(ep.painTags)) {
    if (ep.painTags.length === 0) errs.push('painTags must be non-empty');
    for (const tag of ep.painTags) {
      if (!PAIN_TAXONOMY_SET.has(tag)) errs.push(`painTags contains unknown tag: ${tag}`);
    }
  }

  if (typeof ep.severity === 'string' && !SEVERITY_SET.has(ep.severity)) {
    errs.push(`severity must be one of ${SEVERITY_LEVELS.join(',')}`);
  }

  if (typeof ep.occurredAt === 'string' && Number.isNaN(Date.parse(ep.occurredAt))) {
    errs.push('occurredAt must be ISO-8601 parseable');
  }

  if (Array.isArray(ep.evidence)) {
    ep.evidence.forEach((e, i) => {
      if (!e || typeof e !== 'object') {
        errs.push(`evidence[${i}] must be object`);
        return;
      }
      if (typeof e.kind !== 'string') errs.push(`evidence[${i}].kind must be string`);
      if (typeof e.ref !== 'string') errs.push(`evidence[${i}].ref must be string`);
    });
  }

  if (typeof ep.userFeedback !== 'undefined' && typeof ep.userFeedback !== 'string') {
    errs.push('userFeedback must be string when present');
  }

  return errs;
}

module.exports = {
  PAIN_TAXONOMY,
  PAIN_TAXONOMY_SET,
  SEVERITY_LEVELS,
  SECRET_PATTERNS,
  findSecret,
  assertNoSecrets,
  validateEpisode,
};
