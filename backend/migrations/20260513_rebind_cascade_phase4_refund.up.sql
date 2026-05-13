-- Rebind cascade Phase 4: strict per-second refunds + rental audit.
-- Wallet movements remain canonical in wallet_ledger; this migration adds
-- rental-domain audit and a stable duration denominator.

ALTER TABLE rental_contracts
    ADD COLUMN IF NOT EXISTS total_duration_sec INTEGER;

UPDATE rental_contracts
   SET total_duration_sec = GREATEST(0, planned_duration_min * 60)
 WHERE total_duration_sec IS NULL
   AND planned_duration_min IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'rental_contracts_total_duration_sec_nonnegative'
           AND conrelid = 'rental_contracts'::regclass
    ) THEN
        ALTER TABLE rental_contracts
            ADD CONSTRAINT rental_contracts_total_duration_sec_nonnegative
            CHECK (total_duration_sec IS NULL OR total_duration_sec >= 0)
            NOT VALID;
    END IF;
END $$;

ALTER TABLE rental_contracts
    VALIDATE CONSTRAINT rental_contracts_total_duration_sec_nonnegative;

CREATE TABLE IF NOT EXISTS rental_rebind_audit_log (
    id BIGSERIAL PRIMARY KEY,
    contract_id VARCHAR(48) NOT NULL UNIQUE,
    listing_id VARCHAR(48) NOT NULL,
    owner_device_id TEXT NOT NULL,
    owner_entity_id INTEGER NOT NULL,
    owner_user_id UUID NOT NULL,
    renter_user_id UUID NOT NULL,
    status_from VARCHAR(40) NOT NULL,
    status_to VARCHAR(40) NOT NULL DEFAULT 'terminated_by_rebind',
    deposit_mli BIGINT NOT NULL DEFAULT 0 CHECK (deposit_mli >= 0),
    deposit_release_mli BIGINT NOT NULL DEFAULT 0 CHECK (deposit_release_mli >= 0),
    refund_mli BIGINT NOT NULL DEFAULT 0 CHECK (refund_mli >= 0),
    remaining_sec INTEGER NOT NULL DEFAULT 0 CHECK (remaining_sec >= 0),
    total_duration_sec INTEGER NOT NULL DEFAULT 0 CHECK (total_duration_sec >= 0),
    wallet_release_idempotency_key TEXT,
    wallet_debit_idempotency_key TEXT,
    wallet_credit_idempotency_key TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT fk_rebind_audit_contract FOREIGN KEY (contract_id)
        REFERENCES rental_contracts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rebind_audit_owner_time
    ON rental_rebind_audit_log(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rebind_audit_slot_time
    ON rental_rebind_audit_log(owner_device_id, owner_entity_id, created_at DESC);
