-- Down: 20260626_action_request_related_card
-- Drop the optional related-card reference column.

ALTER TABLE agent_action_requests
    DROP COLUMN IF EXISTS related_card_id;
