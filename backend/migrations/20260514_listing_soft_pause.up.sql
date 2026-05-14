-- Listing soft-pause for degraded-but-listed rental bots.
-- Keep status='listed'; active pause is derived from soft_pause_until > NOW().
ALTER TABLE bot_listings
    ADD COLUMN IF NOT EXISTS soft_pause_until TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS soft_pause_reason VARCHAR(64) NULL;

CREATE INDEX IF NOT EXISTS idx_listings_soft_pause_active
    ON bot_listings(soft_pause_until)
    WHERE status = 'listed' AND soft_pause_until IS NOT NULL;
