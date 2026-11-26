# Isolated runtime-subset build preparation

This tool prepares a private reconstruction from the already acquired, individually checked runtime subset. It is **not original source restoration**, a recovered original root lock, a signed baseline, or proof of production equivalence. `signed: none`. No deployment artifact is produced or uploaded. Source servers, migrations, seed scripts and source tests are never executed by this preparer.

The authorized evidence root is `/Volumes/ProjectsData/portfolio-private-staging/20261126-stray-map-isolated-rebuild/`. Generated source, dependency archives, npm cache, logs, build patches and result files stay there. Only the preparation program and this document belong in Git. Do not copy private runtime captures, legal documents or generated workspace into public Git.

## Inputs and evidence boundaries

- `baseline/`: 54 files, each checked against `BASELINE_MANIFEST.private.json`. The manifest is unsigned. The API `tsconfig.json`, all API/contracts source, migrations and legal/content files are copied byte-for-byte. Only the three package manifests are rewritten in the workspace; originals stay in `baseline/`.
- `runtime-capture.private.json`: captured Node `v22.23.3`, npm `10.9.9`, Linux x64 and 199 installed package metadata entries. This is an observed installed tree, not a statement about the original development install or original lock.
- `runtime-hidden-lock.raw.private.json`: sanitized `/app/node_modules/.package-lock.json`. Public funding/homepage/repository/bugs metadata is omitted. Registry tarball URLs and integrity values are retained; other remote URLs or credential fields fail capture. The adjacent capture metadata records original and sanitized SHA256, removal count, source path and unsigned status. This is a **runtime hidden lock, not an original root lock**.
- The initial rejected capture receipt only records the conservative URL-filter rejection and contains no lock payload. The successful receipt is `runtime-hidden-lock.sanitized.private.json`.

## Reproduction

Run from the existing EClaw worktree. First verify the external storage identity and the specific additional-space budget (2 GiB for this run; retain the separate 20 GiB system reserve):

```sh
python3 /Volumes/ProjectsData/check_storage.py
/Users/hank/.local/bin/project-storage check --required-gib 2
```

If a new capture is expressly authorized and the evidence destinations do not already exist, the optional read-only acquisition command is:

```sh
node tools/stray-map-rebuild/prepare-runtime-lock.js /Volumes/ProjectsData/portfolio-private-staging/20261126-stray-map-isolated-rebuild
```

It uses the existing authenticated Railway CLI transport and fixed project/environment/service identifiers. It reads only `/app/node_modules/.package-lock.json`; no environment/variable/DB operation is issued. Evidence destinations are exclusive. Ordinary reproduction reuses the captured evidence and does not contact Railway.

On a fresh authorized private root containing the input evidence (no existing `workspace/`), run each phase **to completion in order**, or use `all`:

```sh
node tools/stray-map-rebuild/prepare.js /Volumes/ProjectsData/portfolio-private-staging/20261126-stray-map-isolated-rebuild all
```

The phase sequence is `toolchain`, `workspace`, `install`, `fresh-primary`, `codec`, `build`, `ci`, `verify`. An individual failed phase can be rerun by replacing `all` with that phase. The workspace phase refuses an existing workspace and never resets it. Do not invoke phases concurrently. `fresh-primary` replaces only dependencies in the private primary workspace; it must finish before handing that workspace to another task. Subsequent `ci` uses an exclusively created `workspace-ci/` and never deletes or rewrites the primary workspace.

## Newly selected build configuration

