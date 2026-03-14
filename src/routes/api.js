const express = require('express');
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
  res.json(obj);
});

// PUT /api/settings
router.put('/settings', (req, res) => {
  for (const [key, value] of Object.entries(req.body)) {
    setSetting(key, value);
  }
  res.json({ updated: true });
});

// POST /api/import
router.post('/import', async (req, res) => {
  try {
    const { importExcel } = require('../services/importer');
    const result = importExcel(req.body.filePath);
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
