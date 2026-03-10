# Gatekeeper "fetch" pattern triggers on normal English text

**Labels**: bug, security

## Bug Description

The `MALICIOUS_ATTACK_PATTERNS` regex for curl/wget/fetch is too broad:

```js
/(?:curl|wget|fetch)\s+(?:https?:\/\/)?(?!whitelisted-domains)/i
```

The word "fetch" commonly appears in normal technical English text (e.g., "Web Fetch 抓取", "fetch documentation", "go fetch the data"). The pattern triggers on ANY occurrence of "fetch" followed by a space and anything that isn't a whitelisted domain.

## Examples of False Positives

- "Web Fetch 抓取 eclawbot.com" → blocked (Chinese chars after "fetch ")
- "please fetch the latest data" → blocked
- "use the web fetch tool" → blocked

## Suggested Fix

Require that `curl`/`wget`/`fetch` be preceded by a command-like context or followed by a URL-like pattern:

```js
// Option A: Only match when followed by URL-like strings
/(?:curl|wget)\s+(?:-[sS]\s+)?(?:https?:\/\/)?(?!whitelisted)/i,
/(?:^|\s)fetch\s+(?:https?:\/\/)(?!whitelisted)/i

// Option B: Require fetch to look like a command (at start of line or after ;/&&/||)
/(?:^|[;&|]\s*)fetch\s+(?:https?:\/\/)?(?!whitelisted)/i
```

The word "fetch" should only be flagged when it appears to be used as a shell command (like `fetch https://...`), not as part of a product name or English sentence.
