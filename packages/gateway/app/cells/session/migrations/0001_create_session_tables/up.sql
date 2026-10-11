CREATE TABLE openorb_session (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  record TEXT NOT NULL
);

CREATE TABLE openorb_git_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  snapshot TEXT NOT NULL
);

CREATE TABLE openorb_media (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL
);

CREATE TABLE openorb_inline_image (
  id TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  entry_id INTEGER
);
