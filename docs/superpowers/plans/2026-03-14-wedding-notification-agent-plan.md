# Wedding Notification Agent — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an agent-driven wedding invitation and RSVP management system for ~400 guests, with WhatsApp + SMS via Twilio, Hebrew NLP reply parsing, automated reminders, and a Hebrew dashboard.

**Architecture:** Node.js Express server (port 3860) with SQLite via better-sqlite3. Twilio SDK for WhatsApp + SMS. Cloudflare tunnel for webhooks. pm2 for process management. Server is autonomous (handles webhooks, reminders, admin commands). Claude Code supervises complex tasks.

**Tech Stack:** Node.js 20+, Express, better-sqlite3, twilio, xlsx, node:test (built-in test runner), cloudflared, pm2

**Spec:** `docs/superpowers/specs/2026-03-14-wedding-notification-agent-design.md`

---

## Chunk 1: Foundation (Project Setup, Database, Utilities)

### Task 1: Project Initialization

**Files:**
- Create: `package.json`
- Create: `.env.example`
- Create: `.env`

- [ ] **Step 1: Initialize npm project**

Run: `npm init -y`

- [ ] **Step 2: Install dependencies**

Run: `npm install express better-sqlite3 twilio xlsx dotenv`

- [ ] **Step 3: Create .env.example**

```
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
ANTHROPIC_API_KEY=
DASHBOARD_TOKEN=wedding-admin-2026
PORT=3860
TZ=Asia/Jerusalem
WEBHOOK_BASE_URL=
```

- [ ] **Step 4: Create .env from example with real values**

Copy `.env.example` to `.env`. Fill in Twilio credentials from the Twilio console. Generate a random DASHBOARD_TOKEN.

- [ ] **Step 5: Update .gitignore**

Add `node_modules/` if not already present.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .env.example .gitignore
git commit -m "feat: initialize project with dependencies"
```

---

### Task 2: Database Schema and Connection

**Files:**
- Create: `src/db/schema.sql`
- Create: `src/db/db.js`
- Create: `tests/db.test.js`

- [ ] **Step 1: Write schema.sql**

```sql
CREATE TABLE IF NOT EXISTS guests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  side TEXT CHECK(side IN ('groom', 'bride')),
  group_name TEXT,
  num_invited INTEGER DEFAULT 1,
  num_coming INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'invited', 'coming', 'not_coming', 'undecided', 'opted_out')),
  notes TEXT,
  created_at DATETIME DEFAULT (datetime('now')),
  updated_at DATETIME DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guest_id INTEGER REFERENCES guests(id),
  direction TEXT NOT NULL CHECK(direction IN ('outgoing', 'incoming')),
  channel TEXT NOT NULL CHECK(channel IN ('whatsapp', 'sms')),
  content TEXT,
  status TEXT DEFAULT 'sent' CHECK(status IN ('sent', 'delivered', 'read', 'failed', 'received')),
  twilio_sid TEXT,
  created_at DATETIME DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guest_id INTEGER REFERENCES guests(id),
  scheduled_at DATETIME NOT NULL,
  sent_at DATETIME,
  reminder_num INTEGER NOT NULL DEFAULT 1,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'sent', 'cancelled'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Default settings
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('reminder_interval_days', '5'),
  ('max_reminders', '10'),
  ('invitation_template', 'שלום {{name}}, אתם מוזמנים לחתונה של נתנאל ועמית! נשמח לדעת אם תוכלו להגיע.'),
  ('reminder_template', 'היי {{name}}, רק רצינו לוודא - נשמח לדעת אם תוכלו להגיע לחתונה'),
  ('daily_summary_time', '20:00'),
  ('batch_size', '10'),
  ('batch_delay_seconds', '60'),
  ('whatsapp_enabled', 'false'),
  ('admin_phones', ''),
  ('milestone_thresholds', '50,100,150,200,250,300,350'),
  ('milestones_sent', '');
