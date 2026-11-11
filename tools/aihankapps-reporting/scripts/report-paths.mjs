// Where the reporting pipeline reads and writes.
//
// The defaults are the original authoring setup (app-showcase-site). That project was lost with the old external
// drive (Hank, 2026-11-11: 「舊硬碟已經丟棄沒辦法挽救」), so the daily report runner points these at an EClaw
// checkout and the private analytics store through environment variables instead.
import { join } from 'node:path';

const env = process.env;
export const ROOT = env.AIHANKAPPS_ANALYTICS_ROOT || '/Users/hank/.local/share/AiHankApps/analytics';
export const SOURCE = env.AIHANKAPPS_REPORT_SOURCE || '/Users/hank/Desktop/Project/app-showcase-site';
export const CATALOG = env.AIHANKAPPS_REPORT_CATALOG || join(SOURCE, 'app-catalog.json');
export const VIEW = env.AIHANKAPPS_REPORT_VIEW || join(SOURCE, 'reports/report-view.mjs');
export const INDEX = env.AIHANKAPPS_REPORT_INDEX || join(SOURCE, 'reports/index.html');
export const PUBLIC = env.AIHANKAPPS_REPORT_PUBLIC || join(SOURCE, 'public');
export const TARGETS = env.AIHANKAPPS_REPORT_TARGETS
  ? env.AIHANKAPPS_REPORT_TARGETS.split(':').filter(Boolean)
  : [join(SOURCE, 'reports'), join(SOURCE, 'public/reports'), '/Users/hank/Desktop/Project/EClaw-ai-hank-apps-route/backend/public/AiHankApps/reports'];
// 'published': build against the portfolio's published catalog exactly as it is, without a same-day store catalog
// sync. The old sync overwrote curated names, guides and H-watermarked icons, so it is not part of the daily path.
export const CATALOG_MODE = env.AIHANKAPPS_REPORT_CATALOG_MODE === 'published' ? 'published' : 'synced';
export const PLAYWRIGHT_FROM = env.AIHANKAPPS_PLAYWRIGHT_FROM || '/Users/hank/Desktop/Project/EClaw-ai-hank-apps-route/backend/package.json';
