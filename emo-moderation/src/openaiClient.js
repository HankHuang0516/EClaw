'use strict';

/**
 * Thin fetch wrapper over the OpenAI Moderation API. No SDK dependency — we
 * only need one endpoint, so a native fetch call keeps this module install-free
 * for the caller. Node >=18 has global `fetch`.
 *
 * The moderation endpoint returns:
 *   { id, model, results: [ { flagged, categories, category_scores } ] }
 *
 * See: https://platform.openai.com/docs/api-reference/moderations
 */

const DEFAULT_MODEL = 'text-moderation-latest';
const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/moderations';

/**
 * @param {string} text
 * @param {{
 *   openaiKey: string,
 *   model?: string,
 *   endpoint?: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 * }} options
 * @returns {Promise<{ flagged: boolean, categories: Record<string, boolean>, category_scores: Record<string, number>, model: string }>}
 */
async function callOpenAIModeration(text, options) {
  if (!options || typeof options.openaiKey !== 'string' || options.openaiKey.length < 8) {
    throw new Error('emo-moderation: openaiKey is required and must be a non-empty string.');
  }
  const model = options.model || DEFAULT_MODEL;
  const endpoint = options.endpoint || DEFAULT_ENDPOINT;
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) {
    throw new Error(
      'emo-moderation: global fetch not available and no fetchImpl provided. Use Node >=18.'
    );
  }
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || 10000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.openaiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: text, model }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await safeReadText(res);
      throw new Error(
        `emo-moderation: OpenAI moderation failed HTTP ${res.status}: ${detail.slice(0, 300)}`
      );
    }
    const json = await res.json();
    const result = json && Array.isArray(json.results) ? json.results[0] : null;
    if (!result) throw new Error('emo-moderation: OpenAI moderation returned no result.');
    return {
      flagged: !!result.flagged,
      categories: result.categories || {},
      category_scores: result.category_scores || {},
      model: json.model || model,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function safeReadText(res) {
  try {
    return await res.text();
  } catch (_) {
    return '';
  }
}

module.exports = { callOpenAIModeration, DEFAULT_MODEL, DEFAULT_ENDPOINT };
