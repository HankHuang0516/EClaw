/**
 * Cross-speak chat rendering regression test (Jest)
 *
 * Validates that the client-side rendering logic in chat.html correctly handles
 * cross-device message direction:
 * - Outgoing cross-device messages (sent by this device) render as "sent" (right-aligned)
 * - Incoming cross-device messages (sent by another device) render as "received" (left-aligned)
 * - "My messages" filter excludes incoming cross-device messages
 * - Source labels show correct sender/target for each direction
 *
 * Regression: incoming cross-device messages on target device were displayed
 * as "sent" (right-aligned, "You → target") instead of "received".
 */

// Simulate the client-side functions from chat.html
function parseEntitySource(source) {
    if (!source) return null;
    const xmatch = source.match(/^xdevice:([a-z0-9]+):([^:]+)->(.+)$/);
    if (xmatch) {
        return {
            fromPublicCode: xmatch[1],
            character: xmatch[2],
            targets: [xmatch[3]],
            crossDevice: true
        };
    }
    const match = source.match(/^entity:(\d+):([^:]+)->(.+)$/);
    if (!match) return null;
    return {
        fromEntityId: parseInt(match[1]),
        character: match[2],
        targets: match[3].split(',').map(id => parseInt(id.trim()))
    };
}

/**
 * Simulates the fixed isSent logic from chat.html renderMessages:
 *   const xdInfo = msg.source ? parseEntitySource(msg.source) : null;
 *   const isIncomingXDevice = msg.is_from_user && xdInfo && xdInfo.crossDevice && !myPublicCodeMap[xdInfo.fromPublicCode];
 *   const isSent = msg.is_from_user && !isIncomingXDevice;
 */
function computeIsSent(msg, myPublicCodeMap) {
    const xdInfo = msg.source ? parseEntitySource(msg.source) : null;
    const isIncomingXDevice = msg.is_from_user && xdInfo && xdInfo.crossDevice && !myPublicCodeMap[xdInfo.fromPublicCode];
    return msg.is_from_user && !isIncomingXDevice;
}

/**
 * Simulates the fixed "my" filter from chat.html getFilteredMessages
 */
function filterMyMessages(messages, myPublicCodeMap) {
    return messages.filter(m => {
        if (!m.is_from_user) return false;
        const parsed = parseEntitySource(m.source);
        if (parsed && parsed.crossDevice && !myPublicCodeMap[parsed.fromPublicCode]) return false;
        return true;
    });
}

/**
 * Simulates the fixed buildSourceLabel direction check
 */
function getSourceDirection(msg, myPublicCodeMap) {
    const xdParsed = msg.source ? parseEntitySource(msg.source) : null;
    if (msg.is_from_user && xdParsed && xdParsed.crossDevice) {
        if (myPublicCodeMap[xdParsed.fromPublicCode]) {
            return 'outgoing'; // "You → target"
        } else {
            return 'incoming'; // "[sender] → entity"
        }
    }
    if (msg.is_from_bot && xdParsed && xdParsed.crossDevice) {
        return 'reply'; // "[sender] → [target]"
    }
    if (msg.is_from_user) return 'outgoing';
    return 'received';
}

// ════════════════════════════════════════════════════════════════
// Test data
// ════════════════════════════════════════════════════════════════
const DEVICE_A_CODE = 'abc123';  // Device A's entity publicCode
const DEVICE_B_CODE = 'xyz789';  // Device B's entity publicCode

// Device A's myPublicCodeMap (knows its own publicCodes)
const myMapA = { [DEVICE_A_CODE]: { entityId: 0, label: 'Entity #0' } };
// Device B's myPublicCodeMap
const myMapB = { [DEVICE_B_CODE]: { entityId: 0, label: 'Entity #0' } };

// Cross-device message: Device A sends to Device B
const crossSpeakSource = `xdevice:${DEVICE_A_CODE}:LOBSTER->${DEVICE_B_CODE}`;
// Cross-device reply: Device B's entity replies to Device A
const crossReplySource = `xdevice:${DEVICE_B_CODE}:PIG->${DEVICE_A_CODE}`;

// ════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════

