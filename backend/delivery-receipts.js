'use strict';

const DEFAULT_FAILURE_ALERT_THRESHOLD = 3;
const deliveryFailureStreaks = new Map();

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
    threshold = DEFAULT_FAILURE_ALERT_THRESHOLD
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
