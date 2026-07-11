'use strict';

const path = require('path');
const fs = require('fs');

const HOTLINES_PATH = path.join(__dirname, '..', 'resources', 'tw-crisis-hotlines.json');

let _hotlinesCache = null;
function loadHotlines() {
  if (_hotlinesCache) return _hotlinesCache;
  const raw = fs.readFileSync(HOTLINES_PATH, 'utf8');
  _hotlinesCache = JSON.parse(raw);
  return _hotlinesCache;
}

/**
 * Resolve the best hotline entry for a given locale string. Matcher is a
 * case-insensitive startsWith over the registry keys, so callers can pass
 * "zh-TW", "zh-tw", "zh_TW", "zh-TW-hant", etc. and get the TW entry back.
 * Falls back to registry `default` when no key matches.
 *
 * @param {string} [locale]
 * @returns {{ key: string, entry: object }}
 */
function resolveHotline(locale) {
  const registry = loadHotlines();
  const norm = (locale || '').toLowerCase().replace(/_/g, '-');
  const keys = Object.keys(registry.locales).filter((k) => k !== 'default');
  // Exact-prefix match first (e.g. "zh-tw" beats "zh")
  const sorted = keys.slice().sort((a, b) => b.length - a.length);
  for (const key of sorted) {
    if (norm.startsWith(key.toLowerCase())) {
      return { key, entry: registry.locales[key] };
    }
  }
  return { key: 'default', entry: registry.locales.default };
}

// Compassion-first, non-clinical response templates. These are the ONLY strings
// the module emits to a user in a crisis pathway. They deliberately:
//   - validate the feeling
//   - do NOT diagnose or prescribe
//   - point at a local free hotline
//   - stay under 300 words
const TEMPLATES = {
  'zh-TW': {
    title: '我聽到你了',
    validate:
      '你願意講出這些，本身就是很不容易的一步。你現在感受到的沉重是真實的，不必獨自扛。',
    handoff:
      '如果現在很難撐住，臺灣有免費、24 小時的{{name}}（{{number}}），另外還有生命線 1995 與張老師 1980。你打過去可以只是說「我需要有人聽我說」，他們會陪你。',
    close: '我沒辦法取代這些專業支持，但我在這裡，你隨時可以回來說話。',
    disclaimer: '本訊息不是醫療或心理諮商建議。',
  },
  'zh-HK': {
    title: '我聽到你了',
    validate:
      '你願意講出這些，已經是很重要的一步。你現在的感受是真實的，不用一個人扛。',
    handoff:
      '如果現在好辛苦，香港有 24 小時免費的{{name}}（{{number}}），你可以打去講「我想有人聽我說」，他們會陪住你。',
    close: '我唔可以代替專業支援，但我一直喺度，你想返嚟講嘢隨時得。',
    disclaimer: '呢個訊息唔係醫療或心理輔導建議。',
  },
  'en-HK': {
    title: 'I hear you.',
    validate:
      'What you are carrying sounds heavy. Putting it into words takes courage, and you do not have to hold it alone.',
    handoff:
      'If right now feels too much, {{name}} in Hong Kong is free and open 24 hours ({{number}}). You can simply say "I just need someone to listen."',
    close: 'I cannot replace that support, but I am here when you want to come back.',
    disclaimer: 'This message is not medical or clinical advice.',
  },
  'en-SG': {
    title: 'I hear you.',
    validate:
      'What you are carrying sounds heavy. Putting it into words takes courage, and you do not have to hold it alone.',
    handoff:
      'If right now feels too much, {{name}} is free and open 24 hours ({{number}}). It is okay to call and say "I just need someone to listen."',
    close: 'I cannot replace that support, but I am here when you want to come back.',
    disclaimer: 'This message is not medical or clinical advice.',
  },
  default: {
    title: 'I hear you.',
    validate:
      'What you are carrying sounds heavy. Putting it into words takes courage, and you do not have to hold it alone.',
    handoff:
      'If right now feels too much, {{name}} can help you find a free, local helpline ({{url}}). Reaching out and saying "I just need someone to listen" is enough.',
    close: 'I cannot replace that support, but I am here when you want to come back.',
    disclaimer: 'This message is not medical or clinical advice.',
  },
};

function pickTemplate(localeKey) {
  return TEMPLATES[localeKey] || TEMPLATES.default;
}

function fillTemplate(str, hotline) {
  return str
    .replace(/\{\{name\}\}/g, hotline.name || '')
    .replace(/\{\{number\}\}/g, hotline.number || '')
    .replace(/\{\{url\}\}/g, hotline.url || 'https://findahelpline.com');
}

/**
 * Build a compassionate, non-clinical crisis response.
 *
 * @param {string} [_text]  Original user text (unused today; reserved for future
 *                          heuristics like "user mentioned a specific person").
 *                          Named with underscore to signal intentional non-use.
 * @param {string} [locale] BCP-47-ish locale hint from the caller.
 * @returns {{
 *   schema: 'emo-moderation.crisis-response/v1',
 *   action: 'crisis_referral',
 *   locale: string,
 *   region: string,
 *   title: string,
 *   body: string,
 *   hotline: { name: string, number?: string|null, url?: string, hours: string, cost: string },
 *   alternates: Array<object>,
 *   disclaimer: string,
 *   wordCount: number,
 * }}
 */
function buildCrisisResponse(_text, locale) {
  const { key, entry } = resolveHotline(locale);
  const template = pickTemplate(key);
  const hotline = entry.primary;

  const body = [
    template.validate,
    fillTemplate(template.handoff, hotline),
    template.close,
  ].join('\n\n');

  const wordCount = body.split(/\s+/u).filter(Boolean).length;

  const response = {
    schema: 'emo-moderation.crisis-response/v1',
    action: 'crisis_referral',
    locale: key,
    region: entry.region,
    title: template.title,
    body,
    hotline: {
      name: hotline.name,
      number: hotline.number || null,
      url: hotline.url,
      hours: hotline.hours,
      cost: hotline.cost,
    },
    alternates: entry.alternates || [],
    disclaimer: template.disclaimer,
    wordCount,
  };

  // Hard invariant: crisis response must never exceed 300 words. If a future
  // template edit breaks this we want the test suite to catch it, but at
  // runtime we still return a safe truncation rather than nothing.
  if (wordCount > 300) {
    const truncated = body.split(/\s+/u).slice(0, 290).join(' ');
    response.body = `${truncated}…`;
    response.wordCount = 290;
    response.truncated = true;
  }

  return response;
}

module.exports = {
  buildCrisisResponse,
  resolveHotline,
  loadHotlines,
  _internal: { TEMPLATES, HOTLINES_PATH },
};
