'use strict';
// Entirely invented fixtures. No source polling, real photograph, licence claim or animal record.
const SUBMITTED = '2026-11-26T12:00:00.000Z';
const policy = { verified: true, publisherId: 'synthetic-a', datasetId: 'synthetic-dataset-a',
    origin: 'https://news.example.invalid', pathPrefix: '/public-tips/', allowedRegions: ['TW-TPE', 'US-WA'] };
const peerPolicy = { ...policy, publisherId: 'synthetic-b', datasetId: 'synthetic-dataset-b', origin: 'https://peer.example.invalid' };
const rights = { license: 'EXPLICIT_PERMISSION', evidenceRef: 'ev_synthetic001', attributionRef: 'credit_synthetic001', permitsRedaction: true };
const safeFlags = ['reuseConsentVerified', 'exifRemoved', 'geoRemoved', 'manualRedactionConfirmed',
    'noFacesOrPlates', 'noPersonalData', 'noSensitiveVisualLocation', 'caseMatchConfirmed'];
const instant = (value, timeZone) => ({ precision: 'INSTANT', value, timeZone });
const date = value => ({ precision: 'DATE', value, timeZone: 'America/Los_Angeles' });
const unknown = () => ({ precision: 'UNKNOWN', value: null, timeZone: null });
const clone = object => JSON.parse(JSON.stringify(object));
function taiwan() {
    return { schemaVersion: 2, thirdParty: true, selfWitness: false,
        source: { publisherId: policy.publisherId, datasetId: policy.datasetId, recordKey: 'private_synthetic_tw_001',
            url: null, publishedAt: instant('2026-11-26T18:00:00+08:00', 'Asia/Taipei') },
        observation: instant('2026-11-26T17:00:00+08:00', 'Asia/Taipei'),
        animal: { kind: 'DOG', count: null, condition: 'ROAMING' },
        location: { countryCode: 'TW', regionCode: 'TW-TPE', sensitivity: 'NONE' },
        display: { locale: 'zh-TW', title: '合成案例：台北市犬隻線索', description: '純測試資料，僅保留城市層級，不對應真實動物。' }, photos: [] };
}
function washington() {
    const body = taiwan();
    body.source.recordKey = 'private_synthetic_wa_001'; body.source.publishedAt = date('2026-11-25');
    body.observation = date('2026-11-25');
    body.location = { countryCode: 'US', regionCode: 'US-WA', sensitivity: 'NONE' };
    body.display = { locale: 'en-US', title: 'Synthetic Washington dog lead', description: 'Invented test case. Location is limited to Washington state.' };
    return body;
}
function photoFixture() {
    const body = taiwan();
    body.photos = [{ uploadId: 'up_synthetic001', rights: clone(rights), caption: '合成照片說明，沒有真實動物影像。' }];
    const upload = { uploadId: 'up_synthetic001', publisherId: policy.publisherId, datasetId: policy.datasetId,
        recordKey: body.source.recordKey, sourceUrl: null, status: 'VERIFIED_SAFE', sha256: 'a'.repeat(64),
        byteLength: 1024, mimeType: 'image/jpeg', width: 100, height: 100, rights: clone(rights),
        ...Object.fromEntries(safeFlags.map(flag => [flag, true])) };
    return { body, upload };
}
module.exports = { SUBMITTED, policy, peerPolicy, rights, safeFlags, instant, date, unknown, clone, taiwan, washington, photoFixture };
