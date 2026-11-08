CREATE TABLE rooms (
  code TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
