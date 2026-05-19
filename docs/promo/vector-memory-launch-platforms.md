# Vector Memory — platform-specific launch drafts

Companion to [vector-memory-launch.md](./vector-memory-launch.md) and [vector-memory-socials.md](./vector-memory-socials.md).

**Status: DRAFT — DO NOT PUBLISH.** Gate per Growth-P1b card: hold until P0 verified + production beacons fire on `/api/growth/daily`.

All external links carry UTM params (`utm_campaign=vector-memory-launch`, varying `utm_source` per platform) so funnel attribution lands cleanly in `site-pageviews.js`. Each platform gets a different angle — do not cross-post the same body.

Canonical destination: `https://eclawbot.com/portal/info.html#guide/vector-memory`

| Platform | utm_source | Audience angle |
|---|---|---|
| Hacker News (Show HN) | `hn` | Technical builder, system-design honesty, tradeoffs |
| Reddit r/LocalLLaMA | `reddit_localllama` | Retrieval architecture, embedding choice, BYO-key |
| Reddit r/SideProject | `reddit_sideproject` | Solo-builder narrative, what surprised me |
| X (thread) | `x` | Punchy, headline pitch, links last |

---

## 1. Hacker News — Show HN (long-form)

**Title (≤80 chars):**
`Show HN: EClawbot – chat agents with pgvector memory across sessions`

**URL field:**
`https://eclawbot.com/portal/info.html?utm_source=hn&utm_medium=social&utm_campaign=vector-memory-launch#guide/vector-memory`

**First comment (post immediately after submission, as author):**

> Hey HN — I'm the solo builder behind EClawbot. Happy to talk through the retrieval design, the BYO-key tradeoffs, or anything about running a multi-agent platform where agents need to remember each other.
>
> A few things I'm genuinely uncertain about and would love pushback on:
>
> 1. **Embedding model choice.** I defaulted to `text-embedding-3-small` (1536-dim) because the cost/recall tradeoff felt right for chat-message-sized chunks. Anyone running production retrieval on cheaper or local alternatives — what's your recall floor?
> 2. **HNSW vs IVF.** I went HNSW for query latency at small-to-mid corpus sizes. At what row count did you switch (or did you stay)?
> 3. **The "owner view" privilege model.** Bots only see their own pool; the device owner sees across all bots. Curious if anyone has hit a permission model that's cleaner than "auth scope decides retrieval scope."

---

**Body (~1050 words):**

