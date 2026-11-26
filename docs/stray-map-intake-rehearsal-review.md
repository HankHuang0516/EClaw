# Synthetic Stray Map intake review — 2026-11-26

The previous draft could only evaluate an in-memory payload. Draft v2 plus the standalone loopback rehearsal now exercise scheduled anonymous fixture JSON reads, HTTP acceptance, durable immutable receipts, private review and an anonymous coarse public projection. No production route, scheduler, source credentials or map write is installed.

- A1 ✅ Logic: exact input/policy/precision/region/text/photo validation precedes acceptance; source record identity is distinct from retry identity and candidate groups. fsync + atomic snapshot/directory sync precede receipt delivery. Explicit supervisor review is the only publication path; withdrawal/rejection and sensitive wildlife remain hidden.
- A2 ✅ Tests: 150 passing tests across the v2 contract, HTTP/store/scheduler rehearsal and existing Stray Map Hub suite, using `--forceExit=false --detectOpenHandles`; no open handles. The CLI additionally records two distinct processes, five stable receipts, three approved ordinary cases and two public cases after withdrawal. Photo metadata/rights flags are synthetic, not real image processing evidence.
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
