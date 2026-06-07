// OODA-R classifier — keyword + taskType heuristic that maps free-form
// feedback text to PAIN_TAXONOMY tags. Lives in its own module so both
// agent-improvement.js (ingestion) and preflight.js (composer) can import
// it without a circular dependency.

'use strict';

const KEYWORD_TO_TAG = Object.freeze([
    { tag: 'delivery_reliability', kws: ['offline', 'queue', 'reconnect', 'delivery', '斷線', '送不出', '訊息被阻擋', '無法送達', 'retry', 'backoff'] },
    { tag: 'auth_session',         kws: ['login', 'session', '登入', '重新登入', 'token', 'refresh', '401', 'auth', '帳號'] },
    { tag: 'redirect_deeplink',    kws: ['redirect', 'deep link', 'deeplink', '轉導', 'universal link', 'app links', 'route'] },
    { tag: 'ux_feedback',          kws: ['feedback', '回饋', '使用者看不到', 'silent', '無感', 'no signal', '不知道送出沒'] },
    { tag: 'agent_ownership',      kws: ['偷懶', 'slack', 'ownership', '誰負責', 'handoff', 'idle', '沒人接'] },
    { tag: 'task_context',         kws: ['不知道該做', 'context', '不知道做甚麼', '不知道自己要做', 'scope unclear', '沒說清楚'] },
    { tag: 'test_coverage',        kws: ['測試', 'test', 'coverage', 'no e2e', 'mock', '沒測'] },
    { tag: 'scope_completeness',   kws: ['不能一次到位', '修修改改', 'rework', 'partial', '未完成', 'incomplete'] },
]);

const TASKTYPE_TO_TAG = Object.freeze({
    pr_review: 'scope_completeness',
    test_coverage: 'test_coverage',
    spec_draft: 'task_context',
    bugfix: 'ux_feedback',
});

/**
 * @param {string} text
 * @param {string} [taskType]
 * @returns {string[]}
 */
function classifyPainTags(text, taskType) {
    const hits = new Set();
    const haystack = (text || '').toLowerCase();
    for (const { tag, kws } of KEYWORD_TO_TAG) {
        for (const kw of kws) {
            if (haystack.includes(kw.toLowerCase())) {
                hits.add(tag);
                break;
            }
        }
    }
    if (taskType && TASKTYPE_TO_TAG[taskType]) hits.add(TASKTYPE_TO_TAG[taskType]);
    if (hits.size === 0) hits.add('scope_completeness');
    return Array.from(hits);
}

module.exports = {
    KEYWORD_TO_TAG,
    TASKTYPE_TO_TAG,
    classifyPainTags,
};
