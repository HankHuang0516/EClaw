# Offline Demo map response adaptation review

This narrow change replaces the existing external tile initialization with an original inline schematic. It adds no dependency, upload, share, permission, endpoint or database mutation. It preserves the original map selection callbacks and retains a visible Chinese notice that the image is a flow illustration, not a pickup location.

The previously authorized manual reuse/quality/efficiency review is used; `simplify` is unavailable and was not run. Reuse: the existing Leaflet library, capability query, generic 404 and headers remain the boundaries. Quality: an exact original-script hash and one-match patch guards prevent unintended source edits. Efficiency: one small deterministic response transformation is limited to `map.js`; the SVG requires no fetch or timer. Access: transformation happens only after the live capability query. No database assets or bundle digest change.

## Ten-item review

- A1. Logic trace: live resource lookup precedes the `map.js` adapter; source/marker mismatch reaches the existing generic 404. Other files are sent unchanged.
- A2. Test coverage: 16 focused sharing/adapter tests pass, including disposable PostgreSQL concurrency/rollback/persistence and synthetic offline map execution, selection, source guards, resource permissions and headers.
- A3. Return shape: existing management JSON contracts stay intact; the existing public resource contract remains bytes on success or plain 404 on denial.
- A4. Remaining scope: the SVG is an illustration and supplies no real-world navigation or pickup location; original product facts, orders, sharing and management flows are outside this change.
- A5. Security: no new mutation or credentials; unchanged token/expiry/revocation gate; unknown script hash fails closed; SVG is fixed original artwork without user input or external network references.
- B1. `/api/help`: NO-OP — no new endpoint or management response shape.
- B2. Related docs: README, sharing spec and baseline review clarify original storage versus one runtime adaptation; no instruction or memory files change.
- B3. i18n: scoped Chinese-only original Demo; the requested notice remains exactly `離線流程示意圖／非實際取貨點`. No locale feature or change to the workspace's shared translations.
- B4. Info/promo: NO-OP — private capability Demo is excluded from the public homepage and sitemap; no public marketing surface gains a feature.
- B5. Debug: NO-OP — no new stored state; existing gated share counts remain sufficient. Adapter version/hash are non-secret code constants.

`Cache-Control: no-transform` prevents Cloudflare's email-obfuscation rewrite according to its [official notes](https://developers.cloudflare.com/waf/tools/scrape-shield/email-address-obfuscation/). The existing browser/CDN no-store and no-referrer policy is retained. The map no longer requires an external image host in CSP.

Result: local checks pass; normal required PR CI and owner release review remain required. No merge or deployment is performed by this review.
