const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { importPastedWithDb } = require('../src/services/importer');

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
  const runSchema = db['exec'].bind(db);
  runSchema(schema);
  return db;
}

describe('Paste importer', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('imports comma-separated rows', () => {
    const text = `דנה, 0501234567, כלה, משפחה
יוסי, 0547654321, חתן, חברים`;
    const r = importPastedWithDb(text, db);
    assert.strictEqual(r.imported, 2);
    assert.strictEqual(r.skipped, 0);
    const rows = db.prepare('SELECT name, phone, side, group_name FROM guests ORDER BY id').all();
    assert.deepStrictEqual(rows, [
      { name: 'דנה', phone: '+972501234567', side: 'bride', group_name: 'משפחה' },
      { name: 'יוסי', phone: '+972547654321', side: 'groom', group_name: 'חברים' }
    ]);
  });

  it('handles tab-separated rows and mixed formats', () => {
    const text = "דנה\t0501234567\tכלה\nיוסי;972547654321;חתן";
    const r = importPastedWithDb(text, db);
    assert.strictEqual(r.imported, 2);
  });

  it('skips invalid rows and reports errors', () => {
    const text = `דנה, 0501234567
בלי טלפון,
, 0541111111
דני, 123`;
    const r = importPastedWithDb(text, db);
    assert.strictEqual(r.imported, 1);
    assert.strictEqual(r.skipped, 3);
    assert.strictEqual(r.errors.length, 3);
  });

  it('detects duplicate phone numbers', () => {
    db.prepare("INSERT INTO guests (name, phone) VALUES ('קיים', '+972501234567')").run();
    const r = importPastedWithDb('דנה, 0501234567', db);
    assert.strictEqual(r.imported, 0);
    assert.strictEqual(r.skipped, 1);
    assert.match(r.errors[0], /Duplicate/);
  });

  it('handles empty input', () => {
    assert.deepStrictEqual(importPastedWithDb('', db), { imported: 0, skipped: 0, total: 0, errors: [] });
    assert.deepStrictEqual(importPastedWithDb(null, db), { imported: 0, skipped: 0, total: 0, errors: [] });
  });
});
