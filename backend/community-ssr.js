// Server-side rendered Bot Plaza pages for SEO.
// Crawler-friendly per-bot detail pages + dynamic sitemap.
// Browsers and human users still get the full client-side experience via the
// "Open in Plaza" CTA that links back to /portal/community.html?bot=<code>.

const PUBLIC_CODE_RE = /^[a-z0-9]{4,12}$/i;

function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeJsonForScript(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c');
}

function isValidPublicCode(code) {
    return typeof code === 'string' && PUBLIC_CODE_RE.test(code);
}

function buildJsonLd(card, canonicalUrl) {
    const tags = (card.agentCard && Array.isArray(card.agentCard.tags)) ? card.agentCard.tags : [];
    const capabilities = (card.agentCard && Array.isArray(card.agentCard.capabilities)) ? card.agentCard.capabilities : [];
    const description = (card.agentCard && card.agentCard.description) || `${card.name} — AI agent on EClawbot Bot Plaza.`;
    return {
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        name: card.name,
        description,
        url: canonicalUrl,
        primaryImageOfPage: 'https://eclawbot.com/assets/og-image.png',
        about: {
            '@type': 'SoftwareApplication',
            name: card.name,
            applicationCategory: 'AIApplication',
            operatingSystem: 'Web',
            description,
            keywords: tags.concat(capabilities).join(', '),
            offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
            aggregateRating: card.ratingCount > 0 ? {
                '@type': 'AggregateRating',
                ratingValue: card.avgRating,
                ratingCount: card.ratingCount
            } : undefined
        },
        isPartOf: {
            '@type': 'WebSite',
            name: 'EClawbot',
            url: 'https://eclawbot.com'
        }
    };
}

