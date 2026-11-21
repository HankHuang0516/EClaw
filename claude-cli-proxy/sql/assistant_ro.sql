-- Read-only window onto the live database for the chat assistant (claude-cli-proxy).
--
-- The assistant runs shell commands on behalf of whoever is chatting, so whatever
-- its database login can read, a chat can be talked into printing. This file gives
-- that login a schema of views that leave out every credential, and nothing else:
-- no base table in `public` is granted to it.
--
-- Left out on purpose:
--   devices            device_secret, fcm_token, apns_token, prompt_policy
--   entities           bot_secret, webhook token/sessionKey/setup credentials,
--                      message_queue (other people's messages), parts, identity, agent_card
--   channel_accounts   channel_api_secret, callback_token, callback basic-auth;
--                      channel_api_key is masked (the key alone authenticates)
--   server_logs        ip_address, user_id; credential-looking keys of metadata
--   handshake_failures request_payload, response_body
--   device_telemetry   input (request bodies: deviceSecret, botSecret, password, …)
--   official_bots      token, session_key_template, bot_secret, setup credentials
--   official_bot_bindings  session_key
--
-- Apply as the database owner. Safe to re-run: views are dropped and recreated.
-- The role's password is set separately by the operator and is not kept here:
--   ALTER ROLE eclaw_assistant_ro PASSWORD '<generated>';
-- then DATABASE_URL of claude-cli-proxy uses that role.

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'eclaw_assistant_ro') THEN
        CREATE ROLE eclaw_assistant_ro LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT 8;
    END IF;
END
$$;

ALTER ROLE eclaw_assistant_ro SET default_transaction_read_only = on;
ALTER ROLE eclaw_assistant_ro SET statement_timeout = '15s';
ALTER ROLE eclaw_assistant_ro SET idle_in_transaction_session_timeout = '30s';
-- Unqualified names resolve to the views, never to the base tables.
ALTER ROLE eclaw_assistant_ro SET search_path = assistant_ro;

CREATE SCHEMA IF NOT EXISTS assistant_ro;

-- Drops top-level keys that hold credentials, by name: …secret, …password, …token,
-- …api_key / apiKey, …session_key / sessionKey, authorization, cookie.
-- "tokenPrefix" and the like are kept (they do not end in the credential word).
CREATE OR REPLACE FUNCTION assistant_ro.redact(doc jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE
        WHEN doc IS NULL OR jsonb_typeof(doc) <> 'object' THEN doc
        ELSE COALESCE(
            (SELECT jsonb_object_agg(key, value)
               FROM jsonb_each(doc)
              WHERE key !~* '(secret|password|passwd|token|api_?key|session_?key|authorization|cookie)$'),
            '{}'::jsonb)
    END
$$;

DROP VIEW IF EXISTS assistant_ro.devices, assistant_ro.entities, assistant_ro.channel_accounts,
    assistant_ro.server_logs, assistant_ro.handshake_failures, assistant_ro.device_telemetry,
    assistant_ro.scheduled_messages, assistant_ro.official_bots, assistant_ro.official_bot_bindings;

CREATE VIEW assistant_ro.devices AS
SELECT device_id, created_at, updated_at, paid_borrow_slots, next_entity_id, user_display_name,
       (fcm_token IS NOT NULL)  AS has_fcm_token,
       (apns_token IS NOT NULL) AS has_apns_token
  FROM public.devices;

CREATE VIEW assistant_ro.entities AS
SELECT device_id, entity_id, is_bound, name, character, state, message, battery_level, last_updated,
       app_version, xp, level, avatar, public_code, binding_type, channel_account_id,
       encryption_status, is_public, published_at, rental_status,
       (webhook IS NOT NULL)        AS has_webhook,
       webhook->>'url'              AS webhook_url,
       webhook->>'type'             AS webhook_type,
       webhook->>'registeredAt'     AS webhook_registered_at,
       CASE WHEN jsonb_typeof(message_queue) = 'array' THEN jsonb_array_length(message_queue) END AS message_queue_len
  FROM public.entities;

CREATE VIEW assistant_ro.channel_accounts AS
SELECT id, device_id,
       left(channel_api_key, 12) || '…' || right(channel_api_key, 6) AS channel_api_key,
       callback_url,
       (callback_url IS NOT NULL)   AS has_callback,
       (callback_token IS NOT NULL) AS has_callback_token,
       status, e2ee_capable, created_at, updated_at
  FROM public.channel_accounts;

CREATE VIEW assistant_ro.server_logs AS
SELECT id, level, category, message, device_id, entity_id,
       assistant_ro.redact(metadata) AS metadata,
       created_at, action, resource, result
  FROM public.server_logs;

CREATE VIEW assistant_ro.handshake_failures AS
SELECT id, device_id, entity_id, webhook_url, error_type, http_status, error_message, source, created_at
  FROM public.handshake_failures;

CREATE VIEW assistant_ro.device_telemetry AS
SELECT id, device_id, ts, type, action, page, duration, size_bytes, created_at,
       assistant_ro.redact(output) AS output,
       assistant_ro.redact(meta)   AS meta
  FROM public.device_telemetry;

CREATE VIEW assistant_ro.scheduled_messages AS
SELECT id, device_id, entity_id, message, scheduled_at, repeat_type, cron_expr, status, label, timezone,
       is_paused, created_at, executed_at, sent_at, cancelled_at, result_status, last_error
  FROM public.scheduled_messages;

CREATE VIEW assistant_ro.official_bots AS
SELECT bot_id, bot_type, display_name, model_name, webhook_url, status,
       assigned_device_id, assigned_entity_id, assigned_at, created_at, retirement_reason
  FROM public.official_bots;

CREATE VIEW assistant_ro.official_bot_bindings AS
SELECT bot_id, device_id, entity_id, bound_at, subscription_verified_at
  FROM public.official_bot_bindings;

-- Privileges: connect, and read the views. Nothing in `public`, and no temporary
-- tables (the application connects as the owner and is unaffected).
DO $$
BEGIN
    EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END
$$;
REVOKE ALL ON SCHEMA public FROM eclaw_assistant_ro;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM eclaw_assistant_ro;
GRANT USAGE ON SCHEMA assistant_ro TO eclaw_assistant_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA assistant_ro TO eclaw_assistant_ro;
GRANT EXECUTE ON FUNCTION assistant_ro.redact(jsonb) TO eclaw_assistant_ro;

COMMIT;
