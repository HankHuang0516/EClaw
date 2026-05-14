#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const kanbanJs = fs.readFileSync(path.join(root, 'kanban.js'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'kanban_schema.sql'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'portal', 'kanban.html'), 'utf8');
const spec = fs.readFileSync(path.join(root, '..', 'docs', 'mission-v2-kanban-spec.md'), 'utf8');

const reopenStart = kanbanJs.indexOf("router.post('/card/:id/reopen'");
const reopenEnd = reopenStart >= 0 ? kanbanJs.indexOf("// ============================================\n    // GET /card/:id/comments", reopenStart) : -1;
const reopenBlock = reopenStart >= 0 ? kanbanJs.slice(reopenStart, reopenEnd > reopenStart ? reopenEnd : reopenStart + 6500) : '';

const checks = [
  {
    name: 'backend exposes an explicit /card/:id/reopen endpoint',
    ok: reopenStart >= 0,
  },
  {
    name: 'ordinary /move still rejects Done -> non-Done transitions',
    ok: /if \(oldStatus === 'done'\) \{[\s\S]{0,240}Done cards cannot be moved/.test(kanbanJs),
  },
  {
    name: 'reopen only accepts done as source and excludes archived cards',
    ok: /archived = false/.test(reopenBlock) && /card\.status !== 'done'/.test(reopenBlock),
  },
  {
    name: 'reopen target excludes done and backlog',
    ok: /STATUSES\.filter\(s => s !== 'done' && s !== 'backlog'\)/.test(reopenBlock),
  },
  {
    name: 'reopen requires a non-empty reason',
    ok: /Reopen reason is required/.test(reopenBlock),
  },
  {
    name: 'reopen endpoint does not implement any time-based lock',
    ok: !/(7\s*days?|604800000|done_retention_ms|retention|older than)/i.test(reopenBlock),
  },
  {
    name: 'reopen permission is supervisor/creator/reviewer/device-owner and not assignedBots',
    ok: /REOPEN_SUPERVISOR_ENTITY_IDS/.test(reopenBlock)
      && /isCreator/.test(reopenBlock)
      && /isReviewer/.test(reopenBlock)
      && /isDeviceOwner/.test(reopenBlock)
      && !/assigned_bots[\s\S]{0,500}(allowed|authorized|permission|isOwner)/i.test(reopenBlock),
  },
  {
    name: 'P0 or PR-rework reopen is restricted to supervisor/reviewer/device-owner',
    ok: /p0OrPrRework/.test(reopenBlock) && /allowedForStrictCard/.test(reopenBlock),
  },
  {
    name: 'reopen writes immutable system audit comment',
    ok: /addSystemComment[\s\S]*REOPENED from Done ->/.test(reopenBlock),
  },
  {
    name: 'schema stores reopen audit and PR rework metadata',
    ok: ['reopened_at', 'reopened_by', 'reopen_reason', 'requires_pr_rework', 'rework_pr_number'].every(s => schema.includes(s)),
  },
  {
    name: 'reopened PR-rework cards need PR number before final Done',
    ok: /REWORK_PR_REQUIRED/.test(kanbanJs),
  },
  {
    name: 'Done cards are not draggable in the UI',
    ok: /card\.archived \|\| card\.status === 'done'/.test(html),
  },
  {
    name: 'UI provides Reopen modal path rather than Done move buttons',
    ok: /openReopenDialog/.test(html) && /submitReopenCard/.test(html) && /apiReopenCard/.test(html),
  },
  {
    name: 'spec documents no-time-lock explicit reopen flow',
    ok: /Done 卡重新打開/.test(spec) && /不設時間鎖/.test(spec) && /POST\s+\/api\/mission\/card\/:id\/reopen/.test(spec),
  },
];

const failed = checks.filter(c => !c.ok);
if (failed.length) {
  console.error('[kanban-done-reopen] FAILED');
  for (const f of failed) console.error(`- ${f.name}`);
  process.exit(1);
}
console.log(`[kanban-done-reopen] PASS (${checks.length} checks)`);