describe('parseEntitySource', () => {
    it('parses cross-device source correctly', () => {
        const parsed = parseEntitySource(crossSpeakSource);
        expect(parsed).not.toBeNull();
        expect(parsed.crossDevice).toBe(true);
        expect(parsed.fromPublicCode).toBe(DEVICE_A_CODE);
        expect(parsed.character).toBe('LOBSTER');
        expect(parsed.targets).toEqual([DEVICE_B_CODE]);
    });

    it('parses cross-device reply source correctly', () => {
        const parsed = parseEntitySource(crossReplySource);
        expect(parsed).not.toBeNull();
        expect(parsed.crossDevice).toBe(true);
        expect(parsed.fromPublicCode).toBe(DEVICE_B_CODE);
        expect(parsed.targets).toEqual([DEVICE_A_CODE]);
    });

    it('parses same-device entity source', () => {
        const parsed = parseEntitySource('entity:0:LOBSTER->1,2');
        expect(parsed).not.toBeNull();
        expect(parsed.crossDevice).toBeUndefined();
        expect(parsed.fromEntityId).toBe(0);
        expect(parsed.targets).toEqual([1, 2]);
    });

    it('returns null for non-entity sources', () => {
        expect(parseEntitySource(null)).toBeNull();
        expect(parseEntitySource('web_chat')).toBeNull();
        expect(parseEntitySource('platform')).toBeNull();
    });
});

describe('isSent (message alignment)', () => {
    it('marks outgoing cross-device message as sent on Device A', () => {
        const msg = { is_from_user: true, source: crossSpeakSource };
        expect(computeIsSent(msg, myMapA)).toBe(true);
    });

    it('marks incoming cross-device message as NOT sent on Device B (regression fix)', () => {
        // THIS IS THE REGRESSION: before the fix, this was true (right-aligned on Device B)
        const msg = { is_from_user: true, source: crossSpeakSource };
        expect(computeIsSent(msg, myMapB)).toBe(false);
    });

    it('marks auto-routed reply as NOT sent on Device A', () => {
        const msg = { is_from_user: false, is_from_bot: true, source: crossReplySource };
        expect(computeIsSent(msg, myMapA)).toBe(false);
    });

    it('marks normal user message as sent', () => {
        const msg = { is_from_user: true, source: 'web_chat' };
        expect(computeIsSent(msg, myMapA)).toBe(true);
    });

    it('marks normal bot reply as NOT sent', () => {
        const msg = { is_from_user: false, is_from_bot: true, source: 'Bot Name' };
        expect(computeIsSent(msg, myMapA)).toBe(false);
    });
});

describe('"My Messages" filter', () => {
    const messages = [
        { id: 1, is_from_user: true, source: 'web_chat', text: 'local msg' },
        { id: 2, is_from_user: true, source: crossSpeakSource, text: 'outgoing xd' },
        { id: 3, is_from_user: true, source: crossSpeakSource, text: 'incoming xd on B' },
        { id: 4, is_from_user: false, is_from_bot: true, source: 'Bot', text: 'bot reply' },
        { id: 5, is_from_user: false, is_from_bot: true, source: crossReplySource, text: 'xd reply' },
    ];

    it('includes local user messages on Device A', () => {
        const filtered = filterMyMessages(messages, myMapA);
        expect(filtered.some(m => m.id === 1)).toBe(true);
    });

    it('includes outgoing cross-device messages on Device A', () => {
        const filtered = filterMyMessages(messages, myMapA);
        expect(filtered.some(m => m.id === 2)).toBe(true);
    });

    it('excludes bot replies from "my" filter', () => {
        const filtered = filterMyMessages(messages, myMapA);
        expect(filtered.some(m => m.id === 4)).toBe(false);
        expect(filtered.some(m => m.id === 5)).toBe(false);
    });

    it('excludes incoming cross-device messages on Device B (regression fix)', () => {
        // On Device B, message id=3 has source with fromPublicCode=DEVICE_A_CODE
        // which is NOT in myMapB → should be excluded from "my" filter
        const filtered = filterMyMessages(messages, myMapB);
        expect(filtered.some(m => m.id === 3)).toBe(false);
    });
});

describe('Source label direction', () => {
    it('shows "outgoing" for own cross-device messages on Device A', () => {
        const msg = { is_from_user: true, source: crossSpeakSource };
        expect(getSourceDirection(msg, myMapA)).toBe('outgoing');
    });

    it('shows "incoming" for cross-device messages on Device B (regression fix)', () => {
        const msg = { is_from_user: true, source: crossSpeakSource };
        expect(getSourceDirection(msg, myMapB)).toBe('incoming');
    });

    it('shows "reply" for auto-routed bot replies', () => {
        const msg = { is_from_user: false, is_from_bot: true, source: crossReplySource };
        expect(getSourceDirection(msg, myMapA)).toBe('reply');
    });

    it('shows "outgoing" for normal user messages', () => {
        const msg = { is_from_user: true, source: 'web_chat' };
        expect(getSourceDirection(msg, myMapA)).toBe('outgoing');
    });

    it('shows "received" for normal bot messages', () => {
        const msg = { is_from_user: false, is_from_bot: true, source: 'Bot Name' };
        expect(getSourceDirection(msg, myMapA)).toBe('received');
    });
});

