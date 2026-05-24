'use strict';

const MAX_SESSION_SCOPE_PART = 80;

function sanitizeSessionScopePart(value, fallback = 'unknown', allowColon = false) {
    const raw = String(value ?? '').trim();
    const pattern = allowColon ? /[^A-Za-z0-9._:-]+/g : /[^A-Za-z0-9._-]+/g;
    const sanitized = raw.replace(pattern, '_').replace(/^_+|_+$/g, '');
    return (sanitized || fallback).slice(0, MAX_SESSION_SCOPE_PART);
}

function buildOrgEntitySessionKey(baseKey, orgId, entityId) {
    const base = sanitizeSessionScopePart(baseKey || 'default', 'default', true);
    const org = sanitizeSessionScopePart(orgId, 'unknown_org');
    const entity = sanitizeSessionScopePart(entityId, 'unknown_entity');
    return `${base}:org:${org}:entity:${entity}`;
}

function isOrgEntitySessionKey(sessionKey, baseKey, orgId, entityId) {
    if (!sessionKey) return false;
    return sessionKey === buildOrgEntitySessionKey(baseKey, orgId, entityId);
}

module.exports = {
    buildOrgEntitySessionKey,
    isOrgEntitySessionKey,
    sanitizeSessionScopePart
};
