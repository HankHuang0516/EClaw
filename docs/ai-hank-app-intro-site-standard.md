# AiHankApps introduction-site standard

Every APP listed in the portfolio must receive a dedicated introduction site.

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
