const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
  db.exec(schema);
  return db;
}

describe('Excel importer', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
  });

  it('imports valid rows and skips invalid ones', () => {
    const { importExcelWithDb } = require('../src/services/importer');

    // Create test Excel in memory
    const data = [
      { 'שם': 'דוד כהן', 'טלפון': '0501234567', 'צד': 'חתן', 'קבוצה': 'חברים', 'מוזמנים': 2 },
      { 'שם': 'שרה לוי', 'טלפון': '0521234567', 'צד': 'כלה', 'קבוצה': 'משפחה', 'מוזמנים': 3 },
      { 'שם': '', 'טלפון': '0531234567' },  // Missing name - skip
      { 'שם': 'יוסי', 'טלפון': '123' }       // Bad phone - skip
    ];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const tmpPath = path.join(__dirname, 'test-import.xlsx');
    XLSX.writeFile(wb, tmpPath);

    try {
      const result = importExcelWithDb(tmpPath, db);
      assert.strictEqual(result.imported, 2);
      assert.strictEqual(result.skipped, 2);

      const guests = db.prepare('SELECT * FROM guests').all();
      assert.strictEqual(guests.length, 2);
      assert.strictEqual(guests[0].name, 'דוד כהן');
      assert.strictEqual(guests[0].phone, '+972501234567');
      assert.strictEqual(guests[0].side, 'groom');
      assert.strictEqual(guests[0].num_invited, 2);
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('skips duplicate phone numbers', () => {
    const { importExcelWithDb } = require('../src/services/importer');

    db.prepare("INSERT INTO guests (name, phone) VALUES ('Existing', '+972501234567')").run();

    const data = [
      { 'שם': 'דוד כהן', 'טלפון': '0501234567', 'צד': 'חתן' },  // Duplicate
      { 'שם': 'שרה לוי', 'טלפון': '0521234567', 'צד': 'כלה' }   // New
    ];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const tmpPath = path.join(__dirname, 'test-import-dup.xlsx');
    XLSX.writeFile(wb, tmpPath);

    try {
      const result = importExcelWithDb(tmpPath, db);
      assert.strictEqual(result.imported, 1);
      assert.strictEqual(result.skipped, 1);
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('exports guests to Excel with Hebrew headers', () => {
    const { exportExcelWithDb } = require('../src/services/importer');

    db.prepare("INSERT INTO guests (name, phone, side, group_name, num_invited) VALUES ('דוד', '+972501234567', 'groom', 'חברים', 2)").run();
    db.prepare("INSERT INTO guests (name, phone, side, group_name, num_invited, status) VALUES ('שרה', '+972521234567', 'bride', 'משפחה', 3, 'coming')").run();

    const tmpPath = path.join(__dirname, 'test-export.xlsx');
    try {
      exportExcelWithDb(tmpPath, db);
      assert.ok(fs.existsSync(tmpPath), 'File should exist');

      const wb = XLSX.readFile(tmpPath);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(ws);
      assert.strictEqual(data.length, 2);
      assert.strictEqual(data[0]['שם'], 'דוד');
      assert.strictEqual(data[0]['צד'], 'חתן');
    } finally {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  });
});
