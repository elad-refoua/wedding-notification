const { describe, it } = require('node:test');
const assert = require('node:assert');
const { parseAdminCommand } = require('../src/services/admin');

describe('Admin command parser', () => {
  it('parses "סטטוס"', () => assert.strictEqual(parseAdminCommand('סטטוס').action, 'status'));
  it('parses "שלח לכולם"', () => assert.strictEqual(parseAdminCommand('שלח לכולם').action, 'send_all'));
  it('parses "שלח לחברים של החתן"', () => {
    const cmd = parseAdminCommand('שלח לחברים של החתן');
    assert.strictEqual(cmd.action, 'send_group');
    assert.strictEqual(cmd.group, 'חברים של החתן');
  });
  it('parses "הוסף דוד כהן 0501234567 חתן חברים"', () => {
    const cmd = parseAdminCommand('הוסף דוד כהן 0501234567 חתן חברים');
    assert.strictEqual(cmd.action, 'add_guest');
    assert.strictEqual(cmd.name, 'דוד כהן');
    assert.strictEqual(cmd.phone, '0501234567');
  });
  it('parses "תזכורות כל 5 ימים"', () => {
    const cmd = parseAdminCommand('תזכורות כל 5 ימים');
    assert.strictEqual(cmd.action, 'set_reminder_interval');
    assert.strictEqual(cmd.days, 5);
  });
  it('parses "עדכן דוד כהן מגיע 3"', () => {
    const cmd = parseAdminCommand('עדכן דוד כהן מגיע 3');
    assert.strictEqual(cmd.action, 'update_status');
    assert.strictEqual(cmd.status, 'coming');
    assert.strictEqual(cmd.num, 3);
  });
  it('parses "עצור שליחה"', () => assert.strictEqual(parseAdminCommand('עצור שליחה').action, 'pause_send'));
  it('parses "המשך שליחה"', () => assert.strictEqual(parseAdminCommand('המשך שליחה').action, 'resume_send'));
  it('parses "עזרה"', () => assert.strictEqual(parseAdminCommand('עזרה').action, 'help'));
  it('returns unknown for gibberish', () => assert.strictEqual(parseAdminCommand('בלה בלה').action, 'unknown'));
  it('parses "דוח יומי ב-21:00"', () => {
    const cmd = parseAdminCommand('דוח יומי ב-21:00');
    assert.strictEqual(cmd.action, 'set_summary_time');
    assert.strictEqual(cmd.time, '21:00');
  });
  it('parses "עצור תזכורות לדוד כהן"', () => {
    const cmd = parseAdminCommand('עצור תזכורות לדוד כהן');
    assert.strictEqual(cmd.action, 'stop_reminders');
    assert.strictEqual(cmd.query, 'דוד כהן');
  });
});
