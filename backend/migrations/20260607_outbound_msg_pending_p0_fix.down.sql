-- Down: 20260607_outbound_msg_pending_p0_fix
DROP INDEX IF EXISTS idx_omp_match;
DROP INDEX IF EXISTS idx_omp_expires_at;
DROP TABLE IF EXISTS outbound_msg_pending;