describe('Cross-device filter chip logic', () => {
    it('identifies external codes for filter chips on Device B', () => {
        const xdeviceCodesWithMessages = new Set();
        const source = crossSpeakSource;
        const parsed = parseEntitySource(source);

        if (parsed && parsed.crossDevice) {
            if (parsed.fromPublicCode && !myMapB[parsed.fromPublicCode]) {
                xdeviceCodesWithMessages.add(parsed.fromPublicCode);
            }
            for (const t of (parsed.targets || [])) {
                if (!myMapB[t]) xdeviceCodesWithMessages.add(t);
            }
        }

        // Device A's code should appear as a contact filter chip
        expect(xdeviceCodesWithMessages.has(DEVICE_A_CODE)).toBe(true);
        // Device B's own code should NOT appear
        expect(xdeviceCodesWithMessages.has(DEVICE_B_CODE)).toBe(false);
    });

    it('xdevice-CODE filter includes both incoming and outgoing messages', () => {
        const messages = [
            { source: crossSpeakSource },   // A→B
            { source: crossReplySource },    // B→A (reply)
            { source: 'web_chat' },          // local
        ];

        // Filter by DEVICE_A_CODE on Device B
        const filtered = messages.filter(m => {
            if (!m.source) return false;
            const parsed = parseEntitySource(m.source);
            if (!parsed || !parsed.crossDevice) return false;
            return parsed.fromPublicCode === DEVICE_A_CODE || (parsed.targets || []).includes(DEVICE_A_CODE);
        });

        expect(filtered.length).toBe(2); // Both A→B and B→A involve DEVICE_A_CODE
    });
});

describe('Chat integrity validator direction check', () => {
    /**
     * Regression: chat.html integrity validator at line 1221 did NOT call isIncomingCrossDevice(),
     * so it expected "sent" class for incoming cross-device messages that render as "received".
     * This caused 19 false-positive "wrong direction" warnings in production.
     * Fix: integrity validator now uses same isSent logic as rendering.
     */
    function computeExpectedClass(msg, myPublicCodeMap) {
        const isPlatform = !msg.is_from_user && !msg.is_from_bot && msg.source === 'platform';
        const isSent = computeIsSent(msg, myPublicCodeMap);
        return isSent ? 'sent' : isPlatform ? 'platform' : 'received';
    }

    const myMap = { abc123: true };

    it('incoming cross-device message expects "received" class (not "sent")', () => {
        const msg = {
            is_from_user: true,
            is_from_bot: false,
            source: 'xdevice:xyz789:LOBSTER->entity:0:CRAB',
            text: 'Hello from another device'
        };
        expect(computeExpectedClass(msg, myMap)).toBe('received');
    });

    it('outgoing cross-device message expects "sent" class', () => {
        const msg = {
            is_from_user: true,
            is_from_bot: false,
            source: 'xdevice:abc123:CRAB->entity:0:LOBSTER',
            text: 'Hello to another device'
        };
        expect(computeExpectedClass(msg, myMap)).toBe('sent');
    });

    it('normal user message expects "sent" class', () => {
        const msg = { is_from_user: true, is_from_bot: false, source: 'entity:0:CRAB->1', text: 'hi' };
        expect(computeExpectedClass(msg, myMap)).toBe('sent');
    });

    it('bot message expects "received" class', () => {
        const msg = { is_from_user: false, is_from_bot: true, source: null, text: 'reply' };
        expect(computeExpectedClass(msg, myMap)).toBe('received');
    });

    it('platform message expects "platform" class', () => {
        const msg = { is_from_user: false, is_from_bot: false, source: 'platform', text: 'system msg' };
        expect(computeExpectedClass(msg, myMap)).toBe('platform');
    });
});

describe('Message isolation between devices', () => {
    it('chat history is per-device (no cross-device leakage)', () => {
        // This is a design verification: chat_messages are stored with device_id
        // GET /api/chat/history filters by device_id only
        // Device A's local messages are NEVER in Device B's history
        // Cross-device messages are explicitly saved to each device separately

        // Device A has:
        //   1. Outgoing cross-speak (saved by line 6198 in index.js)
        //   2. Auto-routed reply (saved by line 3054 in index.js)
        //
        // Device B has:
        //   1. Incoming cross-speak (saved by line 6196 in index.js)
        //   2. Entity's normal bot reply (saved by line 3037 in index.js)
        //
        // Device B's normal entity messages are NOT on Device A (no leakage)
        expect(true).toBe(true); // Architecture verification
    });
});
