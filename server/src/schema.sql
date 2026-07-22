-- Unote database schema (PostgreSQL / Neon). Applied idempotently on boot (db.ts).
--
-- Ported from the original SQLite schema. Two deliberate carry-overs keep the
-- port honest rather than clever:
--   * Timestamps stay TEXT in ISO-8601 UTC. ISO-8601 sorts correctly as text, so
--     every existing ORDER BY / comparison keeps working untouched.
--   * Booleans stay INTEGER 0/1, so the ~40 `archived = 0` style predicates in the
--     route layer did not need rewriting during the migration.
-- FTS5's virtual table + sync triggers are replaced by a generated tsvector column,
-- which needs no triggers and cannot drift out of sync with its source rows.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  -- scrypt(password, salt) — salt is per-user and random; see server/src/auth/password.ts
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  -- One-time recovery key, hashed exactly like a password. The app sends no email,
  -- so this is the only route back into a locked-out account. Shown once at signup
  -- and never recoverable afterwards; redeeming it sets recovery_key_used.
  recovery_key_hash TEXT,
  recovery_key_salt TEXT,
  recovery_key_used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
-- Additive columns for databases created before recovery keys existed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_key_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_key_salt TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_key_used INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_users_email ON users(lower(email));

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,               -- random 256-bit token, stored hashed
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Social (OAuth) identities linked to a local account. One user may have several — one
-- per provider they have signed in with. The account itself is still a `users` row; an
-- OAuth-only account simply has a password nobody holds (see routes/oauth.ts).
--
-- UNIQUE(provider, provider_user_id) is the anchor the callback resolves on first: a
-- returning identity maps straight to its user. Linking by verified email inserts a row
-- here pointing at the pre-existing user; a first-time user gets a fresh user + a row.
CREATE TABLE IF NOT EXISTS oauth_identities (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,              -- 'google' | 'github' (and future providers)
  provider_user_id TEXT NOT NULL,      -- the provider's stable subject id ('sub' / user id)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,                          -- the address seen at link time, for reference
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  UNIQUE (provider, provider_user_id)
);
CREATE INDEX IF NOT EXISTS idx_oauth_identities_user ON oauth_identities(user_id);

CREATE TABLE IF NOT EXISTS notebooks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '📓',
  color TEXT NOT NULL DEFAULT '#6366f1',
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_notebooks_user ON notebooks(user_id, position);

