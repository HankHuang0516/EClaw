# Isolated synthetic image-bytes rehearsal

This extension verifies actual image decoding, metadata removal, rights-context binding and resource limits inside the existing EClaw repository. It is independent of the evolving tip/case contract and receipt store. It does not register a route, accept external image URLs, open input photograph paths, upload media, activate a source or contact production. Its output state is `SANITIZED_PRIVATE`, with `publicVisible: false` and `semanticSafetyReviewed: false`.

## Tools and dependency provenance

The run used existing repository dependencies; no package, lockfile, system codec or Python dependency was installed or changed.

| Component | Actually exercised version | Source |
| --- | --- | --- |
| Node.js | 25.8.1 | Existing local Node executable |
| Jest | 29.7.0 | Existing `backend/node_modules/jest` |
| sharp | 0.35.1 | Declared in `backend/package.json`, exactly resolved by `backend/package-lock.json` |
| libvips | 8.18.3 | Existing sharp native bundle |
| libpng | 1.6.58 | `sharp.versions.png` |
| mozjpeg | `0826579` | `sharp.versions.mozjpeg` |
| libwebp | 1.6.0 | `sharp.versions.webp` |

The locked sharp package comes from `https://registry.npmjs.org/sharp/-/sharp-0.35.1.tgz`; the inspected local native platform bundle is the already-installed Darwin ARM64 package. The module resolves sharp through the backend dependency tree, rather than an independently installed global copy. `dependencyInfo()` records actual runtime and lockfile versions in each private run report. A different encoder/platform may generate different encoded hashes; source pixels and the verification procedure remain reproducible. Other Node/platform combinations are not claimed as exercised by this local run.

## Reproduce

Run from the existing EClaw worktree root. No install command is needed:

```sh
node backend/node_modules/jest/bin/jest.js --config backend/jest.config.js --runInBand --no-cache --runTestsByPath backend/tests/jest/stray-map-intake-image-bytes.test.js
```

Generate a fresh private evidence run:

```sh
node tools/stray-map-intake/image-rehearsal.run.js /Volumes/ProjectsData/portfolio-private-staging/20261126-stray-map-case-image-extension
```

The only CLI argument is an absolute **output** evidence directory. Each invocation creates a new `image-bytes-<UUID>` subdirectory and uses exclusive file creation; existing runs are retained. The base must be a real private directory with no group/other permissions. Run directories use mode `0700`; fixture bytes, synthetic grants and reports use `0600`. No input filename or input URL is supported. Failure to load the existing codec fails the run; there is no mocked-codec or skipped-byte fallback.

## Actual fixtures and acceptance boundary

`image-rehearsal.js` generates deterministic 128×96 RGB pixels using coordinate arithmetic. No photograph, animal, face, plate, logo, generative image or third-party sample is used. PNG, JPEG and lossless WebP are encoded locally with:

- EXIF description/artist containing `SYNTHETIC_IMAGE_METADATA_ONLY`;
- a real TIFF GPS IFD containing invented 0/0 coordinates, not a sighting;
- synthetic XMP and an sRGB ICC profile;
- a PNG `tEXt` chunk or JPEG COM segment where applicable.

The input proof reads the GPS IFD tag structure, not merely a matching string. PNG supplies raw TIFF EXIF while JPEG/WebP may supply the `Exif\0\0` prefix; both are inspected. Fixtures are also decoded into actual pixels before claiming input validity.

Sanitization checks byte and container bounds, verifies declared MIME against both signature and the decoder, uses `failOn: 'warning'`, fully decodes, applies EXIF orientation and re-encodes to PNG. The sanitizer never calls metadata-retention methods. The output is inspected and decoded again. Tests assert that EXIF/GPS/XMP/ICC and the synthetic metadata marker are gone and that the output pixels equal the input's already-decoded/oriented pixels. JPEG is lossy at fixture creation; comparison is against its decoded pixels, not an assertion that JPEG compression is lossless. The orientation-6 fixture additionally verifies the expected 96×128 output without an orientation tag.

IPTC is absent in these fixtures. The output guard checks for it, but this run does **not** claim an exercised IPTC-removal fixture. EXIF/GPS/XMP/ICC, PNG text and JPEG comment removal were exercised.

## Rights and case binding

