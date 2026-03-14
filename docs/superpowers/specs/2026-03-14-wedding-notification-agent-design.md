# Wedding Notification Agent — Design Spec

## Overview

An agent-driven system for managing wedding invitations and RSVPs for Netanel & Amit's wedding (August 30, 2026). ~400 guests. Claude Code acts as the primary agent — sending invitations, parsing replies, managing reminders, and reporting status. Three admins (Elad, Netanel, Amit) control the system via WhatsApp messages to the Twilio number. A Hebrew dashboard provides monitoring and manual overrides.

## Architecture

### Approach: Node.js + SQLite + Twilio (Agent-Driven)

```
┌──────────────────────────────────────────────────────┐
│              Claude Code Agent                        │
│                                                        │
│  - Send invitations on schedule                        │
│  - Auto-parse replies → update guest status            │
│  - Auto-send reminders to undecided guests             │
│  - Escalate ambiguous replies to admins                │
│  - Daily summary report via WhatsApp                   │
│  - Execute admin WhatsApp/CLI commands                 │
│  - Manage Twilio config & templates                    │
└───────────────────────┬──────────────────────────────┘
                        │ manages
┌───────────────────────▼──────────────────────────────┐
│              Node.js Server (port 3860)                │
│                                                        │
│  REST API │ Twilio Sender │ Webhook Receiver           │
│  Reply Parser │ Reminder Engine │ Excel Importer       │
└───────────────────────┬──────────────────────────────┘
                        │
          SQLite (guests.db)
                        │
          Twilio (WhatsApp + SMS parallel)
                        │
          Cloudflare Tunnel (webhooks)
                        │
          Dashboard (Hebrew, monitor + override)
```

### Components

- **Express server** on port 3860 — serves dashboard + API + Twilio webhooks
- **SQLite** via better-sqlite3 — single file DB, zero config
- **Twilio SDK** — sends WhatsApp + SMS, receives reply webhooks
- **Cloudflare Tunnel** (free) — exposes webhook endpoint to internet
- **Claude Code CLI** — direct agent management
- **WhatsApp admin interface** — admins command via Twilio number

## Data Model

### guests

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| name | TEXT NOT NULL | Guest display name |
| phone | TEXT NOT NULL UNIQUE | Phone number (E.164 format) |
| side | TEXT | 'groom' or 'bride' |
| group_name | TEXT | family/friends/work/etc |
| num_invited | INTEGER DEFAULT 1 | How many people in this invitation |
| num_coming | INTEGER DEFAULT 0 | How many confirmed coming |
| status | TEXT DEFAULT 'pending' | pending/invited/coming/not_coming/undecided |
| special_req | TEXT | Dietary, accessibility, etc |
| notes | TEXT | Free-form notes |
| created_at | DATETIME | Record creation time |
| updated_at | DATETIME | Last update time |

### messages

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| guest_id | INTEGER FK | References guests.id |
| direction | TEXT | 'outgoing' or 'incoming' |
| channel | TEXT | 'whatsapp' or 'sms' |
| content | TEXT | Message body |
| status | TEXT | sent/delivered/read/failed |
| twilio_sid | TEXT | Twilio message SID |
| created_at | DATETIME | Timestamp |

### reminders

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| guest_id | INTEGER FK | References guests.id |
| scheduled_at | DATETIME | When to send |
| sent_at | DATETIME | When actually sent (null if pending) |
| reminder_num | INTEGER | Which reminder this is (1st, 2nd, etc) |
| status | TEXT | pending/sent/cancelled |

### settings

| Key | Description |
|-----|-------------|
| reminder_interval_days | Days between reminders (default: 5) |
| max_reminders | Max reminders per guest (default: 0 = unlimited) |
| invitation_template | Message template for invitations |
| reminder_template | Message template for reminders |
| special_req_template | Message template for special request question |
| daily_summary_time | Time for daily WhatsApp summary (default: 20:00) |
| batch_size | Messages per batch (default: 10) |
| batch_delay_seconds | Delay between batches (default: 60) |

## Message Flow

### Outgoing (Invitations)

1. Admin says "send to [group]" or "send to all"
2. Agent batches guests (batch_size per batch_delay_seconds)
3. For each guest → send WhatsApp + SMS in parallel via Twilio
4. Log to messages table, update guest status → 'invited'

### Incoming (Reply Parsing)

1. Guest replies via WhatsApp or SMS
2. Twilio webhook → server receives message
3. Match phone → guest record
4. Hebrew parser classifies reply:

**Level 1: Keyword match (fast, free)**
- COMING: כן, בטח, נגיע, נבוא, מגיעים, אנחנו שם, בהחלט
- NOT_COMING: לא, לא נוכל, לצערנו, לא מגיעים, נאלץ לוותר
- UNDECIDED: אולי, עוד לא יודעים, צריך לבדוק, לא בטוח

**Level 2: Pattern match (numbers)**
- "נבוא 4" / "אנחנו 3" / "מגיעים 2" → extract num_coming

**Level 3: Claude API (ambiguous only, ~5% of replies)**
- Send to Claude for classification
- If still unclear → escalate to admins

5. Update guest status + num_coming
6. Optionally ask about special requests

### Reminders

