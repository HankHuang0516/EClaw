# Contributing to EClawbot

EClawbot uses a PR-first workflow. Do not push directly to `main`; open a feature branch, run the relevant local checks, and let GitHub Actions complete before merge.

## Pull Request Flow

1. Create a branch from current `main`.
2. Keep the change focused and avoid unrelated formatting churn.
3. Run the local checks that match the files you touched.
4. Open a PR into `main`.
5. Complete the self-review checklist in [`docs/code-review-checklist.md`](docs/code-review-checklist.md).
6. Wait for `PR CI Hard Gate / Required PR CI gate` to pass before merge.

The hard gate is the single branch-protection status that should be required. It runs on every PR and waits for the path-scoped CI jobs that apply to the changed files. If an expected workflow is missing, skipped by mistake, cancelled, or failing, the hard gate fails.

## Local Checks

Backend changes:

```bash
cd backend
npm run lint
npm test
```

Portal or shared frontend changes:

```bash
cd backend
npm run smoke:portal
npx jest tests/jest/portal-smoke-static.test.js tests/jest/chat-targets-static.test.js tests/jest/kanban-nav-static.test.js --runInBand
```

Changes to `backend/public/shared/i18n.js` or portal HTML:

```bash
cd backend
npm test -- --testPathPattern=i18n-syntax
node scripts/i18n-check.js
```

Android changes:

```bash
./gradlew lintDebug testDebugUnitTest assembleDebug --no-daemon
```

CLI proxy changes:

```bash
cd claude-cli-proxy
python -m unittest tests.test_repo_auth tests.test_multi_tenant -v
```

iOS locale changes:

```bash
node -e "const fs=require('fs'); const dir='ios-app/i18n'; for (const f of fs.readdirSync(dir).filter(x=>x.endsWith('.json'))) JSON.parse(fs.readFileSync(dir+'/'+f,'utf8')); console.log('iOS locale JSON parsed');"
```

## CI Requirements

Repository branch protection should require only:

```text
PR CI Hard Gate / Required PR CI gate
```

The individual path-scoped workflow jobs should stay optional in branch protection. Requiring them directly can leave PRs blocked when a workflow is correctly skipped because its files were not touched.

## Secrets

Never include device secrets, API tokens, private keys, database URLs, or production credentials in commits, PR bodies, logs, screenshots, or review comments. Use redacted examples such as `YOUR_DEVICE_ID` and `YOUR_BOT_SECRET`.
