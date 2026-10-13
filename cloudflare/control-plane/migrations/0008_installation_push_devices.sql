-- APNs device tokens an installation registered for closed-app phone alerts
-- (src/push.ts). A token is stored only so the relay can address it; nothing
-- the phone shows is stored. A token belongs to the installation that
-- registered it: another installation can push to the same phone only by
-- registering the token itself, which its own paired phone has to give it.
-- Revoking the installation deletes its rows (installations.ts); a hard
-- deletion cascades.
CREATE TABLE installation_push_devices (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL CHECK (length(token_hash) = 64),
  token TEXT NOT NULL CHECK (length(token) BETWEEN 64 AND 200),
  environment TEXT NOT NULL CHECK (environment IN ('production', 'sandbox')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_sent_at INTEGER,
  PRIMARY KEY (installation_id, token_hash)
);

-- APNs reporting a token dead drops it for every installation.
CREATE INDEX installation_push_devices_token_idx
  ON installation_push_devices(token_hash);
