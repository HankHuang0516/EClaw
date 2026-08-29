# AiHankApps introduction-site standard

Every APP listed in the portfolio must receive a dedicated introduction site.

## Content preservation

- Standardizing an introduction page must merge the existing material into the new presentation; it must never replace a complete guide with a shorter generic summary.
- Original workflows, safety guidance, FAQs, feature explanations, screenshots, and support details remain part of the APP record unless the product itself makes them inaccurate.
- Pages with recovered long-form material are protected by `scripts/check-ai-hank-intro-sites.mjs`. Removing a protected section requires an intentional update to both the page and its preservation markers.

## Presentation rules

- The portfolio card keeps the icon, short description, store buttons, status, likes, comments, and a top-right introduction link.
- Once an introduction URL exists, store promotional screenshots move to that introduction site and are omitted from the portfolio card.
- Introduction sites use one persistent top toolbar containing the APP title, section shortcuts, Google Play, and App Store links.
- Store images must retain their original aspect ratio and must not be cropped.

## Subpath safety

- A site hosted below `/AiHankApps/.../` must use relative asset URLs such as `./assets/app.png`.
- Root-relative `/assets/...` URLs are prohibited because they resolve against `https://eclawbot.com/assets/` instead of the introduction-site directory.
- Run `node scripts/check-ai-hank-intro-sites.mjs` before publishing.
- After production deployment, verify the page and every referenced local asset return HTTP 200.


## Persistent header: three required elements

Every APP introduction or strategy page must keep a polished header visible at the top. It is incomplete unless all three elements are present together:

1. The APP title.
2. Quick navigation links to the page's main sections.
3. Google Play and App Store download actions.

A published or release-ready platform must link to its real store page. A platform still in development must show a disabled development state and must not use a fake store link.

## Static asset cache versioning

Cloudflare serves `/AiHankApps` static assets with a seven-day immutable cache. Whenever a shared CSS or JavaScript file changes, every HTML reference to that asset must also change by adding or updating a version query such as `?v=<release-id>`. A deployment is not complete until the production HTML points at the new versioned URL and the returned asset contains the expected release marker. This prevents successfully deployed HTML from executing a stale toolbar or community script.
