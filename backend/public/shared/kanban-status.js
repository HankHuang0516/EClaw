/**
 * Kanban Status — single source of truth for the kanban card status enum.
 *
 * Card status was duplicated across 6+ places (server enum, UI columns, nudge
 * whitelist, chat smart-chip preview, i18n labels, schema comments) and they
 * drifted apart, causing card_c043100f5b43e7711fef05cc (status=blocked) to be
 * invisible in the kanban UI because kanban.html had no `blocked` column.
 *
 * Spec: docs/specs/kanban-status.md (P1.4 of card_42526620af35fb0b27edb2a2).
 *
 * Anyone introducing a new status MUST update STATUSES, STATUS_I18N_KEYS,
 * the SQL CASE in kanban.js (priority sort), the schema comment in
 * kanban_schema.sql, and the nudge whitelist in device-preferences.js
 * (decide whether the new status should be nudgeable).
 */
(function (global) {
    const STATUSES = Object.freeze([
        'backlog',
        'todo',
        'in_progress',
        'review',
        'done',
        'blocked',
    ]);

    const STATUS_I18N_KEYS = Object.freeze({
        backlog: 'kb_col_backlog',
        todo: 'kb_col_todo',
        in_progress: 'kb_col_in_progress',
        review: 'kb_col_review',
        done: 'kb_col_done',
        blocked: 'kb_col_blocked',
    });

    const STATUS_LABELS_EN = Object.freeze({
        backlog: 'Backlog',
        todo: 'TODO',
        in_progress: 'In Progress',
        review: 'Review',
        done: 'Done',
        blocked: 'Blocked',
    });

    const STATUS_EMOJI = Object.freeze({
        backlog: '📦',
        todo: '📋',
        in_progress: '🔄',
        review: '👀',
        done: '✅',
        blocked: '🚫',
    });

    const NUDGEABLE_STATUSES = Object.freeze([
        'backlog',
        'todo',
        'in_progress',
        'review',
        'blocked',
    ]);

    const NUDGE_DEFAULT_STATUSES = Object.freeze([
        'todo',
        'in_progress',
        'review',
    ]);

    const PRIORITY_ORDER = Object.freeze({
        in_progress: 0,
        review: 1,
        todo: 2,
        backlog: 3,
        blocked: 4,
        done: 5,
    });

    function isValidStatus(s) {
        return STATUSES.includes(s);
    }

    function priorityOrderSql(column) {
        const cases = STATUSES
            .map(s => `WHEN '${s}' THEN ${PRIORITY_ORDER[s]}`)
            .join(' ');
        return `CASE ${column} ${cases} ELSE ${STATUSES.length} END`;
    }

    const api = {
        STATUSES,
        STATUS_I18N_KEYS,
        STATUS_LABELS_EN,
        STATUS_EMOJI,
        NUDGEABLE_STATUSES,
        NUDGE_DEFAULT_STATUSES,
        PRIORITY_ORDER,
        isValidStatus,
        priorityOrderSql,
    };

    global.KanbanStatus = api;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
