const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');

describe('Database', () => {
  let db;

  before(() => {
    const Database = require('better-sqlite3');
    const fs = require('fs');
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
    db.exec(schema);
  });

  after(() => { db.close(); });

  it('should create guests table', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='guests'").all();
    assert.strictEqual(tables.length, 1);
  });

  it('should insert and retrieve a guest', () => {
    db.prepare('INSERT INTO guests (name, phone) VALUES (?, ?)').run('דוד כהן', '+972501234567');
    const guest = db.prepare('SELECT * FROM guests WHERE phone = ?').get('+972501234567');
    assert.strictEqual(guest.name, 'דוד כהן');
    assert.strictEqual(guest.status, 'pending');
    assert.strictEqual(guest.num_invited, 1);
  });

  it('should enforce unique phone', () => {
    assert.throws(() => {
      db.prepare('INSERT INTO guests (name, phone) VALUES (?, ?)').run('Other', '+972501234567');
    });
  });

  it('should have default settings', () => {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'reminder_interval_days'").get();
    assert.strictEqual(row.value, '5');
  });

  it('should enforce valid status', () => {
    assert.throws(() => {
      db.prepare("INSERT INTO guests (name, phone, status) VALUES (?, ?, ?)").run('Bad', '+972509999999', 'invalid');
    });
  });
});
