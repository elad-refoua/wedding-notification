# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview
Automated wedding invitation & RSVP system for **Netanel & Amit's wedding (2026-08-30, ~400 guests)**.
Sends invitations via Twilio (SMS + WhatsApp), auto-classifies Hebrew replies, schedules reminders,
and exposes a Hebrew RTL dashboard for non-technical users.

## Commands
```bash
npm install
node server.js                           # Start server on PORT (default 3860)
npm test                                 # Run all tests (node --test tests/**/*.test.js)
node --test tests/parser.test.js         # Run a single test file
node --test --test-name-pattern='<x>' tests/parser.test.js   # Run tests matching name
```
There is no build step, bundler, or linter configured. Tests use Node's built-in `node:test` runner.

**Production URL:** `https://wedding-notification-246665220680.europe-west1.run.app`

Deployment is Google Cloud Run in project `wedding-netanel-amit` (isolated from menti). See `docs/DEPLOYMENT.md` for the full runbook. Pushing to `master` does NOT auto-deploy — trigger a new revision with `gcloud run deploy wedding-notification --source . --region europe-west1` (from the `wedding` gcloud configuration).

## Architecture

### Request flow
```
Twilio (SMS/WhatsApp)
    │  status callbacks         inbound messages
    ▼                           ▼
/webhooks/{sms,whatsapp}/status   /webhooks/{sms,whatsapp}
(no auth; Twilio signature validated in NODE_ENV=production)
                                ▼
                  handleIncoming() in routes/webhooks.js
                                ▼
        ┌──── sender is admin ──────► services/admin.js (Hebrew commands)
        ├──── unknown phone ────────► reply + notify admins
        └──── known guest ──────────► services/parser.js → update guests.status
                                                        → services/reminder.js (cancel/schedule)

Browser ──► /dashboard/*.html (static, client-side token auth)
        ──► /api/* (server-side Bearer token, localhost bypassed)
```

### 3-level reply parser (`src/services/parser.js`)
Runs in strict order, short-circuits on first hit:
1. **Keyword match** — `PHRASES` dict (opted_out → re_enable → undecided → not_coming → coming), longest phrase wins within a category.
2. **Number parsing** — extracts `num_coming` from Hebrew words (שלושה, ארבע…) and digits via `NUM_PATTERNS`.
3. **Gemini 2.0 Flash fallback** — only invoked if Level 1+2 fail. Rate-limited via `gemini_daily_limit` / `gemini_calls_today` settings; confidence threshold gates whether result is applied or escalated to admin.

Never add other AI providers — Gemini is the only approved fallback.

### Scheduled jobs (`src/services/reminder.js`, started in `server.js`)
- `processDueReminders()` — runs every **hour**. Picks up `reminders` rows where `scheduled_at <= now AND status='pending' AND guest.status IN ('invited','undecided')`. 24h dedup guard (skip if any reminder sent to that guest in the last day). After sending, schedules the next reminder at `+reminder_interval_days`. Batch size and batch delay are settings.
- `sendDailySummary()` — checked every minute against `daily_summary_time` HH:MM setting.
- `backupDatabase()` — daily copy of `guests.db` → `backups/guests-YYYY-MM-DD.db`; keeps last 7.

### Data layer (`src/db/db.js`, `src/db/schema.sql`)
- SQLite via `better-sqlite3`, foreign keys ON, singleton `getDb()`.
- **`DB_PATH` env var** picks the file location (defaults to `./guests.db` for local dev). On Cloud Run it's `/data/guests.db` where `/data` is a GCS Cloud Storage volume mount to `gs://wedding-netanel-amit-data` — the DB file is therefore durable across restarts/revisions.
- **`DB_JOURNAL_MODE` env var** picks the journal mode. Local dev: `WAL` (default, fastest). Cloud Run (GCS FUSE): must be `DELETE` — WAL uses mmap which does not work over networked filesystems.
- **Cloud Run single-writer constraint** — the service is deployed with `--max-instances 1` because SQLite over a shared GCS volume cannot tolerate concurrent writers. Do not raise this limit without switching databases.
- **UTF-8 locale is mandatory on Cloud Run** — Dockerfile sets `LANG=LC_ALL=LANGUAGE=C.UTF-8` + installs `locales` package. Without this, Node ↔ better-sqlite3 string-binding at the C boundary interprets Hebrew UTF-8 bytes as Latin-1 and writes each byte as a separate codepoint (mojibake). This was the root cause of the "Hebrew saved as question marks" bug.
- Schema is **idempotent** — the entire `schema.sql` is re-applied on every `getDb()` call. New tables/columns must use `CREATE ... IF NOT EXISTS` / `INSERT OR IGNORE`. Column additions use `runMigrations()` in `db.js`.
- **Schema-constraint migrations** (adding CHECK values, CASCADE to FKs, etc.) — SQLite can't ALTER constraints. Use the rebuild pattern already present in `runMigrations()`: detect the old constraint by introspecting `sqlite_master.sql` or `foreign_key_list`, then `CREATE table_new → INSERT SELECT → DROP table → RENAME new`. Examples: `maybeRebuildForCascade()` (messages/reminders FK CASCADE), `maybeRebuildGuestsForBoth()` (side CHECK allows 'both'). Triggers dropped with the old table must be recreated.
- All PUT `/api/settings` write happens inside a single SQLite transaction — on the GCS FUSE volume, 14 sequential setSetting() calls cost ~13 seconds (one flush per write); one transaction drops it to ~0.6 sec. See `bulk.js` and `/settings` handler.
- Settings are key/value strings in the `settings` table, accessed via `getSetting` / `setSetting`. Defaults seeded from `schema.sql`. Notable keys: `default_channel` (auto/whatsapp/sms/both), `wedding_mode` (global freeze), `whatsapp_template_invitation_sid` (HX… after Meta approval).
- **Secrets never round-trip in GET /api/settings** — `gemini_api_key` is replaced with a boolean flag `gemini_api_key_set` so clients can't accidentally overwrite it with a masked value.
- Tables: `guests` (with `side IN ('groom','bride','both')`, `reminders_paused`), `messages` (incoming+outgoing log; `error` column captures Twilio failure detail; indexed on direction+status, guest_id), `reminders` (schedule+status, indexed on guest_id, status+scheduled_at), `settings`.
- FKs use `ON DELETE CASCADE` on messages.guest_id and reminders.guest_id — deleting a guest cleanly removes their history.