```

- [ ] **Step 2: Write db.js**

```js
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '..', 'guests.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    db.exec(schema);
  }
  return db;
}

function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

function closeDb() {
  if (db) { db.close(); db = null; }
}

module.exports = { getDb, getSetting, setSetting, closeDb };
```

- [ ] **Step 3: Write failing test**

```js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');

describe('Database', () => {
  let db;

  before(() => {
    const Database = require('better-sqlite3');
    const fs = require('fs');
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
    db.exec(schema);
  });

  after(() => { db.close(); });

  it('should create guests table', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='guests'").all();
    assert.strictEqual(tables.length, 1);
  });

  it('should insert and retrieve a guest', () => {
    db.prepare('INSERT INTO guests (name, phone) VALUES (?, ?)').run('דוד כהן', '+972501234567');
    const guest = db.prepare('SELECT * FROM guests WHERE phone = ?').get('+972501234567');
    assert.strictEqual(guest.name, 'דוד כהן');
    assert.strictEqual(guest.status, 'pending');
    assert.strictEqual(guest.num_invited, 1);
  });

  it('should enforce unique phone', () => {
    assert.throws(() => {
      db.prepare('INSERT INTO guests (name, phone) VALUES (?, ?)').run('Other', '+972501234567');
    });
  });

  it('should have default settings', () => {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'reminder_interval_days'").get();
    assert.strictEqual(row.value, '5');
  });

  it('should enforce valid status', () => {
    assert.throws(() => {
      db.prepare("INSERT INTO guests (name, phone, status) VALUES (?, ?, ?)").run('Bad', '+972509999999', 'invalid');
    });
  });
});
```

- [ ] **Step 4: Run test**

Run: `node --test tests/db.test.js`
Expected: All 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.sql src/db/db.js tests/db.test.js
git commit -m "feat: add database schema, connection module, and tests"
```

---

### Task 3: Phone Number Utility

**Files:**
- Create: `src/utils/phone.js`
- Create: `tests/phone.test.js`

- [ ] **Step 1: Write failing test**

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { normalizePhone, isValidPhone } = require('../src/utils/phone');

describe('Phone normalization', () => {
  it('converts 05X to +9725X', () => {
    assert.strictEqual(normalizePhone('0501234567'), '+972501234567');
  });
  it('strips dashes and spaces', () => {
    assert.strictEqual(normalizePhone('050-123-4567'), '+972501234567');
    assert.strictEqual(normalizePhone('050 123 4567'), '+972501234567');
  });
  it('keeps +972 format as-is', () => {
    assert.strictEqual(normalizePhone('+972501234567'), '+972501234567');
  });
  it('handles 972 without plus', () => {
    assert.strictEqual(normalizePhone('972501234567'), '+972501234567');
  });
  it('returns null for invalid numbers', () => {
    assert.strictEqual(normalizePhone('hello'), null);
    assert.strictEqual(normalizePhone('123'), null);
    assert.strictEqual(normalizePhone(''), null);
  });
});

