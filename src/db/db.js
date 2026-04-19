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
  // Column additions — idempotent
  const msgCols = d.prepare("PRAGMA table_info(messages)").all().map(c => c.name);
  if (!msgCols.includes('error')) {
    d.prepare("ALTER TABLE messages ADD COLUMN error TEXT").run();
  }
  const guestCols = d.prepare("PRAGMA table_info(guests)").all().map(c => c.name);
  if (!guestCols.includes('reminders_paused')) {
    d.prepare("ALTER TABLE guests ADD COLUMN reminders_paused INTEGER DEFAULT 0").run();
  }

  // SQLite cannot alter FK constraints in-place. If the messages or reminders table was
  // created before we added ON DELETE CASCADE, rebuild it (SQLite-recommended pattern:
  // CREATE new → COPY → DROP old → RENAME). Detect by probing foreign_key_list.
  maybeRebuildForCascade(d, 'messages', `
    CREATE TABLE messages_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guest_id INTEGER REFERENCES guests(id) ON DELETE CASCADE,
      direction TEXT NOT NULL CHECK(direction IN ('outgoing', 'incoming')),
      channel TEXT NOT NULL CHECK(channel IN ('whatsapp', 'sms')),
      content TEXT,
      status TEXT DEFAULT 'sent' CHECK(status IN ('sent', 'delivered', 'read', 'failed', 'received', 'queued', 'accepted')),
      twilio_sid TEXT,
      error TEXT,
      created_at DATETIME DEFAULT (datetime('now'))
    )
  `);
  maybeRebuildForCascade(d, 'reminders', `
    CREATE TABLE reminders_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guest_id INTEGER REFERENCES guests(id) ON DELETE CASCADE,
      scheduled_at DATETIME NOT NULL,
      sent_at DATETIME,
      reminder_num INTEGER NOT NULL DEFAULT 1,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'sent', 'cancelled'))
    )
  `);
}

function maybeRebuildForCascade(d, tableName, createNewSQL) {
  const fks = d.prepare(`PRAGMA foreign_key_list(${tableName})`).all();
  const fk = fks.find(f => f.table === 'guests');
  if (!fk) return; // No guests FK at all — fresh table will have been created from the new schema
  if (fk.on_delete === 'CASCADE') return; // Already migrated

  // Rebuild: create new, copy, drop old, rename. Must disable FK enforcement during swap.
  d.prepare('PRAGMA foreign_keys = OFF').run();
  try {
    const insideTxn = d.transaction(() => {
      d.prepare(createNewSQL).run();
      // Copy rows using shared column names (exclude PK-replaceable gaps by taking what's in the old table)
      const oldCols = d.prepare(`PRAGMA table_info(${tableName})`).all().map(c => c.name);
      const newCols = d.prepare(`PRAGMA table_info(${tableName}_new)`).all().map(c => c.name);
      const shared = oldCols.filter(c => newCols.includes(c));
      const colList = shared.join(', ');
      d.prepare(`INSERT INTO ${tableName}_new (${colList}) SELECT ${colList} FROM ${tableName}`).run();
      d.prepare(`DROP TABLE ${tableName}`).run();
      d.prepare(`ALTER TABLE ${tableName}_new RENAME TO ${tableName}`).run();
      console.log('Migrated ' + tableName + ' — added ON DELETE CASCADE');
    });
    insideTxn();
  } finally {
    d.prepare('PRAGMA foreign_keys = ON').run();
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
