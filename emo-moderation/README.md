# @eclaw/emo-moderation

Server-side moderation + crisis-referral flow for the EClaw 情緒價值 App pipeline
(Epic `card_6d0f2746`, infra card I4 `card_9806a61f1b1eabd21cdab063`).

Emotional-value apps (grief companion, vent journal, breakup companion, etc.)
touch heavy content and cannot ship to Apple / Google / AdMob without a
moderation + crisis-referral gate. This module wraps OpenAI Moderation, maps
categories to actions, and builds a compassionate, non-clinical crisis response
with a locale-aware hotline.

## Actions

`screen(text, options)` returns one of:

| action            | meaning                                                            |
|-------------------|--------------------------------------------------------------------|
| `pass`            | nothing tripped                                                    |
| `soft_flag`       | borderline; deliver but redact high-risk phrases                   |
| `hard_block`      | refuse; log for review                                             |
| `crisis_referral` | user in distress; return a compassionate response + local hotline  |

Category → action mapping:

| OpenAI category                  | action            |
|----------------------------------|-------------------|
| `sexual/minors`                  | `hard_block`      |
| `self-harm/intent`               | `hard_block`      |
| `self-harm/instructions`         | `hard_block`      |
| `violence/graphic`               | `hard_block`      |
| `hate/threatening`               | `hard_block`      |
| `self-harm` (broad, no intent)   | `crisis_referral` |
| `hate`, `harassment`, `sexual`, `violence` | `soft_flag` |
| else                             | `pass`            |

Precedence: `hard_block > crisis_referral > soft_flag > pass`.

## Install

```bash
npm install @eclaw/emo-moderation
```

Node >= 18 (uses global `fetch`).

## Integration example

```js
const { screen, assessAgeAppropriateness } = require('@eclaw/emo-moderation');

async function handleUserMessage(text, { locale, openaiKey }) {
  const result = await screen(text, { openaiKey, locale });

  switch (result.action) {
    case 'hard_block':
      return { ok: false, kind: 'refused', reason: result.reason };
    case 'crisis_referral':
      // result.crisisResponse is a UI-ready card payload.
      return { ok: true, kind: 'crisis-card', card: result.crisisResponse };
    case 'soft_flag':
      return { ok: true, kind: 'redacted', text: result.redactedText };
    default:
      return {
        ok: true,
        kind: 'plain',
        text,
        minAge: assessAgeAppropriateness(text, { moderation: result }).minAge,
      };
  }
}
```

### Key handling

The module NEVER embeds an OpenAI key. Two supported sources:

1. **Caller supplies** — `screen(text, { openaiKey: '<sk-...>' })`. Recommended
   for local dev and CI (via env var).
2. **EClaw keyref endpoint** — production callers can fetch a named vault key
   via the keyref endpoint shipped in PR #3853
   (`project_keyref_value_endpoint_spec`):

   ```js
   const url = new URL('https://eclawbot.com/api/device-vars/value');
   url.searchParams.set('name', 'OPENAI_MODERATION_KEY');
   url.searchParams.set('deviceId', deviceId);
   url.searchParams.set('botSecret', botSecret);
   url.searchParams.set('entityId', entityId);
   const openaiKey = (await (await fetch(url)).json()).value;
   const result = await screen(text, { openaiKey, locale });
   ```

   The value is only in the API body; audit log fires `bot_read_value`.

### Stub mode (tests / offline)

Pass `moderationResult` to skip the network call and drive the branch selector
directly. This is what the test suite uses and what CI runs in offline mode.

```js
const result = await screen('[test:selfharm_intent_low]', {
  locale: 'zh-TW',
  moderationResult: {
    flagged: true,
    categories: { 'self-harm': true },
    category_scores: { 'self-harm': 0.6 },
  },
});
// result.action === 'crisis_referral'
// result.crisisResponse.hotline.number === '1925'
```

## Crisis response contract

Schema: `emo-moderation.crisis-response/v1`.

```json
{
  "schema": "emo-moderation.crisis-response/v1",
  "action": "crisis_referral",
  "locale": "zh-TW",
  "region": "Taiwan",
  "title": "我聽到你了",
  "body": "…",
  "hotline": { "name": "安心專線", "number": "1925", "hours": "24h", "cost": "free" },
  "alternates": [
    { "name": "生命線", "number": "1995", "hours": "24h", "cost": "free" }
  ],
  "disclaimer": "本訊息不是醫療或心理諮商建議。",
  "wordCount": 78
}
```

Invariants:

- Body is `< 300 words`.
- No diagnostic / prescriptive vocabulary (enforced by the test suite).
- Non-clinical validation + resource pointer only.

## Locales shipped

- `zh-TW` → 安心專線 1925 (+ 1995, 1980)
- `zh-HK` / `en-HK` → 生命熱線 2382-0000
- `en-SG` → SOS 1767
- fallback → https://findahelpline.com

Locale matcher is case-insensitive prefix (`zh-tw`, `zh_TW`, `zh-TW-hant` all
route to `zh-TW`). Extend by editing `resources/tw-crisis-hotlines.json`.

## Age-appropriateness helper

```js
const { assessAgeAppropriateness } = require('@eclaw/emo-moderation');

assessAgeAppropriateness('the puppy played in the yard');
// → { minAge: 4, reasons: ['default'] }

assessAgeAppropriateness('scary ghost story', { moderation: modResult });
// → { minAge: 9 | 12 | 17, reasons: [...] }
```

Buckets are Play Store / App Store IARC-adjacent: 4 / 9 / 12 / 17.

## Tests

```bash
npm test
npm run typecheck
```

Real OpenAI calls are opt-in — set `EMO_MODERATION_TEST_OPENAI_KEY` to enable
the live-network suite; otherwise CI uses canned fixtures.

## Constraints (product)

- No hardcoded API keys — caller supplies.
- Crisis response is **non-clinical**; no medical advice, no diagnoses,
  no dosages.
- Test vectors use `[test:selfharm_intent_low]` placeholders; we never inline
  real crisis language in fixtures.

## Related

- Epic: `card_6d0f2746` (情緒價值 App 量產流水線)
- Card: `card_9806a61f1b1eabd21cdab063` (I4)
- Sibling infra: I1 shell, I2 gateway, I3 AdMob SSV, I5 screenshot, I6 store
- Keyref endpoint: PR #3853 (owner-decided spec)
