// Tests pin the wire format that channel plugins forward to bots. If you
// change the materialised layout, also bump the version note in
// openclaw-channel-eclaw/src/webhook-handler.ts.

const {
    SILENT_TOKEN,
    buildMentionsBlock,
    enrichContext,
    materializeChannelText,
} = require('../../push-context');

// ── buildMentionsBlock ────────────────────────────────────────────────────
describe('buildMentionsBlock', () => {
    test('returns empty string when no mentions and no @all', () => {
        expect(buildMentionsBlock(null)).toBe('');
        expect(buildMentionsBlock({})).toBe('');
        expect(buildMentionsBlock({ mentions: [], hasAll: false })).toBe('');
    });

    test('renders single same-device mention', () => {
        const block = buildMentionsBlock({
            mentions: [{ name: 'Alice', publicCode: 'AB12CD', isCrossDevice: false }],
            hasAll: false,
        });
        expect(block).toContain('[MENTIONS — IMPORTANT ROUTING HINT]');
        expect(block).toContain('tagged 1 entity');
        expect(block).toContain('@Alice (publicCode: AB12CD)');
        expect(block).not.toContain('cross-device');
        expect(block).toContain('"AB12CD"');
        expect(block).toContain('speakTo');
        expect(block).toContain('MUST call');
        expect(block).toContain('Do NOT fall back');
        expect(block).not.toContain('broadcast:true');
    });

    test('marks cross-device mentions explicitly', () => {
        const block = buildMentionsBlock({
            mentions: [
                { name: 'Bob', publicCode: 'XY99ZZ', isCrossDevice: true },
            ],
        });
        expect(block).toContain('@Bob (publicCode: XY99ZZ, cross-device)');
    });

    test('renders @all and includes broadcast hint', () => {
        const block = buildMentionsBlock({ mentions: [], hasAll: true });
        expect(block).toContain('tagged 1 entity');
        expect(block).toContain('@all (broadcast to every bound entity on this device)');
        expect(block).toContain('broadcast:true');
        expect(block).toContain('MUST call');
    });

    test('renders @all + explicit mentions together', () => {
        const block = buildMentionsBlock({
            mentions: [{ name: 'Carol', publicCode: 'PQ77RS', isCrossDevice: false }],
            hasAll: true,
        });
        expect(block).toContain('tagged 2 entities');
        expect(block).toContain('@all (broadcast to every bound entity on this device)');
        expect(block).toContain('@Carol (publicCode: PQ77RS)');
        expect(block).toContain('AND/OR broadcast:true');
    });

    test('same-device mention bullet includes entityId so bots can use @#N or @N', () => {
        const block = buildMentionsBlock({
            mentions: [
                { name: 'EClaw 小助手', publicCode: 'aaaaaa', entityId: 0, isCrossDevice: false }
            ],
        });
        expect(block).toContain('@EClaw 小助手 (publicCode: aaaaaa, entityId: 0)');
    });

    test('cross-device mention bullet OMITS entityId (entityId is local-only)', () => {
        const block = buildMentionsBlock({
            mentions: [
                { name: 'Remote', publicCode: 'remoot', entityId: 7, isCrossDevice: true }
            ],
        });
        // entityId is meaningless across devices — should not appear
        expect(block).toContain('@Remote (publicCode: remoot, cross-device)');
        expect(block).not.toContain('entityId: 7');
    });

    test('imperative wording discourages fallback to previous conversation partner', () => {
        // Regression for the bug where bot #0 defaulted to speak-to its
        // existing b2b partner instead of following the user's @-tag.
        const block = buildMentionsBlock({
            mentions: [{ name: 'Target', publicCode: 'AAAAAA', isCrossDevice: false }],
            hasAll: false,
        });
        expect(block).toMatch(/do NOT fall back to a previous conversation partner/i);
        expect(block).toMatch(/authoritative routing target/i);
    });
});

