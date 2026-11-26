'use strict';
const f = require('./synthetic-fixtures');
function caseTip(type) {
    const body = type === 'SIGHTING' ? f.taiwan() : f.washington();
    body.schemaVersion = 3;
    body.animal.condition = type === 'SIGHTING' ? 'INJURED' : 'HEALTHY';
    body.source.recordKey = `private_synthetic_${type.toLowerCase()}_001`;
    body.report = { type, locationMeaning: { LOST: 'LAST_KNOWN', FOUND: 'FOUND_AT', SIGHTING: 'OBSERVED_AT' }[type],
        custody: { status: 'UNKNOWN', asOf: f.unknown() } };
    if (type === 'LOST') {
        body.observation = f.date('2026-11-24');
        body.display = { locale: 'en-US', title: 'Synthetic missing dog lead',
            description: 'Invented case. Washington state is the last known region, not a new sighting or current location.' };
    } else if (type === 'FOUND') {
        Object.assign(body.source, { publisherId: f.peerPolicy.publisherId, datasetId: f.peerPolicy.datasetId,
            publishedAt: f.date('2026-11-26') });
        body.report.custody = { status: 'IN_CARE', asOf: f.date('2026-11-26') };
        body.display = { locale: 'en-US', title: 'Synthetic found dog lead',
            description: 'Invented case. Found in Washington state. Care is source-reported; no present care location is supplied.' };
    } else {
        body.display = { locale: 'zh-TW', title: '合成直接目擊：台北市犬隻', description: '來源記錄此時目擊疑似受傷犬隻；匯入者不是本人目擊，不推論照管狀態。' };
    }
    return body;
}
function event(body, type, suffix = '001') {
    return { publisherId: body.source.publisherId, datasetId: body.source.datasetId, recordKey: body.source.recordKey,
        eventKey: `synthetic_event_${type.toLowerCase()}_${suffix}`, type, sourceChangedAt: f.unknown() };
}
module.exports = { caseTip, event };
