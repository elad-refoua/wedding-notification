const express = require('express');
const router = express.Router();
const { getDb, getSetting, setSetting } = require('../db/db');
const { normalizePhone } = require('../utils/phone');
const { sendSms, sendWhatsApp, sendToAdmins, validateTwilioSignature } = require('../services/twilio');
const { parseReplyWithAI } = require('../services/parser');
const { executeAdminCommand } = require('../services/admin');

// Twilio signature validation middleware (skip in dev)
function twilioAuth(req, res, next) {
  if (process.env.NODE_ENV !== 'production') return next();
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

// Check and send milestone notifications
function checkMilestone(db) {
  const thresholds = (getSetting('milestone_thresholds') || '').split(',').map(Number).filter(Boolean);
  const sent = (getSetting('milestones_sent') || '').split(',').filter(Boolean);
  const totalComing = db.prepare("SELECT COALESCE(SUM(num_coming),0) as c FROM guests WHERE status='coming'").get().c;

  for (const t of thresholds) {
    if (totalComing >= t && !sent.includes(String(t))) {
      sent.push(String(t));
      setSetting('milestones_sent', sent.join(','));
      sendToAdmins('🎉 אבן דרך! הגענו ל-' + totalComing + ' מאושרים!');
      break;
    }
  }
}

// SMS webhooks
router.post('/sms', twilioAuth, (req, res) => { return handleIncoming(req, res, 'sms'); });
router.post('/sms/status', twilioAuth, (req, res) => {
  const db = getDb();
  const sid = req.body.MessageSid;
  const status = req.body.MessageStatus;
  if (sid && status) {
    db.prepare('UPDATE messages SET status = ? WHERE twilio_sid = ?').run(status, sid);
  }
  twimlResponse(res);
});

// WhatsApp webhooks
router.post('/whatsapp', twilioAuth, (req, res) => { return handleIncoming(req, res, 'whatsapp'); });
router.post('/whatsapp/status', twilioAuth, (req, res) => {
  const db = getDb();
  const sid = req.body.MessageSid;
  const status = req.body.MessageStatus;
  if (sid && status) {
    db.prepare('UPDATE messages SET status = ? WHERE twilio_sid = ?').run(status, sid);
  }
  twimlResponse(res);
});

module.exports = router;
