'use strict';

const DEFAULT_FAILURE_ALERT_THRESHOLD = 3;
const deliveryFailureStreaks = new Map();

// MessageLifecycle dual-write (spec §7, card_1b1c1322). Lazily required so this
// leaf module has no hard dependency / require cycle. Best-effort: lifecycle
// failures never affect the legacy delivery_alert path.
let _lifecycle = null;
function lifecycle() {
    if (_lifecycle === null) {
        try { _lifecycle = require('./lib/message-lifecycle'); }
        catch (_) { _lifecycle = false; }
    }
    return _lifecycle || null;
}

function deliveryReceiptKey(deviceId, entityId, channel = 'channel_callback') {
    return `${deviceId || 'unknown_device'}:${entityId ?? 'unknown_entity'}:${channel}`;
}

function trimReason(reason) {
    return String(reason || 'unknown').slice(0, 240);
}

function recordDeliveryReceipt({
    serverLog,
    notifyDevice,
    deviceId,
    entityId,
    channel = 'channel_callback',
    success,
    reason,
    metadata = {},
    threshold = DEFAULT_FAILURE_ALERT_THRESHOLD,
    messageId = null
}) {
    const key = deliveryReceiptKey(deviceId, entityId, channel);
    const receiptMetadata = {
        channel,
        consecutiveFailures: 0,
        ...metadata
    };

    if (success) {
        deliveryFailureStreaks.delete(key);
        if (serverLog) {
            serverLog('info', 'delivery_receipt', `Delivery receipt OK for Entity ${entityId}`, {
                deviceId,
                entityId,
                metadata: receiptMetadata
            });
        }
        // Dual-write (spec §7): a confirmed delivery receipt advances the
        // lifecycle to push_delivered. Only when a real message_id is threaded
        // through — push_delivered is NEVER derived/synthesized (constraint #2).
        if (messageId) {
            const lc = lifecycle();
            if (lc) {
                Promise.resolve(lc.transition({
                    messageId,
                    targetState: 'push_delivered',
                    eventAt: new Date(),
                    source: 'channel_callback',
                })).catch(() => {});
            }
        }
        return { consecutiveFailures: 0, alerted: false };
    }

    const consecutiveFailures = (deliveryFailureStreaks.get(key) || 0) + 1;
    deliveryFailureStreaks.set(key, consecutiveFailures);
    const failureReason = trimReason(reason);
    const failureMetadata = {
        ...receiptMetadata,
        consecutiveFailures,
        reason: failureReason
    };

    if (serverLog) {
        serverLog('warn', 'delivery_receipt', `Delivery receipt failed for Entity ${entityId}: ${failureReason}`, {
            deviceId,
            entityId,
            metadata: failureMetadata
        });
    }

    const alerted = consecutiveFailures === threshold + 1;
    if (alerted) {
        const title = 'Commander delivery alert';
        const body = `Entity ${entityId} has ${consecutiveFailures} consecutive delivery failures (${failureReason}).`;
        if (serverLog) {
            serverLog('error', 'delivery_alert', body, {
                deviceId,
                entityId,
                metadata: failureMetadata
            });
        }
        // Dual-write divergence guard (spec §6.5 / §9.10): the legacy
        // delivery_alert just fired. If we have a message_id but no lifecycle
        // row stuck at bot_acked/push_delivered, dual-write was skipped on the
        // delivery path — record it for the Phase 3 cutover gate.
        if (messageId) {
            const lc = lifecycle();
            if (lc) {
                Promise.resolve((async () => {
                    const row = await lc.getLifecycle(messageId).catch(() => null);
                    if (!row || row.state === 'inbound_seen') {
                        await lc.recordDivergence({
                            messageId, deviceId, entityId,
                            legacyCounter: 'delivery_alert',
                            direction: 'lifecycle_skipped',
                            reason: 'delivery_alert fired but lifecycle not at/after bot_acked',
                        });
                    }
                })()).catch(() => {});
            }
        }
        if (notifyDevice) {
            Promise.resolve(notifyDevice(deviceId, {
                type: 'alert',
                category: 'delivery_alert',
                title,
                body,
                link: 'chat.html',
                metadata: failureMetadata
            })).catch(err => {
                if (serverLog) {
                    serverLog('warn', 'delivery_alert', `Commander delivery alert notification failed: ${err.message}`, {
                        deviceId,
                        entityId,
                        metadata: failureMetadata
                    });
                }
            });
        }
    }

    return { consecutiveFailures, alerted };
}

function resetDeliveryReceiptState() {
    deliveryFailureStreaks.clear();
}

module.exports = {
    DEFAULT_FAILURE_ALERT_THRESHOLD,
    deliveryReceiptKey,
    recordDeliveryReceipt,
    resetDeliveryReceiptState
};
