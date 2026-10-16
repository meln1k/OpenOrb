-- Sessions are created only by the gateway, with fresh IDs, so a deleted one cannot reappear.
DROP TRIGGER IF EXISTS prevent_session_resurrection;
DROP TABLE IF EXISTS deleted_sessions;