describe('Phone validation', () => {
  it('validates E.164 Israeli numbers', () => {
    assert.strictEqual(isValidPhone('+972501234567'), true);
    assert.strictEqual(isValidPhone('+972521234567'), true);
    assert.strictEqual(isValidPhone('bad'), false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/phone.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement phone.js**

```js
function normalizePhone(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let phone = raw.replace(/[\s\-\(\)]/g, '');
  if (phone.startsWith('+')) phone = phone.slice(1);
  if (/^0[5-9]\d{8}$/.test(phone)) {
    phone = '972' + phone.slice(1);
  }
  if (/^972[5-9]\d{8}$/.test(phone)) {
    return '+' + phone;
  }
  return null;
}

function isValidPhone(phone) {
  return /^\+972[5-9]\d{8}$/.test(phone);
}

module.exports = { normalizePhone, isValidPhone };
```

- [ ] **Step 4: Run test**

Run: `node --test tests/phone.test.js`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/utils/phone.js tests/phone.test.js
git commit -m "feat: add Israeli phone number normalization utility"
```

---

### Task 4: Basic Express Server

**Files:**
- Create: `server.js`

- [ ] **Step 1: Write server.js**

```js
require('dotenv').config();
const express = require('express');
const path = require('path');
const { getDb } = require('./src/db/db');

const app = express();
const PORT = process.env.PORT || 3860;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Auth middleware for API/dashboard routes
function authMiddleware(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
    return next();
  }
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token === process.env.DASHBOARD_TOKEN) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

app.use('/api', authMiddleware);
app.use('/dashboard', authMiddleware, express.static(path.join(__dirname, 'dashboard')));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Initialize DB on startup
getDb();

app.listen(PORT, () => {
  console.log(`Wedding server running on port ${PORT}`);
});

module.exports = app;
```

- [ ] **Step 2: Test manually**

Run: `node server.js &` then `curl http://localhost:3860/health`
Expected: `{"status":"ok","timestamp":"..."}`

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: add basic Express server with auth middleware"
```

---

## Chunk 2: Core Services (Twilio, Parser, Admin Commands)

### Task 5: Twilio Service

**Files:**
- Create: `src/services/twilio.js`

- [ ] **Step 1: Write twilio.js**

```js
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
```

- [ ] **Step 2: Commit**

```bash
git add src/services/twilio.js
git commit -m "feat: add Twilio send service (SMS + WhatsApp + admin notify)"
```

---

### Task 6: Hebrew Reply Parser

**Files:**
- Create: `src/services/parser.js`
- Create: `tests/parser.test.js`

- [ ] **Step 1: Write failing test**

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { parseReply } = require('../src/services/parser');

describe('Hebrew reply parser', () => {
  it('parses "כן" as coming', () => assert.strictEqual(parseReply('כן').status, 'coming'));
  it('parses "בטח נגיע" as coming', () => assert.strictEqual(parseReply('בטח נגיע').status, 'coming'));
  it('parses "מגיעים!" as coming', () => assert.strictEqual(parseReply('מגיעים!').status, 'coming'));
  it('parses "לא נוכל" as not_coming', () => assert.strictEqual(parseReply('לא נוכל').status, 'not_coming'));
  it('parses "לצערנו לא" as not_coming', () => assert.strictEqual(parseReply('לצערנו לא').status, 'not_coming'));
  it('parses "עוד לא יודעים" as undecided', () => assert.strictEqual(parseReply('עוד לא יודעים').status, 'undecided'));
  it('parses "לא בטוח" as undecided (not not_coming)', () => assert.strictEqual(parseReply('לא בטוח').status, 'undecided'));
  it('parses "אולי" as undecided', () => assert.strictEqual(parseReply('אולי').status, 'undecided'));
  it('extracts number from "נבוא 4"', () => {
    const r = parseReply('נבוא 4');
    assert.strictEqual(r.status, 'coming');
    assert.strictEqual(r.numComing, 4);
  });
  it('extracts number from "מגיעים 2"', () => {
    const r = parseReply('מגיעים 2');
    assert.strictEqual(r.status, 'coming');
    assert.strictEqual(r.numComing, 2);
  });
  it('parses "הסר" as opted_out', () => assert.strictEqual(parseReply('הסר').status, 'opted_out'));
  it('parses "stop" as opted_out', () => assert.strictEqual(parseReply('stop').status, 'opted_out'));
  it('parses "חידוש" as re_enable', () => assert.strictEqual(parseReply('חידוש').status, 're_enable'));
  it('returns null for "מה השעה?"', () => assert.strictEqual(parseReply('מה השעה?').status, null));
});

describe('Level 3 Claude API fallback', () => {
  it('classifyWithClaude returns status from API response', async () => {
    const { classifyWithClaude } = require('../src/services/parser');
    // This test verifies the function signature and error handling.
    // In CI, ANTHROPIC_API_KEY is not set, so it should return null (UNCLEAR).
    const result = await classifyWithClaude('אם הילדים יהיו בריאים אז כן');
    // Without API key, should gracefully return null
    assert.strictEqual(result.status, null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/parser.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement parser.js (Level 1 + Level 2)**

```js
const PHRASES = {
  opted_out: ['הסר', 'stop', 'הפסק'],
  re_enable: ['חידוש'],
  undecided: [
    'עוד לא יודעים', 'צריך לבדוק', 'נחזור אליכם', 'צריך לחשוב',
    'לא בטוח', 'לא יודע', 'אולי', 'נעדכן'
  ],
  not_coming: [
    'לצערנו לא', 'לא מגיעים', 'נאלץ לוותר', 'לא יכולים',
    'לא נוכל', 'לא נגיע', 'לא באים', 'לצערנו'
  ],
  coming: [
    'שמחים להגיע', 'אישור הגעה', 'אנחנו שם', 'בטח נגיע',
    'כן נגיע', 'נהיה שם', 'מגיעים', 'בהחלט', 'נגיע', 'נבוא', 'בטח', 'כן'
  ]
};

for (const key of Object.keys(PHRASES)) {
  PHRASES[key].sort((a, b) => b.length - a.length);
}

const NUM_PATTERNS = [
  /(נבוא|נגיע|מגיעים|אנחנו)\s*(\d+)/,
  /(\d+)\s*(אנשים|נפשות|מגיעים)?/
];

function parseReply(text) {
  if (!text || typeof text !== 'string') return { status: null, numComing: null };
  const cleaned = text.replace(/[.,!?;:'"()\-]/g, '').trim();

  let status = null;
  const priorities = ['opted_out', 're_enable', 'undecided', 'not_coming', 'coming'];
  for (const cat of priorities) {
    for (const phrase of PHRASES[cat]) {
      if (cleaned.includes(phrase)) { status = cat; break; }
    }
    if (status) break;
  }

  let numComing = null;
  for (const pattern of NUM_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const num = parseInt(match[1]) || parseInt(match[2]);
      if (num && num > 0 && num <= 50) { numComing = num; break; }
    }
  }

  return { status, numComing };
}

module.exports = { parseReply, classifyWithClaude };
```

- [ ] **Step 4: Add Level 3 — classifyWithClaude function to parser.js**

```js
async function classifyWithClaude(text) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { status: null, numComing: null };

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 50,
        messages: [{
          role: 'user',
          content: 'Classify this Hebrew wedding RSVP reply as COMING, NOT_COMING, UNDECIDED, or UNCLEAR. Reply with only the classification and optional number of guests. Reply: ' + text
        }]
      })
    });

    if (!response.ok) return { status: null, numComing: null };
    const data = await response.json();
    const answer = (data.content?.[0]?.text || '').trim().toUpperCase();

    const statusMap = { 'COMING': 'coming', 'NOT_COMING': 'not_coming', 'UNDECIDED': 'undecided' };
    const status = statusMap[answer.split(/\s/)[0]] || null;
    const numMatch = answer.match(/(\d+)/);
    return { status, numComing: numMatch ? parseInt(numMatch[1]) : null };
  } catch (err) {
    console.error('Claude API classification failed:', err.message);
    return { status: null, numComing: null };
  }
}
```

If `classifyWithClaude` returns `null` status → the webhook handler escalates to admins.

- [ ] **Step 5: Run test**

Run: `node --test tests/parser.test.js`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/parser.js tests/parser.test.js
git commit -m "feat: add Hebrew reply parser with L1 keywords, L2 numbers, L3 Claude API"
```