- Download `https://nodejs.org/dist/v22.23.3/node-v22.23.3-<host-platform>-<host-arch>.tar.gz`; verify against the official HTTPS `SHASUMS256.txt`. The local run uses Darwin arm64, unlike the observed Linux x64 production runtime. SHASUM matching is recorded; no signature verification is claimed. Bundled npm must equal `10.9.9`.
- Root workspaces are exactly `apps/api` and `packages/contracts`. Root Expo/React/React Native and mobile workspaces are omitted because their source is unavailable. API's captured production `expo-server-sdk` remains an API dependency; no Expo mobile app dependency is installed.
- Direct API/contracts production dependencies are pinned to observed installed versions. Runtime dependency edges become version-specific overrides. The sanitized runtime hidden lock seeds a **new reconstruction lock**; npm resolves the selected development tools and host-specific optional native packages. The resulting lock is preserved and compared during `ci`.
- The Linux hidden lock omitted Darwin sharp tarballs even though sharp's manifest declared them. For the Darwin arm64 reconstruction the API manifest explicitly adds optional `@img/sharp-darwin-arm64: 0.35.4` and `@img/sharp-libvips-darwin-arm64: 1.3.3`, using the captured sharp 0.35.4 declaration. These are **new host-platform selections**, not observed Linux installed dependencies. Registry integrity values are added to the new lock. The `codec` phase requires the actual sharp module and encodes/decodes synthetic 3×2 PNG pixels; lifecycle scripts stay disabled.
- Newly selected development versions: TypeScript 5.9.2, tsx 4.20.5, Vitest 3.2.4, `@types/node` 24.3.0, `@types/nodemailer` 8.0.1, `@types/pg` 8.15.5. They are exact versions selected from declared minima, **not claimed original exact dev resolutions**. Runtime metadata separately observes TypeScript 5.9.3 and `@types/node` 24.13.3 in its installed tree.
- Root `tsconfig.base.json` is marked `REWRITTEN_UNKNOWN_ORIGINAL`; its original contents are unknown. It selects ES2022, strict checking, interop, Node types, no emit on errors and skipLibCheck. API's verified `tsconfig.json` is unchanged.
- Contracts are first compiled to JS/declarations using their verified config plus explicit CLI overrides for emit, NodeNext module/resolution, rootDir and outDir. The workspace contracts manifest's `main`/`types` point to those outputs. This creates a separate package boundary for API's verified `rootDir: src`; it is a documented reconstruction manifest patch, not an original build claim.

## Install/build isolation and results

Each npm/tsc child gets an allowlisted environment, private empty HOME/TMP/cache, `--userconfig=/dev/null`, a distinct empty global npm config and public `https://registry.npmjs.org/`. No host npm config, registry token, proxy credentials, NODE_OPTIONS, DB URL or source secrets are inherited. npm 10 refuses using `/dev/null` for both user and global config, hence the separate empty global file. Dependency lifecycle scripts, audit/fund and update checks are disabled.

`install` resolves a new lock using `npm install --ignore-scripts`; `fresh-primary` then performs a clean `npm ci --ignore-scripts` from that lock. `codec` exercises the actual host codec without starting API source. `build` explicitly runs only the generated contract/API compiler scripts, resolving TypeScript 5.9.2 in their own workspaces. `ci` copies checked baseline source, rewritten manifests/config and the new lock to a separate `workspace-ci/`, performs another `npm ci --ignore-scripts`, verifies its codec, builds fresh outputs, and compares all emitted file SHA256s plus the lock SHA256. It never removes primary workspace dependencies or outputs after handoff. The private result records actual commands/stages; a failed stage is never marked successful. Production package versions and integrity retention are reported separately from host-specific native omissions/additions, optional runtime entries omitted by clean host npm and newly selected development tools. Omitted optional entries are reported explicitly, not silently treated as identical.

Primary output: `PREPARE_RESULT.private.json`. Supporting evidence: `DEPENDENCY_SELECTION.private.json`, `PRODUCTION_DEPENDENCY_COMPARISON.private.json`, `FIRST_BUILD_OUTPUTS.private.json`, `build-patches/`, stage logs, captured lock receipts and official toolchain sums.

Synthetic helper boundary checks (no network or application code) and lint:

```sh
node tools/stray-map-rebuild/prepare-check.js
node backend/node_modules/eslint/bin/eslint.js --config backend/eslint.config.js tools/stray-map-rebuild/prepare.js tools/stray-map-rebuild/prepare-lock.js tools/stray-map-rebuild/prepare-runtime-lock.js tools/stray-map-rebuild/prepare-check.js
```

The boundary checker contains 10 assertions covering credential/non-registry URL rejection, allowed registry URLs, public metadata removal without falsely rejecting the package name `token-types`, and nearest-parent dependency resolution. These checks are separate from actual install/build/codec/reproducibility evidence and do not constitute source runtime integration tests.

## Actual acceptance for this reconstruction

- Node 22.23.3 / npm 10.9.9 on Darwin arm64; official Node archive SHA256 matched, signature verification **not performed** (`signed: none`). Actual compiler resolution in both workspaces: TypeScript 5.9.2.
- Fresh registry install → clean primary `npm ci --ignore-scripts` → actual sharp 0.35.4 / libvips 8.18.6 synthetic PNG roundtrip → contracts/API `tsc` passed. A second newly created `workspace-ci/` independently completed clean `npm ci`, the same codec check and both builds.
- **31 emitted files** have identical SHA256s between the two clean installs; new lock SHA256 was unchanged: `60dc39726435c0ee7f4d80e2318c3d3c457109b7d263026303218a9d9e41974d`. This is build reproducibility under the newly selected configuration on the current host, not original-runtime binary equivalence.
- Baseline: 54 files checked; 51 remain byte-identical in the workspace. The three rewritten package manifests have saved diffs; the new root base config is saved separately with `REWRITTEN_UNKNOWN_ORIGINAL`. API/contracts source, verified tsconfigs, migrations and legal/content remain unchanged.
- Installed runtime comparison: **192/199 same path/name/version; 0 unexpected version mismatches or unexplained missing entries**. The seven explicit differences are three Linux native packages omitted on Darwin (`@img/sharp-linux-x64`, `@img/sharp-libvips-linux-x64`, `lightningcss-linux-x64-gnu`), three originally optional entries omitted by clean host npm (`@img/sharp-wasm32`, `@emnapi/runtime`, `tslib`), and runtime devOptional TypeScript 5.9.3 replaced by the newly selected workspace TypeScript 5.9.2. These are not counted as matches. The new lock retains **195** observed version/integrity pairs, including locked non-host optional entries; this count is lock retention, not installed-package equality. The detailed report lists 56 new installed path entries, comprising selected development dependencies and host adaptations, rather than claiming an identical tree.
- Boundary checks: **10 passed**; lint: **4 preparer JavaScript files passed**. Install emits an actual `EBADENGINE` warning for nsfwjs 4.4.0's exact Node 22.13.0 declaration, while both observed runtime and this build use 22.23.3. No engine declaration was altered. Model loading/inference and source API behavior are outside this preparer's validation.
- Primary workspace is stable after its final codec/build validation; all later ci work used the second workspace. No source server, live DB, credentials, Keychain, deployment, source terms change, production pins or support contact were used by this preparer.

## Review checklist

A1: trace input hash validation, exclusive workspace creation, safe public downloads, install/build/ci and failure persistence. A2: use actual fresh-install/compiler/ci evidence, not a mocked successful build. A3: CLI stage JSON intentionally differs from application REST responses. A4: full original source/root lock/base configuration, signed provenance, Linux runtime equivalence, source runtime safety and official third-party intake integration remain outside this preparer. A5: no production start/write, credentials, Keychain, arbitrary remote fetch, migrations, seed scripts or deployment.

B1 `/api/help`: NO-OP, no application endpoint. B2: this document defines the preparer and provenance boundaries. B3 i18n: NO-OP, development-only tooling/JSON. B4 info page: NO-OP, no product feature published. B5 debug endpoint: NO-OP, isolated build tool, private result files only. H/icon: not applicable; no product assets or release changed.