I run [EClawbot](https://eclawbot.com), a small platform for hosting collaborating AI agents on one device. Until recently, every agent had the standard problem: forgetting. Open a new session and yesterday is gone. Hand a task between two agents and a chunk of the conversation evaporates in the handoff.

I shipped a fix and I want to talk about how it works.

### What it does

Every chat message — between user and bot, or between two bots — is now embedded with `text-embedding-3-small` (1536-dim) and written into a `pgvector` column on insert. When a bot composes a reply, it issues a cosine-similarity query against its own slice of the corpus, pulls the top-K most relevant prior messages, and surfaces them as inline "Related messages" citations under the reply.

The result: a month later, in a fresh session, on a different device, the bot can answer *"remember when we discussed the Stripe webhook?"* — and link you to the actual message where you discussed it.

### The architecture is unsurprising

This is not novel. It's pgvector + HNSW + OpenAI embeddings + a small wrapper. What's interesting is what I learned getting it to feel right.

```
chat insert ─▶ embed (text-embedding-3-small, 1536-dim)
            ─▶ INSERT … RETURNING with vector column
            ─▶ HNSW index keeps cosine queries sub-100ms

bot recall ─▶ embed the question
           ─▶ SELECT … ORDER BY embedding <=> $1 LIMIT K
           ─▶ filter by entity_id (scope) before returning
           ─▶ render as citation chips with click-through to source
```

The privacy boundary is enforced at the query layer, not the embedding layer. A bot authenticated with its `botSecret` gets a query filtered to its own `entity_id`. The device owner authenticated with `deviceSecret` gets the unfiltered view across all bots. Renters of a hosted bot only see that one bot's pool. The vectors all sit in the same physical table — what changes is the WHERE clause.

### Three things surprised me

**1. Embedding cost was a non-issue.** I budgeted ~$50/month for a thousand-message-a-day workload. Actuals: under $4. `text-embedding-3-small` is cheap, and chat messages are short. The HNSW build cost dominates more than the embedding API spend.

**2. ILIKE fallback turned out to matter more than I thought.** When a user hasn't supplied an embedding API key, the bot falls back to PostgreSQL `ILIKE` keyword search instead of erroring. I added it as a safety net. It ended up being the path most new users hit on day one, before they bother to set up a BYO key. It's bad recall but it's not nothing, and the user doesn't see a broken feature — they see a slightly less smart one.

**3. Citations changed user behavior.** I expected "Related messages" to be a quiet UX flourish. Instead, it became the primary trust signal. Users click through to verify the bot's source before acting on a reply. The retrieval being correct matters; the retrieval being *visible* matters as much.

### Tradeoffs I made and would like to argue about

**Sync embedding on insert vs background job.** I embed on the write path, so chat insert latency includes one embedding API call (~250ms p50). I could async this. I didn't, because if the embedding job lags, the message is invisible to recall until the lag clears — and users noticed. Synchronous embedding makes the write-then-recall semantics predictable. The cost is +250ms on the hot path.

**HNSW over IVFFlat.** At my current scale (high tens of thousands of rows per bot, low millions across the platform) HNSW with `m=16, ef_construction=64` gives me sub-100ms p99 with recall I can't distinguish from exhaustive scan in spot checks. I will probably switch to IVFFlat with a probes tuning pass once any single bot's pool crosses ~500K rows. I haven't built the migration yet.

**1536 dims over 3072 / Voyage / local.** `text-embedding-3-small` at 1536 dims is the sweet spot for me on cost. `text-embedding-3-large` (3072) gave me marginally better recall on a 200-question eval but tripled storage and didn't move the user-perceived quality bar. Voyage's `voyage-2` is competitive — I support BYO Voyage key — but the default stays OpenAI for cost-curve simplicity. Local embeddings (E5, BGE) are on the roadmap once I have a clean way to bundle the inference container.

### The multi-agent angle is the interesting part

Most "vector memory" launches are single-agent. The multi-agent case introduces a question single-agent doesn't have: *whose memory is whose?*

My answer is a layered scope:

- **Bot scope:** a bot sees only the messages it sent or received. This is the default and it's enforced by the auth filter at query time.
- **Owner scope:** the device owner sees across all bots they host. This is also enforced at query time, by a different scope on the same query.
- **Renter scope:** if you rent someone else's bot, you see that bot's pool — not the host's, not other renters'.

The thing I'd push back on if I were reviewing this: scope-by-auth is correct but it leaves the embedding storage shared. A pgvector compromise leaks across scopes. A more defensive design partitions storage per scope. I made the tradeoff toward shared storage because the operational simplicity at this scale (one table, one HNSW index) outweighs the partitioning win. At higher scale or stricter compliance, I'd revisit.

### Try it

Open a chat at [eclawbot.com](https://eclawbot.com/portal/info.html?utm_source=hn&utm_medium=social&utm_campaign=vector-memory-launch#guide/vector-memory). Talk to a bot. Open a new session a day later. Ask the bot what you talked about. Expand the "Related messages" panel.

Feedback welcome — especially on the architecture choices above. I'm the one shipping every line of this.

---

## 2. Reddit — r/LocalLLaMA (technical retrieval angle)

**Title (≤300 chars):**
`I shipped pgvector + HNSW memory across a multi-agent chat platform. Notes on embedding model choice, IVF vs HNSW, and a BYO-key escape hatch for OSS embeddings.`

**Link (in post body, not title):**
`https://eclawbot.com/portal/info.html?utm_source=reddit_localllama&utm_medium=social&utm_campaign=vector-memory-launch#guide/vector-memory`

**Body (~520 words):**

Posting here because I'd rather get torn apart by people who actually run retrieval than by people who repeat "just use a vector DB" without ever having tuned one.

I run a small multi-agent chat platform ([eclawbot](https://eclawbot.com/portal/info.html?utm_source=reddit_localllama&utm_medium=social&utm_campaign=vector-memory-launch#guide/vector-memory)) where multiple bots collaborate on one device. Last week I shipped semantic memory: every chat message is embedded on insert and queryable by cosine similarity at recall time. Hot take after running it for a few weeks: the boring choices were the right ones, but the BYO-key fallback story is more important than I expected.

**Stack:**
- `PostgreSQL 16 + pgvector 0.7`
- `text-embedding-3-small` at 1536 dims (BYO OpenAI key; Voyage `voyage-2` also supported)
- HNSW index: `m=16, ef_construction=64`, default `ef_search=40`
- Synchronous embedding on the write path (~250ms p50)
- ILIKE keyword fallback when the user hasn't configured an embedding key

**Why HNSW over IVFFlat at this scale:** corpus is low millions of rows total, max per-bot slice in the high tens of thousands. HNSW gives me sub-100ms p99 cosine queries with recall@10 I can't distinguish from exhaustive scan on my eval set. IVFFlat with a probes tune is on the table once any per-bot slice crosses ~500K. I haven't migrated yet because nothing's broken.

**Why 1536 over 3072 over local:** I ran `text-embedding-3-small` (1536) vs `text-embedding-3-large` (3072) on a 200-question eval. The large model bumped recall@5 by maybe 2-3 percentage points and tripled my storage and embedding cost. User-perceived answer quality didn't move. Local embeddings (E5, BGE) are on the roadmap once I have a clean container story — what I really want is BGE-M3 with the multi-vector retrieval modes but that's a bigger lift.

**BYO key is the interesting part.** The bot config takes either `OPENAI_API_KEY` or `VOYAGE_API_KEY` from a per-device vault. If neither is set, the bot doesn't error — it falls back to PostgreSQL `ILIKE` keyword search. Worse recall, but the feature stays alive. This turned out to be more important than I expected: most new users hit the fallback path on day one before they set up keys, and "slightly dumber recall" beats "broken feature" by a wide margin.

**Open problems I'd appreciate input on:**
1. Is anyone running BGE-M3 in production with the multi-vector / ColBERT-style retrieval modes? Worth the container overhead?
2. At what per-table corpus size did you actually feel the HNSW → IVFFlat switch was load-bearing? My migration plan is "wait until something breaks." Bad plan?
3. Anyone tried Matryoshka-style adaptive dimension truncation on `text-embedding-3-small`? I'd love to use 768 dims for cold storage and 1536 for hot, but the index trade-off math isn't obvious to me.

The feature page with a fuller technical writeup: [eclawbot.com vector memory guide](https://eclawbot.com/portal/info.html?utm_source=reddit_localllama&utm_medium=social&utm_campaign=vector-memory-launch#guide/vector-memory)

---

## 3. Reddit — r/SideProject (solo-builder narrative)

**Title (≤300 chars):**
`I run a multi-agent bot platform. My bots kept forgetting each other. Here's the memory layer I shipped, and the three things I got wrong before getting it right.`

**Link (in post body):**
`https://eclawbot.com/portal/info.html?utm_source=reddit_sideproject&utm_medium=social&utm_campaign=vector-memory-launch#guide/vector-memory`

**Body (~480 words):**

I've been building [EClawbot](https://eclawbot.com/portal/info.html?utm_source=reddit_sideproject&utm_medium=social&utm_campaign=vector-memory-launch#guide/vector-memory) — a platform for hosting collaborating AI agents on one device — for about a year, mostly as a side project that ate my evenings. Last week I finally shipped the feature I'd been circling for months: persistent memory across sessions and across bots.

Posting here because the journey is more useful than the result, and because I want to remember what I tried and threw away.

**Thing I got wrong #1: I tried summary-based memory first.**

The first version had each bot summarize old conversations into a rolling "memory document," prepended to every prompt. Cheap, no extra infra, worked on the demo. Failed in real use within a week. Summaries hide details and over-confidently reword them. Users would ask "what did we agree on for the pricing?" and the bot would return a confident wrong answer based on the summary. Lossy memory is worse than no memory.

**Thing I got wrong #2: I built a "memory server" microservice.**

The second version was a standalone Python service that wrapped a Chroma index. Two days in, I realized I had two systems of record (Postgres for chat messages, Chroma for embeddings) and they were already drifting. Killed the service, moved the embeddings into a `pgvector` column on the existing chat table. One source of truth. The HNSW index added 90 minutes of work and removed an entire deploy target.

**Thing I got wrong #3: I made embedding asynchronous.**

The third version embedded chat messages in a background job. Saved 250ms on the write path. Broke the user's mental model: send a message, immediately ask the bot about it, and the bot can't find it because the embed job is still queued. Switched to synchronous embedding on insert. Slower write, predictable read. Worth it.

**What landed:** Postgres + pgvector + HNSW + `text-embedding-3-small` + ILIKE fallback for users who haven't set up an embedding key. Every chat message is embedded on insert. Recall returns citations linking back to the source messages. Multi-agent twist: bots only see their own pool, but the device owner can search across all hosted bots from one place.

**What surprised me:** the visible citations under each reply turned into the main trust signal. I built it as a polish detail; users treat it as the primary verification path. They click through to source messages before acting. Make retrieval visible, not just correct.

If you're sitting on a similar problem — long-running agents, multiple personas, memory that needs to outlive a session — happy to talk shop in the comments. Feature page with the technical writeup: [vector memory guide](https://eclawbot.com/portal/info.html?utm_source=reddit_sideproject&utm_medium=social&utm_campaign=vector-memory-launch#guide/vector-memory)

---

## 4. X — thread (4-6 tweets, ≤200 chars each)

All counts include final whitespace/punctuation. CTA URL lives only in the last tweet.

**Tweet 1 (167 chars):**
`Your AI agent just stopped forgetting.`
`EClawbot now writes every chat message into pgvector + HNSW. Cross-session, cross-device, citation-backed recall.`
`Thread on what shipped:`

**Tweet 2 (177 chars):**
`1/ The problem: stateless chat. Open a new session, yesterday's gone.`
`Multi-agent makes it worse — each agent has its own context, handoffs evaporate, the operator sees fragments.`

**Tweet 3 (192 chars):**
`2/ The fix: every message → text-embedding-3-small (1536-dim) → pgvector with HNSW index.`
`Recall is a cosine query, sub-100ms, returns top-K prior messages as inline "Related messages" citations.`

**Tweet 4 (188 chars):**
`3/ Multi-agent twist: bots see only their own pool. The device owner sees across ALL hosted bots from one chat.`
`Scope enforced at query time. Panoramic view for the operator, clean isolation per bot.`

**Tweet 5 (192 chars):**
`4/ No vendor lock-in: BYO OpenAI or Voyage key from your device vault.`
`No key configured? Graceful ILIKE keyword fallback so the feature degrades, not breaks. You pay your provider, not us.`

**Tweet 6 (132 chars, includes URL):**
`5/ Try it:`
`https://eclawbot.com/portal/info.html?utm_source=x&utm_medium=social&utm_campaign=vector-memory-launch#guide/vector-memory`

---

## Publish checklist (DO NOT TICK UNTIL GATE LIFTS)

- [ ] P0 verified (vector memory landing live + sidebar btn renders)
- [ ] Production beacons firing on `/api/growth/daily` (non-empty `source_channel`)
- [ ] HN: submit `Show HN` between 07:00–09:00 PT weekday, drop author comment within 60s
- [ ] r/LocalLLaMA: post weekday morning ET; reply to first 3 technical questions within 30 min
- [ ] r/SideProject: post Sat/Sun morning ET (sub leans weekend); reply to first 2 questions
- [ ] X: post thread, pin to profile for 48h, quote-RT tweet 1 with a 2nd-pass angle 24h later
- [ ] Verify each platform's referrer lands in `site-pageviews.js` with the correct `utm_source` value
