const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// Use in-memory DB for tests
function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
  db.exec(schema);
  return db;
}

describe('Reminder engine', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
  });

  it('createFirstReminderWithDb creates a pending reminder row', () => {
    const { createFirstReminderWithDb } = require('../src/services/reminder');
    db.prepare("INSERT INTO guests (name, phone) VALUES ('Test', '+972501234567')").run();
    const guest = db.prepare('SELECT * FROM guests').get();
    createFirstReminderWithDb(guest.id, db);
    const reminder = db.prepare('SELECT * FROM reminders WHERE guest_id = ?').get(guest.id);
    assert.ok(reminder, 'Reminder should exist');
    assert.strictEqual(reminder.status, 'pending');
    assert.strictEqual(reminder.reminder_num, 1);
    assert.ok(reminder.scheduled_at, 'Should have scheduled_at');
  });

  it('cancelRemindersForGuestWithDb cancels pending reminders', () => {
    const { createFirstReminderWithDb, cancelRemindersForGuestWithDb } = require('../src/services/reminder');
    db.prepare("INSERT INTO guests (name, phone) VALUES ('Test', '+972501234567')").run();
    const guest = db.prepare('SELECT * FROM guests').get();
    createFirstReminderWithDb(guest.id, db);
    cancelRemindersForGuestWithDb(guest.id, db);
    const reminder = db.prepare('SELECT * FROM reminders WHERE guest_id = ?').get(guest.id);
    assert.strictEqual(reminder.status, 'cancelled');
  });

  it('does not create reminder beyond max_reminders', () => {
    const { createFirstReminderWithDb } = require('../src/services/reminder');
    db.prepare("INSERT INTO guests (name, phone) VALUES ('Test', '+972501234567')").run();
    const guest = db.prepare('SELECT * FROM guests').get();
    // Insert 10 sent reminders (max_reminders default is 10)
    for (let i = 1; i <= 10; i++) {
      db.prepare("INSERT INTO reminders (guest_id, scheduled_at, sent_at, reminder_num, status) VALUES (?, datetime('now'), datetime('now'), ?, 'sent')")
        .run(guest.id, i);
    }
    createFirstReminderWithDb(guest.id, db);
    const pending = db.prepare("SELECT * FROM reminders WHERE guest_id = ? AND status = 'pending'").all(guest.id);
    assert.strictEqual(pending.length, 0, 'Should not create reminder beyond max');
  });
});
