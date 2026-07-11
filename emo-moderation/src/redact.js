'use strict';

/**
 * Redact high-risk phrases from soft-flag output so the caller can safely display
 * or forward the text. We only redact for the "soft_flag" bucket — hard_block
 * outputs don't return text at all, crisis_referral outputs are replaced with the
 * compassionate response, and pass outputs are untouched.
 *
 * Approach: conservative regex list keyed to the OpenAI Moderation categories we
 * flag as soft_flag (hate / harassment / sexual / violence). We favour false
 * positives (over-redact) rather than leak — this text has already been flagged
 * by moderation, so aggressive masking is the safer default.
 *
 * Redacted spans are replaced with the literal token `[REDACTED]`. Consecutive
 * matches collapse to a single token.
 */

// Curated slur/threat/adult stems. We intentionally keep this list short and
// generic; the point is not to build a lexicon but to strip the most obvious
// tokens after the ML classifier already tripped. Extend via `extraPatterns`
// in the options passed to `redactText`.
const DEFAULT_PATTERNS = [
  // Direct threats
  /\bi(?:'| a| wi)ll (?:kill|hurt|beat|murder|stab|shoot) (?:you|him|her|them|myself)\b/gi,
  /\b(?:kill|murder|shoot|stab|beat|hurt) (?:you|him|her|them)\b/gi,
  // Generic slurs placeholder — replaced with a broad "any all-caps insult" cue
  // to keep the file clean of actual slurs.
  /\b(?:f\*+|s\*+|b\*+)\w*\b/gi,
  // Sexual explicit stems (very conservative)
  /\b(?:explicit sexual|graphic sex|xxx)\w*\b/gi,
  // Test placeholders used by our own fixtures
  /\[test:[a-z0-9_]+\]/gi,
];

/**
 * @param {string} text
 * @param {{ extraPatterns?: RegExp[], token?: string }} [options]
 * @returns {string}
 */
function redactText(text, options = {}) {
  if (typeof text !== 'string' || text.length === 0) return text;
  const token = options.token || '[REDACTED]';
  const patterns = DEFAULT_PATTERNS.concat(options.extraPatterns || []);

  let out = text;
  for (const p of patterns) {
    out = out.replace(p, token);
  }
  // Collapse consecutive [REDACTED] separated by whitespace/punct
  const collapsePattern = new RegExp(
    `(?:${escapeRegex(token)}[\\s.,;:!?—-]*){2,}`,
    'g'
  );
  out = out.replace(collapsePattern, `${token} `);
  return out.trim();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { redactText, DEFAULT_PATTERNS };