- Hourly check for due reminders
- For each undecided guest with reminder due → send follow-up
- Schedule next reminder based on settings.reminder_interval_days
- Stop when guest gives definitive answer or max_reminders reached

## Admin Interface (WhatsApp)

### Admin Numbers

Three admins with equal access, configurable list:
- Elad (primary)
- Netanel (groom)
- Amit (bride)

### Routing Logic

```
Message arrives at Twilio number
    │
    ├── From admin number? → Command parsing
    └── From anyone else?  → RSVP parsing
```

### Admin Commands (Hebrew)

| Command | Example | Action |
|---------|---------|--------|
| שלח ל[קבוצה] | שלח לחברים של החתן | Send invitations to group |
| שלח לכולם | שלח לכולם | Send to all pending |
| הוסף אורח | הוסף אורח דוד כהן 0501234567 חתן חברים | Add guest |
| סטטוס | סטטוס | Quick summary |
| תזכורות כל X | תזכורות כל 5 ימים | Change reminder interval |
| עצור תזכורות | עצור תזכורות לדוד כהן | Stop reminders for guest |
| עדכן סטטוס | עדכן דוד כהן מגיע 3 | Manual status override |
| ייבא אקסל | ייבא אקסל | Trigger Excel import |
| דוח יומי | דוח יומי ב-20:00 | Change daily summary time |

### Proactive Agent Messages (to all admins)

| Event | Message |
|-------|---------|
| Daily summary | דוח יומי: X מגיעים, Y לא, Z מתלבטים, W ממתינים |
| Ambiguous reply | הודעה לא ברורה מ-[שם]: '[הודעה]'. מה לסמן? |
| Delivery failure | נכשל לשלוח ל-[שם] ([טלפון]) - [סיבה] |
| Milestone | עברנו את ה-200 אישורים! |
| Reminder batch done | נשלחו X תזכורות למתלבטים |

## Dashboard (Hebrew)

RTL Hebrew web dashboard served at localhost:3860. Vanilla HTML/CSS/JS.

### Pages

1. **ראשי** — Status cards (coming/not/undecided/pending/total), progress bar, recent activity
2. **רשימת אורחים** — Filterable/searchable table, inline edit, add guest, import Excel
3. **הודעות** — Full message log, filter by direction/channel/status, per-guest conversation view
4. **תזכורות** — Upcoming/sent reminders, pause/resume per guest or globally, change interval
5. **הגדרות** — Message templates, reminder config, admin phones, Twilio status, batch config
6. **ייצוא** — Export to Excel, filter by status, print-friendly view

## Twilio Setup

### Steps (agent-managed with user approval for payments)

1. Upgrade Twilio account (user enters payment)
2. Buy Israeli number (+972) with SMS + WhatsApp capability
3. Register WhatsApp sender via Twilio console
4. Submit message templates to Meta for approval
5. Configure webhooks → Cloudflare tunnel → server
6. Set up delivery status callbacks

### Message Templates (Meta approval required)

- **Invitation:** Personalized wedding invitation with RSVP prompt
- **Reminder:** Soft follow-up for undecided guests
- **Special request:** Ask about dietary/accessibility needs

Templates text TBD — will be configured via settings.

## Technical Details

### Tech Stack

- **Runtime:** Node.js 20+
- **Server:** Express
- **Database:** better-sqlite3
- **Twilio:** twilio SDK
- **Excel:** xlsx package
- **Dashboard:** Vanilla HTML/CSS/JS, RTL
- **Tunnel:** cloudflared (free tier)
- **Reply parsing:** Rule-based Hebrew + Claude API fallback

### Rate Limiting & Safety

- Batch sending: 10 messages/minute (configurable)
- 2-second delay between Twilio API calls
- Retry failed messages up to 3 times with exponential backoff
- Never send duplicate messages to same guest within 24 hours
- All messages logged to database

### File Structure

```
wedding-notification/
├── server.js              # Express server entry point
├── package.json
├── .env                   # Twilio credentials, Claude API key
├── guests.db              # SQLite database
├── src/
│   ├── routes/
│   │   ├── api.js         # REST API for guests, messages, settings
│   │   └── webhooks.js    # Twilio incoming webhooks
│   ├── services/
│   │   ├── twilio.js      # Twilio send WhatsApp + SMS
│   │   ├── parser.js      # Hebrew reply parser
│   │   ├── reminder.js    # Reminder scheduler
│   │   ├── importer.js    # Excel import/export
│   │   └── admin.js       # Admin command parser
│   ├── db/
│   │   ├── schema.sql     # Database schema
│   │   └── db.js          # Database connection + helpers
│   └── utils/
│       └── phone.js       # Phone number normalization (IL)
├── dashboard/
│   ├── index.html         # Main dashboard page
│   ├── guests.html        # Guest list page
│   ├── messages.html      # Message log page
│   ├── reminders.html     # Reminders page
│   ├── settings.html      # Settings page
│   ├── export.html        # Export page
│   ├── css/
│   │   └── style.css      # RTL Hebrew styles
│   └── js/
│       └── app.js         # Dashboard JavaScript
├── docs/
│   └── superpowers/
│       └── specs/
│           └── 2026-03-14-wedding-notification-agent-design.md
└── .gitignore
```
