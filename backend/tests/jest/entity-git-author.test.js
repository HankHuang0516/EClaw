'use strict';

/**
 * Tests for the per-entity git author identity helper (Tier 1).
 * Spec: docs/specs/per-entity-git-author-spec.md
 * Card: card_35009109c256040aa91200bd
 */

const { execFileSync } = require('child_process');
const path = require('path');
const {
    entityGitAuthor,
    entityGitEmail,
    resolveDisplayName,
    normalizeEntityId,
    EMAIL_DOMAIN,
} = require('../../scripts/entity-git-author');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'entity-git-author.js');

describe('entity-git-author helper', () => {
    test('email scheme is entity-<N>@bots.eclaw, derived from id alone', () => {
        expect(EMAIL_DOMAIN).toBe('bots.eclaw');
        expect(entityGitEmail(2)).toBe('entity-2@bots.eclaw');
        expect(entityGitEmail(42)).toBe('entity-42@bots.eclaw');
        expect(entityGitEmail('5')).toBe('entity-5@bots.eclaw');
        // email derivable even with no name
        expect(entityGitAuthor(7).email).toBe('entity-7@bots.eclaw');
    });

    test('author string for #2 matches the spec sample', () => {
        const a = entityGitAuthor(2, { name: 'Mac_ClaudeAce主管' });
        expect(a.name).toBe('EClaw #2 Mac_ClaudeAce主管');
        expect(a.email).toBe('entity-2@bots.eclaw');
        expect(a.authorString).toBe('EClaw #2 Mac_ClaudeAce主管 <entity-2@bots.eclaw>');
    });

    test('name format is EClaw #<N> <displayName>', () => {
        expect(entityGitAuthor(5, { name: 'Hermes' }).name).toBe('EClaw #5 Hermes');
        expect(entityGitAuthor(5, { name: 'Hermes' }).authorString)
            .toBe('EClaw #5 Hermes <entity-5@bots.eclaw>');
    });

    test('falls back to "Entity <N>" when no name provided', () => {
        const a = entityGitAuthor(42);
        expect(a.name).toBe('EClaw #42 Entity 42');
        expect(a.authorString).toBe('EClaw #42 Entity 42 <entity-42@bots.eclaw>');
    });

    test('blank / whitespace name falls back to "Entity <N>"', () => {
        expect(entityGitAuthor(3, { name: '   ' }).name).toBe('EClaw #3 Entity 3');
        expect(entityGitAuthor(3, { name: '' }).name).toBe('EClaw #3 Entity 3');
        expect(resolveDisplayName(3, null)).toBe('Entity 3');
        expect(resolveDisplayName(3, 'Mac_E')).toBe('Mac_E');
    });

    test('accepts numeric-string entity ids', () => {
        expect(entityGitAuthor('2', { name: 'X' }).email).toBe('entity-2@bots.eclaw');
    });

    test('entity 0 is valid (non-negative)', () => {
        expect(entityGitAuthor(0).authorString).toBe('EClaw #0 Entity 0 <entity-0@bots.eclaw>');
    });

    test('globe-user: no hardcoded entity — arbitrary high id works', () => {
        const a = entityGitAuthor(99999, { name: 'Future Bot' });
        expect(a.authorString).toBe('EClaw #99999 Future Bot <entity-99999@bots.eclaw>');
    });

    test.each([null, undefined, -1, 1.5, NaN, 'abc', {}])(
        'throws TypeError on invalid id %p', (bad) => {
            expect(() => entityGitAuthor(bad)).toThrow(TypeError);
        }
    );

    test('normalizeEntityId / entityGitEmail return null on invalid id', () => {
        expect(normalizeEntityId('abc')).toBeNull();
        expect(normalizeEntityId(-1)).toBeNull();
        expect(entityGitEmail('abc')).toBeNull();
    });

    test('CLI prints the author string for an entity id', () => {
        const out = execFileSync('node', [SCRIPT, '2', 'Mac_ClaudeAce主管'], { encoding: 'utf8' });
        expect(out.trim()).toBe('EClaw #2 Mac_ClaudeAce主管 <entity-2@bots.eclaw>');
    });

    test('CLI without a name falls back to Entity <N>', () => {
        const out = execFileSync('node', [SCRIPT, '8'], { encoding: 'utf8' });
        expect(out.trim()).toBe('EClaw #8 Entity 8 <entity-8@bots.eclaw>');
    });
});
