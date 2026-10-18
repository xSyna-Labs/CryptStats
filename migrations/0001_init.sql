-- CryptStats: Grundschema für D1.
-- Zeitstempel werden als ISO-8601-Strings (UTC) gespeichert.

CREATE TABLE IF NOT EXISTS stocks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL UNIQUE,
  symbol        TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  url           TEXT NOT NULL DEFAULT '',
  parent_id     INTEGER REFERENCES stocks(id) ON DELETE SET NULL,
  start_price   REAL NOT NULL,
  current_price REAL NOT NULL,
  listed_at     TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id    INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  delta       REAL NOT NULL,
  occurs_at   TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('scheduled', 'applied')),
  price_after REAL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_stock ON events (stock_id, occurs_at);
CREATE INDEX IF NOT EXISTS idx_events_status ON events (status, occurs_at);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('root', 'admin', 'viewer')),
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);
