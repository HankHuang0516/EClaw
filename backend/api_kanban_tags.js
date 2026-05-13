'use strict';

/**
 * Device-scoped Kanban card tags.
 *
 * Tags are first-class rows (kanban_tags) linked to cards through
 * kanban_card_tags.  Slugs are normalized as trim/lower strings so duplicate
 * user input such as " UI " and "ui" resolves to one tag per device.
 */

const express = require('express');
const { Pool } = require('pg');
const safeEqual = require('./safe-equal');

const TAG_SLUG_MAX = 80;

function normalizeTagSlug(raw) {
    return String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9._:-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, TAG_SLUG_MAX);
}

function displayLabel(raw, slug) {
    const trimmed = String(raw || '').trim();
    return (trimmed || slug).slice(0, 120);
}

module.exports = function (devices, options = {}) {
    const router = express.Router();
    const pool = options.pool || new Pool({
        connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/realbot'
    });

    function findEntityByCredentials(deviceId, entityId, botSecret) {
        const device = devices[deviceId];
        if (!device) return null;
        const entity = (device.entities || {})[entityId];
        if (!entity || !safeEqual(entity.botSecret, botSecret)) return null;
        return entity;
    }

    function findDeviceByCredentials(deviceId, deviceSecret) {
        const device = devices[deviceId];
        if (!device || !safeEqual(device.deviceSecret, deviceSecret)) return null;
        return device;
    }

    function authenticate(req, res) {
        const params = { ...req.query, ...req.body };
        const { deviceId, deviceSecret, botSecret, entityId } = params;

        if (!deviceId) {
            res.status(400).json({ success: false, error: 'Missing deviceId' });
            return null;
        }

        if (deviceSecret) {
            const device = findDeviceByCredentials(deviceId, deviceSecret);
            if (device) return { deviceId, entityId: entityId ? parseInt(entityId, 10) : 0 };
        }

        if (botSecret) {
            const parsedEntityId = parseInt(entityId || 0, 10);
            const entity = findEntityByCredentials(deviceId, parsedEntityId, botSecret);
            if (entity) return { deviceId, entityId: parsedEntityId };
        }

        if (!deviceSecret && !botSecret) {
            res.status(400).json({ success: false, error: 'Missing deviceSecret or botSecret' });
        } else {
            res.status(401).json({ success: false, error: 'Invalid credentials' });
        }
        return null;
    }

    async function cardExistsInDevice(cardId, deviceId, queryable = pool) {
        const { rows } = await queryable.query(
            'SELECT id FROM kanban_cards WHERE id = $1 AND device_id = $2 LIMIT 1',
            [cardId, deviceId]
        );
        return rows.length > 0;
    }

    function mapTagRow(row) {
        return {
            id: row.id == null ? null : Number(row.id),
            slug: row.slug,
            label: row.label || row.slug,
            cardCount: row.card_count == null ? undefined : Number(row.card_count),
            createdBy: row.created_by == null ? undefined : Number(row.created_by),
            createdAt: row.created_at || null,
        };
    }

    async function listTagsForCard(deviceId, cardId) {
        const { rows } = await pool.query(
            `SELECT t.id, t.slug, t.label, t.created_by, t.created_at
             FROM kanban_card_tags ct
             JOIN kanban_tags t ON t.id = ct.tag_id AND t.device_id = ct.device_id
             WHERE ct.device_id = $1 AND ct.card_id = $2
             ORDER BY t.slug`,
            [deviceId, cardId]
        );
        return rows.map(mapTagRow);
    }

    // GET /card/:cardId/tags — list tags on one card.
    router.get('/card/:cardId/tags', async (req, res) => {
        const auth = authenticate(req, res);
        if (!auth) return;
        const { deviceId } = auth;
        const { cardId } = req.params;

        try {
            if (!(await cardExistsInDevice(cardId, deviceId))) {
                return res.status(404).json({ success: false, error: 'Card not found' });
            }
            res.json({ success: true, cardId, tags: await listTagsForCard(deviceId, cardId) });
        } catch (err) {
            console.error('[KanbanTags] GET tags error:', err);
            res.status(500).json({ success: false, error: 'Internal server error' });
        }
    });

    // POST /card/:cardId/tag — normalize/create a device tag and attach it to the card.
    router.post('/card/:cardId/tag', async (req, res) => {
        const auth = authenticate(req, res);
        if (!auth) return;
        const { deviceId, entityId } = auth;
        const { cardId } = req.params;
        const raw = (req.body && (req.body.tag || req.body.slug || req.body.name || req.body.label)) || '';
        const slug = normalizeTagSlug(raw);
        const label = displayLabel(raw, slug);

        if (!slug) {
            return res.status(400).json({ success: false, error: 'Missing tag' });
        }

        try {
            if (!(await cardExistsInDevice(cardId, deviceId))) {
                return res.status(404).json({ success: false, error: 'Card not found' });
            }

            const existingTag = await pool.query(
                `SELECT id, slug, label, created_by, created_at
                 FROM kanban_tags WHERE device_id = $1 AND slug = $2 LIMIT 1`,
                [deviceId, slug]
            );

            let tag;
            let createdTag = false;
            if (existingTag.rows.length) {
                tag = existingTag.rows[0];
            } else {
                const inserted = await pool.query(
                    `INSERT INTO kanban_tags (device_id, slug, label, created_by)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT (device_id, slug) DO UPDATE SET label = kanban_tags.label
                     RETURNING id, slug, label, created_by, created_at`,
                    [deviceId, slug, label, entityId || 0]
                );
                tag = inserted.rows[0];
                createdTag = true;
            }

            const existingLink = await pool.query(
                `SELECT 1 FROM kanban_card_tags
                 WHERE device_id = $1 AND card_id = $2 AND tag_id = $3 LIMIT 1`,
                [deviceId, cardId, tag.id]
            );
            let attached = false;
            if (!existingLink.rows.length) {
                await pool.query(
                    `INSERT INTO kanban_card_tags (device_id, card_id, tag_id, created_by)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT (device_id, card_id, tag_id) DO NOTHING`,
                    [deviceId, cardId, tag.id, entityId || 0]
                );
                attached = true;
                await pool.query('UPDATE kanban_cards SET updated_at = NOW() WHERE device_id = $1 AND id = $2', [deviceId, cardId]);
            }

            res.json({
                success: true,
                createdTag,
                attached,
                cardId,
                tag: mapTagRow(tag),
                tags: await listTagsForCard(deviceId, cardId),
            });
        } catch (err) {
            console.error('[KanbanTags] POST tag error:', err);
            res.status(500).json({ success: false, error: 'Internal server error' });
        }
    });

    // DELETE /card/:cardId/tag/:slug — remove one tag from a card. The tag row
    // remains so filters/graph labels stay stable if another card uses it.
    router.delete('/card/:cardId/tag/:slug', async (req, res) => {
        const auth = authenticate(req, res);
        if (!auth) return;
        const { deviceId } = auth;
        const { cardId } = req.params;
        const slug = normalizeTagSlug(req.params.slug || (req.body && req.body.tag));

        if (!slug) {
            return res.status(400).json({ success: false, error: 'Missing tag' });
        }

        try {
            const result = await pool.query(
                `DELETE FROM kanban_card_tags
                 WHERE device_id = $1
                   AND card_id = $2
                   AND tag_id IN (
                       SELECT id FROM kanban_tags WHERE device_id = $1 AND slug = $3
                   )`,
                [deviceId, cardId, slug]
            );
            if (result.rowCount > 0) {
                await pool.query('UPDATE kanban_cards SET updated_at = NOW() WHERE device_id = $1 AND id = $2', [deviceId, cardId]);
            }
            res.json({ success: true, deleted: result.rowCount, cardId, tag: slug, tags: await listTagsForCard(deviceId, cardId) });
        } catch (err) {
            console.error('[KanbanTags] DELETE tag error:', err);
            res.status(500).json({ success: false, error: 'Internal server error' });
        }
    });

    // GET /tags — device-scoped tag catalogue for board filter chips/autocomplete.
    router.get('/tags', async (req, res) => {
        const auth = authenticate(req, res);
        if (!auth) return;
        const { deviceId } = auth;
        try {
            const { rows } = await pool.query(
                `SELECT t.id, t.slug, t.label, t.created_by, t.created_at,
                        COUNT(ct.card_id)::int AS card_count
                 FROM kanban_tags t
                 LEFT JOIN kanban_card_tags ct ON ct.device_id = t.device_id AND ct.tag_id = t.id
                 WHERE t.device_id = $1
                 GROUP BY t.id, t.slug, t.label, t.created_by, t.created_at
                 ORDER BY t.slug`,
                [deviceId]
            );
            res.json({ success: true, tags: rows.map(mapTagRow) });
        } catch (err) {
            console.error('[KanbanTags] GET /tags error:', err);
            res.status(500).json({ success: false, error: 'Internal server error' });
        }
    });

    return { router, _internal: { normalizeTagSlug, displayLabel } };
};
