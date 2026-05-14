-- Reversible rollback for device-scoped Kanban tags.
DROP INDEX IF EXISTS idx_kanban_card_tags_tag;
DROP INDEX IF EXISTS idx_kanban_card_tags_card;
DROP INDEX IF EXISTS idx_kanban_tags_device_slug;
DROP TABLE IF EXISTS kanban_card_tags;
DROP TABLE IF EXISTS kanban_tags;
