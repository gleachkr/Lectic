PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK (scope IN ('user', 'project')),
  project_key TEXT,
  kind TEXT NOT NULL,
  gist TEXT NOT NULL,
  content TEXT NOT NULL,
  source_file TEXT,
  source_interlocutor TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  accessed_at TEXT,
  access_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'superseded', 'deleted')),
  supersedes_id INTEGER REFERENCES memories(id),
  CHECK (
    (scope = 'user' AND project_key IS NULL)
    OR (scope = 'project' AND project_key IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_memories_scope_status_updated
  ON memories(scope, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_project_status_updated
  ON memories(project_key, status, updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  gist,
  content,
  kind,
  content = 'memories',
  content_rowid = 'id',
  tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, gist, content, kind)
  VALUES (new.id, new.gist, new.content, new.kind);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, gist, content, kind)
  VALUES ('delete', old.id, old.gist, old.content, old.kind);
END;

CREATE TRIGGER IF NOT EXISTS memories_au
AFTER UPDATE OF gist, content, kind ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, gist, content, kind)
  VALUES ('delete', old.id, old.gist, old.content, old.kind);
  INSERT INTO memories_fts(rowid, gist, content, kind)
  VALUES (new.id, new.gist, new.content, new.kind);
END;

CREATE TABLE IF NOT EXISTS conversation_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_key TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  interlocutor TEXT,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_history_project_created
  ON conversation_history(project_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_conversation_created
  ON conversation_history(conversation_key, created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS conversation_history_fts USING fts5(
  content,
  content = 'conversation_history',
  content_rowid = 'id',
  tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS history_ai
AFTER INSERT ON conversation_history BEGIN
  INSERT INTO conversation_history_fts(rowid, content)
  VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS history_ad
AFTER DELETE ON conversation_history BEGIN
  INSERT INTO conversation_history_fts(
    conversation_history_fts,
    rowid,
    content
  ) VALUES ('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS history_au
AFTER UPDATE ON conversation_history BEGIN
  INSERT INTO conversation_history_fts(
    conversation_history_fts,
    rowid,
    content
  ) VALUES ('delete', old.id, old.content);
  INSERT INTO conversation_history_fts(rowid, content)
  VALUES (new.id, new.content);
END;
