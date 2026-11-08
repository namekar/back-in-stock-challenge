const Database = require('better-sqlite3');
const db = new Database('stock.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    sku TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    notified_at TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_pending
    ON requests(email, sku) WHERE status = 'pending';

  CREATE TABLE IF NOT EXISTS processed_events (
    event_id TEXT PRIMARY KEY
  );
`);

module.exports = db;