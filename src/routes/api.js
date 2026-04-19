const express = require('express');
const path = require('path');
const router = express.Router();
const { getDb, getSetting, setSetting } = require('../db/db');
const { normalizePhone } = require('../utils/phone');

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

// GET /api/reminders
router.get('/reminders', (req, res) => {
  const db = getDb();
  let sql = 'SELECT r.*, g.name as guest_name FROM reminders r LEFT JOIN guests g ON r.guest_id = g.id WHERE 1=1';
  const params = [];
  if (req.query.status) { sql += ' AND r.status = ?'; params.push(req.query.status); }
  sql += ' ORDER BY r.scheduled_at ASC';
  res.json(db.prepare(sql).all(...params));
});

// GET /api/settings
router.get('/settings', (req, res) => {
  const rows = getDb().prepare('SELECT * FROM settings').all();
  const obj = {};
  for (const row of rows) obj[row.key] = row.value;
  // Mask sensitive keys
  if (obj.gemini_api_key) {
    const key = obj.gemini_api_key;
    obj.gemini_api_key = '****...' + key.slice(-4);
  }
  res.json(obj);
});

// PUT /api/settings — all changes committed in one SQLite transaction so the
// DB file on the GCS FUSE volume flushes once, not once per key (which used to
// take 10+ seconds for a full-form save and timed out Firefox).
router.put('/settings', (req, res) => {
  const db = getDb();
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const txn = db.transaction((entries) => {
    for (const [key, value] of entries) {
      if (key === 'gemini_api_key' && typeof value === 'string' && value.startsWith('****')) continue;
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

// POST /api/send-invitations — send invitations to pending guests
router.post('/send-invitations', async (req, res) => {
  try {
    const db = getDb();
    const { sendToGuest } = require('../services/twilio');
    const { createFirstReminder } = require('../services/reminder');
    const template = getSetting('invitation_template') || 'שלום {{name}}, אתם מוזמנים לחתונה של נתנאל ועמית!';
    const templateSid = getSetting('whatsapp_template_invitation_sid') || null;
    const batchSize = parseInt(getSetting('batch_size') || '10');
    const batchDelay = parseInt(getSetting('batch_delay_seconds') || '60') * 1000;
    const channelOverride = req.body.channel || null; // 'whatsapp' | 'sms' | 'auto' | 'both' | null

    let sql = "SELECT * FROM guests WHERE status = 'pending'";
    const params = [];
    if (req.body.group) { sql += ' AND group_name LIKE ?'; params.push('%' + req.body.group + '%'); }
    const guests = db.prepare(sql).all(...params);

    if (!guests.length) return res.json({ sent: 0, total: 0, message: 'אין אורחים ממתינים' });

    // Send in background, return immediately
    const total = guests.length;
    (async () => {
      let sent = 0;
      for (let i = 0; i < guests.length; i++) {
        const g = guests[i];
        const body = template.replace(/\{\{name\}\}/g, g.name);
        try {
          const opts = { channel: channelOverride || undefined };
          if (templateSid) {
            opts.templateSid = templateSid;
            opts.templateVariables = { "1": g.name };
          }
          const result = await sendToGuest(g, body, opts);
          // Only promote to 'invited' when at least one channel actually accepted the send.
          // If both SMS and WhatsApp failed (result.delivered === null), leave status='pending'
          // so the guest shows up in the next retry/send and admin can see they were NOT contacted.
          if (result && result.delivered) {
            db.prepare("UPDATE guests SET status = 'invited' WHERE id = ?").run(g.id);
            createFirstReminder(g.id);
            sent++;
          } else {
            console.warn('Invitation NOT delivered for ' + g.name + ' — keeping status=pending');
          }
        } catch (err) {
          console.error('Send invitation failed for ' + g.name + ':', err.message);
        }
        if ((i + 1) % batchSize === 0 && i < guests.length - 1) {
          await new Promise(resolve => setTimeout(resolve, batchDelay));
        }
      }
      console.log('Bulk send complete: ' + sent + '/' + total);
    })().catch(err => console.error('Bulk send failed:', err));

    res.json({ sent: 0, total, message: 'מתחיל שליחה ל-' + total + ' אורחים...' });
  } catch (e) {
    res.status(500).json({ error: e.message });
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

// POST /api/backfill-errors — for any outgoing message with status='failed' and empty error,
// fetch the Twilio Message record and record error_code/error_message. Safe to call repeatedly.
router.post('/backfill-errors', async (req, res) => {
  const db = getDb();
  const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  const rows = db.prepare("SELECT id, twilio_sid FROM messages WHERE status IN ('failed','undelivered') AND (error IS NULL OR error = '') AND twilio_sid IS NOT NULL").all();
  let updated = 0, skipped = 0;
  const { getSetting } = require('../db/db');
  const hints = { '21608': 'שדר Twilio Trial — מספרים לא מאומתים נחסמים.', '63007': 'WhatsApp Sandbox: הנמען לא שלח "join getting-film" ל-+14155238886.', '63015': 'WhatsApp Sandbox: הנמען לא שלח "join getting-film" ל-+14155238886.', '21211': 'מספר היעד לא תקני.', '21610': 'הנמען ביטל מנוי ("STOP").', '63016': 'הודעת טקסט חופשי מחוץ לחלון 24 שעות — חובה תבנית מאושרת.' };
  for (const r of rows) {
    try {
      const m = await twilio.messages(r.twilio_sid).fetch();
      const detail = (m.errorCode ? '[' + m.errorCode + '] ' : '') + (m.errorMessage || '') + (hints[String(m.errorCode)] ? ' — ' + hints[String(m.errorCode)] : '');
      if (detail.trim()) {
        db.prepare('UPDATE messages SET error = ? WHERE id = ?').run(detail.trim(), r.id);
        updated++;
      } else { skipped++; }
    } catch (e) { skipped++; }
  }
  res.json({ updated, skipped, scanned: rows.length });
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

// POST /api/messages/:id/resend — resend the same content to the same guest using the current
// default_channel strategy. Works on any message (most useful for failed outgoing ones).
router.post('/messages/:id/resend', async (req, res) => {
  try {
    const db = getDb();
    const { sendToGuest } = require('../services/twilio');
    const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
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

// POST /api/retry-failed — bulk retry every outgoing message whose LATEST attempt to its guest
// is still failed/undelivered. One-click recovery after fixing a problem (e.g. opting into the
// WhatsApp sandbox, upgrading Twilio, switching channel). Body: { channel?: 'sms'|'whatsapp'|'auto' }
router.post('/retry-failed', async (req, res) => {
  try {
    const db = getDb();
    const { sendToGuest } = require('../services/twilio');
    // For each guest, find their most-recent outgoing message and retry if that one is failed.
    // Avoids resending to guests who already got a successful delivery afterwards.
    const rows = db.prepare(`
      SELECT m.* FROM messages m
      INNER JOIN (
        SELECT guest_id, MAX(created_at) AS last_at
        FROM messages WHERE direction = 'outgoing' AND guest_id IS NOT NULL GROUP BY guest_id
      ) latest ON latest.guest_id = m.guest_id AND latest.last_at = m.created_at
      WHERE m.direction = 'outgoing' AND m.status IN ('failed','undelivered')
    `).all();
    if (!rows.length) return res.json({ retried: 0, total: 0, message: 'אין הודעות נכשלות לשליחה חוזרת' });
    // Kick off in background (Cloud Run allows this since max_instances=1)
    const total = rows.length;
    (async () => {
      let ok = 0, fail = 0;
      for (const m of rows) {
        try {
          const guest = db.prepare('SELECT * FROM guests WHERE id = ?').get(m.guest_id);
          if (!guest) { fail++; continue; }
          const result = await sendToGuest(guest, m.content || '', { channel: req.body && req.body.channel ? req.body.channel : undefined });
          if (result.delivered) ok++; else fail++;
        } catch (e) { fail++; console.error('Retry failed for message ' + m.id + ':', e.message); }
      }
      console.log('Retry-failed batch complete: ok=' + ok + ' fail=' + fail + ' of ' + total);
    })().catch(err => console.error('Retry-failed batch error:', err));
    res.json({ retried: 0, total, message: 'שליחה חוזרת התחילה ל-' + total + ' הודעות. בדוק את הפעילות תוך שניות.' });
  } catch (e) {
    console.error('Retry-failed error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/guest/:id/timeline — full per-guest message history, chronological oldest-first
router.get('/guests/:id/timeline', (req, res) => {
  const db = getDb();
  const guest = db.prepare('SELECT * FROM guests WHERE id = ?').get(req.params.id);
  if (!guest) return res.status(404).json({ error: 'Guest not found' });
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
