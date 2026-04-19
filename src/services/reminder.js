const { getDb, getSetting } = require('../db/db');
const path = require('path');
const fs = require('fs');

// === WithDb variants (for testing with in-memory DB) ===

function createFirstReminderWithDb(guestId, db) {
  const intervalDays = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'reminder_interval_days'").get()?.value) || 5;
  if (!Number.isFinite(intervalDays) || intervalDays < 1) return;
  const maxReminders = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'max_reminders'").get()?.value) || 10;

  const sentCount = db.prepare("SELECT COUNT(*) as c FROM reminders WHERE guest_id = ? AND status IN ('sent', 'pending')").get(guestId).c;
  if (sentCount >= maxReminders) return;

  const nextNum = (db.prepare("SELECT MAX(reminder_num) as m FROM reminders WHERE guest_id = ?").get(guestId).m || 0) + 1;

  db.prepare("INSERT INTO reminders (guest_id, scheduled_at, reminder_num, status) VALUES (?, datetime('now', '+' || ? || ' days'), ?, 'pending')")
    .run(guestId, intervalDays, nextNum);
}

function cancelRemindersForGuestWithDb(guestId, db) {
  db.prepare("UPDATE reminders SET status = 'cancelled' WHERE guest_id = ? AND status = 'pending'").run(guestId);
}

// === Production variants (use singleton DB) ===

function createFirstReminder(guestId) {
  createFirstReminderWithDb(guestId, getDb());
}

function cancelRemindersForGuest(guestId) {
  cancelRemindersForGuestWithDb(guestId, getDb());
}

// === Scheduled jobs ===

async function processDueReminders() {
  const db = getDb();
  const { sendToGuest } = require('./twilio');

  const dueReminders = db.prepare(
    "SELECT r.*, g.name, g.phone, g.id as guest_id, g.num_invited FROM reminders r JOIN guests g ON r.guest_id = g.id WHERE r.status = 'pending' AND r.scheduled_at <= datetime('now') AND g.status IN ('invited', 'undecided')"
  ).all();

  const template = getSetting('reminder_template') || 'היי {{name}}, רצינו לוודא - נשמח לדעת אם תוכלו להגיע לחתונה';
  const batchSize = parseInt(getSetting('batch_size') || '10');
  const batchDelay = parseInt(getSetting('batch_delay_seconds') || '60') * 1000;

  for (let i = 0; i < dueReminders.length; i++) {
    const r = dueReminders[i];

    // 24h dedup: skip if we already sent a reminder to this guest today
    const recentSent = db.prepare(
      "SELECT COUNT(*) as c FROM reminders WHERE guest_id = ? AND sent_at > datetime('now', '-1 day') AND status = 'sent'"
    ).get(r.guest_id).c;
    if (recentSent > 0) continue;

    const body = template.replace('{{name}}', r.name);
    try {
      const reminderTemplateSid = getSetting('whatsapp_template_reminder_sid') || null;
      const opts = reminderTemplateSid
        ? { templateSid: reminderTemplateSid, templateVariables: { "1": r.name } }
        : {};
      await sendToGuest({ id: r.guest_id, phone: r.phone }, body, opts);
      db.prepare("UPDATE reminders SET status = 'sent', sent_at = datetime('now') WHERE id = ?").run(r.id);

      // Schedule next reminder
      createFirstReminder(r.guest_id);
    } catch (err) {
      console.error('Reminder send failed for ' + r.name + ':', err.message);
    }

    // Batch delay
    if ((i + 1) % batchSize === 0 && i < dueReminders.length - 1) {
      await new Promise(resolve => setTimeout(resolve, batchDelay));
    }
  }
}

async function sendDailySummary() {
  const db = getDb();
  const { sendToAdmins } = require('./twilio');

  const stats = {
    coming: db.prepare("SELECT COUNT(*) as c FROM guests WHERE status = 'coming'").get().c,
    not_coming: db.prepare("SELECT COUNT(*) as c FROM guests WHERE status = 'not_coming'").get().c,
    undecided: db.prepare("SELECT COUNT(*) as c FROM guests WHERE status = 'undecided'").get().c,
    pending: db.prepare("SELECT COUNT(*) as c FROM guests WHERE status IN ('pending','invited')").get().c,
    total_people: db.prepare("SELECT COALESCE(SUM(num_coming),0) as c FROM guests WHERE status='coming'").get().c,
    total: db.prepare("SELECT COUNT(*) as c FROM guests").get().c
  };

  const msg = '\u{1F4CA} \u05D3\u05D5\u05D7 \u05D9\u05D5\u05DE\u05D9:\n' +
    '\u2705 \u05DE\u05D2\u05D9\u05E2\u05D9\u05DD: ' + stats.coming + ' (' + stats.total_people + ' \u05E0\u05E4\u05E9\u05D5\u05EA)\n' +
    '\u274C \u05DC\u05D0 \u05DE\u05D2\u05D9\u05E2\u05D9\u05DD: ' + stats.not_coming + '\n' +
    '\u{1F914} \u05DE\u05EA\u05DC\u05D1\u05D8\u05D9\u05DD: ' + stats.undecided + '\n' +
    '\u23F3 \u05DE\u05DE\u05EA\u05D9\u05E0\u05D9\u05DD: ' + stats.pending + '\n' +
    '\u{1F4CB} \u05E1\u05D4"\u05DB: ' + stats.total;

  await sendToAdmins(msg);
}

function backupDatabase() {
  const dbPath = path.join(__dirname, '..', '..', 'guests.db');
  const backupDir = path.join(__dirname, '..', '..', 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const date = new Date().toISOString().split('T')[0];
  const backupPath = path.join(backupDir, 'guests-' + date + '.db');

  try {
    fs.copyFileSync(dbPath, backupPath);
    console.log('Database backup created: ' + backupPath);

    // Cleanup: keep only last 7 backups
    const files = fs.readdirSync(backupDir).filter(f => f.startsWith('guests-') && f.endsWith('.db')).sort().reverse();
    for (const f of files.slice(7)) {
      fs.unlinkSync(path.join(backupDir, f));
    }
  } catch (err) {
    console.error('Backup failed:', err.message);
  }
}

let _intervals = [];

function startScheduledJobs() {
  // Process due reminders every hour
  _intervals.push(setInterval(() => {
    processDueReminders().catch(err => console.error('Reminder processing failed:', err.message));
  }, 60 * 60 * 1000));

  // Check for daily summary every minute
  _intervals.push(setInterval(() => {
    const now = new Date();
    const time = now.toTimeString().slice(0, 5); // HH:MM
    const summaryTime = getSetting('daily_summary_time') || '20:00';
    if (time === summaryTime) {
      sendDailySummary().catch(err => console.error('Daily summary failed:', err.message));
    }
  }, 60 * 1000));

  // Backup daily at 03:00
  _intervals.push(setInterval(() => {
    const now = new Date();
    if (now.getHours() === 3 && now.getMinutes() === 0) {
      backupDatabase();
    }
  }, 60 * 1000));

  console.log('Scheduled jobs started: reminders (hourly), daily summary, backup (03:00)');
}

function stopScheduledJobs() {
  _intervals.forEach(clearInterval);
  _intervals = [];
}

module.exports = {
  createFirstReminder,
  cancelRemindersForGuest,
  createFirstReminderWithDb,
  cancelRemindersForGuestWithDb,
  processDueReminders,
  sendDailySummary,
  backupDatabase,
  startScheduledJobs,
  stopScheduledJobs
};