// ── enrichContext ─────────────────────────────────────────────────────────
describe('enrichContext', () => {
    const fakeHelpers = {
        getMissionApiHints: jest.fn(() => '\n\n[AVAILABLE TOOLS — Mission Dashboard]\n...'),
        buildIdentitySetupHint: jest.fn(() => ''),
        buildBroadcastRecipientBlock: jest.fn(() => '[BROADCAST RECIPIENTS] ...'),
    };
    const fakeEntity = { botSecret: 'bs-XXX' };
    const fakeDevice = { entities: { 0: fakeEntity } };

    afterEach(() => {
        jest.clearAllMocks();
    });

    test('always sets a default silentToken', () => {
        const ctx = enrichContext(null, {
            helpers: fakeHelpers,
            apiBase: 'https://eclawbot.com',
            targetEntity: fakeEntity,
            targetDeviceId: 'dev1',
            targetEntityId: 0,
        });
        expect(ctx.silentToken).toBe(SILENT_TOKEN);
    });

    test('preserves caller-supplied silentToken', () => {
        const ctx = enrichContext({ silentToken: '[QUIET]' }, {
            helpers: fakeHelpers,
            targetEntity: fakeEntity,
            targetDeviceId: 'dev1',
            targetEntityId: 0,
        });
        expect(ctx.silentToken).toBe('[QUIET]');
    });

    test('fills in missionHints when missing', () => {
        const ctx = enrichContext({}, {
            helpers: fakeHelpers,
            apiBase: 'https://eclawbot.com',
            targetEntity: fakeEntity,
            targetDeviceId: 'dev1',
            targetEntityId: 0,
        });
        expect(fakeHelpers.getMissionApiHints).toHaveBeenCalledWith(
            'https://eclawbot.com',
            'dev1',
            0,
            'bs-XXX'
        );
        expect(ctx.missionHints).toContain('[AVAILABLE TOOLS');
    });

    test('does NOT overwrite caller-supplied missionHints', () => {
        const ctx = enrichContext({ missionHints: 'custom hints' }, {
            helpers: fakeHelpers,
            targetEntity: fakeEntity,
            targetDeviceId: 'dev1',
            targetEntityId: 0,
        });
        expect(ctx.missionHints).toBe('custom hints');
        expect(fakeHelpers.getMissionApiHints).not.toHaveBeenCalled();
    });

    test('only fills recipientBlock when 2+ recipients are present', () => {
        const single = enrichContext({}, {
            helpers: fakeHelpers,
            targetDevice: fakeDevice,
            targetEntityId: 0,
            broadcastRecipients: [0],
        });
        expect(single.recipientBlock).toBeUndefined();

        const many = enrichContext({}, {
            helpers: fakeHelpers,
            targetDevice: fakeDevice,
            targetEntityId: 0,
            broadcastRecipients: [0, 1, 2],
        });
        expect(many.recipientBlock).toContain('[BROADCAST RECIPIENTS]');
    });

    test('skips missionHints fill when targetEntity is missing', () => {
        const ctx = enrichContext({}, {
            helpers: fakeHelpers,
            targetEntity: null,
            targetDeviceId: 'dev1',
            targetEntityId: 0,
        });
        expect(ctx.missionHints).toBeUndefined();
        expect(fakeHelpers.getMissionApiHints).not.toHaveBeenCalled();
    });

    test('never auto-fills identityHint (helper has a side-effect on the entity)', () => {
        // buildIdentitySetupHint mutates entity._identityHintCount and is rate
        // limited to 3 sessions; auto-filling on every channel push would burn
        // that quota faster than the original webhook path. The helper must
        // never be reached via enrichContext.
        const ctx = enrichContext({}, {
            helpers: fakeHelpers,
            targetEntity: fakeEntity,
            targetDeviceId: 'dev1',
            targetEntityId: 0,
        });
        expect(ctx.identityHint).toBeUndefined();
        expect(fakeHelpers.buildIdentitySetupHint).not.toHaveBeenCalled();
    });

    test('pre-renders mentionsBlock from raw mentions/hasAll', () => {
        const ctx = enrichContext(
            { mentions: [{ name: 'Alice', publicCode: 'AB12CD', isCrossDevice: false }] },
            { helpers: fakeHelpers, targetEntity: fakeEntity, targetDeviceId: 'd', targetEntityId: 0 }
        );
        expect(ctx.mentionsBlock).toContain('[MENTIONS — IMPORTANT ROUTING HINT]');
        expect(ctx.mentionsBlock).toContain('@Alice (publicCode: AB12CD)');
    });

    test('preserves caller-supplied mentionsBlock without re-rendering', () => {
        const ctx = enrichContext(
            { mentionsBlock: 'CUSTOM', mentions: [{ name: 'X', publicCode: 'YY', isCrossDevice: false }] },
            { helpers: fakeHelpers }
        );
        expect(ctx.mentionsBlock).toBe('CUSTOM');
    });
});