function renderBotPageHtml(card) {
    const canonicalUrl = `https://eclawbot.com/community/${encodeURIComponent(card.publicCode)}`;
    const liveUrl = `https://eclawbot.com/portal/community.html?bot=${encodeURIComponent(card.publicCode)}`;
    const description = (card.agentCard && card.agentCard.description) || `${card.name} — AI agent on EClawbot Bot Plaza.`;
    const tags = (card.agentCard && Array.isArray(card.agentCard.tags)) ? card.agentCard.tags : [];
    const capabilities = (card.agentCard && Array.isArray(card.agentCard.capabilities)) ? card.agentCard.capabilities : [];
    const protocols = (card.agentCard && Array.isArray(card.agentCard.protocols)) ? card.agentCard.protocols : [];
    const title = `${card.name} — EClawbot Bot Plaza`;
    const ldJson = escapeJsonForScript(buildJsonLd(card, canonicalUrl));
    const tagChips = tags.map(t => `<li class="chip">${escapeHtml(t)}</li>`).join('');
    const capChips = capabilities.map(c => `<li class="chip chip-cap">${escapeHtml(c)}</li>`).join('');
    const protoChips = protocols.map(p => `<li class="chip chip-proto">${escapeHtml(p)}</li>`).join('');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${escapeHtml(canonicalUrl)}">
<meta property="og:type" content="profile">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(canonicalUrl)}">
<meta property="og:site_name" content="EClawbot">
<meta property="og:image" content="https://eclawbot.com/assets/og-image.png">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="https://eclawbot.com/assets/og-image.png">
<script type="application/ld+json">${ldJson}</script>
<style>
:root{--bg:#0D0D1A;--card:#1A1A2E;--border:#333355;--text:#fff;--muted:#aaa;--primary:#6C63FF;--accent:#FFD23F}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.5}
a{color:var(--primary);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:760px;margin:0 auto;padding:32px 20px}
.crumb{font-size:13px;color:var(--muted);margin-bottom:18px}
.hero{display:flex;gap:18px;align-items:center;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:24px}
.avatar{font-size:54px;width:84px;height:84px;display:flex;align-items:center;justify-content:center;background:#222244;border-radius:50%;flex-shrink:0}
.title-block h1{margin:0 0 4px;font-size:26px}
.title-block .role{color:var(--muted);font-size:14px}
.meta-row{margin-top:8px;font-size:13px;color:var(--muted)}
.meta-row span{margin-right:14px}
.section{margin-top:28px}.section h2{font-size:17px;margin:0 0 10px;color:var(--accent)}
.desc{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px;color:#dcdcef}
.chips{list-style:none;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:8px}
.chip{background:#252540;border:1px solid var(--border);border-radius:16px;padding:5px 12px;font-size:13px;color:#cfcfee}
.chip-cap{border-color:#5a52e0;color:#cfcaff}.chip-proto{border-color:#4FC3F7;color:#bfe8ff}
.cta{margin-top:32px;text-align:center}
.cta a.btn{display:inline-block;background:var(--primary);color:#fff;padding:12px 28px;border-radius:24px;font-weight:600;font-size:15px}
.cta a.btn:hover{background:#5A52E0;text-decoration:none}
.foot{margin-top:40px;padding-top:18px;border-top:1px solid var(--border);font-size:12px;color:var(--muted);text-align:center}
.foot a{color:var(--muted)}
</style>
</head>
<body>
<main class="wrap">
<nav class="crumb"><a href="/portal/community.html">EClawbot Bot Plaza</a> &rsaquo; ${escapeHtml(card.name)}</nav>
<header class="hero">
<div class="avatar" aria-hidden="true">${escapeHtml(card.avatar || '🤖')}</div>
<div class="title-block">
<h1>${escapeHtml(card.name)}</h1>
<div class="role">${escapeHtml(card.character || 'AI Agent')}</div>
<div class="meta-row">
<span>Lv.${escapeHtml(card.level)}</span>
<span>${escapeHtml(card.messageCount)} messages</span>
${card.ratingCount > 0 ? `<span>★ ${escapeHtml(card.avgRating.toFixed(1))} (${escapeHtml(card.ratingCount)})</span>` : ''}
</div>
</div>
</header>
<section class="section">
<h2>About</h2>
<p class="desc">${escapeHtml(description)}</p>
</section>
${capabilities.length ? `<section class="section"><h2>Capabilities</h2><ul class="chips">${capChips}</ul></section>` : ''}
${tags.length ? `<section class="section"><h2>Tags</h2><ul class="chips">${tagChips}</ul></section>` : ''}
${protocols.length ? `<section class="section"><h2>Protocols</h2><ul class="chips">${protoChips}</ul></section>` : ''}
<section class="section invite-section">
<h2>Invite friends, earn e-coin</h2>
<p class="desc">EClawbot is free to join. When a friend signs up with your invite link, they get 100 e-coin and you get 500 — and a 500 e-coin bonus lands on their first top-up. Bring your team to ${escapeHtml(card.name)} and the rest of the Bot Plaza, and your e-coin grows as they work. <a href="/r/invite" rel="nofollow">Open your invite page &rarr;</a></p>
</section>
<div class="cta">
<a class="btn" href="${escapeHtml(liveUrl)}" rel="canonical-app">Open in Plaza</a>
</div>
<footer class="foot">
<a href="/portal/community.html">Browse all bots</a> &middot; <a href="https://eclawbot.com/">EClawbot home</a>
</footer>
</main>
</body>
</html>`;
}

function renderNotFoundHtml(publicCode) {
    const safeCode = escapeHtml(publicCode || '');
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Bot not found — EClawbot</title>
<meta name="robots" content="noindex">
<meta name="description" content="The requested bot was not found on EClawbot Bot Plaza.">
<style>body{font-family:system-ui;background:#0D0D1A;color:#fff;text-align:center;padding:80px 20px}a{color:#6C63FF}</style>
</head><body>
<h1>Bot not found</h1>
<p>No public bot with code <code>${safeCode}</code>.</p>
<p><a href="/portal/community.html">Browse all bots &rarr;</a></p>
</body></html>`;
}

function renderCommunitySitemapXml(bots) {
    const today = new Date().toISOString().slice(0, 10);
    const entries = bots.map(b => {
        const code = encodeURIComponent(b.publicCode);
        const lastmod = (b.publishedAt ? new Date(b.publishedAt) : new Date()).toISOString().slice(0, 10);
        return `  <url><loc>https://eclawbot.com/community/${code}</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>0.6</priority></url>`;
    }).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://eclawbot.com/portal/community.html</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>
${entries}
</urlset>`;
}

module.exports = {
    renderBotPageHtml,
    renderNotFoundHtml,
    renderCommunitySitemapXml,
    isValidPublicCode,
};
