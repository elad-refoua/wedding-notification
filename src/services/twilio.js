const twilio = require('twilio');
const { getDb, getSetting } = require('../db/db');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM_PHONE = process.env.TWILIO_PHONE_NUMBER;

async function sendSms(to, body) {
  const msg = await client.messages.create({
    body,
    from: FROM_PHONE,
    to,
    statusCallback: process.env.WEBHOOK_BASE_URL + '/webhooks/sms/status'
  });
  return msg.sid;
}

async function sendWhatsApp(to, body) {
  const msg = await client.messages.create({
    body,
    from: 'whatsapp:' + FROM_PHONE,
    to: 'whatsapp:' + to,
    statusCallback: process.env.WEBHOOK_BASE_URL + '/webhooks/whatsapp/status'
  });
  return msg.sid;
}

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

async function sendToAdmins(body) {
  const adminPhones = (getSetting('admin_phones') || '').split(',').filter(Boolean);
  for (const phone of adminPhones) {
    try {
      await sendSms(phone.trim(), body);
      if (getSetting('whatsapp_enabled') === 'true') {
        await sendWhatsApp(phone.trim(), body);
      }
    } catch (err) {
      console.error('Admin notify failed for ' + phone + ':', err.message);
    }
  }
}

function validateTwilioSignature(req) {
  const signature = req.headers['x-twilio-signature'];
  const url = process.env.WEBHOOK_BASE_URL + req.originalUrl;
  return twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, signature, url, req.body);
}

module.exports = { sendSms, sendWhatsApp, sendToGuest, sendToAdmins, validateTwilioSignature };
