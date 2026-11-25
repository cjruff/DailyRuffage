-- Daily Ruffage D1 schema. Each recipe is stored whole as JSON; search happens on the phone.
CREATE TABLE IF NOT EXISTS recipes (
  id         TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recipes_updated ON recipes(updated_at);

-- Source photos (screenshots etc.), shrunk to ~1800px JPEG before upload.
CREATE TABLE IF NOT EXISTS images (
  key        TEXT PRIMARY KEY,
  mime       TEXT NOT NULL,
  data       BLOB NOT NULL,
  created_at TEXT NOT NULL
);
