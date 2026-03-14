const { normalizePhone } = require('../utils/phone');

const STATUS_KEYWORDS = {
  'מגיע': 'coming', 'מגיעים': 'coming',
  'לא מגיע': 'not_coming', 'לא מגיעים': 'not_coming',
  'מתלבט': 'undecided', 'מתלבטים': 'undecided'
};
const SIDE_KEYWORDS = { 'חתן': 'groom', 'כלה': 'bride' };

function parseAdminCommand(text) {
  if (!text || typeof text !== 'string') return { action: 'unknown' };
  const t = text.trim();

  if (/^סטטוס$/i.test(t)) return { action: 'status' };
  if (/^עזרה$/i.test(t)) return { action: 'help' };
  if (/^ייבא$/i.test(t)) return { action: 'import' };
  if (/^עצור שליחה$/i.test(t)) return { action: 'pause_send' };
  if (/^המשך שליחה$/i.test(t)) return { action: 'resume_send' };
  if (/^שלח לכולם$/i.test(t)) return { action: 'send_all' };

  const sendGroupMatch = t.match(/^שלח ל(.+)$/i);
  if (sendGroupMatch) return { action: 'send_group', group: sendGroupMatch[1].trim() };

  const addMatch = t.match(/^הוסף\s+(.+)$/i);
  if (addMatch) {
    const rest = addMatch[1];
    const phoneMatch = rest.match(/(0[5-9]\d[\d\-\s]{7,}|\+972[5-9]\d{8})/);
    if (phoneMatch) {
      const phoneIdx = rest.indexOf(phoneMatch[0]);
      const name = rest.slice(0, phoneIdx).trim();
      const afterPhone = rest.slice(phoneIdx + phoneMatch[0].length).trim();
      const words = afterPhone.split(/\s+/).filter(Boolean);
      let side = null, group = null;
      for (const w of words) {
        if (SIDE_KEYWORDS[w] && !side) side = w;
        else if (!group) group = w;
        else group += ' ' + w;
      }
      return { action: 'add_guest', name, phone: phoneMatch[0].replace(/[\s\-]/g, ''), side, group };
    }
  }

  const reminderMatch = t.match(/^תזכורות כל\s+(\d+)\s*ימים?$/i);
  if (reminderMatch) return { action: 'set_reminder_interval', days: parseInt(reminderMatch[1]) };

  const stopRemMatch = t.match(/^עצור תזכורות ל(.+)$/i);
  if (stopRemMatch) return { action: 'stop_reminders', query: stopRemMatch[1].trim() };

  const updateMatch = t.match(/^עדכן\s+(.+)$/i);
  if (updateMatch) {
    const rest = updateMatch[1];
    const sortedKeys = Object.keys(STATUS_KEYWORDS).sort((a, b) => b.length - a.length);
    for (const kw of sortedKeys) {
      const idx = rest.indexOf(kw);
      if (idx !== -1) {
        const query = rest.slice(0, idx).trim();
        const afterStatus = rest.slice(idx + kw.length).trim();
        const numMatch = afterStatus.match(/(\d+)/);
        return { action: 'update_status', query, status: STATUS_KEYWORDS[kw], num: numMatch ? parseInt(numMatch[1]) : null };
      }
    }
  }

  const summaryMatch = t.match(/^דוח יומי(?:\s+ב[- ]?(\d{1,2}:\d{2}))?$/i);
  if (summaryMatch) return { action: 'set_summary_time', time: summaryMatch[1] || null };

  return { action: 'unknown' };
}

