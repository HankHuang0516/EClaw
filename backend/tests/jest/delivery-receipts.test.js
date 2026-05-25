const {
    recordDeliveryReceipt,
    resetDeliveryReceiptState
} = require('../../delivery-receipts');
const fs = require('fs');
const path = require('path');

describe('delivery receipt logging and commander alerting', () => {
    let serverLog;
    let notifyDevice;

    beforeEach(() => {
        resetDeliveryReceiptState();
        serverLog = jest.fn();
        notifyDevice = jest.fn().mockResolvedValue(undefined);
    });

    test('logs successes and resets the failure streak', () => {
        recordDeliveryReceipt({ serverLog, notifyDevice, deviceId: 'dev-a', entityId: 6, success: false, reason: 'http_502' });
        const result = recordDeliveryReceipt({ serverLog, notifyDevice, deviceId: 'dev-a', entityId: 6, success: true });
        const nextFailure = recordDeliveryReceipt({ serverLog, notifyDevice, deviceId: 'dev-a', entityId: 6, success: false, reason: 'timeout' });

        expect(result).toEqual({ consecutiveFailures: 0, alerted: false });
        expect(nextFailure.consecutiveFailures).toBe(1);
        expect(serverLog).toHaveBeenCalledWith('info', 'delivery_receipt', expect.stringContaining('Delivery receipt OK'), expect.any(Object));
    });

    test('alerts commander after more than three consecutive failures', () => {
        for (let i = 0; i < 3; i += 1) {
            const result = recordDeliveryReceipt({ serverLog, notifyDevice, deviceId: 'dev-a', entityId: 6, success: false, reason: 'http_503' });
            expect(result.alerted).toBe(false);
        }

        const fourth = recordDeliveryReceipt({ serverLog, notifyDevice, deviceId: 'dev-a', entityId: 6, success: false, reason: 'http_503' });

        expect(fourth).toEqual({ consecutiveFailures: 4, alerted: true });
        expect(notifyDevice).toHaveBeenCalledWith('dev-a', expect.objectContaining({
            type: 'alert',
            category: 'delivery_alert',
            title: 'Commander delivery alert'
        }));
        expect(serverLog).toHaveBeenCalledWith('error', 'delivery_alert', expect.stringContaining('4 consecutive delivery failures'), expect.any(Object));
    });

    test('channel callback exception path records a defined account id', () => {
        const source = fs.readFileSync(path.join(__dirname, '../../channel-api.js'), 'utf8');
        expect(source).toMatch(/channelAccountId:\s*account\.id/);
        expect(source).not.toContain('metadata: { channelAccountId }');
    });
});
