DROP INDEX IF EXISTS idx_listings_soft_pause_active;

ALTER TABLE bot_listings
    DROP COLUMN IF EXISTS soft_pause_reason,
    DROP COLUMN IF EXISTS soft_pause_until;
