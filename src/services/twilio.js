const twilio = require('twilio');
const { getDb, getSetting } = require('../db/db');

let _client = null;
function getClient() {
  if (!_client) {
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
      throw new Error('Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN environment variables');
    }
    _client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return _client;
}
function getFromPhone() {
  return process.env.TWILIO_PHONE_NUMBER;
}

async function sendSms(to, body) {
  const msg = await getClient().messages.create({
    body,
    from: getFromPhone(),
    to,
    statusCallback: process.env.WEBHOOK_BASE_URL + '/webhooks/sms/status'
  });
  return msg.sid;
}

async function sendWhatsApp(to, body) {
  const msg = await getClient().messages.create({
    body,
    from: 'whatsapp:' + getFromPhone(),
    to: 'whatsapp:' + to,
    statusCallback: process.env.WEBHOOK_BASE_URL + '/webhooks/whatsapp/status'
  });
  return msg.sid;
}

/**
 * Send message to guest via SMS (+ WhatsApp if enabled). Logs to messages table.
 * NOTE: Does NOT update guest.status — caller is responsible for status transitions.
 */
async function sendToGuest(guest, body) {
  const results = { sms: null, whatsapp: null };
  const db = getDb();
  const whatsappEnabled = getSetting('whatsapp_enabled') === 'true';

  try {
    const sid = await sendSms(guest.phone, body);
    results.sms = sid;
    db.prepare('INSERT INTO messages (guest_id, direction, channel, content, status, twilio_sid) VALUES (?, ?, ?, ?, ?, ?)')
      .run(guest.id, 'outgoing', 'sms', body, 'sent', sid);
  } catch (err) {
    console.error('SMS failed for ' + guest.phone + ':', err.message);
    db.prepare('INSERT INTO messages (guest_id, direction, channel, content, status) VALUES (?, ?, ?, ?, ?)')
      .run(guest.id, 'outgoing', 'sms', body, 'failed');
  }

  if (whatsappEnabled) {
    try {
      const sid = await sendWhatsApp(guest.phone, body);
      results.whatsapp = sid;
      db.prepare('INSERT INTO messages (guest_id, direction, channel, content, status, twilio_sid) VALUES (?, ?, ?, ?, ?, ?)')
        .run(guest.id, 'outgoing', 'whatsapp', body, 'sent', sid);
    } catch (err) {
      console.error('WhatsApp failed for ' + guest.phone + ':', err.message);
      db.prepare('INSERT INTO messages (guest_id, direction, channel, content, status) VALUES (?, ?, ?, ?, ?)')
        .run(guest.id, 'outgoing', 'whatsapp', body, 'failed');
    }
  }

  return results;
}

/**
 * Send notification to all admins via preferred channel.
 * Uses WhatsApp if enabled, otherwise SMS — never both to avoid duplicates.
 */
async function sendToAdmins(body) {
  const adminPhones = (getSetting('admin_phones') || '').split(',').filter(Boolean);
  const useWhatsApp = getSetting('whatsapp_enabled') === 'true';
  for (const phone of adminPhones) {
    try {
      if (useWhatsApp) {
        await sendWhatsApp(phone.trim(), body);
      } else {
        await sendSms(phone.trim(), body);
      }
    } catch (err) {
      console.error('Admin notify failed for ' + phone + ':', err.message);
    }
  }
}

function validateTwilioSignature(req) {
  const signature = req.headers['x-twilio-signature'];
  if (!signature || !process.env.WEBHOOK_BASE_URL || !process.env.TWILIO_AUTH_TOKEN) {
    return false;
  }
  const url = process.env.WEBHOOK_BASE_URL + req.originalUrl;
  return twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, signature, url, req.body);
}

module.exports = { sendSms, sendWhatsApp, sendToGuest, sendToAdmins, validateTwilioSignature };
