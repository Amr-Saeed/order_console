import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = Database.Database;

export const STATUSES = ["pending", "paid", "shipped", "delivered", "cancelled"] as const;
export type Status = (typeof STATUSES)[number];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','agent'))
);

CREATE TABLE IF NOT EXISTS orders (
  id              INTEGER PRIMARY KEY,
  customer_name   TEXT NOT NULL,
  customer_email  TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending','paid','shipped','delivered','cancelled')),
  total_cents     INTEGER NOT NULL CHECK (total_cents >= 0),
  item_count      INTEGER NOT NULL CHECK (item_count > 0),
  created_at      INTEGER NOT NULL,            -- unix ms
  deleted_at      INTEGER,                     -- soft delete
  created_by      INTEGER REFERENCES users(id),
  idempotency_key TEXT,
  request_hash    TEXT,
  -- THE duplicate guarantee: one key per user can only ever create one row.
  -- (NULLs are distinct in SQLite, so seeded orders without a key are fine.)
  UNIQUE (created_by, idempotency_key)
);

CREATE TABLE IF NOT EXISTS order_items (
  id          INTEGER PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  quantity    INTEGER NOT NULL CHECK (quantity > 0),
  unit_cents  INTEGER NOT NULL CHECK (unit_cents >= 0)
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);

-- Keyset-pagination indexes. Every one ends in id (the tie-breaker) and is
-- partial (live rows only) so it matches the "deleted_at IS NULL" in the query.
CREATE INDEX IF NOT EXISTS idx_orders_date         ON orders(created_at, id)               WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_orders_amount       ON orders(total_cents, id)              WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_orders_status_date  ON orders(status, created_at, id)       WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_orders_status_amt   ON orders(status, total_cents, id)      WHERE deleted_at IS NULL;

-- Full-text search (word-prefix) over customer name + email.
CREATE VIRTUAL TABLE IF NOT EXISTS orders_fts USING fts5(
  customer_name, customer_email, content='orders', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS orders_ai AFTER INSERT ON orders BEGIN
  INSERT INTO orders_fts(rowid, customer_name, customer_email)
  VALUES (new.id, new.customer_name, new.customer_email);
END;
`;

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}
