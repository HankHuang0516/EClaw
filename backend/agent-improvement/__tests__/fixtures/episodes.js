// Sample episodes — one per painTag in PAIN_TAXONOMY.
// These are REDACTED stand-ins drawn from the OODA-R kickoff (2026-06-07).
// Real values for cardId / PR numbers / chat refs are kept; secret values are
// deliberately omitted (never embedded inline). The redaction tests assert this.

'use strict';

/** @type {import('../../episode-schema').Episode[]} */
const FIXTURES = [
  {
    cardId: 'card_47ed9a0c21dd507d3b726136',
    entityId: 2,
    taskType: 'feature_impl',
    painTags: ['delivery_reliability'],
    deliverable: 'offline delivery queue + reconnect replay',
    userVisibleResult: 'pending — Phase 2 #5, not yet shipped',
    evidence: [
      { kind: 'card', ref: 'card_47ed9a0c21dd507d3b726136', note: 'Phase 2 #5 subcard' },
      { kind: 'chat', ref: 'web_chat:2026-06-07T04:28+08:00', note: 'Hank: 一旦斷線訊息就被阻擋' },
    ],
    missedChecks: [
      'no queue dedupe key tested under reconnect',
      'no UI state surface for queued/retrying/sent/failed',
    ],
    userFeedback: '一旦斷線訊息就被阻擋',
    severity: 'P1',
    occurredAt: '2026-06-07T04:28:00+08:00',
  },
  {
    cardId: 'card_214d48e395e812b3e909e5ca',
    entityId: 2,
    taskType: 'feature_impl',
    painTags: ['auth_session'],
    deliverable: 'auth/session persistence + refresh diagnostics',
    userVisibleResult: 'pending — Phase 2 #6, silent re-login still happens',
    evidence: [
      { kind: 'card', ref: 'card_214d48e395e812b3e909e5ca', note: 'Phase 2 #6 subcard' },
      { kind: 'chat', ref: 'web_chat:2026-06-07T04:28+08:00', note: 'Hank: 帳號莫名要重新登入' },
    ],
    missedChecks: [
      'no refresh-token mutex',
      'no 401 reason-code surface (silent kick instead of explicit prompt)',
    ],
    userFeedback: '帳號莫名要重新登入',
    severity: 'P1',
    occurredAt: '2026-06-07T04:28:00+08:00',
  },
  {
    cardId: 'card_14571f26914b9c1eae148362',
    entityId: 2,
    taskType: 'feature_impl',
    painTags: ['redirect_deeplink'],
    deliverable: 'unified App/Web redirect state machine',
    userVisibleResult: 'pending — Phase 2 #7, app↔web routing still inconsistent',
    evidence: [
      { kind: 'card', ref: 'card_14571f26914b9c1eae148362', note: 'Phase 2 #7 subcard' },
      { kind: 'chat', ref: 'web_chat:2026-06-07T04:28+08:00', note: 'Hank: App 轉導不穩定 + Web 轉導也不盡人意' },
    ],
    missedChecks: [
      'no canonical route contract across web/app/publicCode/cardId',
      'no traceId on deep links — cannot diagnose where redirect dropped',
    ],
    userFeedback: 'App 轉導不穩定 / Web 轉導也不盡人意',
    severity: 'P2',
    occurredAt: '2026-06-07T04:28:00+08:00',
  },
  {
    cardId: 'card_3041',
    entityId: 2,
    taskType: 'bugfix',
    painTags: ['ux_feedback'],
    deliverable: 'avatar status drawer no_reply counter',
    userVisibleResult: 'counter stayed at 0 even when #1 silently dropped a2a message — semantic gap',
    evidence: [
      { kind: 'pr', ref: 'PR#3221' },
      { kind: 'pr', ref: 'PR#3222', note: 'same-device deliverToEntity hook' },
      { kind: 'chat', ref: 'web_chat:2026-06-07T06:00+08:00', note: 'Hank: 為何錯誤累計次數的a2a未回覆次數沒有增加' },
    ],
    missedChecks: [
      'counter hook only covered push-failure not brain-silence',
      'no E2E that sent a silent probe and asserted counter tick',
    ],
    userFeedback: '無法接受 Agent 犯這種低級錯誤',
    severity: 'P0',
    occurredAt: '2026-06-07T06:00:00+08:00',
  },
  {
    cardId: 'card_5ac74610cbf1f89440427809',
    entityId: 2,
    taskType: 'spec_draft',
    painTags: ['agent_ownership'],
    deliverable: 'rule promotion engine + public roadmap tracker',
    userVisibleResult: 'pending — Phase 4 #9, owner=#2 but execution slot not yet held',
    evidence: [
      { kind: 'card', ref: 'card_5ac74610cbf1f89440427809', note: 'Phase 4 #9 subcard' },
      { kind: 'chat', ref: 'web_chat:2026-06-07T04:28+08:00', note: 'Hank: 任務偷懶 / 不知道自己該做甚麼' },
    ],
    missedChecks: [
      'no auto-suggest when same taxonomy fires N times',
      'roadmap.html is hard-coded — not pulled from kanban',
    ],
    severity: 'P2',
    occurredAt: '2026-06-07T04:28:00+08:00',
  },
  {
    cardId: 'card_50dccd356888b22d6654e85a',
    entityId: 2,
    taskType: 'feature_impl',
    painTags: ['task_context'],
    deliverable: 'task-start preflight lint (the PoC)',
    userVisibleResult: 'pending — Phase 1 #3, blocked on this Phase 0 #1 finishing',
    evidence: [
      { kind: 'card', ref: 'card_50dccd356888b22d6654e85a', note: 'Phase 1 #3 subcard' },
      { kind: 'comment', ref: 'preflight-comment-on-self-2026-06-07T17:13+08:00' },
    ],
    missedChecks: [
      'no episode store to pull prior lessons from until Phase 0 #2 wires ingestion',
    ],
    severity: 'P0',
    occurredAt: '2026-06-07T04:28:00+08:00',
  },
  {
    cardId: 'card_42ffca0d29ce22b369d55ca4',
    entityId: 2,
    taskType: 'test_coverage',
    painTags: ['test_coverage'],
    deliverable: 'cross-surface E2E matrix for top workflows',
    userVisibleResult: 'pending — Phase 3 #8, no required-check gate yet',
    evidence: [
      { kind: 'card', ref: 'card_42ffca0d29ce22b369d55ca4', note: 'Phase 3 #8 subcard' },
      { kind: 'chat', ref: 'web_chat:2026-06-07T04:28+08:00', note: 'Hank: 測試沒完整' },
    ],
    missedChecks: [
      'no matrix definition checked in',
      'CI does not block PR merge on matrix failure',
    ],
    userFeedback: '測試沒完整',
    severity: 'P1',
    occurredAt: '2026-06-07T04:28:00+08:00',
  },
  {
    cardId: 'card_337040389de34bcb65cf0cb0',
    entityId: 2,
    taskType: 'feature_impl',
    painTags: ['scope_completeness'],
    deliverable: 'done-evidence gate + anti-laziness guard',
    userVisibleResult: 'pending — Phase 1 #4, silent-done antipattern still possible',
    evidence: [
      { kind: 'card', ref: 'card_337040389de34bcb65cf0cb0', note: 'Phase 1 #4 subcard' },
      { kind: 'chat', ref: 'web_chat:2026-06-07T04:28+08:00', note: 'Hank: 用戶功能總是不能一次到位 還要修修改改' },
    ],
    missedChecks: [
      'done transitions accept cards without evidence today',
      'no in_progress >2h heartbeat prompt',
    ],
    userFeedback: '用戶功能總是不能一次到位 還要修修改改',
    severity: 'P0',
    occurredAt: '2026-06-07T04:28:00+08:00',
  },
];

module.exports = FIXTURES;