---

### Task 7: Admin Command Parser

**Files:**
- Create: `src/services/admin.js`
- Create: `tests/admin.test.js`

- [ ] **Step 1: Write failing test**

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { parseAdminCommand } = require('../src/services/admin');

describe('Admin command parser', () => {
  it('parses "סטטוס"', () => assert.strictEqual(parseAdminCommand('סטטוס').action, 'status'));
  it('parses "שלח לכולם"', () => assert.strictEqual(parseAdminCommand('שלח לכולם').action, 'send_all'));
  it('parses "שלח לחברים של החתן"', () => {
    const cmd = parseAdminCommand('שלח לחברים של החתן');
    assert.strictEqual(cmd.action, 'send_group');
    assert.strictEqual(cmd.group, 'חברים של החתן');
  });
  it('parses "הוסף דוד כהן 0501234567 חתן חברים"', () => {
    const cmd = parseAdminCommand('הוסף דוד כהן 0501234567 חתן חברים');
    assert.strictEqual(cmd.action, 'add_guest');
    assert.strictEqual(cmd.name, 'דוד כהן');
    assert.strictEqual(cmd.phone, '0501234567');
  });
  it('parses "תזכורות כל 5 ימים"', () => {
    const cmd = parseAdminCommand('תזכורות כל 5 ימים');
    assert.strictEqual(cmd.action, 'set_reminder_interval');
    assert.strictEqual(cmd.days, 5);
  });
  it('parses "עדכן דוד כהן מגיע 3"', () => {
    const cmd = parseAdminCommand('עדכן דוד כהן מגיע 3');
    assert.strictEqual(cmd.action, 'update_status');
    assert.strictEqual(cmd.status, 'coming');
    assert.strictEqual(cmd.num, 3);
  });
  it('parses "עצור שליחה"', () => assert.strictEqual(parseAdminCommand('עצור שליחה').action, 'pause_send'));
  it('parses "המשך שליחה"', () => assert.strictEqual(parseAdminCommand('המשך שליחה').action, 'resume_send'));
  it('parses "עזרה"', () => assert.strictEqual(parseAdminCommand('עזרה').action, 'help'));
  it('returns unknown for gibberish', () => assert.strictEqual(parseAdminCommand('בלה בלה').action, 'unknown'));
  it('parses "דוח יומי ב-21:00"', () => {
    const cmd = parseAdminCommand('דוח יומי ב-21:00');
    assert.strictEqual(cmd.action, 'set_summary_time');
    assert.strictEqual(cmd.time, '21:00');
  });
  it('parses "עצור תזכורות לדוד כהן"', () => {
    const cmd = parseAdminCommand('עצור תזכורות לדוד כהן');
    assert.strictEqual(cmd.action, 'stop_reminders');
    assert.strictEqual(cmd.query, 'דוד כהן');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/admin.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement admin.js — parseAdminCommand function**

```js
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
```

- [ ] **Step 4: Implement admin.js — executeAdminCommand function**

```js
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
      // Batch send logic — uses sendToGuest + createFirstReminder per guest
      // with batch_size/batch_delay_seconds from settings
      return 'מתחיל שליחה ל-' + guests.length + ' אורחים...';
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
      require('./reminder').cancelRemindersForGuest(guests[0].id);
      return 'תזכורות הופסקו ל-' + guests[0].name;
    }
    case 'update_status': {
      const guests = db.prepare('SELECT * FROM guests WHERE name LIKE ? OR phone LIKE ?').all('%'+cmd.query+'%', '%'+cmd.query+'%');
      if (!guests.length) return 'לא נמצא: ' + cmd.query;
      if (guests.length > 1) return 'נמצאו ' + guests.length + ':\n' + guests.map((g,i) => (i+1)+'. '+g.name+' ('+g.phone+')').join('\n');
      const num = cmd.num || (cmd.status === 'coming' ? guests[0].num_invited : 0);
      db.prepare("UPDATE guests SET status=?, num_coming=?, updated_at=datetime('now') WHERE id=?").run(cmd.status, num, guests[0].id);
      if (cmd.status === 'coming' || cmd.status === 'not_coming') require('./reminder').cancelRemindersForGuest(guests[0].id);
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
```

- [ ] **Step 4: Run test**

Run: `node --test tests/admin.test.js`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/admin.js tests/admin.test.js
git commit -m "feat: add admin WhatsApp command parser and executor"
```

---

## Chunk 3: Server Routes (API, Webhooks, Reminders, Excel)

### Task 8: REST API Routes

**Files:**
- Create: `src/routes/api.js`

- [ ] **Step 1: Implement API routes**

Endpoints:
- `GET /api/guests` — list with optional filters (status, side, group, search)
- `GET /api/guests/:id` — single guest
- `POST /api/guests` — add guest (name, phone required)
- `PUT /api/guests/:id` — update guest fields
- `DELETE /api/guests/:id` — remove guest
- `GET /api/stats` — summary counts (coming, not_coming, undecided, pending, total, total_people)
- `GET /api/messages` — list with optional filters (guest_id, direction, channel, limit)
- `GET /api/reminders` — list with optional status filter
- `GET /api/settings` — all settings as key-value object
- `PUT /api/settings` — update settings (body = key-value pairs)
- `POST /api/import` — import Excel (body.filePath)
- `GET /api/export` — download Excel (optional status filter)

- [ ] **Step 2: Wire into server.js**

```js
app.use('/api', authMiddleware, require('./src/routes/api'));
```

- [ ] **Step 3: Commit**

```bash
git add src/routes/api.js server.js
git commit -m "feat: add REST API routes for guests, messages, reminders, settings"
```

---

### Task 9: Webhook Routes

**Files:**
- Create: `src/routes/webhooks.js`

- [ ] **Step 1: Implement webhook routes**

Endpoints:
- `POST /webhooks/sms` — incoming SMS, routes to admin command parser or RSVP parser
- `POST /webhooks/sms/status` — delivery status callback, updates message status
- `POST /webhooks/whatsapp` — incoming WhatsApp, same routing logic
- `POST /webhooks/whatsapp/status` — delivery status callback

Routing logic:
1. Normalize incoming phone number
2. If from admin phone -> parse as admin command, reply with result
3. If from known guest -> parse as RSVP reply:
   - Level 1+2 (parseReply) first. If status found -> update guest, handle opt-out/re-enable
   - If status is null -> call classifyWithClaude (Level 3). If still null -> escalate to admins
   - On COMING: update status + num_coming, cancel reminders
   - On NOT_COMING: update status, cancel reminders
   - On UNDECIDED: update status (reminders continue)
   - On OPTED_OUT: update status, cancel reminders, reply confirmation
   - On RE_ENABLE: set status to 'invited', call `createFirstReminder(guestId)` to restart reminder cycle
   - Check milestones after any COMING status change
4. If from unknown -> reply with "not on the list" message, notify admins

**CRITICAL dependency on Task 10:** The `send_all`/`send_group` admin commands (in admin.js) must call `createFirstReminder(guestId)` after updating each guest to `invited` status. Without this, no reminders will ever fire. Import this from `reminder.js`.

Twilio signature validation middleware (skip in dev mode).
Respond 200 immediately with empty TwiML.

- [ ] **Step 2: Wire into server.js**

```js
app.use('/webhooks', require('./src/routes/webhooks'));
```

- [ ] **Step 3: Commit**

```bash
git add src/routes/webhooks.js server.js
git commit -m "feat: add Twilio webhook routes for SMS and WhatsApp"
```

---

### Task 10: Reminder Engine

**Files:**
- Create: `src/services/reminder.js`
- Create: `tests/reminder.test.js`

- [ ] **Step 1: Write failing test**

Test `createFirstReminderWithDb` creates a pending reminder row.
Test `cancelRemindersForGuestWithDb` sets pending reminders to cancelled.
Use in-memory SQLite for tests.

- [ ] **Step 2: Implement reminder.js**

Functions:
- `createFirstReminder(guestId)` — insert reminder row with scheduled_at = now + interval days
- `cancelRemindersForGuest(guestId)` — set all pending reminders to cancelled
- `processDueReminders()` — hourly job: find due reminders, check 24h dedup, send, create next
- `sendDailySummary()` — send stats to all admins
- `backupDatabase()` — copy DB to backups/ with date, cleanup old
- `startScheduledJobs()` — start all intervals (reminders hourly, summary check every minute, backup daily at 03:00)

WithDb variants for testing with in-memory DB.

- [ ] **Step 3: Run test**

Run: `node --test tests/reminder.test.js`
Expected: Pass.

- [ ] **Step 4: Wire scheduled jobs into server.js**

```js
const { startScheduledJobs } = require('./src/services/reminder');
startScheduledJobs();
```

- [ ] **Step 5: Commit**

```bash
git add src/services/reminder.js tests/reminder.test.js server.js
git commit -m "feat: add reminder engine with scheduled jobs and daily summary"
```

---

### Task 11: Excel Import/Export

**Files:**
- Create: `src/services/importer.js`
- Create: `tests/importer.test.js`

- [ ] **Step 1: Write failing test**

Create test Excel in memory with 4 rows (2 valid, 1 missing name, 1 bad phone).
Verify importExcelWithDb returns imported=2, skipped=2.
Verify correct phone normalization and side mapping (חתן->groom).

- [ ] **Step 2: Implement importer.js**

Column mapping: שם/name, טלפון/phone, צד/side, קבוצה/group, מוזמנים/invited, הערות/notes.
Side mapping: חתן->groom, כלה->bride.
Validation: skip missing name/phone, skip invalid phone, skip duplicates.
Export: reverse mapping back to Hebrew headers.

- [ ] **Step 3: Run test**

Run: `node --test tests/importer.test.js`
Expected: Pass.

- [ ] **Step 4: Commit**

```bash
git add src/services/importer.js tests/importer.test.js
git commit -m "feat: add Excel import/export with Hebrew column support"
```

---

## Chunk 4: Dashboard (Hebrew RTL Web UI)

### Task 12: Dashboard Shared Assets

**Files:**
- Create: `dashboard/css/style.css`
- Create: `dashboard/js/app.js`

- [ ] **Step 1: Write style.css**

RTL Hebrew dashboard. Dark slate theme (#1e293b bg, #f1f5f9 text). Card layout for stats. Status colors: coming=green, not_coming=red, undecided=amber, pending=gray. Responsive table styles. Navigation bar. Form styles. Modal styles.

- [ ] **Step 2: Write app.js**

Shared utilities:
- `api(path, options)` — fetch wrapper (auto-adds auth header if needed)
- `formatDate(iso)` — Hebrew date formatting
- `statusLabel(status)` — Hebrew status labels (מגיע, לא מגיע, מתלבט, ממתין, הוסר)
- `statusClass(status)` — CSS class names for badges
- Navigation active-page highlighting

- [ ] **Step 3: Commit**

```bash
git add dashboard/css/style.css dashboard/js/app.js
git commit -m "feat: add dashboard shared styles (RTL Hebrew) and JS utilities"
```

---

### Task 13: Dashboard Pages

**Files:**
- Create: `dashboard/index.html`
- Create: `dashboard/guests.html`
- Create: `dashboard/messages.html`
- Create: `dashboard/reminders.html`
- Create: `dashboard/settings.html`
- Create: `dashboard/export.html`

- [ ] **Step 1: Write index.html (Home)**

Status cards (coming/not/undecided/pending/total + total people coming). Progress bar toward 400. Recent activity feed (last 20 messages). Auto-refresh every 30s.

- [ ] **Step 2: Write guests.html**

Table: שם, טלפון, צד, קבוצה, סטטוס, מוזמנים, מגיעים. Filter dropdowns (status, side). Search box. Add guest form. Import Excel file upload. Inline click-to-edit.

- [ ] **Step 3: Write messages.html**

Table: time, guest name, direction arrow, channel icon (WA/SMS), content, status badge. Filter by direction, channel. Click guest for full conversation modal.

- [ ] **Step 4: Write reminders.html**

Table: guest name, scheduled time, reminder #, status. Pause/resume per guest. Global pause all.

- [ ] **Step 5: Write settings.html**

Form for all settings. Save button. Admin phones list manager (add/remove). Twilio connection status indicator.

- [ ] **Step 6: Write export.html**

Status filter dropdown. Preview table. Export Excel download button.

- [ ] **Step 7: Manual test**

Run: `node server.js`
Open: `http://localhost:3860/dashboard/`
Verify all pages load, RTL is correct, data fetches work.

- [ ] **Step 8: Commit**

```bash
git add dashboard/
git commit -m "feat: add complete Hebrew RTL dashboard (6 pages)"
```

---

## Chunk 5: Deployment and Twilio Setup

### Task 14: Cloudflare Tunnel

- [ ] **Step 1: Install cloudflared**

Run: `winget install Cloudflare.cloudflared`

- [ ] **Step 2: Create quick tunnel**

Run: `cloudflared tunnel --url http://localhost:3860`
Note the assigned URL.

- [ ] **Step 3: Update .env**

Set `WEBHOOK_BASE_URL` to the tunnel URL.

- [ ] **Step 4: Commit**

```bash
git add .env.example
git commit -m "feat: add Cloudflare tunnel configuration"
```

---

### Task 15: Twilio Account Setup (Browser)

- [ ] **Step 1: Upgrade Twilio account** (user enters payment manually)
- [ ] **Step 2: Buy Israeli +972 phone number** (with user approval)
- [ ] **Step 3: Configure SMS webhook URL** to `{WEBHOOK_BASE_URL}/webhooks/sms`
- [ ] **Step 4: Set up WhatsApp sender** (initiate Meta approval)
- [ ] **Step 5: Configure WhatsApp webhook URL** (after approval)
- [ ] **Step 6: Update .env with credentials**
- [ ] **Step 7: Set admin_phones** via dashboard settings
- [ ] **Step 8: End-to-end test** — send "סטטוס" from admin phone, verify response

---

### Task 16: Process Manager (pm2)

**Files:**
- Create: `ecosystem.config.js`

- [ ] **Step 1: Install pm2**

Run: `npm install -g pm2`

- [ ] **Step 2: Create ecosystem.config.js**

```js
module.exports = {
  apps: [{
    name: 'wedding',
    script: 'server.js',
    env: { NODE_ENV: 'production', TZ: 'Asia/Jerusalem' },
    watch: false,
    max_memory_restart: '200M'
  }]
};
```

- [ ] **Step 3: Start and save**

Run: `pm2 start ecosystem.config.js && pm2 save && pm2 startup`

- [ ] **Step 4: Commit**

```bash
git add ecosystem.config.js
git commit -m "feat: add pm2 ecosystem config for production"
```

---

### Task 17: Final Integration Test

- [ ] **Step 1: Run all unit tests** — `node --test tests/*.test.js`
- [ ] **Step 2: Start server** — `pm2 start ecosystem.config.js`
- [ ] **Step 3: Import test Excel** with 5 sample guests
- [ ] **Step 4: Send test invitations** — "שלח לכולם" from admin phone
- [ ] **Step 5: Test reply parsing** — reply with "כן", "לא", "אולי"
- [ ] **Step 6: Verify dashboard** — all stats update correctly
- [ ] **Step 7: Final commit**

```bash
git commit -m "chore: complete wedding notification agent — ready for production"
```
