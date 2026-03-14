# Wedding Notification Agent — Design Spec

## Overview

An agent-driven system for managing wedding invitations and RSVPs for Netanel & Amit's wedding (August 30, 2026). ~400 guests. Claude Code acts as the primary agent — sending invitations, parsing replies, managing reminders, and reporting status. Three admins (Elad, Netanel, Amit) control the system via WhatsApp messages to the Twilio number. A Hebrew dashboard provides monitoring and manual overrides.

## Deployment & Operations

- **Single-instance deployment** — one server, one SQLite file, one tunnel. Never run multiple instances.
- **Timezone:** Israel Standard Time (Asia/Jerusalem) for all timestamps and scheduled events.
- **Process manager:** pm2 keeps the server running, auto-restarts on crash.
- **Startup:** `pm2 start server.js --name wedding` — runs on boot.
- **Dashboard auth:** Simple token-based auth (bearer token in .env). The Cloudflare tunnel exposes only `/webhooks/*` paths to the internet. Dashboard routes are localhost-only by default.

### Agent Invocation Model

The Node.js server is autonomous — it handles all real-time operations (webhooks, reply parsing, reminder scheduling) without Claude Code being active. Claude Code acts as the **supervisor and command executor**:

1. **Server runs 24/7** via pm2 — handles webhooks, parses replies, sends scheduled reminders, serves dashboard
2. **Admin WhatsApp commands** are parsed by the server itself (`admin.js`) — no Claude Code involvement needed for standard commands
3. **Claude Code** is invoked for:
   - Complex/ambiguous situations the server escalates (via WhatsApp bridge)
   - System configuration changes (Twilio setup, template changes)
   - Excel imports (user provides file in CLI)
   - Bulk operations initiated via CLI
   - Debugging and monitoring
4. **Claude Code WhatsApp bridge** (existing system) — receives escalation notifications and admin commands that need AI reasoning

```
Server (always running)          Claude Code (on-demand)
├── Webhook receiver             ├── Complex command execution
├── Reply parser (L1+L2)         ├── Reply parser (L3 - Claude API)
├── Reminder scheduler           ├── Twilio configuration
├── Admin command parser         ├── Excel import
├── Daily summary sender         ├── System monitoring
└── Dashboard                    └── Escalation handling
```

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
| status | TEXT DEFAULT 'pending' | pending/invited/coming/not_coming/undecided/opted_out |
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
| max_reminders | Max reminders per guest (default: 10) |
| invitation_template | Message template for invitations |
| reminder_template | Message template for reminders |
| special_req_template | Message template for special request question |
| daily_summary_time | Time for daily WhatsApp summary (default: 20:00) |
| batch_size | Messages per batch (default: 10) |
| batch_delay_seconds | Delay between batches (default: 60) |
| ask_special_requests | Ask about special requests after COMING (default: true) |
| whatsapp_enabled | Enable WhatsApp channel (default: false, enable after Meta approval) |
| admin_phones | Comma-separated admin phone numbers in E.164 format |

## Status Transitions

```
pending ──(invitation sent)──→ invited
invited ──(positive reply)───→ coming
invited ──(negative reply)───→ not_coming
invited ──(undecided reply)──→ undecided
invited ──(no reply, first reminder sent)──→ undecided
undecided ──(positive reply)──→ coming
undecided ──(negative reply)──→ not_coming
coming ──(changed mind)──→ not_coming
not_coming ──(changed mind)──→ coming
any ──(admin manual override)──→ any
```

- A guest becomes `undecided` either from an explicit undecided reply OR after the first reminder fires (no response within `reminder_interval_days` of invitation).
- Guests can change their mind at any time — the system always accepts the latest reply.
- Special request question is sent automatically after a guest status becomes `coming` (configurable: on/off in settings via `ask_special_requests` key, default: on).

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

**Level 1: Phrase match (longest match wins, fast, free)**
Multi-word phrases are checked first (e.g., "לא בטוח" matches UNDECIDED before "לא" matches NOT_COMING). Matching is substring-based on the full reply text, case-insensitive, punctuation-stripped.

- COMING: נגיע, נבוא, מגיעים, אנחנו שם, בהחלט, כן נגיע, בטח נגיע, כן, בטח, נהיה שם, שמחים להגיע, אישור הגעה
- NOT_COMING: לא נוכל, לצערנו לא, לא מגיעים, נאלץ לוותר, לא נגיע, לצערנו, לא יכולים, לא באים
- UNDECIDED: עוד לא יודעים, צריך לבדוק, לא בטוח, לא יודע, אולי, נעדכן, נחזור אליכם, צריך לחשוב
- Priority: UNDECIDED phrases > NOT_COMING phrases > COMING phrases (longer/more specific phrases always win over single keywords)

**Level 2: Number extraction (runs alongside Level 1)**
Regex patterns: `(\d+)\s*(אנשים|נפשות|מגיעים)?` or `(נבוא|נגיע|מגיעים|אנחנו)\s*(\d+)`
If number found → set `num_coming`. If no number and status is COMING → `num_coming = num_invited` (default to full party).

