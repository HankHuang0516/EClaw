'use strict';

const {
    collectSettingsHelpFanoutGaps,
    formatSettingsHelpFanoutWarnings,
} = require('../../scripts/i18n-check');

describe('settings-help fanout warnings', () => {
    const registry = [
        { labelKey: 'sample_label', helpKey: 'sample_help' },
        { labelKey: 'other_label', helpKey: 'other_help' },
    ];

    test('reports non-canonical locale gaps while skipping en, zh, and zh-TW stub', () => {
        const gaps = collectSettingsHelpFanoutGaps({
            en: { sample_label: 'Sample', sample_help: 'Help' },
            zh: { sample_label: '範例', sample_help: '說明' },
            'zh-TW': {},
            ja: { sample_label: 'Sample', other_label: 'Other', other_help: 'Other help' },
            ko: { sample_label: 'Sample', sample_help: 'Help', other_label: 'Other', other_help: 'Other help' },
            rootLeak: 'not a locale',
        }, registry);

        expect(gaps).toEqual([
            { locale: 'ja', missingKeys: ['sample_help'] },
        ]);
    });

    test('formats warnings as soft warnings, not hard gate failures', () => {
        const lines = formatSettingsHelpFanoutWarnings([
            { locale: 'ja', missingKeys: ['sample_help', 'other_help'] },
        ], { maxPreviewKeys: 1 });

        expect(lines.join('\n')).toContain('Settings-help fanout gaps');
        expect(lines.join('\n')).toContain('Soft warning only');
        expect(lines.join('\n')).toContain('zh-TW is a thin fallback stub and is skipped');
        expect(lines.join('\n')).toContain('ja: 2 missing (sample_help, ... +1 more)');
    });
});
