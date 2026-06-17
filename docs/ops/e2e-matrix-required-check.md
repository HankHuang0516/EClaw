# Cross-surface E2E Matrix — required merge check

Card: `card_5ea44479c72edce14ac00a2e` (OODA-R Phase 3 #8 child).

## Goal

Make a failing **Cross-surface E2E Matrix** entry block PR merges into `main`,
without re-introducing the path-filter deadlock that branch protection has on
path-scoped jobs.

## Gate (pre-condition for wiring)

Wire only after the matrix shows **≥3 consecutive green runs on `main`** since the
driver fix landed (`card_5d344fd9`). Verify:

```bash
gh run list --workflow="Cross-surface E2E Matrix" --branch main --limit 3 \
  --json conclusion,headSha,createdAt
```

All three must be `conclusion=success` with no flakes/skips.

Gate status at wire-up (2026-06-16): **MET** — the five most recent `main` runs
were all `success` (`27633167150`, `27632125299`, `27631810047`, `27630106497`,
`27622179712`).

## How the check is enforced (chosen approach)

The matrix job is enforced **through the PR CI Hard Gate aggregator**
(`.github/workflows/pr-ci-hard-gate.yml`), the repo's single required
branch-protection context (`PR CI Hard Gate / Required PR CI gate`).

A new group was added to the hard gate:

```js
{
  label: 'Cross-surface E2E Matrix CI',
  when: path =>
    path.startsWith('backend/public/portal/') ||
    path.startsWith('backend/public/shared/') ||
    path.startsWith('backend/tests/e2e/matrix/') ||
    [
      'backend/shared/route-registry.js',
      'backend/redirect-router.js',
      '.github/workflows/e2e-matrix-ci.yml'
    ].includes(path),
  checks: ['matrix']
}
```

The `when` predicate mirrors the path filter in `e2e-matrix-ci.yml`, so:

- PRs that touch matrix-covered paths → hard gate waits for `matrix`, fails the
  PR if `matrix` fails or is missing.
- PRs that do **not** touch those paths → matrix workflow is correctly skipped,
  the hard gate does not expect it, and the PR is not blocked.

This preserves the documented anti-deadlock policy in `CONTRIBUTING.md`
("CI Requirements"): only `PR CI Hard Gate / Required PR CI gate` is a direct
branch-protection context; path-scoped jobs stay enforced *through* the gate.

The matrix workflow's PR/push path filters were also extended to include
`.github/workflows/pr-ci-hard-gate.yml`, so changes to the gate logic re-run the
matrix and stay self-validating.

## Why not add `Cross-surface E2E Matrix / matrix` directly to branch protection

`e2e-matrix-ci.yml` is path-filtered. A path-filtered job added directly to
`required_status_checks.contexts` never reports a status on PRs that don't touch
its paths, and GitHub then blocks those PRs forever ("Expected — Waiting for
status to be reported"). The hard-gate aggregator exists specifically to avoid
this; routing the matrix through it is the correct fit.

## Alternative: direct branch-protection wiring (only if the gate approach is rejected)

If a maintainer explicitly wants the matrix as its own direct required context
(accepting the deadlock caveat — every PR would then need to touch a
matrix-covered path or be force-merged), apply the PATCH below. It re-asserts the
full required-checks set (GitHub replaces the array wholesale, so the existing
hard-gate context must be included).

```bash
# Current required contexts (read first):
gh api repos/HankHuang0516/EClaw/branches/main/protection/required_status_checks \
  --jq '.contexts'

# PATCH adding the matrix context alongside the existing hard gate.
# strict=false matches current setting; preserve the rest of protection.
gh api -X PATCH repos/HankHuang0516/EClaw/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": false,
    "contexts": [
      "PR CI Hard Gate / Required PR CI gate",
      "Cross-surface E2E Matrix / matrix"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 1
  },
  "restrictions": null
}
JSON
```

The status-check **context** name is `Cross-surface E2E Matrix / matrix`
(`<workflow name> / <job name>`); the underlying check-run name is `matrix`.

## Failing-PR unblock instructions (? icon / PR checks tab)

When a PR is blocked by a matrix failure, the hard gate reports
`Required CI failed: matrix (failure) <url>`. To unblock:

1. Read the job logs at the `<url>` shown (Actions → "Cross-surface E2E Matrix"
   → the run on your PR head SHA).
2. Reproduce locally:

   ```bash
   cd backend/tests/e2e/matrix
   MATRIX_TEST_DEVICE_ID=YOUR_DEVICE_ID MATRIX_TEST_DEVICE_SECRET=YOUR_BOT_SECRET \
     node run-matrix.js
   ```

3. Fix the failing flow and push. The matrix re-runs; the hard gate unblocks once
   it is green.

## Validation

The PR that introduces this change touches `.github/workflows/pr-ci-hard-gate.yml`
(a matrix-covered path), so the matrix workflow runs on the PR and the hard gate
waits for it — demonstrating the check is enforced. A subsequent intentional
driver break on a temp branch (then reverted) demonstrates the block path.
