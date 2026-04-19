const express = require('express');
const router = express.Router();
const { getDb, getSetting, setSetting } = require('../db/db');
const { normalizePhone } = require('../utils/phone');
const { sendSms, sendWhatsApp, sendToAdmins, validateTwilioSignature } = require('../services/twilio');
const { parseReplyWithAI } = require('../services/parser');
const { executeAdminCommand } = require('../services/admin');

// Twilio signature validation middleware.
// SKIPS ONLY IF the dev opts out EXPLICITLY with DISABLE_TWILIO_SIG=1.
// Previously gated on "NODE_ENV !== 'production'" which silently disabled sig validation
// on any preview/staging env that forgot to set NODE_ENV — that opened admin commands
// to anyone who could hit the webhook URL.
function twilioAuth(req, res, next) {
  if (process.env.DISABLE_TWILIO_SIG === '1') return next();
  if (!validateTwilioSignature(req)) {
    return res.status(403).send('Invalid signature');
  }
  next();
}

// Always respond 200 with empty TwiML to Twilio
function twimlResponse(res) {
  res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
}

// Reply via the same channel the message came in on
function reply(phone, body, channel) {
  return channel === 'whatsapp' ? sendWhatsApp(phone, body) : sendSms(phone, body);
}

// Core incoming message handler (shared between SMS and WhatsApp)
async function handleIncoming(req, res, channel) {
  const db = getDb();
  const from = normalizePhone(req.body.From?.replace('whatsapp:', ''));
  const body = (req.body.Body || '').trim();

  if (!from || !body) return twimlResponse(res);

  // Log incoming message
  const guest = db.prepare('SELECT * FROM guests WHERE phone = ?').get(from);
  db.prepare('INSERT INTO messages (guest_id, direction, channel, content, status) VALUES (?,?,?,?,?)')
    .run(guest?.id || null, 'incoming', channel, body, 'received');

  // Check if sender is admin
  const adminPhones = (getSetting('admin_phones') || '').split(',').map(p => p.trim()).filter(Boolean);
  if (adminPhones.includes(from)) {
    try {
      const result = await executeAdminCommand(body, db);
      await reply(from, result, channel);
    } catch (err) {
      console.error('Admin command failed:', err.message);
      await reply(from, 'שגיאה: ' + err.message, channel);
    }
    return twimlResponse(res);
  }

  // Not an admin — check if known guest
  if (!guest) {
    // Unknown sender
    await reply(from, 'מצטערים, המספר שלך לא נמצא ברשימת המוזמנים. אם יש טעות, נא ליצור קשר עם נתנאל או עמית.', channel);
    await sendToAdmins('הודעה ממספר לא מוכר: ' + from + '\nתוכן: ' + body);
    return twimlResponse(res);
  }

  // Known guest — parse RSVP reply (Level 1-2 keywords, Level 3 Gemini AI)
  const result = await parseReplyWithAI(body);

  // Unrecognized reply — escalate to admins
  if (!result.status) {
    await sendToAdmins('לא הצלחתי לפענח תשובה מ-' + guest.name + ' (' + guest.phone + '):\n"' + body + '"');
    return twimlResponse(res);
  }

  // Handle status transitions
  switch (result.status) {
    case 'coming': {
      const num = result.numComing || guest.num_invited;
      db.prepare("UPDATE guests SET status='coming', num_coming=? WHERE id=?").run(num, guest.id);
      try { require('../services/reminder').cancelRemindersForGuest(guest.id); } catch (e) { /* reminder module not yet available */ }
      await reply(from, 'תודה ' + guest.name + '! שמחים שאתם מגיעים' + (num > 1 ? ' (' + num + ' אנשים)' : '') + ' 🎉', channel);
      // Check milestones
      checkMilestone(db);
      break;
    }
    case 'not_coming': {
      db.prepare("UPDATE guests SET status='not_coming', num_coming=0 WHERE id=?").run(guest.id);
      try { require('../services/reminder').cancelRemindersForGuest(guest.id); } catch (e) { /* reminder module not yet available */ }
      await reply(from, 'תודה על העדכון ' + guest.name + '. נשמח לראות אתכם באירוע אחר!', channel);
      break;
    }
    case 'undecided': {
      db.prepare("UPDATE guests SET status='undecided' WHERE id=?").run(guest.id);
      await reply(from, 'בסדר ' + guest.name + ', ניצור קשר שוב בהמשך. אפשר לעדכן בכל שלב!', channel);
      break;
    }
    case 'opted_out': {
      db.prepare("UPDATE guests SET status='opted_out' WHERE id=?").run(guest.id);
      try { require('../services/reminder').cancelRemindersForGuest(guest.id); } catch (e) { /* reminder module not yet available */ }
      await reply(from, 'הוסרת מרשימת התפוצה. כדי לחזור, שלח "חידוש".', channel);
      break;
    }
    case 're_enable': {
      db.prepare("UPDATE guests SET status='invited' WHERE id=?").run(guest.id);
      try { require('../services/reminder').createFirstReminder(guest.id); } catch (e) { /* reminder module not yet available */ }
      await reply(from, 'חזרת לרשימה ' + guest.name + '! נשמח לשמוע אם תוכלו להגיע.', channel);
      break;
    }
  }

  twimlResponse(res);
}

