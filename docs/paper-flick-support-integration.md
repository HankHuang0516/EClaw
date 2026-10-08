# Paper Flick Soldiers support integration

The canonical introduction and video QR target remains
`/AiHankApps/guides/paper-flick-soldiers/`. Official support now lives in that
page at `#support`, with contact and troubleshooting, FAQ, privacy and optional
private Beta feedback disclosure, App Review instructions, and the existing
review video.

The former `/AiHankApps/support/paper-flick-soldiers/` contains only a
compatibility redirect and a fallback link. JavaScript uses `location.replace`
to avoid a Back-button redirect loop and preserves query parameters, including
`?lang=en`, plus recognized support anchors. A meta refresh works without
JavaScript. The old video asset URL remains available, so previous review links
still work. Neither store download URL changes.

Support prose is explicitly bilingual Traditional Chinese and English. New
headings use the site's existing i18n system; the preexisting introduction is
still Traditional Chinese. There is no full-page language selector suggesting
the entire introduction has been translated. No player feedback records are
embedded or requested by this public page.

The old fixed release/build badges were removed because they were stale. The
review video is explicitly labeled as footage from version 1.0.0; current public
releases are linked to the stores. Crashlytics installation identifiers and the
Beta form's lack of device identifiers are described separately.

Local regression coverage: all 9 tests in
`paper-flick-support-integration.test.js` passed. They verify
redirect targets and query/anchor retention, the canonical/store links, no-JS
fallback, privacy and video availability (a bounded range request), and that
the public page does not fetch private feedback. Fresh Chrome verification
passed at 390px and 1280px without document horizontal overflow, including FAQ
Space/Enter operation, native anchor navigation, Back/Forward without redirect
loops, explicit `?lang=en` and `?lang=zh` heading rendering, and the
no-JavaScript redirect. Browser sessions used a temporary localhost server and
no personal browser profile. No production data was read or written.

Before committing, complete the repository UI/UX reuse, quality and efficiency review and i18n
checks, including shared web and mobile keys. Publishing requires the current
feature's PR/CI/review and production validation; previous introduction-page
exceptions do not authorize this integration's publication.

The owner explicitly approved this round's manual review and website publication on 2026-10-07 and requested removal of the mandatory simplify/Claude Code login dependency. Project instructions now require documented code review and applicable tests, retaining PR/CI, security and production verification.