**Level 3: Claude API (ambiguous/no match, ~5% of replies)**
Triggered when Level 1 finds no match or finds conflicting signals.
Prompt: "Classify this Hebrew wedding RSVP reply as COMING, NOT_COMING, UNDECIDED, or UNCLEAR. Reply with only the classification and optional number of guests. Reply: [text]"
If Claude returns UNCLEAR → escalate to admins via WhatsApp.

5. Update guest status + num_coming
6. If status changed to `coming` and `ask_special_requests` is on → send special request question

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

Commands are parsed with a keyword-first approach. The first word(s) identify the command, the rest are arguments. Commands are forgiving — the parser uses fuzzy matching on command keywords.

| Command | Syntax | Example | Action |
|---------|--------|---------|--------|
| שלח ל... | `שלח ל<group_name substring>` | שלח לחברים של החתן | Send to guests where group_name contains the substring |
| שלח לכולם | `שלח לכולם` | שלח לכולם | Send to all with status='pending' |
| הוסף אורח | `הוסף <name> <phone> [side] [group]` | הוסף דוד כהן 0501234567 חתן חברים | Name = all words before phone, phone = first 05X/+972 match, side/group = remaining words |
| סטטוס | `סטטוס` | סטטוס | Quick summary counts |
| תזכורות כל | `תזכורות כל <N> ימים` | תזכורות כל 5 ימים | Change reminder_interval_days |
| עצור תזכורות | `עצור תזכורות ל<name or phone>` | עצור תזכורות לדוד כהן | Match by name (partial) or phone. If multiple matches → reply with list, ask to specify |
| עדכן | `עדכן <name or phone> <status> [num]` | עדכן דוד כהן מגיע 3 | Status keywords: מגיע/לא מגיע/מתלבט. If multiple name matches → reply with list |
| ייבא | `ייבא` | ייבא | Reply with instructions to provide file path via CLI |
| דוח יומי | `דוח יומי [ב-HH:MM]` | דוח יומי ב-20:00 | Change daily summary time |
| עזרה | `עזרה` | עזרה | List available commands |

**Error handling:** Unrecognized commands → reply "לא הבנתי. שלח 'עזרה' לרשימת פקודות". Name collisions → reply with numbered list of matches, ask admin to reply with number.

**Concurrency:** First admin response wins for escalation questions. Once a status is set by one admin, others are notified of the change.

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

## Edge Cases & Safety

### Unknown Phone Numbers
If a message arrives from a phone not in the guests table and not an admin number → reply: "שלום, המספר שלך לא מופיע ברשימת המוזמנים. אם קיבלת הזמנה, אנא צור קשר עם נתנאל או עמית." Log the message for admin review.

### Dual-Channel Replies
A guest may reply on both WhatsApp and SMS. Rule: **last reply wins**. Both replies are logged in the messages table with their respective channels. The guest status reflects the most recent reply regardless of channel. No dedup — each reply is processed independently.

### Opt-Out / STOP
Twilio handles SMS STOP at the carrier level automatically. For WhatsApp, if a guest sends "הסר" / "stop" / "הפסק" → set guest status to `opted_out` (new status), cancel all reminders, reply "הוסרת מרשימת התפוצה. לחידוש, שלח 'חידוש'." Admin notification sent. Admin can manually re-enable.

### Send Cancellation
Once a batch send starts, individual messages already sent cannot be recalled. But a batch in progress can be paused via admin command "עצור שליחה". Unsent messages in the queue are cancelled. Already-sent messages are logged normally.

### Max Reminders Safety
Default max_reminders = 10 (not unlimited). After max is reached, guest stays `undecided` but gets no more automatic reminders. Admin is notified: "X אורחים הגיעו למקסימום תזכורות ועדיין לא ענו."

### Data Backup
SQLite DB is backed up daily to `backups/guests_YYYY-MM-DD.db` (auto-cleanup after 30 days).

## Excel Import/Export

### Import Format

Expected Excel columns (first row = headers):

| Column | Required | Maps to | Notes |
|--------|----------|---------|-------|
| שם / name | Yes | name | Guest display name |
| טלפון / phone | Yes | phone | Any format — normalized to E.164 |
| צד / side | No | side | חתן→groom, כלה→bride |
| קבוצה / group | No | group_name | Free text |
| מוזמנים / invited | No | num_invited | Number, default 1 |
| הערות / notes | No | notes | Free text |

**Validation rules:**
- Skip rows with missing name or phone
- Normalize phone: strip spaces/dashes, convert 05X→+9725X
- Duplicate phone (already in DB) → skip, log warning
- Invalid phone format → skip, log warning
- Report: "Imported X guests. Skipped Y (Z duplicates, W invalid phones)."

### Export Format
Same columns as import + status, num_coming, special_req. Filterable by status before export.

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

### Meta Approval Contingency

Meta template approval can take days to weeks and may be rejected.
- **Phase 1 (immediate):** SMS-only mode. Send all messages via SMS while WhatsApp approval is pending.
- **Phase 2 (WhatsApp approved):** Enable dual-channel (WhatsApp + SMS parallel).
- **If rejected:** Revise template and resubmit. Continue SMS-only in the meantime.
- The system has a `whatsapp_enabled` setting (default: false). Flip to true once approved.

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
