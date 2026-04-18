const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '..', 'guests.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    db.exec(schema);
    runMigrations(db);
  }
  return db;
}

function runMigrations(d) {
  const cols = d.prepare("PRAGMA table_info(messages)").all().map(c => c.name);
  if (!cols.includes('error')) {
    d.prepare("ALTER TABLE messages ADD COLUMN error TEXT").run();
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
