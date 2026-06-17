'use strict';

/**
 * Per-device cron host resolution (card_1ce50de359411f0d0947399f, #6 ruling d).
 *
 * Problem this solves
 * -------------------
 * Recurring kanban cards fire centrally (one backend process runs the schedule
 * tick for every device). When a card fires, the notify is dispatched via
 * `devices[card.device_id].entities[bot]` — i.e. it assumes the device that
 * OWNS the card is also the device that HOSTS the assigned entity.
 *
 * That assumption breaks for any entity that runs on a separate device identity.
 * Concrete failure: Hermes Docker registered its own device (a different
 * deviceId) and bound an entity there; a recurring card owned by the main device
 * and assigned to that entity pushes to a binding that does not exist on the
 * card's device → the tick silently lands nowhere (the recurring "Card B can't
 * run on Hermes" churn).
 *
 * Fix
 * ---
 * Resolve, per assigned entity, WHICH registered device actually hosts that
 * entity (bound + reachable), and dispatch the notify to that device. Entity ids
 * are per-device, so cross-device matching is done by the entity's stable
 * `publicCode` (falling back to the bare entityId when the card device hosts it
 * locally — the legacy single-device path).
 *
 * Design properties
 * -----------------
 * - Local-first / backward-compatible: if the assigned entity is bound on the
 *   card's own device, host = card.device_id. Existing single-device setups are
 *   unchanged (no DB lookups, no behavior change).
 * - Globe-user: any worldwide user's device runs its own crons; the resolver
 *   derives hosting purely from the live `devices` registry — nothing is
 *   hardcoded to any specific deviceId.
 * - No silent drop: an entity with no registered/active host yields an explicit
 *   skip decision with a logged reason; the caller may still fall back to the
 *   card device's local binding (preserving prior behavior) instead of hard
 *   failing.
 * - No double-fire: this module only chooses WHERE each notify lands. It never
 *   advances the card's schedule_next_run_at and never re-fires the card, so the
 *   existing once-per-tick idempotency (the single row UPDATE in
 *   checkScheduleTriggers) is untouched.
 *
 * All functions here are pure (no I/O) so they are deterministically unit
 * testable from the in-memory `devices` registry.
 */

/**
 * Is this entity record currently reachable for a push?
 * A reachable entity is bound AND has a delivery channel (channel callback id or
 * a webhook). An unbound or delivery-less slot cannot receive a cron dispatch.
 *
 * @param {object|null} entity - entity record from devices[dev].entities[id]
 * @returns {boolean}
 */
function isEntityReachable(entity) {
    if (!entity || !entity.isBound) return false;
    if (entity.bindingType === 'channel') {
        return !!entity.channelAccountId;
    }
    // webhook binding (or legacy null bindingType with a webhook configured)
    return !!entity.webhook;
}

/**
 * Find an entity on a device by its stable publicCode.
 *
 * @param {object|null} device - devices[deviceId]
 * @param {string} publicCode
 * @returns {{ entityId: number, entity: object } | null}
 */
function findEntityByPublicCode(device, publicCode) {
    if (!device || !device.entities || !publicCode) return null;
    for (const [eid, entity] of Object.entries(device.entities)) {
        if (entity && entity.publicCode && entity.publicCode === publicCode) {
            return { entityId: Number(eid), entity };
        }
    }
    return null;
}

/**
 * Resolve which registered device should receive the cron dispatch for one
 * assigned entity of a recurring card.
 *
 * Resolution order:
 *  1. LOCAL (backward-compatible): if the card's own device hosts the entity id
 *     and it is reachable, dispatch locally. This is the single-device path and
 *     incurs no cross-device search — behaviour is identical to before.
 *  2. CROSS-DEVICE: otherwise, take the entity's stable publicCode (from the
 *     card device's slot, even if that local slot is not reachable) and find
 *     another registered device that hosts a reachable entity with the same
 *     publicCode. Dispatch there.
 *  3. SKIP: if no device hosts a reachable copy of the entity, return a skip
 *     decision with a reason. The caller decides whether to fall back to the
 *     card device's local binding (legacy behavior) or log-and-skip.
 *
 * @param {object} card - kanban card row (needs device_id; bot is passed separately)
 * @param {number} bot - assigned entity id (as numbered on the card's device)
 * @param {object} devices - the live in-memory device registry
 * @returns {{
 *   shouldDispatch: boolean,
 *   hostDeviceId: string|null,
 *   hostEntityId: number|null,
 *   resolution: 'local'|'cross_device'|'no_host',
 *   reason: string,
 *   publicCode: string|null,
 * }}
 */
function resolveEntityHostDevice(card, bot, devices) {
    const cardDeviceId = card && card.device_id;
    const botId = Number(bot);
    const cardDevice = (devices && cardDeviceId) ? devices[cardDeviceId] : null;
    const localEntity = cardDevice && cardDevice.entities ? cardDevice.entities[botId] : null;
    const publicCode = localEntity ? (localEntity.publicCode || null) : null;

    // 1. Local-first (legacy single-device path)
    if (isEntityReachable(localEntity)) {
        return {
            shouldDispatch: true,
            hostDeviceId: cardDeviceId,
            hostEntityId: botId,
            resolution: 'local',
            reason: 'hosted_locally',
            publicCode,
        };
    }

    // 2. Cross-device by stable publicCode.
    // Without a publicCode there is no stable cross-device identity to match on,
    // so we cannot safely route to another device — treat as no host.
    if (publicCode) {
        for (const [otherDeviceId, otherDevice] of Object.entries(devices || {})) {
            if (otherDeviceId === cardDeviceId) continue;
            const match = findEntityByPublicCode(otherDevice, publicCode);
            if (match && isEntityReachable(match.entity)) {
                return {
                    shouldDispatch: true,
                    hostDeviceId: otherDeviceId,
                    hostEntityId: match.entityId,
                    resolution: 'cross_device',
                    reason: 'hosted_on_remote_device',
                    publicCode,
                };
            }
        }
    }

    // 3. No registered/active device hosts a reachable copy of this entity.
    return {
        shouldDispatch: false,
        hostDeviceId: null,
        hostEntityId: null,
        resolution: 'no_host',
        reason: publicCode
            ? 'no_registered_host_device'
            : 'no_public_code_and_local_unreachable',
        publicCode,
    };
}

module.exports = {
    isEntityReachable,
    findEntityByPublicCode,
    resolveEntityHostDevice,
};