async function executeAdminCommand(text, db) {
  const cmd = parseAdminCommand(text);
  if (!db) db = require('../db/db').getDb();
  const { getSetting, setSetting } = require('../db/db');

  switch (cmd.action) {
    case 'status': {
      const s = {
        coming: db.prepare("SELECT COUNT(*) as c FROM guests WHERE status = 'coming'").get().c,
        not_coming: db.prepare("SELECT COUNT(*) as c FROM guests WHERE status = 'not_coming'").get().c,
        undecided: db.prepare("SELECT COUNT(*) as c FROM guests WHERE status = 'undecided'").get().c,
        pending: db.prepare("SELECT COUNT(*) as c FROM guests WHERE status IN ('pending','invited')").get().c,
        total_people: db.prepare("SELECT COALESCE(SUM(num_coming),0) as c FROM guests WHERE status='coming'").get().c
      };
      return 'סטטוס:\n✅ מגיעים: ' + s.coming + ' (' + s.total_people + ' נפשות)\n❌ לא: ' + s.not_coming + '\n🤔 מתלבטים: ' + s.undecided + '\n⏳ ממתינים: ' + s.pending;
    }
    case 'send_all':
    case 'send_group': {
      let sql = "SELECT * FROM guests WHERE status = 'pending'";
      const params = [];
      if (cmd.group) { sql += ' AND group_name LIKE ?'; params.push('%' + cmd.group + '%'); }
      const guests = db.prepare(sql).all(...params);
      if (!guests.length) return 'אין אורחים ממתינים לשליחה';

      // Actually send invitations in background
      const template = getSetting('invitation_template') || 'שלום {{name}}, אתם מוזמנים לחתונה של נתנאל ועמית!';
      const batchSize = parseInt(getSetting('batch_size') || '10');
      const batchDelay = parseInt(getSetting('batch_delay_seconds') || '60') * 1000;
      const { sendToGuest, sendToAdmins } = require('./twilio');
      const { createFirstReminder } = require('./reminder');

      (async () => {
        let sent = 0;
        for (let i = 0; i < guests.length; i++) {
          const g = guests[i];
          const body = template.replace(/\{\{name\}\}/g, g.name);
          try {
            await sendToGuest(g, body);
            db.prepare("UPDATE guests SET status = 'invited' WHERE id = ?").run(g.id);
            createFirstReminder(g.id);
            sent++;
          } catch (err) {
            console.error('Send failed for ' + g.name + ':', err.message);
          }
          if ((i + 1) % batchSize === 0 && i < guests.length - 1) {
            await new Promise(resolve => setTimeout(resolve, batchDelay));
          }
        }
        await sendToAdmins('שליחה הושלמה: ' + sent + '/' + guests.length + ' הזמנות נשלחו');
      })().catch(err => console.error('Bulk send failed:', err));

      return 'מתחיל שליחה ל-' + guests.length + ' אורחים... תקבלו עדכון בסיום.';
    }
    case 'add_guest': {
      const phone = normalizePhone(cmd.phone);
      if (!phone) return 'מספר טלפון לא תקין';
      try {
        db.prepare('INSERT INTO guests (name, phone, side, group_name) VALUES (?,?,?,?)')
          .run(cmd.name, phone, SIDE_KEYWORDS[cmd.side] || null, cmd.group || null);
        return 'נוסף: ' + cmd.name + ' (' + phone + ')';
      } catch (e) {
        return e.message.includes('UNIQUE') ? 'מספר כבר קיים' : 'שגיאה: ' + e.message;
      }
    }
    case 'set_reminder_interval':
      setSetting('reminder_interval_days', cmd.days);
      return 'תזכורות עודכנו לכל ' + cmd.days + ' ימים';
    case 'stop_reminders': {
      const guests = db.prepare('SELECT * FROM guests WHERE name LIKE ? OR phone LIKE ?').all('%'+cmd.query+'%', '%'+cmd.query+'%');
      if (!guests.length) return 'לא נמצא: ' + cmd.query;
      if (guests.length > 1) return 'נמצאו ' + guests.length + ':\n' + guests.map((g,i) => (i+1)+'. '+g.name+' ('+g.phone+')').join('\n');
      try { require('./reminder').cancelRemindersForGuest(guests[0].id); } catch (e) { /* reminder module not yet available */ }
      return 'תזכורות הופסקו ל-' + guests[0].name;
    }
    case 'update_status': {
      const guests = db.prepare('SELECT * FROM guests WHERE name LIKE ? OR phone LIKE ?').all('%'+cmd.query+'%', '%'+cmd.query+'%');
      if (!guests.length) return 'לא נמצא: ' + cmd.query;
      if (guests.length > 1) return 'נמצאו ' + guests.length + ':\n' + guests.map((g,i) => (i+1)+'. '+g.name+' ('+g.phone+')').join('\n');
      const num = cmd.num || (cmd.status === 'coming' ? guests[0].num_invited : 0);
      db.prepare("UPDATE guests SET status=?, num_coming=?, updated_at=datetime('now') WHERE id=?").run(cmd.status, num, guests[0].id);
      try {
        if (cmd.status === 'coming' || cmd.status === 'not_coming') require('./reminder').cancelRemindersForGuest(guests[0].id);
      } catch (e) { /* reminder module not yet available */ }
      return 'עודכן: ' + guests[0].name + ' → ' + cmd.status + (cmd.num ? ' (' + cmd.num + ')' : '');
    }
    case 'set_summary_time':
      if (cmd.time) { setSetting('daily_summary_time', cmd.time); return 'דוח יומי עודכן ל-' + cmd.time; }
      return 'דוח יומי: ' + (getSetting('daily_summary_time') || '20:00');
    case 'pause_send': return 'שליחה מופסקת';
    case 'resume_send': return 'אין שליחה מושהית';
    case 'import': return 'לייבוא, השתמש ב-CLI';
    case 'help': return 'פקודות:\n• סטטוס\n• שלח לכולם / שלח ל<קבוצה>\n• הוסף <שם> <טלפון> [צד] [קבוצה]\n• תזכורות כל X ימים\n• עצור תזכורות ל<שם>\n• עדכן <שם> מגיע/לא מגיע [מספר]\n• דוח יומי ב-HH:MM\n• עצור שליחה / המשך שליחה\n• עזרה';
    default: return 'לא הבנתי. שלח \'עזרה\' לרשימת פקודות';
  }
}

module.exports = { parseAdminCommand, executeAdminCommand };
