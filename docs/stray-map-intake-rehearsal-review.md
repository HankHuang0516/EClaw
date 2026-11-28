# Synthetic Stray Map intake review — 2026-11-26

The previous draft could only evaluate an in-memory payload. Draft v2 plus the standalone loopback rehearsal now exercise scheduled anonymous fixture JSON reads, HTTP acceptance, durable immutable receipts, private review and an anonymous coarse public projection. No production route, scheduler, source credentials or map write is installed.

- A1 ✅ Logic: exact input/policy/precision/region/text/photo validation precedes acceptance; source record identity is distinct from retry identity and candidate groups. fsync + atomic snapshot/directory sync precede receipt delivery. Explicit supervisor review is the only publication path; withdrawal/rejection and sensitive wildlife remain hidden.
- A2 ✅ Tests: 259 passing tests across the v2 contract, HTTP/store/scheduler rehearsal and existing Stray Map Hub suite, using `--forceExit=false --detectOpenHandles`; no open handles. The original CLI records two processes and stable v2 receipts; the case CLI records three processes, four independent v3 receipts, two private manual suggestions and one direct-sighting eligibility signal without any map write. The image suite exercises actual self-generated PNG/JPEG/WebP bytes and locked sharp; grants and semantic safety remain synthetic/unverified.
- A3 ✅ Returns: success/machine-code convention; protocol-specific 413/415/429/503 documented. Original pending receipt is immutable, while receipt lookup reports current review separately. Local wrappers are not official API responses.
- A4 ⚠️ Open: complete verified Stray Map build source, a dedicated official pending intake, production authentication/abuse/queue/store controls, true image bytes/author rights/privacy review, terms approval and actual release/production acceptance. No crash/power-loss or multi-worker recovery guarantee; stale locks fail closed.
- A5 ✅ Security: only synthetic publishers/identities and module-created loopback origins, no arbitrary local tunnel, no production imports/device impersonation/remote photo fetch. Mandatory safety review and NEVER-sensitive projection; private source/evidence keys are absent from public data. Bounded byte/image/rate/storage limits, persisted poll slots, parallel replay and response loss/body interruption are exercised.
- B1 ⚠️ `/api/help` NO-OP: standalone synthetic test routes; no official endpoint.
- B2 ✅ README, AGENTS, CLAUDE, draft documentation and OpenAPI updated together.
- B3 ⚠️ Product i18n NO-OP: no UI changes; original en-US/zh-TW title/description/photo caption and actual time precision are preserved and tested.
- B4 ⚠️ Product info page NO-OP: no shipped feature or promotion claim.
- B5 ⚠️ Production debug endpoint NO-OP: no production state installed; private rehearsal evidence stays on disk.

Independent review reproduced three defects: cross-zone day ordering, midnight date rollback and receipt-body transport loss. The implementation now compares the extents of IANA date intervals, including disjoint midnight rollback segments without changing DATE payloads, and retries a lost/unusable successful acknowledgement once with the same key/body. Regressions cover both cases. Simplify was not run and is optional. H/icon review is not applicable: this change produces no icon, product UI or released application/website artifact.

Result: reviewable synthetic implementation; official intake remains disabled. No merge or production deployment is implied by local verification.

## Case and byte extension review

V3 reports preserve v2 canonical hashes and receipts while separating report type, health, last-known/found/observed location and care-asOf. Private unscored lost/found suggestions never merge receipts or infer reunion. Source closure affects only the original case; authoritative absence, temporary failure and recovery keep different availability states and do not rewrite observation/care times. Effective visibility is computed independently of historical approval.

Independent review found the source-event-capacity edge case: when capacity prevents recording freshness/closure, the old PRESENT projection could remain visible. Publication now fails closed with 503/no items based on the persisted count, including after restart; receipt replay remains available. The targeted independent regression passed.

Actual image testing covers PNG/JPEG/WebP decoding, original-byte/case/right binding, malformed/MIME/size refusals and EXIF/GPS/XMP/ICC removal, with private SANITIZED_PRIVATE output. No real photos, semantic image safety, copyright authenticity, native uploader or official API acceptance is claimed. The case CLI adds receive/lifecycle/verify child-process milestones. Backend CI's preview condition now excludes draft PRs; quality checks remain unchanged. No new credentials, terms, production data, provider contact or patrol changes.

A1–A5 trace/coverage/envelopes/limitations/security were checked for the added paths; B1 help, B3 product UI/i18n, B4 info and B5 production debug remain NO-OP because no product route/UI is installed. B2 README/AGENTS/CLAUDE/OpenAPI and isolated image documentation are synchronized. H remains not applicable to self-made QA pixels or standalone tools.
