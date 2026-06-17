'use strict';

/**
 * Per-entity git author identity — Tier 1.
 * Spec: docs/specs/per-entity-git-author-spec.md
 * Card: card_35009109c256040aa91200bd
 *
 * Pure, dependency-light. Given a global entity id (and optionally the entity's
 * display name) it derives the git author identity used to attribute commits /
 * PRs to the real EClaw entity instead of only the shared merging account.
 *
 *   Email :  entity-<globalEntityId>@bots.eclaw   (always derivable from id alone)
 *   Name  :  EClaw #<N> <displayName>             (displayName resolved per §4)
 *   Author:  EClaw #<N> <displayName> <entity-<N>@bots.eclaw>
 *
 * Globe-user: no hardcoded entity/device — everything derives from the id +
 * (optional) name passed in. Works for any entity on any device worldwide.
 *
 * CLI:  node entity-git-author.js <entityId>   → prints the author string.
 */

// Reserved, non-routable attribution domain (see spec §3). Not a real TLD; used
// only as a stable join key for the prs_merged metric, never for mail.
const EMAIL_DOMAIN = 'bots.eclaw';

/**
 * Normalize a global entity id to a non-negative integer, or null if invalid.
 */
function normalizeEntityId(entityId) {
    // Reject null/undefined/'' up front — Number() coerces these to 0/NaN in
    // ways that would silently mint a wrong identity.
    if (entityId == null) return null;
    if (typeof entityId === 'string' && entityId.trim() === '') return null;
    const n = Number(entityId);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
    return n;
}

/**
 * Stable attribution email for an entity. Derivable from the id alone so the
 * metric (§6) always has a join key even when no display name is on record.
 * Returns null only for an invalid id.
 */
function entityGitEmail(entityId) {
    const n = normalizeEntityId(entityId);
    if (n === null) return null;
    return `entity-${n}@${EMAIL_DOMAIN}`;
}

/**
 * Resolve the display name for an entity (spec §4): explicit name → fallback
 * `Entity <N>`. Caller passes whatever it already has (e.g. entity.name from
 * the in-memory device record, or a codename); we never reach into a DB here so
 * the function stays pure and dependency-light.
 */
function resolveDisplayName(entityId, name) {
    const n = normalizeEntityId(entityId);
    if (name != null) {
        const trimmed = String(name).trim();
        if (trimmed) return trimmed;
    }
    return `Entity ${n === null ? entityId : n}`;
}

/**
 * Build the per-entity git author identity.
 *
 * @param {number|string} entityId  global entity id
 * @param {{name?: string}} [opts]  optional display name (entity.name / codename)
 * @returns {{name: string, email: string, authorString: string}}
 * @throws {TypeError} if entityId is not a non-negative integer
 */
function entityGitAuthor(entityId, opts) {
    const n = normalizeEntityId(entityId);
    if (n === null) {
        throw new TypeError(
            `entityGitAuthor: entityId must be a non-negative integer, got ${JSON.stringify(entityId)}`
        );
    }
    const displayName = resolveDisplayName(n, opts && opts.name);
    const name = `EClaw #${n} ${displayName}`;
    const email = `entity-${n}@${EMAIL_DOMAIN}`;
    const authorString = `${name} <${email}>`;
    return { name, email, authorString };
}

module.exports = {
    EMAIL_DOMAIN,
    entityGitAuthor,
    entityGitEmail,
    resolveDisplayName,
    normalizeEntityId,
};

// ── CLI ───────────────────────────────────────────────────────────────────────
// node entity-git-author.js <entityId> [displayName]
// Prints the author string (e.g. for `git commit --author="$(...)"`).
if (require.main === module) {
    const [, , idArg, nameArg] = process.argv;
    if (idArg == null) {
        process.stderr.write('usage: node entity-git-author.js <entityId> [displayName]\n');
        process.exit(2);
    }
    try {
        const { authorString } = entityGitAuthor(idArg, nameArg != null ? { name: nameArg } : undefined);
        process.stdout.write(authorString + '\n');
    } catch (err) {
        process.stderr.write(String((err && err.message) || err) + '\n');
        process.exit(1);
    }
}
