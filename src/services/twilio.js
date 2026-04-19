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
function getSmsPhone() {
  return process.env.TWILIO_PHONE_NUMBER;
}
function getWhatsAppPhone() {
  return process.env.TWILIO_WHATSAPP_NUMBER || process.env.TWILIO_PHONE_NUMBER;
}

async function sendSms(to, body) {
  const msg = await getClient().messages.create({
    body,
    from: getSmsPhone(),
    to,
    statusCallback: process.env.WEBHOOK_BASE_URL + '/webhooks/sms/status'
  });
  return msg.sid;
}

async function sendWhatsApp(to, body) {
  const msg = await getClient().messages.create({
    body,
    from: 'whatsapp:' + getWhatsAppPhone(),
    to: 'whatsapp:' + to,
    statusCallback: process.env.WEBHOOK_BASE_URL + '/webhooks/whatsapp/status'
  });
  return msg.sid;
}

/**
 * Send a WhatsApp message using an approved Meta template (contentSid = 'HX...').
 * Required for business-initiated messages outside the 24h session window once the
 * account moves off the sandbox. Variables map positionally: { "1": "Dana", "2": "3" }.
 */
async function sendWhatsAppTemplate(to, contentSid, variables) {
  const msg = await getClient().messages.create({
    from: 'whatsapp:' + getWhatsAppPhone(),
    to: 'whatsapp:' + to,
    contentSid,
    contentVariables: variables ? JSON.stringify(variables) : undefined,
    statusCallback: process.env.WEBHOOK_BASE_URL + '/webhooks/whatsapp/status'
  });
  return msg.sid;
}

/**
 * Send a single message to a guest using the configured channel strategy.
 * Strategies (set via `default_channel` setting or per-call `opts.channel`):
 *   'whatsapp' — WhatsApp only; logs failure if unreachable (no silent SMS fallback)
 *   'sms'      — SMS only
 *   'auto'     — try WhatsApp first, fall back to SMS on failure (one message actually delivered)
 *   'both'     — legacy behaviour: send on both channels (guest gets two copies)
 *
 * `opts.templateSid` + `opts.templateVariables` — if present AND channel is whatsapp/auto,
 * the WhatsApp send uses Twilio Content API (required for WABA senders outside 24h window).
 *
 * Every attempt is logged to the `messages` table with its channel and status, including
 * failures (`status='failed'`, error column populated).
 *
 * Returns: { sms, whatsapp, delivered } — the Twilio SIDs of successful sends and which
 * channel ultimately delivered. Does NOT update guest.status — callers own that.
 */
async function sendToGuest(guest, body, opts) {
  opts = opts || {};
  const db = getDb();
  const whatsappEnabled = getSetting('whatsapp_enabled') === 'true';
  const strategy = opts.channel || getSetting('default_channel') || 'auto';
  const results = { sms: null, whatsapp: null, delivered: null };

  const logSent = (channel, content, sid) =>
    db.prepare('INSERT INTO messages (guest_id, direction, channel, content, status, twilio_sid) VALUES (?, ?, ?, ?, ?, ?)')
      .run(guest.id, 'outgoing', channel, content, 'sent', sid);
  const logFailed = (channel, content, detail) =>
    db.prepare('INSERT INTO messages (guest_id, direction, channel, content, status, error) VALUES (?, ?, ?, ?, ?, ?)')
      .run(guest.id, 'outgoing', channel, content, 'failed', detail);

  const tryWhatsApp = async () => {
    try {
      const sid = opts.templateSid
        ? await sendWhatsAppTemplate(guest.phone, opts.templateSid, opts.templateVariables)
        : await sendWhatsApp(guest.phone, body);
      results.whatsapp = sid;
      results.delivered = results.delivered || 'whatsapp';
      // Content column stores the rendered body for audit, even for template sends
      logSent('whatsapp', body, sid);
      return true;
    } catch (err) {
      const detail = formatTwilioError(err);
      console.error('WhatsApp failed for ' + guest.phone + ':', detail);
      logFailed('whatsapp', body, detail);
      return false;
    }
  };

  const trySms = async () => {
    try {
      const sid = await sendSms(guest.phone, body);
      results.sms = sid;
      results.delivered = results.delivered || 'sms';
      logSent('sms', body, sid);
      return true;
    } catch (err) {
      const detail = formatTwilioError(err);
      console.error('SMS failed for ' + guest.phone + ':', detail);
      logFailed('sms', body, detail);
      return false;
    }
  };

  if (strategy === 'sms') {
    await trySms();
  } else if (strategy === 'whatsapp') {
    if (!whatsappEnabled) {
      // Respect enable flag — if WhatsApp is explicitly disabled, fall through to SMS so guest still gets a message
      await trySms();
    } else {
      await tryWhatsApp();
    }
  } else if (strategy === 'both') {
    await trySms();
    if (whatsappEnabled) await tryWhatsApp();
  } else {
    // 'auto' (default): WhatsApp first, SMS only if WhatsApp fails
    const waOk = whatsappEnabled && (await tryWhatsApp());
    if (!waOk) await trySms();
  }

  return results;
}

function formatTwilioError(err) {
  if (!err) return 'unknown error';
  const code = err.code ? '[' + err.code + '] ' : '';
  const msg = err.message || String(err);
  const more = err.moreInfo ? ' — ' + err.moreInfo : '';
  return (code + msg + more).slice(0, 1000);
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

module.exports = { sendSms, sendWhatsApp, sendWhatsAppTemplate, sendToGuest, sendToAdmins, validateTwilioSignature, formatTwilioError };