// Check and send milestone notifications.
// Read-modify-write of the milestones_sent setting is wrapped in one SQLite transaction so
// two concurrent reply webhooks can't both decide to send the same milestone (prior bug caused
// the admin to receive duplicate "🎉 100 אורחים" messages on high-traffic moments).
function checkMilestone(db) {
  const thresholds = (getSetting('milestone_thresholds') || '').split(',').map(Number).filter(Boolean);
  const totalComing = db.prepare("SELECT COALESCE(SUM(num_coming),0) as c FROM guests WHERE status='coming'").get().c;

  let crossed = null;
  const txn = db.transaction(() => {
    const sent = (getSetting('milestones_sent') || '').split(',').filter(Boolean);
    for (const t of thresholds) {
      if (totalComing >= t && !sent.includes(String(t))) {
        sent.push(String(t));
        setSetting('milestones_sent', sent.join(','));
        crossed = t;
        break;
      }
    }
  });
  txn();
  if (crossed !== null) {
    sendToAdmins('🎉 אבן דרך! הגענו ל-' + totalComing + ' מאושרים!');
  }
}

// Ordinal rank of message statuses — higher means "later in lifecycle".
// Used to prevent an out-of-order status callback from overwriting a later status with an earlier one
// (Twilio sends queued → sent → delivered, but occasionally reorders them in the webhook stream).
const STATUS_RANK = { queued: 1, accepted: 1, sent: 2, delivered: 3, read: 4, failed: 99, undelivered: 99, received: 99 };

function updateStatusFromCallback(req) {
  const db = getDb();
  const sid = req.body.MessageSid;
  const newStatus = req.body.MessageStatus;
  if (!sid || !newStatus) return;

  // Ladder guard: read current status, only write if new >= current.
  const existing = db.prepare('SELECT status FROM messages WHERE twilio_sid = ?').get(sid);
  if (existing) {
    const curRank = STATUS_RANK[existing.status] || 0;
    const newRank = STATUS_RANK[newStatus] || 0;
    // Never regress (delivered → sent, read → delivered) UNLESS we're moving into a terminal error state
    if (curRank > newRank && newRank < 99) return;
  }

  const errorCode = req.body.ErrorCode;
  const errorMessage = req.body.ErrorMessage;
  if ((newStatus === 'failed' || newStatus === 'undelivered') && (errorCode || errorMessage)) {
    const detail = '[' + (errorCode || '?') + '] ' + (errorMessage || '') + ' ' + hebrewHint(errorCode);
    db.prepare('UPDATE messages SET status = ?, error = COALESCE(NULLIF(?, \'\'), error) WHERE twilio_sid = ?').run(newStatus, detail.trim(), sid);
  } else {
    db.prepare('UPDATE messages SET status = ? WHERE twilio_sid = ?').run(newStatus, sid);
  }
}

// Short Hebrew explanation for common Twilio error codes so the dashboard shows a hint alongside the raw code.
// Expanded per UX review — covers the bulk of errors users will see in practice.
function hebrewHint(code) {
  const hints = {
    // Trial account
    '21608': '— החשבון ב-Twilio במצב ניסיון. שדרג או אמת את המספר בקונסול של Twilio.',
    '21610': '— הנמען ביקש להסיר (STOP). ישלח "חידוש" כדי לחזור.',
    '21614': '— מספר היעד לא חוקי לפי Twilio. ערוך את המספר ונסה שוב.',
    '21211': '— מספר היעד שגוי או לא תקני.',
    '21612': '— Twilio לא יכול לשלוח מהמספר-מקור לטלפון הזה. ייתכן שצריך לאפשר שליחה בינלאומית להגדרות Twilio.',
    '21408': '— שליחה למדינה זו חסומה בהגדרות הגיאוגרפיות של Twilio. הפעל את ישראל ב-Messaging → Geo Permissions.',
    // WhatsApp
    '63007': '— סנדבוקס WhatsApp: הנמען לא הצטרף. שלח "join getting-film" ל-+14155238886.',
    '63015': '— סנדבוקס WhatsApp: הנמען לא הצטרף. שלח "join getting-film" ל-+14155238886.',
    '63016': '— שליחת WhatsApp חופשי מחוץ לחלון 24 שעות. חייבים תבנית מאושרת של מטא.',
    '63018': '— מגבלת קצב WhatsApp נחצתה. המתן ונסה שוב.',
    '63024': '— המספר לא רשום ב-WhatsApp.',
    '63032': '— תבנית WhatsApp לא מאושרה עדיין במטא.',
    // Carrier / delivery
    '30003': '— מכשיר היעד כבוי או מחוץ לכיסוי.',
    '30004': '— ההודעה נחסמה על ידי הנמען או המפעיל.',
    '30005': '— המספר לא קיים.',
    '30006': '— המספר ב-landline / לא תומך ב-SMS.',
    '30007': '— המפעיל סינן את ההודעה כספאם.',
    '30008': '— כשלון מסירה לא ידוע מצד המפעיל.',
    '30044': '— המפעיל הישראלי חסם SMS ממספר US. עבור לוואטסאפ או רכוש מספר ישראלי ב-Twilio.',
    '30034': '— המספר-מקור לא רשום ל-A2P 10DLC. פעולת רישום נדרשת ב-Twilio Console.'
  };
  return hints[String(code)] || '';
}

// SMS webhooks
router.post('/sms', twilioAuth, (req, res) => { return handleIncoming(req, res, 'sms'); });
router.post('/sms/status', twilioAuth, (req, res) => { updateStatusFromCallback(req); twimlResponse(res); });

// WhatsApp webhooks
router.post('/whatsapp', twilioAuth, (req, res) => { return handleIncoming(req, res, 'whatsapp'); });
router.post('/whatsapp/status', twilioAuth, (req, res) => { updateStatusFromCallback(req); twimlResponse(res); });

module.exports = router;
