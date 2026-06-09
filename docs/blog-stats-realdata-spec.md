# twopiggyhavefun-blog Site-Stats Real Data Spec

**Card**: card_4e21385d6dd1f77713cc1f87 (parent), slice card_76571e6ba236ca7e23743805
**Date**: 2026-06-09
**Author**: #2 (LOBSTER, EClaw commander)
**Status**: Draft, awaiting Hank approval to proceed with implementation slice

## Current state

The blog renders a "網站人氣統計" widget in the sidebar showing 今日人氣 (today's UV) and 累計人氣 (lifetime PV).

**Source file**: `src/components/Sidebar.astro` lines 300-303 (twopiggyhavefun-blog repo).

```html
<h3 class="font-bold mb-2 text-red-600">網站人氣統計</h3>
<div class="text-sm text-gray-600">
    <p>今日人氣：<span class="font-medium" id="busuanzi_container_site_uv"><span id="busuanzi_value_site_uv">...</span></span></p>
    <p>累計人氣：<span class="font-medium" id="busuanzi_container_site_pv"><span id="busuanzi_value_site_pv">...</span></span></p>
</div>
```

**Tracker**: 不蒜子 (busuanzi), third-party PRC-hosted JS — script tag in `src/layouts/Layout.astro:57`:

```html
<script async src="//busuanzi.ibruce.info/busuanzi/2.3/busuanzi.pure.mini.js"></script>
```

Busuanzi auto-populates the two `...` placeholders with live values at page load.

**Reachability probe 2026-06-09 21:18 TW**: busuanzi.ibruce.info returns 200 OK on the script URL. Working at the moment.

**Why this isn't "real data" enough for Hank**:
1. PRC third-party — outages affect display worldwide; no SLA.
2. No way to verify the count: we cannot pull our own stats.
3. The placeholder shows literal `...` if busuanzi fails to load (CF block, region restrictions, ad-block).
4. Single-blog-scoped — busuanzi assumes domain-keyed; if we rebrand or alias, count resets.

## Proposed real-data source — self-hosted endpoint on existing Railway backend

The blog already runs `article_api_server.js` on Railway (Express, default port 3456). Reuse it.

**No new API keys needed** (per memory `feedback_no_new_api_keys`): the existing Railway DB or a local SQLite file in the container suffices for a single-blog counter.

### New routes (in `article_api_server.js`)

```
POST /api/stats/pageview          # increment lifetime PV + today's UV (dedup by IP+UA hash, 24h TTL)
  body: { path: "/twopiggyhavefun-blog/posts/..." }
  resp: { ok: true }

GET  /api/stats/site              # public, used by Sidebar.astro
  resp: { today_uv: 913, lifetime_pv: 297216779, asof: "2026-06-09T13:18:19Z" }
```

### Storage

Reuse the existing SQLite DB (or whichever the Express server already opens). New tables:

```sql
CREATE TABLE site_stats_daily (
  date TEXT PRIMARY KEY,         -- YYYY-MM-DD in Asia/Taipei
  uv_count INTEGER DEFAULT 0
);
CREATE TABLE site_stats_lifetime (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pv_count INTEGER DEFAULT 0
);
CREATE TABLE site_stats_uv_dedup (
  visitor_hash TEXT PRIMARY KEY, -- sha256(ip + ua + date)
  date TEXT,
  expires_at INTEGER             -- unix ms, GC after 26h
);
```

### Increment logic on POST /api/stats/pageview

1. Compute `visitor_hash = sha256(ip + ua + YYYY-MM-DD)` (Asia/Taipei date)
2. Always increment `site_stats_lifetime.pv_count`
3. UPSERT into `site_stats_uv_dedup`; if new row, also increment `site_stats_daily.uv_count` for today
4. Sweep dedup rows where `expires_at < now()` once per hour

### GET /api/stats/site response

```js
{
  today_uv: SELECT uv_count FROM site_stats_daily WHERE date=today_tpe(),
  lifetime_pv: SELECT pv_count FROM site_stats_lifetime WHERE id=1,
  asof: new Date().toISOString()
}
```

Cache 60s in-memory to avoid hammering on heavy traffic days.

## Wire diagram (post-implementation)

```
[browser hits any blog page]
    ↓ Layout.astro inline <script>
    fetch POST /api/stats/pageview         (Railway article_api_server)
    fetch GET  /api/stats/site             (same)
    ↓ on response, populate:
    #busuanzi_value_site_uv ← today_uv
    #busuanzi_value_site_pv ← lifetime_pv
[busuanzi.ibruce.info script left in place as fallback only]
```

## Backwards-compat shim

Keep the busuanzi script tag in `Layout.astro` to handle the race where our endpoint times out / returns 5xx. The IDs (`busuanzi_value_site_uv` / `busuanzi_value_site_pv`) are kept as-is — busuanzi writes to them if our fetch doesn't finish first.

Order of precedence: our endpoint wins (resolves faster from Railway US-East than busuanzi PRC), busuanzi only paints if our fetch errors or the promise hasn't resolved within 1500ms.

## Implementation slice (NEXT card to file after this spec merges)

Title: `[Blog/P2] Implement /api/stats/pageview + /api/stats/site on article_api_server.js`

Scope: routes + migrations + Sidebar.astro wire-up + 24h soak test on prod.

Needs: bridge-auth U## with Railway access for `git push` to twopiggyhavefun-blog repo, redeploy, and DB migration run.

## Open questions for Hank

1. Initial lifetime PV value: should the new endpoint start at 0 (clean) or seed from the last busuanzi-observed value (~297216779)?
2. Privacy: store visitor_hash deduplication — OK with you, or want truly stateless count (just total PV, drop UV)?
3. Rate cap: do we want to throttle the POST (e.g. 1/sec/IP) to avoid casual spam?

## Out of scope

- Per-post view counts (separate feature)
- GA/Analytics integration
- Dashboard UI on Railway side
- Multi-blog tenancy (this card is single-blog only)
