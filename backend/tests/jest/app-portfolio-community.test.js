const community = require('../../app-portfolio-community');
const express = require('express');
const request = require('supertest');

describe('app portfolio community validation', () => {
    test('accepts only portfolio app ids', () => {
        expect(community.isValidAppId('eclawbot')).toBe(true);
        expect(community.isValidAppId('unknown-app')).toBe(false);
        const catalog = require('../../public/AiHankApps/app-catalog.json');
        for (const app of catalog.apps) {
            expect(community.isValidAppId(app.communityId)).toBe(true);
        }
        expect(catalog.apps.map(app => app.communityId)).toEqual(expect.arrayContaining(['anthill', 'paper-flick-soldiers', 'rebound']));
        expect(catalog.apps.some(app => app.googlePackage === 'com.twopigs.echoesofnames')).toBe(false);
    });

    test('hashes valid visitor ids without storing raw ids', () => {
        const value = 'visitor-1234567890';
        const hash = community.visitorHash(value);
        expect(hash).toHaveLength(64);
        expect(hash).not.toContain(value);
        expect(community.visitorHash('short')).toBeNull();
    });

    test('normalizes and limits public text', () => {
        expect(community.cleanText('  hello\r\nworld  ', 50)).toBe('hello\nworld');
        expect(community.cleanText('abcdef', 3)).toBe('abc');
        expect(community.cleanText(null, 20)).toBe('');
    });

    test('accepts only anonymous, bounded beta feedback payloads', () => {
        const clean = community.cleanBetaFeedback({
            submissionId: 'ab'.repeat(18),
            rating: 5,
            continuation: 'yes',
            comment: '  保留移動即攻擊\r\n改善介面  ',
            version: '1.0.4',
            platform: 'Android',
            deviceId: 'must-not-be-stored',
        });
        expect(clean).toEqual({
            submissionId: 'ab'.repeat(18),
            rating: 5,
            continuation: 'yes',
            comment: '保留移動即攻擊\n改善介面',
            version: '1.0.4',
            platform: 'Android',
        });
        expect(clean).not.toHaveProperty('deviceId');
        expect(community.cleanBetaFeedback({ submissionId: 'short', rating: 5, continuation: 'yes', version: '1', platform: 'Android' })).toBeNull();
        expect(community.cleanBetaFeedback({ submissionId: 'ab'.repeat(18), rating: 6, continuation: 'yes', version: '1', platform: 'Android' })).toBeNull();
        expect(community.cleanBetaFeedback({ submissionId: 'ab'.repeat(18), rating: 4, continuation: 'later', version: '1', platform: 'Android' })).toBeNull();
    });

    test('stores beta feedback once and returns the same receipt on retry', async () => {
        const stored = new Map();
        const inserts = [];
        const pool = {
            query: jest.fn(async (sql, params = []) => {
                if (/CREATE (?:TABLE|INDEX)/.test(sql)) return { rowCount: 0, rows: [] };
                if (/INSERT INTO app_portfolio_beta_feedback/.test(sql)) {
                    inserts.push(params);
                    const key = `${params[0]}:${params[1]}`;
                    if (stored.has(key)) return { rowCount: 0, rows: [] };
                    stored.set(key, '81');
                    return { rowCount: 1, rows: [{ receiptId: '81' }] };
                }
                if (/FROM app_portfolio_beta_feedback/.test(sql)) {
                    return { rowCount: 1, rows: [{ receiptId: stored.get(`${params[0]}:${params[1]}`) }] };
                }
                throw new Error(`Unexpected SQL in test: ${sql}`);
            }),
        };
        const app = express();
        app.use('/api/app-portfolio', community.createRouter(() => pool));
        const payload = {
            submissionId: 'cd'.repeat(18), rating: 4, continuation: 'maybe',
            comment: '希望戰場資訊更清楚', version: '1.0.4', platform: 'Android',
            deviceId: 'must-not-be-stored',
        };
        const first = await request(app).post('/api/app-portfolio/apps/paper-flick-soldiers/beta-feedback').send(payload);
        const retry = await request(app).post('/api/app-portfolio/apps/paper-flick-soldiers/beta-feedback').send(payload);
        expect(first.status).toBe(201);
        expect(first.body).toEqual({ success: true, receiptId: '81', duplicate: false });
        expect(retry.status).toBe(200);
        expect(retry.body).toEqual({ success: true, receiptId: '81', duplicate: true });
        expect(inserts[0]).toEqual(['paper-flick-soldiers', payload.submissionId, 4, 'maybe', payload.comment, '1.0.4', 'Android']);
        expect(inserts.flat()).not.toContain(payload.deviceId);
    });
});
