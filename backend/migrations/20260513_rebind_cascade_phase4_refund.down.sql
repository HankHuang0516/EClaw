-- Rollback Rebind cascade Phase 4 audit/duration additions.
-- NOTE: dropping total_duration_sec removes the fixed refund denominator for
-- existing rows; run only as part of a coordinated rollback.

DROP INDEX IF EXISTS idx_rebind_audit_slot_time;
DROP INDEX IF EXISTS idx_rebind_audit_owner_time;
DROP TABLE IF EXISTS rental_rebind_audit_log;

ALTER TABLE rental_contracts
    DROP CONSTRAINT IF EXISTS rental_contracts_total_duration_sec_nonnegative;

ALTER TABLE rental_contracts
    DROP COLUMN IF EXISTS total_duration_sec;
