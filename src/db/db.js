const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'guests.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let db;

function getDb() {
  if (!db) {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new Database(DB_PATH);
    // WAL uses mmap and doesn't work over networked filesystems (GCS FUSE).
    // DELETE mode is slower but correct on any filesystem.
    db.pragma(process.env.DB_JOURNAL_MODE ? 'journal_mode = ' + process.env.DB_JOURNAL_MODE : 'journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    db.exec(schema);
    runMigrations(db);
  }
  return db;
}

function runMigrations(d) {
  const msgCols = d.prepare("PRAGMA table_info(messages)").all().map(c => c.name);
  if (!msgCols.includes('error')) {
    d.prepare("ALTER TABLE messages ADD COLUMN error TEXT").run();
  }
  const guestCols = d.prepare("PRAGMA table_info(guests)").all().map(c => c.name);
  if (!guestCols.includes('reminders_paused')) {
    d.prepare("ALTER TABLE guests ADD COLUMN reminders_paused INTEGER DEFAULT 0").run();
  }
}

function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

function closeDb() {
  if (db) { db.close(); db = null; }
}

module.exports = { getDb, getSetting, setSetting, closeDb };
