const express = require('express');
const path = require('path');
const router = express.Router();
const { getDb, getSetting, setSetting } = require('../db/db');
const { normalizePhone } = require('../utils/phone');
const reminderSvc = require('../services/reminder');
const twilioSvc = require('../services/twilio');
const importerSvc = require('../services/importer');
const bulkSvc = require('../services/bulk');

// Middleware: load guest by :id param (or 404). Attaches req.guest for handlers.
function loadGuest(req, res, next) {
  const guest = getDb().prepare('SELECT * FROM guests WHERE id = ?').get(req.params.id);
  if (!guest) return res.status(404).json({ error: 'האורח לא נמצא' });
  req.guest = guest;
  next();
}

// GET /api/guests — list with optional filters
router.get('/guests', (req, res) => {
  const db = getDb();
  let sql = 'SELECT * FROM guests WHERE 1=1';
  const params = [];
  if (req.query.status) { sql += ' AND status = ?'; params.push(req.query.status); }
  if (req.query.side) { sql += ' AND side = ?'; params.push(req.query.side); }
  if (req.query.group) { sql += ' AND group_name LIKE ?'; params.push('%' + req.query.group + '%'); }
  if (req.query.search) { sql += ' AND (name LIKE ? OR phone LIKE ?)'; params.push('%' + req.query.search + '%', '%' + req.query.search + '%'); }
  sql += ' ORDER BY created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

// GET /api/guests/:id
router.get('/guests/:id', (req, res) => {
  const guest = getDb().prepare('SELECT * FROM guests WHERE id = ?').get(req.params.id);
  if (!guest) return res.status(404).json({ error: 'Guest not found' });
  res.json(guest);
});

// POST /api/guests — add guest
router.post('/guests', (req, res) => {
  const { name, phone: rawPhone, side, group_name, num_invited, notes } = req.body;
  if (!name || !rawPhone) return res.status(400).json({ error: 'name and phone required' });
  const phone = normalizePhone(rawPhone);
  if (!phone) return res.status(400).json({ error: 'Invalid phone number' });
  try {
    const result = getDb().prepare('INSERT INTO guests (name, phone, side, group_name, num_invited, notes) VALUES (?,?,?,?,?,?)')
      .run(name, phone, side || null, group_name || null, num_invited || 1, notes || null);
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Phone already exists' });
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/guests/:id — update guest
const ALLOWED_STATUSES = new Set(['pending', 'invited', 'coming', 'not_coming', 'undecided', 'opted_out']);
const ALLOWED_SIDES = new Set(['groom', 'bride', 'both']);
router.put('/guests/:id', (req, res) => {
  const db = getDb();
  const guest = db.prepare('SELECT * FROM guests WHERE id = ?').get(req.params.id);
  if (!guest) return res.status(404).json({ error: 'Guest not found' });
  const fields = ['name', 'phone', 'side', 'group_name', 'num_invited', 'num_coming', 'status', 'notes'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      if (f === 'phone') {
        const p = normalizePhone(req.body[f]);
        if (!p) return res.status(400).json({ error: 'Invalid phone' });
        updates.push('phone = ?'); params.push(p);
      } else if (f === 'status' && req.body[f] !== null && req.body[f] !== '' && !ALLOWED_STATUSES.has(req.body[f])) {
        return res.status(400).json({ error: 'Invalid status value: ' + req.body[f] });
      } else if (f === 'side' && req.body[f] !== null && req.body[f] !== '' && !ALLOWED_SIDES.has(req.body[f])) {
        return res.status(400).json({ error: 'Invalid side value: ' + req.body[f] });
      } else {
        updates.push(f + ' = ?'); params.push(req.body[f]);
      }
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  params.push(req.params.id);
  db.prepare('UPDATE guests SET ' + updates.join(', ') + ' WHERE id = ?').run(...params);
  res.json(db.prepare('SELECT * FROM guests WHERE id = ?').get(req.params.id));
});

// DELETE /api/guests/:id
router.delete('/guests/:id', (req, res) => {
  const result = getDb().prepare('DELETE FROM guests WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Guest not found' });
  res.json({ deleted: true });
});

// GET /api/stats
router.get('/stats', (req, res) => {
  const db = getDb();
  res.json({
    coming: db.prepare("SELECT COUNT(*) as c FROM guests WHERE status = 'coming'").get().c,
    not_coming: db.prepare("SELECT COUNT(*) as c FROM guests WHERE status = 'not_coming'").get().c,
    undecided: db.prepare("SELECT COUNT(*) as c FROM guests WHERE status = 'undecided'").get().c,
    pending: db.prepare("SELECT COUNT(*) as c FROM guests WHERE status IN ('pending','invited')").get().c,
    total: db.prepare("SELECT COUNT(*) as c FROM guests").get().c,
    total_people: db.prepare("SELECT COALESCE(SUM(num_coming),0) as c FROM guests WHERE status='coming'").get().c
  });
});

// GET /api/messages
router.get('/messages', (req, res) => {
  const db = getDb();
  let sql = 'SELECT m.*, g.name as guest_name FROM messages m LEFT JOIN guests g ON m.guest_id = g.id WHERE 1=1';
  const params = [];
  if (req.query.guest_id) { sql += ' AND m.guest_id = ?'; params.push(req.query.guest_id); }
  if (req.query.direction) { sql += ' AND m.direction = ?'; params.push(req.query.direction); }
  if (req.query.channel) { sql += ' AND m.channel = ?'; params.push(req.query.channel); }
  sql += ' ORDER BY m.created_at DESC';
  const limit = parseInt(req.query.limit) || 100;
  sql += ' LIMIT ?';
  params.push(limit);
  res.json(db.prepare(sql).all(...params));
});

// POST /api/reminders/:id/cancel — cancel one specific upcoming reminder (doesn't affect others)
router.post('/reminders/:id/cancel', (req, res) => {
  const ok = reminderSvc.cancelReminderById(req.params.id);
  if (!ok) return res.status(404).json({ error: 'תזכורת לא נמצאה או כבר לא ממתינה' });
  res.json({ cancelled: true });
});

router.post('/guests/:id/pause-reminders', loadGuest, (req, res) => {
  reminderSvc.pauseRemindersForGuest(req.guest.id);
  res.json({ paused: true, guest: req.guest.name });
});

router.post('/guests/:id/resume-reminders', loadGuest, (req, res) => {
  reminderSvc.resumeRemindersForGuest(req.guest.id);
  res.json({ resumed: true, guest: req.guest.name });
});

// POST /api/reminders/cancel-all-pending — one-click cancel ALL pending reminders (system-wide).
// Useful for "stop all reminders until I re-enable" moments (wedding week, pause the pipeline).
router.post('/reminders/cancel-all-pending', (req, res) => {
  const db = getDb();
  const result = db.prepare("UPDATE reminders SET status = 'cancelled' WHERE status = 'pending'").run();
  res.json({ cancelled: result.changes });
});

// GET /api/reminders
router.get('/reminders', (req, res) => {
  const db = getDb();
  let sql = 'SELECT r.*, g.name as guest_name, g.phone as guest_phone, g.reminders_paused as guest_paused FROM reminders r LEFT JOIN guests g ON r.guest_id = g.id WHERE 1=1';
  const params = [];
  if (req.query.status) { sql += ' AND r.status = ?'; params.push(req.query.status); }
  sql += ' ORDER BY r.scheduled_at ASC';
  res.json(db.prepare(sql).all(...params));
});

// GET /api/settings — never return secrets, even masked. Instead return a boolean flag
// telling the client "this key IS configured" so the UI can show a green checkmark
// without risking round-trip overwrites.
router.get('/settings', (req, res) => {
  const rows = getDb().prepare('SELECT * FROM settings').all();
  const obj = {};
  for (const row of rows) obj[row.key] = row.value;
  obj.gemini_api_key_set = Boolean(obj.gemini_api_key);
  delete obj.gemini_api_key;
  res.json(obj);
});

// PUT /api/settings — all changes committed in one SQLite transaction so the
// DB file on the GCS FUSE volume flushes once, not once per key (used to take
// 10+ seconds for a full-form save).
// Secrets are now write-only (never returned by GET); the *_set booleans from GET
// mean clients never send mask placeholders back.
router.put('/settings', (req, res) => {
  const db = getDb();
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const txn = db.transaction((entries) => {
    for (const [key, value] of entries) {
      if (key === 'gemini_api_key_set') continue; // read-only flag
      if (value === null || value === undefined) continue;
      stmt.run(key, String(value));
    }
  });
  try {
    txn(Object.entries(req.body || {}));
    res.json({ updated: true });
  } catch (e) {
    console.error('PUT /settings failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/send-invitations — send invitations to pending guests (bulk).
// body.channel?   'whatsapp' | 'sms' | 'auto' | 'both' — overrides default_channel for this run
// body.group?     filter to a specific group
// body.limit?     dry-run limit (10/50/etc.) — pick the first N pending guests
// Serialized via in-process lock so concurrent invocations fail fast; progress readable
// from GET /api/bulk-status for live UI updates.
router.post('/send-invitations', async (req, res) => {
  try {
    const db = getDb();
    const bulk = require('../services/bulk');
    const { createFirstReminder } = require('../services/reminder');
    const template = getSetting('invitation_template') || 'שלום {{name}}, אתם מוזמנים לחתונה של נתנאל ועמית!';
    const templateSid = getSetting('whatsapp_template_invitation_sid') || null;
    const channelOverride = req.body.channel || null;
    const limit = req.body.limit ? parseInt(req.body.limit) : null;

    let sql = "SELECT * FROM guests WHERE status = 'pending'";
    const params = [];
    if (req.body.group) { sql += ' AND group_name LIKE ?'; params.push('%' + req.body.group + '%'); }
    sql += ' ORDER BY id ASC';
    if (limit && limit > 0) sql += ' LIMIT ' + limit;
    const guests = db.prepare(sql).all(...params);

    if (!guests.length) return res.json({ total: 0, message: 'אין אורחים ממתינים' });

    if (!bulk.tryLock('bulk_send', { total: guests.length })) {
      return res.status(409).json({ error: 'שליחה אחרת כבר רצה — חכה לסיומה (ראה פעילות).' });
    }

    (async () => {
      try {
        const result = await bulk.bulkSend(
          guests,
          g => template.replace(/\{\{name\}\}/g, g.name),
          {
            channel: channelOverride || undefined,
            templateSidFor: templateSid ? g => ({ templateSid, templateVariables: { "1": g.name } }) : null
          },
          (done, total, lastResult) => {
            // This runs after each guest. lastResult has { sms, whatsapp, delivered }.
            const g = guests[done - 1];
            bulk.updateProgress('bulk_send', { done, lastGuestName: g.name });
            if (lastResult && lastResult.delivered) {
              db.prepare("UPDATE guests SET status = 'invited' WHERE id = ?").run(g.id);
              try { createFirstReminder(g.id); } catch (_) {}
              bulk.updateProgress('bulk_send', { ok: (bulk.status().jobs.bulk_send?.ok || 0) + 1 });
            } else {
              bulk.updateProgress('bulk_send', { fail: (bulk.status().jobs.bulk_send?.fail || 0) + 1 });
            }
          }
        );
        console.log('Bulk send complete: ok=' + result.ok + ' fail=' + result.fail + ' total=' + result.total);
      } finally {
        bulk.release('bulk_send');
      }
    })().catch(err => { console.error('Bulk send failed:', err); bulk.release('bulk_send'); });

    res.json({ total: guests.length, message: 'מתחיל שליחה ל-' + guests.length + ' אורחים. מעקב התקדמות זמין בפעילות.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/bulk-status — live progress of the currently-running bulk job (or nothing running)
router.get('/bulk-status', (req, res) => {
  const bulk = require('../services/bulk');
  res.json(bulk.status());
});

// GET /api/system-status — real Twilio account info + channel/setting context for the dashboard header
router.get('/system-status', async (req, res) => {
  try {
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
      return res.json({ twilio_account_type: 'unknown', reason: 'missing credentials' });
    }
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const acct = await twilio.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
    res.json({
      twilio_account_type: acct.type || 'unknown', // 'Trial' | 'Full'
      twilio_status: acct.status || 'unknown',
      twilio_friendly_name: acct.friendlyName,
      default_channel: getSetting('default_channel') || 'auto',
      whatsapp_enabled: getSetting('whatsapp_enabled') === 'true',
      whatsapp_template_invitation_configured: Boolean(getSetting('whatsapp_template_invitation_sid')),
      wedding_mode: getSetting('wedding_mode') === 'true'
    });
  } catch (e) {
    res.json({ twilio_account_type: 'unknown', reason: e.message });
  }
});

// POST /api/preview-invitation — returns the rendered body for the first N pending guests, without sending
router.post('/preview-invitation', (req, res) => {
  const db = getDb();
  const template = getSetting('invitation_template') || 'שלום {{name}}, אתם מוזמנים לחתונה של נתנאל ועמית!';
  let sql = "SELECT * FROM guests WHERE status = 'pending'";
  const params = [];
  if (req.body.group) { sql += ' AND group_name LIKE ?'; params.push('%' + req.body.group + '%'); }
  const guests = db.prepare(sql + ' LIMIT 3').all(...params);
  const total = db.prepare(sql.replace('SELECT *', 'SELECT COUNT(*) as c')).get(...params).c;
  res.json({
    total_to_send: total,
    samples: guests.map(g => ({
      name: g.name,
      phone: g.phone,
      rendered: template.replace(/\{\{name\}\}/g, g.name)
    })),
    channel_strategy: req.body.channel || getSetting('default_channel') || 'auto',
    whatsapp_template_configured: Boolean(getSetting('whatsapp_template_invitation_sid'))
  });
});

// POST /api/backfill-errors — fetch Twilio error detail for failed/undelivered messages
// missing our local error column. Bounded to 50 rows per call to avoid Cloud Run 504;
// returns { remaining } so the client can loop. Respects the bulk lock so it never runs
// while a send is in flight.
router.post('/backfill-errors', async (req, res) => {
  const db = getDb();
  const bulk = require('../services/bulk');
  if (bulk.status().any_running) {
    return res.status(409).json({ error: 'שליחה פעילה — חכה לסיומה וחזור.' });
  }
  const LIMIT = 50;
  const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  const rows = db.prepare("SELECT id, twilio_sid FROM messages WHERE status IN ('failed','undelivered') AND (error IS NULL OR error = '') AND twilio_sid IS NOT NULL LIMIT ?").all(LIMIT);
  const remainingRow = db.prepare("SELECT COUNT(*) as c FROM messages WHERE status IN ('failed','undelivered') AND (error IS NULL OR error = '') AND twilio_sid IS NOT NULL").get();
  let updated = 0, skipped = 0;
  for (const r of rows) {
    try {
      const m = await twilio.messages(r.twilio_sid).fetch();
      const detail = (m.errorCode ? '[' + m.errorCode + '] ' : '') + (m.errorMessage || '');
      if (detail.trim()) {
        db.prepare('UPDATE messages SET error = ? WHERE id = ?').run(detail.trim(), r.id);
        updated++;
      } else { skipped++; }
    } catch (e) { skipped++; }
  }
  res.json({ updated, skipped, scanned: rows.length, remaining: Math.max(0, remainingRow.c - rows.length) });
});

// GET /api/activity — unified chronological activity feed (sends, replies, status updates).
// Enriched with guest name. Ordered newest-first. Supports `since` param (ISO) for incremental polling.
router.get('/activity', (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  let sql = 'SELECT m.*, g.name as guest_name, g.status as guest_status FROM messages m LEFT JOIN guests g ON m.guest_id = g.id';
  const params = [];
  if (req.query.since) { sql += ' WHERE m.created_at > ?'; params.push(req.query.since); }
  sql += ' ORDER BY m.created_at DESC LIMIT ?';
  params.push(limit);
  const rows = db.prepare(sql).all(...params);
  res.json({
    rows,
    server_time: new Date().toISOString(),
    counts: {
      total: db.prepare('SELECT COUNT(*) as c FROM messages').get().c,
      outgoing_sent: db.prepare("SELECT COUNT(*) as c FROM messages WHERE direction='outgoing' AND status IN ('sent','delivered','read')").get().c,
      outgoing_failed: db.prepare("SELECT COUNT(*) as c FROM messages WHERE direction='outgoing' AND status IN ('failed','undelivered')").get().c,
      incoming: db.prepare("SELECT COUNT(*) as c FROM messages WHERE direction='incoming'").get().c
    }
  });
});

// POST /api/messages/:id/resend — resend the same content to the same guest.
// Idempotent within a 3-second window per message-id so double-clicking the "שלח שוב"
// button doesn't fire two Twilio requests for the same original.
const _recentResends = new Map(); // messageId -> ts
router.post('/messages/:id/resend', async (req, res) => {
  try {
    const db = getDb();
    const { sendToGuest } = require('../services/twilio');
    const messageId = req.params.id;

    const last = _recentResends.get(messageId);
    if (last && Date.now() - last < 3000) {
      return res.status(429).json({ error: 'שליחה חוזרת כבר בתהליך לאותה הודעה — המתן שנייה-שתיים.' });
    }
    _recentResends.set(messageId, Date.now());
    // Garbage-collect old entries
    if (_recentResends.size > 200) {
      for (const [k, t] of _recentResends.entries()) if (Date.now() - t > 10000) _recentResends.delete(k);
    }

    const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (!m) return res.status(404).json({ error: 'ההודעה לא נמצאה' });
    if (!m.guest_id) return res.status(400).json({ error: 'אין אורח מקושר להודעה זו' });
    const guest = db.prepare('SELECT * FROM guests WHERE id = ?').get(m.guest_id);
    if (!guest) return res.status(404).json({ error: 'האורח נמחק' });
    const body = m.content || '';
    if (!body) return res.status(400).json({ error: 'אין תוכן לשליחה חוזרת' });
    const result = await sendToGuest(guest, body, { channel: req.body && req.body.channel ? req.body.channel : undefined });
    res.json({ resent: true, delivered: result.delivered, sms: result.sms, whatsapp: result.whatsapp });
  } catch (e) {
    console.error('Resend failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/retry-failed — bulk retry every guest whose most-recent outgoing message is failed.
// Serialized by the same lock family as /send-invitations so the two can't race.
router.post('/retry-failed', async (req, res) => {
  try {
    const db = getDb();
    const bulk = require('../services/bulk');
    const rows = db.prepare(`
      SELECT m.*, g.name as gname FROM messages m
      INNER JOIN (
        SELECT guest_id, MAX(created_at) AS last_at
        FROM messages WHERE direction = 'outgoing' AND guest_id IS NOT NULL GROUP BY guest_id
      ) latest ON latest.guest_id = m.guest_id AND latest.last_at = m.created_at
      LEFT JOIN guests g ON m.guest_id = g.id
      WHERE m.direction = 'outgoing' AND m.status IN ('failed','undelivered')
    `).all();
    if (!rows.length) return res.json({ total: 0, message: 'אין הודעות נכשלות לשליחה חוזרת' });

    // Share the same lock name as bulk_send — they cannot run concurrently because the
    // send path also writes guest.status and the retry path reads the message table.
    if (!bulk.tryLock('bulk_send', { total: rows.length })) {
      return res.status(409).json({ error: 'שליחה אחרת כבר רצה — חכה לסיומה (ראה פעילות).' });
    }

    // Build virtual "guest" objects from the row set so bulkSend can iterate them the same way
    const guests = rows.map(r => ({ id: r.guest_id, phone: null, name: r.gname, _msgContent: r.content || '' }));
    // Phone comes from DB per guest when sending
    for (const g of guests) {
      const gd = db.prepare('SELECT phone FROM guests WHERE id = ?').get(g.id);
      if (gd) g.phone = gd.phone;
    }

    (async () => {
      try {
        const result = await bulk.bulkSend(
          guests.filter(g => g.phone),
          g => g._msgContent,
          { channel: req.body && req.body.channel ? req.body.channel : undefined },
          (done, total, lastResult) => {
            const g = guests[done - 1];
            bulk.updateProgress('bulk_send', { done, lastGuestName: g && g.name });
            const s = bulk.status().jobs.bulk_send || {};
            if (lastResult && lastResult.delivered) bulk.updateProgress('bulk_send', { ok: (s.ok || 0) + 1 });
            else bulk.updateProgress('bulk_send', { fail: (s.fail || 0) + 1 });
          }
        );
        console.log('Retry-failed complete: ok=' + result.ok + ' fail=' + result.fail + ' of ' + result.total);
      } finally {
        bulk.release('bulk_send');
      }
    })().catch(err => { console.error('Retry-failed error:', err); bulk.release('bulk_send'); });

    res.json({ total: rows.length, message: 'שליחה חוזרת התחילה ל-' + rows.length + ' הודעות.' });
  } catch (e) {
    console.error('Retry-failed error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/guest/:id/timeline — full per-guest message history, chronological oldest-first
router.get('/guests/:id/timeline', loadGuest, (req, res) => {
  const db = getDb();
  const guest = req.guest;
  const messages = db.prepare("SELECT * FROM messages WHERE guest_id = ? ORDER BY created_at ASC").all(req.params.id);
  const reminders = db.prepare("SELECT * FROM reminders WHERE guest_id = ? ORDER BY scheduled_at ASC").all(req.params.id);
  res.json({ guest, messages, reminders });
});

// POST /api/import-paste — import guests from pasted "name, phone, side, group" lines
router.post('/import-paste', (req, res) => {
  try {
    const { importPasted } = require('../services/importer');
    const { text } = req.body;
    if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text field required' });
    res.json(importPasted(text));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/test-sms — send a test SMS to a phone number
router.post('/test-sms', async (req, res) => {
  try {
    const { sendSms, formatTwilioError } = require('../services/twilio');
    const phone = normalizePhone(req.body.phone);
    if (!phone) return res.status(400).json({ error: 'מספר טלפון לא תקין' });
    const message = req.body.message || 'הודעת ניסיון ממערכת החתונה של נתנאל ועמית 💍';
    try {
      const sid = await sendSms(phone, message);
      res.json({ success: true, sid, message: 'SMS נשלח בהצלחה ל-' + phone });
    } catch (err) {
      const detail = formatTwilioError(err);
      console.error('Test SMS failed for ' + phone + ':', detail);
      res.status(502).json({
        error: 'שליחה נכשלה: ' + detail,
        twilio_code: err.code || null,
        more_info: err.moreInfo || null
      });
    }
  } catch (e) {
    res.status(500).json({ error: 'שליחה נכשלה: ' + e.message });
  }
});

// POST /api/import-upload — import guests from uploaded Excel file (base64)
router.post('/import-upload', (req, res) => {
  try {
    const { importExcelFromBuffer } = require('../services/importer');
    const { data } = req.body;
    if (!data) return res.status(400).json({ error: 'No file data' });
    const buffer = Buffer.from(data, 'base64');
    const result = importExcelFromBuffer(buffer);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/import (legacy — server file path)
router.post('/import', async (req, res) => {
  try {
    const { importExcel } = require('../services/importer');
    const filePath = req.body.filePath;
    if (!filePath) return res.status(400).json({ error: 'filePath required' });
    const resolved = path.resolve(filePath);
    const allowedDir = path.resolve(__dirname, '..', '..');
    if (!resolved.startsWith(allowedDir)) return res.status(400).json({ error: 'Path outside project directory' });
    const result = importExcel(resolved);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Import module not available yet' });
  }
});

// GET /api/export
router.get('/export', (req, res) => {
  try {
    const { exportExcel } = require('../services/importer');
    const filePath = exportExcel(req.query.status);
    res.download(filePath);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Export module not available yet' });
  }
});

module.exports = router;
