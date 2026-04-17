/**
 * Centralized ID factory for the 7 core entity types.
 *
 * Issued IDs are Stripe-style: `<type>_<24 hex chars>`, e.g. `card_7b7dd9e3a4c2...`.
 * This lets the chat UI / linkify detect an entity reference from the ID alone,
 * without a keyword prefix or a backend resolve round-trip.
 *
 * Old plain UUIDs remain valid: isValidEntityId() and the DB columns (VARCHAR(48))
 * accept both formats during the long-tail cutover.
 */
const crypto = require('crypto');

const ENTITY_TYPES = ['card', 'note', 'skill', 'rule', 'listing', 'exam', 'contract'];
const HEX_LEN = 24;

function makeId(type) {
    if (!ENTITY_TYPES.includes(type)) {
        throw new Error(`Unknown entity type: ${type}`);
    }
    return `${type}_${crypto.randomBytes(HEX_LEN / 2).toString('hex')}`;
}

const newCardId = () => makeId('card');
const newNoteId = () => makeId('note');
const newSkillId = () => makeId('skill');
const newRuleId = () => makeId('rule');
const newListingId = () => makeId('listing');
const newExamId = () => makeId('exam');
const newContractId = () => makeId('contract');

const PREFIXED_RE = new RegExp(`^(${ENTITY_TYPES.join('|')})_[a-f0-9]{${HEX_LEN}}$`);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPrefixedEntityId(id, expectedType = null) {
    if (typeof id !== 'string') return false;
    const m = id.match(PREFIXED_RE);
    if (!m) return false;
    return !expectedType || m[1] === expectedType;
}

function isUuid(id) {
    return typeof id === 'string' && UUID_RE.test(id);
}

// Accept either a prefixed id (of the expected type, if given) or a legacy UUID.
function isValidEntityId(id, expectedType = null) {
    return isPrefixedEntityId(id, expectedType) || isUuid(id);
}

function entityTypeOf(id) {
    if (typeof id !== 'string') return null;
    const m = id.match(PREFIXED_RE);
    return m ? m[1] : null;
}

module.exports = {
    ENTITY_TYPES,
    newCardId,
    newNoteId,
    newSkillId,
    newRuleId,
    newListingId,
    newExamId,
    newContractId,
    makeId,
    isPrefixedEntityId,
    isUuid,
    isValidEntityId,
    entityTypeOf
};