-- user_id is denormalised onto notes (rather than reached via notebook_id) so that
-- every read path can filter by owner with a single indexed predicate, and so a
-- forgotten join can never leak another user's rows.
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  content_json TEXT NOT NULL DEFAULT '{"type":"doc","content":[{"type":"paragraph"}]}',
  content_text TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'doc',  -- doc | canvas
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT, -- soft-delete: non-null = in trash (purged after 30 days on boot)
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  fts tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(content_text, '')), 'B')
  ) STORED
);
CREATE INDEX IF NOT EXISTS idx_notes_notebook ON notes(notebook_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_user_updated ON notes(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_fts ON notes USING GIN(fts);
-- Wikilink resolution matches on title; keep it case-insensitively indexed per user.
CREATE INDEX IF NOT EXISTS idx_notes_title ON notes(user_id, lower(title));

CREATE TABLE IF NOT EXISTS note_versions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  content_json TEXT NOT NULL,
  cause TEXT NOT NULL DEFAULT 'autosave', -- autosave | manual | ai | restore | import
  label TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_versions_note ON note_versions(note_id, created_at DESC);

CREATE TABLE IF NOT EXISTS note_tags (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (note_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON note_tags(tag);

-- Resolved wikilinks, extracted server-side from [[Title]] in content_text on save.
CREATE TABLE IF NOT EXISTS links (
  from_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  to_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  PRIMARY KEY (from_note_id, to_note_id)
);
CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_note_id);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
  kind TEXT NOT NULL, -- photo | slides | transcript | image | file
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  -- Serverless has no durable local disk, so bytes live in the row. Large binaries
  -- are TOASTed out of the main heap by Postgres, so this does not bloat note reads.
  bytes BYTEA,
  extracted_text TEXT,
  status TEXT NOT NULL DEFAULT 'uploaded', -- uploaded | extracting | ready | failed
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_attachments_note ON attachments(note_id);
CREATE INDEX IF NOT EXISTS idx_attachments_user ON attachments(user_id);

CREATE TABLE IF NOT EXISTS flashcards (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id TEXT REFERENCES notes(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  ease REAL NOT NULL DEFAULT 2.5,
  interval_days REAL NOT NULL DEFAULT 0,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  due_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  suspended INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_flashcards_due ON flashcards(user_id, due_at) WHERE suspended = 0;

CREATE TABLE IF NOT EXISTS review_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES flashcards(id) ON DELETE CASCADE,
  rating TEXT NOT NULL, -- again | hard | good | easy
  reviewed_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

-- Note templates: reusable skeletons, incl. built-in Lecture + Cornell.
-- Built-ins have a NULL user_id and are visible to everyone; user templates are owned.
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '📄',
  description TEXT NOT NULL DEFAULT '',
  content_json TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_templates_user ON templates(user_id);

-- Margin comments: self-annotations anchored by a comment mark in the document.
CREATE TABLE IF NOT EXISTS note_comments (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  anchor_text TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_comments_note ON note_comments(note_id, created_at);

-- ---------------------------------------------------------------------------
-- Canvas: Freeform-style infinite boards.
-- A canvas is a note with kind='canvas'; its spatial children live here rather
-- than in content_json so that a single item drag does not rewrite the whole doc.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS canvas_items (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,              -- sticky | text | image | shape | link | ink | embed
  x DOUBLE PRECISION NOT NULL DEFAULT 0,
  y DOUBLE PRECISION NOT NULL DEFAULT 0,
  width DOUBLE PRECISION NOT NULL DEFAULT 220,
  height DOUBLE PRECISION NOT NULL DEFAULT 160,
  rotation DOUBLE PRECISION NOT NULL DEFAULT 0,
  z INTEGER NOT NULL DEFAULT 0,
  -- kind-specific payload: sticky/text body, image attachment id, shape variant,
  -- linked note id, or an ink stroke set ({strokes:[{points:[x,y,pressure],...}]}).
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_canvas_items_note ON canvas_items(note_id, z);

-- Connectors between canvas items (arrows/lines drawn between two nodes).
CREATE TABLE IF NOT EXISTS canvas_edges (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  from_item_id TEXT NOT NULL REFERENCES canvas_items(id) ON DELETE CASCADE,
  to_item_id TEXT NOT NULL REFERENCES canvas_items(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT 'arrow', -- arrow | line | dashed
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_canvas_edges_note ON canvas_edges(note_id);

-- Pencil/stylus ink layered over a normal document note (canvas ink lives in
-- canvas_items instead). One row per stroke keeps incremental save cheap.
CREATE TABLE IF NOT EXISTS note_ink (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  -- {points:[[x,y,pressure],...], color, width, tool: pen|highlighter}
  stroke TEXT NOT NULL,
  -- Author of the stroke. NULL for an anonymous link guest; used to colour
  -- presence and to let a collaborator undo only their own ink.
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_note_ink_note ON note_ink(note_id);

-- Import jobs. Deliberately a table rather than a process-local map: the client
-- polls for progress, and on serverless each poll may land on a different
-- instance, so an in-memory store answers "job not found" for a job that is
-- running perfectly well somewhere else.
CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | failed
  step TEXT,
  note_id TEXT,
  attachment_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_import_jobs_user ON import_jobs(user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Sharing: a note or canvas published behind an unguessable link, optionally
-- password-gated. Guests may join without an account.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS note_shares (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  -- The URL token is stored hashed, so a database leak does not hand out
  -- working share links. Same reasoning as the sessions table.
  token_hash TEXT NOT NULL UNIQUE,
  -- Optional gate. Hashed with scrypt + per-share salt, exactly like a password.
  password_hash TEXT,
  password_salt TEXT,
  permission TEXT NOT NULL DEFAULT 'edit', -- view | edit
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_shares_note ON note_shares(note_id);

-- A guest's proof that they cleared the password gate, and their identity for
-- presence. Separate from `sessions` so a guest grant can never be mistaken for
-- an account login.
CREATE TABLE IF NOT EXISTS share_guests (
  id TEXT PRIMARY KEY,              -- hashed guest token, as with sessions
  share_id TEXT NOT NULL REFERENCES note_shares(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL DEFAULT 'Guest',
  color TEXT NOT NULL DEFAULT '#6366f1',
  last_seen_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_share_guests_share ON share_guests(share_id, last_seen_at DESC);

-- Monotonic change feed per note, so collaborators can poll for "everything
-- since revision N" instead of refetching the whole document. Serverless
-- functions cannot hold WebSockets, so sync is delta-polling over this table.
CREATE TABLE IF NOT EXISTS note_events (
  seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,               -- doc | ink | item | edge | presence
  payload TEXT NOT NULL DEFAULT '{}',
  actor TEXT NOT NULL DEFAULT '',   -- user id or guest id, for echo suppression
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_note_events_note ON note_events(note_id, seq);

-- ---------------------------------------------------------------------------
-- AI: shared-pool accounting and user-supplied provider keys.
-- ---------------------------------------------------------------------------

-- Monthly spend against the shared free-tier pool, counted along two dimensions:
-- 'user' (subject = user id) and 'ip' (subject = a keyed hash of the address, never
-- the address itself). A request must clear both, since an account cap alone falls
-- to registering again and an IP cap alone falls to a hotspot.
--
-- Durable rather than in-memory because the budget is monthly: serverless instances
-- are short-lived, so an in-process counter would reset constantly and the real
-- ceiling would become (limit x number of warm instances).
CREATE TABLE IF NOT EXISTS ai_usage (
  scope TEXT NOT NULL,              -- user | ip
  subject TEXT NOT NULL,            -- user id, or HMAC(ip)
  period TEXT NOT NULL,             -- UTC calendar month, 'YYYY-MM'
  calls INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  PRIMARY KEY (scope, subject, period)
);
-- Supports the monthly sweep that drops periods nobody will read again.
CREATE INDEX IF NOT EXISTS idx_ai_usage_period ON ai_usage(period);

-- A user's own provider key, which takes them off the shared pool entirely: their
-- calls are billed to their key and skip the quota check.
--
-- The key is encrypted at rest with AES-256-GCM rather than hashed, because unlike a
-- password it has to be recoverable to be used. `hint` is the last four characters,
-- stored separately so the settings UI can show which key is saved without the
-- server ever having to decrypt one just to render a page.
CREATE TABLE IF NOT EXISTS ai_keys (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- Optional: lets a user point at their own OpenAI-compatible endpoint, not just
  -- swap the credential for the default one.
  base_url TEXT,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  hint TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
