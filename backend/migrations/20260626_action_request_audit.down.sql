-- Down: 20260626_action_request_audit
-- Drop the action-request edit audit trail in reverse order.

DROP INDEX IF EXISTS idx_aar_audit_editor;
DROP INDEX IF EXISTS idx_aar_audit_request;
DROP TABLE IF EXISTS agent_action_request_audit;