This is a synthetic server-owned grant model, not a claim that a real author granted permission. Each grant binds:

1. Synthetic case ID, publisher, dataset, record key and nullable source URL.
2. An allowed licence, synthetic evidence reference, synthetic attribution reference and explicit permission to redact/re-encode.
3. The SHA-256 of the exact original bytes.

The synthetic source URL is only a context string under `.example.invalid`; it is never fetched. Changing the case/source identity, evidence or bytes invalidates the grant. A set cannot mix case contexts. Result bindings retain context/rights digests and the original/sanitized byte hashes. These are integrity hashes of newly generated local fixtures, not cloud-backup verification.

Allowed synthetic licences are `EXPLICIT_PERMISSION`, `CC_BY_4_0` and `CC0_1_0`, and every one still requires a matching verified synthetic grant. Public visibility, an unknown licence or `CC_BY_NC_4_0` is not accepted as permission. No public attribution renderer or real rights-verification service is implemented here.

## Limits and rejection checks

| Bound | Default |
| --- | --- |
| Images per set | 2 |
| Original and sanitized bytes per image | 5 MiB |
| Combined original and sanitized bytes per set | 8 MiB each |
| Decoded pixels | 16,000,000 |
| Either dimension | 8,192 |

Overrides can only tighten these limits. Tests use real byte counts/dimensions and smaller caps for inexpensive boundary coverage, including an actual 8,193×1 PNG. No 16-megapixel stress benchmark or maximum-resident-memory guarantee is claimed.

Rejections cover missing rights, unsupported licences, wrong declared MIME, forged signatures, truncated containers, a JPEG whose header is readable but scan cannot decode, PNG CRC corruption, trailing payloads, size/pixel/dimension/output-expansion limits, mixed case grants, changed bytes and URL/path inputs. A valid header alone never earns a successful result.

## Measured validation

The completed local validation of this extension passed **52 Jest tests in one suite**. The independent evidence runner passed **3 actual input formats and 14 named rejection cases**. These counts describe separate checks, not 69 independent Jest tests. ESLint passed for both new implementation files. The adjacent tip/case/receipt suites are owned by the main change and are not counted as rerun by this sidecar.

Private evidence is under `/Volumes/ProjectsData/portfolio-private-staging/20261126-stray-map-case-image-extension/`:

- `image-bytes-jest.private.json`: actual Jest result and assertion names;
- `image-bytes-<UUID>/`: original synthetic bytes, sanitized bytes, synthetic grants and `image-bytes-result.private.json` with actual versions, before/after metadata and hashes;
- `IMAGE_BYTES_VALIDATION.private.json` and `CODE_REVIEW.private.txt`: scoped validation and the A/B review.

## Scope and checklist

This verifies codec behavior and bounded metadata handling, not face/plate detection, semantic content safety, sensitive-location recognition, human moderation, author permission, licence authenticity, production receipt persistence or uploader integration. Sanitized bytes remain private. It does not produce `VERIFIED_SAFE` uploads for the main contract. The formal Stray Map source/API/terms/credential/release gates remain unchanged.

- A1: rights/context/bytes gate → container/MIME/limits → full decode/re-encode → output metadata/limits → private result; every rejection returns no sanitized image.
- A2: the dedicated Jest file uses the repository's `helpers/mock-setup.js`, with the actual native codec and generated fixtures. No DB schema/query is involved.
- A3: local success uses `success: true`; rejected inputs use `success: false`, a machine-readable error and status. No HTTP response contract is introduced.
- A4: the limitations immediately above remain open and are not represented as completed.
- A5: no network/input-file API; exact typed synthetic contexts, rights and byte binding; bounded resources; safe error codes; private evidence permissions.
- B1: `/api/help` NO-OP — no REST endpoint or deployed route.
- B2: this document describes the new isolated surface; no existing product/API surface is changed or newly connected.
- B3: i18n NO-OP — developer-only local test/report codes, no product UI strings.
- B4: Info page NO-OP — no end-user feature or promotional asset.
- B5: Debug endpoint NO-OP — standalone rehearsal not imported by the backend; private CLI reports provide its diagnostics without exposing a server namespace.

H/icon review is **not applicable**: these synthetic QA pixels are not product icons or assets. No commit, push, deployment, production request, credential change or patrol/schedule change is part of this extension.
