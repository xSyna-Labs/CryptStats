-- CryptStats: RoadMap je Aktie. Jede Aktie hat eigene Einträge mit Status.

CREATE TABLE IF NOT EXISTS roadmap_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id   INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  text       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL CHECK (status IN ('done', 'doing', 'planned')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_roadmap_stock ON roadmap_items (stock_id, id);