// ── materializeChannelText ────────────────────────────────────────────────
describe('materializeChannelText — wire format', () => {
    test('plain message with no context returns just the text', () => {
        const out = materializeChannelText({ event: 'message', text: 'hello' }, {});
        expect(out).toBe('hello');
    });

    test('plain message with mission hints appends them after the body', () => {
        const out = materializeChannelText(
            { event: 'message', text: 'hello world' },
            { missionHints: '\n\n[AVAILABLE TOOLS — Mission Dashboard]\nfoo bar' }
        );
        const lines = out.split('\n\n');
        expect(lines[0]).toBe('hello world');
        expect(lines[1]).toContain('[AVAILABLE TOOLS — Mission Dashboard]');
    });

    test('plain message with @mentions inlines a [MENTIONS] block AFTER the body', () => {
        const out = materializeChannelText(
            { event: 'message', text: 'hey @Alice can you take this?' },
            { mentionsBlock: buildMentionsBlock({ mentions: [{ name: 'Alice', publicCode: 'AB12CD', isCrossDevice: false }] }) }
        );
        const bodyIdx = out.indexOf('hey @Alice');
        const mentionIdx = out.indexOf('[MENTIONS — IMPORTANT ROUTING HINT]');
        expect(bodyIdx).toBeGreaterThanOrEqual(0);
        expect(mentionIdx).toBeGreaterThan(bodyIdx);
        expect(out).toContain('@Alice (publicCode: AB12CD)');
    });

    test('plain message with @all inlines the broadcast hint', () => {
        const out = materializeChannelText(
            { event: 'message', text: '@all heads up' },
            { mentionsBlock: buildMentionsBlock({ hasAll: true }) }
        );
        expect(out).toContain('[MENTIONS — IMPORTANT ROUTING HINT]');
        expect(out).toContain('@all (broadcast to every bound entity on this device)');
        expect(out).toContain('broadcast:true');
    });

    test('entity_message event groups [Bot-to-Bot] prefix and quota line on adjacent lines', () => {
        const out = materializeChannelText(
            {
                event: 'entity_message',
                text: 'need a status update',
                fromEntityId: 2,
                fromCharacter: 'Alice',
            },
            { b2bRemaining: 5, b2bMax: 8, silentToken: SILENT_TOKEN }
        );
        // Header (prefix + quota) is one section, body is the next.
        const sections = out.split('\n\n');
        expect(sections[0]).toBe(
            '[Bot-to-Bot message from Entity 2 (Alice)]\n' +
            '[Quota: 5/8 bot-to-bot remaining — output "[SILENT]" if no new info worth replying to]'
        );
        expect(sections[1]).toBe('need a status update');
    });

    test('entity_message without fromCharacter falls back to bare entity label', () => {
        const out = materializeChannelText(
            { event: 'entity_message', text: 'hi', fromEntityId: 3 },
            {}
        );
        expect(out).toContain('[Bot-to-Bot message from Entity 3]');
        expect(out).not.toContain('(undefined)');
    });

    test('broadcast event renders [Broadcast from] prefix', () => {
        const out = materializeChannelText(
            {
                event: 'broadcast',
                text: 'team meeting in 5',
                fromEntityId: 1,
                fromCharacter: 'Boss',
            },
            { b2bRemaining: 7, b2bMax: 8, silentToken: SILENT_TOKEN }
        );
        expect(out).toContain('[Broadcast from Entity 1 (Boss)]');
        expect(out).toContain('[Quota: 7/8');
    });

    test('kanban_notification with mission hints includes them in trailer', () => {
        const out = materializeChannelText(
            { event: 'kanban_notification', text: 'New card assigned: Fix the bug' },
            { missionHints: '[AVAILABLE TOOLS — Mission Dashboard] curl ...' }
        );
        expect(out).toContain('New card assigned: Fix the bug');
        expect(out).toContain('[AVAILABLE TOOLS — Mission Dashboard]');
        const bodyIdx = out.indexOf('New card');
        const hintsIdx = out.indexOf('[AVAILABLE TOOLS');
        expect(hintsIdx).toBeGreaterThan(bodyIdx);
    });

    test('media attachment label is appended to body, not the trailer', () => {
        const out = materializeChannelText(
            {
                event: 'message',
                text: 'check this out',
                mediaType: 'photo',
                mediaUrl: 'https://example.com/img.jpg',
                backupUrl: 'https://backup.example.com/img.jpg',
            },
            {}
        );
        expect(out).toBe('check this out\n[Image: https://backup.example.com/img.jpg]');
    });

    test('media without text emits a label-only body', () => {
        const out = materializeChannelText(
            {
                event: 'message',
                text: '',
                mediaType: 'voice',
                mediaUrl: 'https://example.com/v.ogg',
            },
            {}
        );
        expect(out).toBe('[Voice: https://example.com/v.ogg]');
    });

    test('broadcast recipient block is rendered before the body', () => {
        const out = materializeChannelText(
            {
                event: 'message',
                text: 'attention all',
            },
            { recipientBlock: '[BROADCAST RECIPIENTS] This message was sent to 3 entities:\n- entity_0\n- entity_1\n- entity_2\n' }
        );
        const recipIdx = out.indexOf('[BROADCAST RECIPIENTS]');
        const bodyIdx = out.indexOf('attention all');
        expect(recipIdx).toBeGreaterThanOrEqual(0);
        expect(bodyIdx).toBeGreaterThan(recipIdx);
    });

    test('full kitchen-sink: entity_message with mentionsBlock, mission hints, identity hint', () => {
        const out = materializeChannelText(
            {
                event: 'entity_message',
                text: 'please relay this to @Alice',
                fromEntityId: 2,
                fromCharacter: 'Bob',
            },
            {
                b2bRemaining: 3,
                b2bMax: 8,
                silentToken: SILENT_TOKEN,
                mentionsBlock: buildMentionsBlock({
                    mentions: [{ name: 'Alice', publicCode: 'AB12CD', isCrossDevice: false }],
                }),
                missionHints: '[AVAILABLE TOOLS — Mission Dashboard]\ncurl ...',
                identityHint: '[IDENTITY_SETUP_REQUIRED]\nset your role',
            }
        );

        // Order: bot-to-bot prefix → quota → body → mentions → mission → identity
        const positions = {
            prefix: out.indexOf('[Bot-to-Bot message from Entity 2 (Bob)]'),
            quota: out.indexOf('[Quota: 3/8'),
            body: out.indexOf('please relay this to @Alice'),
            mentions: out.indexOf('[MENTIONS — IMPORTANT ROUTING HINT]'),
            mission: out.indexOf('[AVAILABLE TOOLS'),
            identity: out.indexOf('[IDENTITY_SETUP_REQUIRED]'),
        };
        expect(positions.prefix).toBeGreaterThanOrEqual(0);
        expect(positions.quota).toBeGreaterThan(positions.prefix);
        expect(positions.body).toBeGreaterThan(positions.quota);
        expect(positions.mentions).toBeGreaterThan(positions.body);
        expect(positions.mission).toBeGreaterThan(positions.mentions);
        expect(positions.identity).toBeGreaterThan(positions.mission);
    });

    test('cross-device mention is marked in the rendered block', () => {
        const out = materializeChannelText(
            { event: 'message', text: '@Bob can you help' },
            { mentionsBlock: buildMentionsBlock({ mentions: [{ name: 'Bob', publicCode: 'XY99ZZ', isCrossDevice: true }] }) }
        );
        expect(out).toContain('@Bob (publicCode: XY99ZZ, cross-device)');
    });

    test('null context degrades gracefully to bare text', () => {
        const out = materializeChannelText({ event: 'message', text: 'plain' }, null);
        expect(out).toBe('plain');
    });
});
