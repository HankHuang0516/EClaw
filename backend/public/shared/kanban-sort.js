/**
 * Kanban Sort — deterministic card ordering shared by kanban UI and tests.
 *
 * Accepts both API camelCase (`updatedAt`) and DB snake_case (`updated_at`)
 * timestamps. This prevents UI sort regressions where cards fall back to the
 * backend/API grouping order (often assigned entity id order) when a timestamp
 * field shape differs between active and done cards.
 */
(function (global) {
    const PRIORITY_RANK = Object.freeze({ P0: 0, P1: 1, P2: 2, P3: 3 });

    function toTimestamp(value) {
        if (value == null || value === '') return 0;
        if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed) return 0;
            const numeric = Number(trimmed);
            if (Number.isFinite(numeric)) return numeric;
            const parsed = Date.parse(trimmed);
            return Number.isFinite(parsed) ? parsed : 0;
        }
        const parsed = Date.parse(String(value));
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function cardUpdatedAt(card) {
        return toTimestamp(card && (card.updatedAt ?? card.updated_at ?? card.updated));
    }

    function cardCreatedAt(card) {
        return toTimestamp(card && (card.createdAt ?? card.created_at ?? card.created));
    }

    function priorityRank(card) {
        return PRIORITY_RANK[(card && card.priority) || ''] ?? 999;
    }

    function idCompare(a, b) {
        return String((a && a.id) || '').localeCompare(String((b && b.id) || ''));
    }

    function firstNonZero(...values) {
        for (const value of values) {
            if (value !== 0) return value;
        }
        return 0;
    }

    function compareCards(a, b, sortType) {
        switch (sortType) {
            case 'updated_desc':
                return firstNonZero(
                    cardUpdatedAt(b) - cardUpdatedAt(a),
                    cardCreatedAt(b) - cardCreatedAt(a),
                    priorityRank(a) - priorityRank(b),
                    idCompare(a, b)
                );
            case 'updated_asc':
                return firstNonZero(
                    cardUpdatedAt(a) - cardUpdatedAt(b),
                    cardCreatedAt(a) - cardCreatedAt(b),
                    priorityRank(a) - priorityRank(b),
                    idCompare(a, b)
                );
            case 'created_asc':
                return firstNonZero(
                    cardCreatedAt(a) - cardCreatedAt(b),
                    cardUpdatedAt(a) - cardUpdatedAt(b),
                    priorityRank(a) - priorityRank(b),
                    idCompare(a, b)
                );
            case 'created_desc':
                return firstNonZero(
                    cardCreatedAt(b) - cardCreatedAt(a),
                    cardUpdatedAt(b) - cardUpdatedAt(a),
                    priorityRank(a) - priorityRank(b),
                    idCompare(a, b)
                );
            case 'priority_asc':
                return firstNonZero(
                    priorityRank(a) - priorityRank(b),
                    cardUpdatedAt(b) - cardUpdatedAt(a),
                    cardCreatedAt(b) - cardCreatedAt(a),
                    idCompare(a, b)
                );
            case 'default':
            default:
                return 0;
        }
    }

    function applyKanbanSort(cards, sortType) {
        const list = Array.isArray(cards) ? cards.slice() : [];
        if (!sortType || sortType === 'default') return list;
        return list.sort((a, b) => compareCards(a, b, sortType));
    }

    global.KanbanSort = Object.freeze({
        apply: applyKanbanSort,
        compareCards,
        toTimestamp,
        cardUpdatedAt,
        cardCreatedAt,
        priorityRank,
    });
})(typeof window !== 'undefined' ? window : globalThis);
