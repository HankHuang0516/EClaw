'use strict';

const fs = require('node:fs');
const { createHash } = require('node:crypto');
const REGION_LOCALES = Object.freeze({ 'TW-TPE': 'zh-TW', 'US-WA': 'en-US' });
const WORDS = {
    'zh-TW': {
        kinds: { DOG: '犬隻', CAT: '貓咪', OTHER_STRAY: '其他流浪動物' },
        reports: { LOST: '走失', FOUND: '拾獲', SIGHTING: '目擊' },
        title: (kind, report) => `${kind}${report}線索`,
        description: '這是第三方公開來源的概略區域線索，仍待人工審查。',
    },
    'en-US': {
        kinds: { DOG: 'Dog', CAT: 'Cat', OTHER_STRAY: 'Other stray animal' },
        reports: { LOST: 'missing', FOUND: 'found', SIGHTING: 'sighting' },
        title: (kind, report) => `${kind}: ${report} lead`,
        description: 'This third-party public lead identifies a broad region and awaits human review.',
    },
};
const MEANING = { LOST: 'LAST_KNOWN', FOUND: 'FOUND_AT', SIGHTING: 'OBSERVED_AT' };
const id = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const smallLabel = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value);
const validCase = c => c && Object.getPrototypeOf(c) === Object.prototype
    && Object.keys(c).length === 5 && smallLabel(c.case)
    && ['region', 'locale'].every(key => Object.hasOwn(c, key) && (c[key] === null || (typeof c[key] === 'string' && /^[a-zA-Z0-9-]{2,15}$/.test(c[key]))))
    && Object.hasOwn(MEANING, c.report) && Object.hasOwn(WORDS['en-US'].kinds, c.kind);
const examples = [
    { case: 'taipei-sighting', region: 'TW-TPE', locale: 'zh-TW', kind: 'DOG', report: 'SIGHTING' },
    { case: 'washington-lost', region: 'US-WA', locale: 'en-US', kind: 'CAT', report: 'LOST' },
    { case: 'missing-locale', region: 'TW-TPE', locale: null, kind: 'DOG', report: 'FOUND' },
    { case: 'missing-region', region: null, locale: 'en-US', kind: 'DOG', report: 'SIGHTING' },
    { case: 'locale-conflict', region: 'US-WA', locale: 'zh-TW', kind: 'CAT', report: 'FOUND' },
];
function parseExtraCases(file) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 4096) throw Error('CASE_FILE_MUST_BE_SMALL_JSON_FILE');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data?.synthetic !== true || Object.keys(data).length !== 2 || !Array.isArray(data.cases)
        || data.cases.length > 4 || !data.cases.every(validCase)
        || new Set([...examples, ...data.cases].map(c => c.case)).size !== examples.length + data.cases.length) throw Error('INVALID_SYNTHETIC_CASE_FILE');
    return data.cases;
}
function prepare(record, scope) {
    if (!validCase(record)) throw Error('INVALID_SYNTHETIC_SOURCE_RECORD');
    const key = id([scope.publisherId, scope.datasetId, record.case]);
    const reasons = [];
    const locale = Object.hasOwn(REGION_LOCALES, record.region) ? REGION_LOCALES[record.region] : null;
    if (!locale) reasons.push('LOCATION_UNCONFIRMED');
    if (!Object.hasOwn(WORDS, record.locale)) reasons.push('LANGUAGE_UNCONFIRMED');
    else if (locale && record.locale !== locale) reasons.push('LANGUAGE_LOCATION_CONFLICT');
    if (reasons.length) return { key, reasons };
    const country = record.region.slice(0, 2), words = WORDS[locale];
    const unknown = { precision: 'UNKNOWN', value: null, timeZone: null };
    const observation = country === 'TW'
        ? { precision: 'INSTANT', value: '2026-11-26T17:00:00+08:00', timeZone: 'Asia/Taipei' }
        : { precision: 'DATE', value: '2026-11-25', timeZone: 'America/Los_Angeles' };
    return {
        key, payload: {
            schemaVersion: 3, thirdParty: true, selfWitness: false,
            source: { publisherId: scope.publisherId, datasetId: scope.datasetId, recordKey: key, url: null,
                publishedAt: { precision: 'INSTANT', value: '2026-11-26T18:00:00Z', timeZone: 'UTC' } },
            observation, animal: { kind: record.kind, count: null, condition: 'UNKNOWN' },
            location: { countryCode: country, regionCode: record.region, sensitivity: 'NONE' },
            display: { locale, title: words.title(words.kinds[record.kind], words.reports[record.report]), description: words.description },
            photos: [], report: { type: record.report, locationMeaning: MEANING[record.report], custody: { status: 'UNKNOWN', asOf: unknown } },
        },
    };
}

/** One model-free patrol tick. The host supplies a persistent clock gate and its authorized source and receiver adapters. */
async function patrolTick({ enabled, reserve, readSource, send, hold, scope }) {
    if (!enabled()) return { skipped: 'DISABLED', cases: [] };
    if (!await reserve()) return { skipped: 'NOT_DUE', cases: [] };
    if (!enabled()) return { skipped: 'DISABLED', cases: [] };
    const feed = await readSource();
    if (feed?.synthetic !== true || !Array.isArray(feed.records) || feed.records.length > 12) throw Error('INVALID_SYNTHETIC_FEED');
    const candidates = feed.records.map(record => ({ record, ...prepare(record, scope) }));
    const cases = [];
    for (const { record, key, reasons, payload } of candidates) {
        if (!enabled()) break;
        if (reasons) {
            await hold({ key, label: record.case, reasons });
            cases.push({ label: record.case, hold: reasons });
            continue;
        }
        let retries = 0, result;
        try { result = await send(payload, key); }
        catch (error) {
            if (error?.code !== 'ACKNOWLEDGEMENT_UNAVAILABLE' || !enabled()) throw error;
            retries++;
            result = await send(payload, key);
        }
        if (result.status !== 202 || result.body?.success !== true || result.body.receipt?.status !== 'PENDING'
            || result.body.receipt.publicVisible !== false || !/^tip_[a-f0-9]{32}$/.test(result.body.receipt.tipId)) throw Error('PENDING_RECEIPT_REQUIRED');
        cases.push({ label: record.case, locale: payload.display.locale, title: payload.display.title,
            region: payload.location.regionCode, precision: payload.observation.precision,
            http: result.status, receipt: result.body.receipt, replay: result.body.replay, retries });
    }
    return { skipped: null, cases };
}

module.exports = { parseExtraCases, examples, prepare, patrolTick, REGION_LOCALES, id };