### Auth (`server.js`)
- `/api/*` — Bearer token against `DASHBOARD_TOKEN`, compared with `crypto.timingSafeEqual`.
- **Localhost bypass is dev-only**: requests from `127.0.0.1` / `::1` skip auth ONLY when `NODE_ENV !== 'production'`. In production this shortcut is closed because `trust proxy = true` means `req.ip` can be spoofed via `X-Forwarded-For: 127.0.0.1`. Check is on `req.socket.remoteAddress` directly.
- `/dashboard/*` — static files; client-side JS stores token and adds it to API calls.
- `/webhooks/*` — no Bearer auth; Twilio signature validation is **always on** unless `DISABLE_TWILIO_SIG=1` is set explicitly (previously gated on NODE_ENV, which silently disabled sig checks on any misconfigured env).

### Phone normalization (`src/utils/phone.js`)
All numbers are normalized to E.164 Israeli format (+972…) at every entry point (API, webhook, admin command, Excel import). `guests.phone` is `UNIQUE` — duplicates are returned as `409 Conflict`.

### Admin WhatsApp commands (`src/services/admin.js`)
Phones listed in the `admin_phones` setting (comma-separated, normalized) can send Hebrew commands: `סטטוס`, `עזרה`, `שלח לכולם`, `שלח ל<קבוצה>`, `הוסף <שם> <טלפון> [חתן|כלה] [קבוצה]`, `עצור שליחה`, `המשך שליחה`. Admin messages are routed before guest-reply parsing.

### Bulk-send serialization (`src/services/bulk.js`)
All three bulk paths — `/api/send-invitations`, `/api/retry-failed`, admin "שלח לכולם" — share an in-process lock named `bulk_send`. A second attempt while one is running returns **409** with a Hebrew explanation. The lock also powers `/api/bulk-status` which the home-page dashboard polls to render a live progress card (sent/failed counts, current guest name, percentage).

### Channel routing (`src/services/twilio.js`)
`sendToGuest(guest, body, opts)` picks a channel strategy from `opts.channel` or the `default_channel` setting:
- `auto` — WhatsApp first, SMS fallback on failure (one message actually delivered)
- `whatsapp` — WhatsApp only (no silent SMS fallback)
- `sms` — SMS only
- `both` — both channels (legacy double-send, use sparingly)

When `opts.templateSid` (HX…) is passed, the WhatsApp send uses Twilio Content API — required for business-initiated messages outside the 24h window on a real WABA sender. The invitation + reminder flows read the template SID from settings automatically.

### Webhook status callback ladder (`src/routes/webhooks.js`)
Twilio status callbacks (`sent → delivered → read`) can arrive out of order. `updateStatusFromCallback()` uses a `STATUS_RANK` table to reject regressions (e.g. a late `sent` callback after `delivered`). Terminal errors (`failed`, `undelivered`) always overwrite + store Twilio's error code + a Hebrew hint via `hebrewHint()`.

### Per-guest journey panel (`dashboard/guests.html`)
Clicking any row in the guests table opens a modal with the full timeline (messages + reminders merged chronologically), a "מה הלאה?" recommendation, and one-click quick actions. The modal helper (`openModal`/`closeModal` in `app.js`) requires the **overlay** element as input — it toggles `.open` on the overlay (which is what CSS `display: none → flex` gates on). Passing the inner `.modal` div is accepted (the helper auto-finds the overlay via `.closest('.modal-overlay')`), but passing the overlay is the canonical form.

## Environment Variables
In production these come from Secret Manager (secrets) or `gcloud run services update --set-env-vars` (non-secrets). In local dev they come from `.env`.
```
# Secrets (Secret Manager in prod, .env locally) — never committed
TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
TWILIO_PHONE_NUMBER              # SMS sender (real US number)
TWILIO_WHATSAPP_NUMBER           # WhatsApp sandbox (+14155238886); falls back to TWILIO_PHONE_NUMBER
DASHBOARD_TOKEN                  # Dashboard + API Bearer token
GEMINI_API_KEY                   # Level 3 parser

# Non-secrets
WEBHOOK_BASE_URL                 # Cloud Run URL, used in Twilio statusCallback URLs
DB_PATH                          # /data/guests.db on Cloud Run; defaults to ./guests.db locally
DB_JOURNAL_MODE                  # DELETE on Cloud Run (networked FS); WAL locally (default)
PORT                             # 8080 on Cloud Run; defaults to 3860 locally
TZ=Asia/Jerusalem
NODE_ENV=production              # gates Twilio signature validation
```

## Rules
- Never use menti infrastructure (GCP project `menti-hipaa-org`, domain `mentiverse.ai`) for this project.
- Gemini 2.0 Flash is the only approved AI fallback — do not add other AI services.
- Hebrew RTL throughout the dashboard; copy must stay understandable to Amit & Netanel (non-technical).
- Keep project memory (`.claude/.../memory/`) updated after significant changes.
- When changing schema, edit `src/db/schema.sql` with idempotent DDL — do not rely on migrations.
