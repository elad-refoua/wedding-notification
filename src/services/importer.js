const XLSX = require('xlsx');
const path = require('path');
const { getDb } = require('../db/db');
const { normalizePhone } = require('../utils/phone');

const COLUMN_MAP = {
  'שם': 'name', 'name': 'name',
  'טלפון': 'phone', 'phone': 'phone',
  'צד': 'side', 'side': 'side',
  'קבוצה': 'group_name', 'group': 'group_name',
  'מוזמנים': 'num_invited', 'invited': 'num_invited',
  'הערות': 'notes', 'notes': 'notes'
};

const SIDE_MAP = { 'חתן': 'groom', 'כלה': 'bride', 'groom': 'groom', 'bride': 'bride' };

const REVERSE_SIDE_MAP = { 'groom': 'חתן', 'bride': 'כלה' };

function importExcelWithDb(filePath, db) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws);

  let imported = 0, skipped = 0;
  const errors = [];

  const insert = db.prepare('INSERT INTO guests (name, phone, side, group_name, num_invited, notes) VALUES (?,?,?,?,?,?)');

  for (const row of rows) {
    // Map columns
    const mapped = {};
    for (const [key, value] of Object.entries(row)) {
      const field = COLUMN_MAP[key.trim()];
      if (field) mapped[field] = value;
    }

    // Validate
    if (!mapped.name || !String(mapped.name).trim()) {
      skipped++;
      errors.push('Missing name');
      continue;
    }

    const phone = normalizePhone(String(mapped.phone || ''));
    if (!phone) {
      skipped++;
      errors.push('Invalid phone: ' + (mapped.phone || 'empty'));
      continue;
    }

    const side = SIDE_MAP[String(mapped.side || '').trim()] || null;
    const group = mapped.group_name ? String(mapped.group_name).trim() : null;
    const numInvited = parseInt(mapped.num_invited) || 1;
    const notes = mapped.notes ? String(mapped.notes).trim() : null;

    try {
      insert.run(String(mapped.name).trim(), phone, side, group, numInvited, notes);
      imported++;
    } catch (e) {
      if (e.message.includes('UNIQUE')) {
        skipped++;
        errors.push('Duplicate: ' + phone);
      } else {
        skipped++;
        errors.push(e.message);
      }
    }
  }

  return { imported, skipped, total: rows.length, errors };
}

function exportExcelWithDb(filePath, db, statusFilter) {
  let sql = 'SELECT * FROM guests';
  const params = [];
  if (statusFilter) { sql += ' WHERE status = ?'; params.push(statusFilter); }
  sql += ' ORDER BY name';

  const guests = db.prepare(sql).all(...params);

  const data = guests.map(g => ({
    'שם': g.name,
    'טלפון': g.phone,
    'צד': REVERSE_SIDE_MAP[g.side] || g.side || '',
    'קבוצה': g.group_name || '',
    'מוזמנים': g.num_invited,
    'מגיעים': g.num_coming,
    'סטטוס': g.status,
    'הערות': g.notes || ''
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'אורחים');
  XLSX.writeFile(wb, filePath);
  return filePath;
}

// Production variants
function importExcel(filePath) {
  return importExcelWithDb(filePath, getDb());
}

function importExcelFromBuffer(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws);
  const db = getDb();

  let imported = 0, skipped = 0;
  const errors = [];
  const insert = db.prepare('INSERT INTO guests (name, phone, side, group_name, num_invited, notes) VALUES (?,?,?,?,?,?)');

  for (const row of rows) {
    const mapped = {};
    for (const [key, value] of Object.entries(row)) {
      const field = COLUMN_MAP[key.trim()];
      if (field) mapped[field] = value;
    }
    if (!mapped.name || !String(mapped.name).trim()) { skipped++; errors.push('Missing name'); continue; }
    const phone = normalizePhone(String(mapped.phone || ''));
    if (!phone) { skipped++; errors.push('Invalid phone: ' + (mapped.phone || 'empty')); continue; }
    const side = SIDE_MAP[String(mapped.side || '').trim()] || null;
    const group = mapped.group_name ? String(mapped.group_name).trim() : null;
    const numInvited = parseInt(mapped.num_invited) || 1;
    const notes = mapped.notes ? String(mapped.notes).trim() : null;
    try {
      insert.run(String(mapped.name).trim(), phone, side, group, numInvited, notes);
      imported++;
    } catch (e) {
      skipped++;
      errors.push(e.message.includes('UNIQUE') ? 'Duplicate: ' + phone : e.message);
    }
  }
  return { imported, skipped, total: rows.length, errors };
}

function exportExcel(statusFilter) {
  const filePath = path.join(__dirname, '..', '..', 'exports', 'guests-' + new Date().toISOString().split('T')[0] + '.xlsx');
  const dir = path.dirname(filePath);
  const fs = require('fs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return exportExcelWithDb(filePath, getDb(), statusFilter);
}

module.exports = { importExcel, importExcelFromBuffer, exportExcel, importExcelWithDb, exportExcelWithDb };
