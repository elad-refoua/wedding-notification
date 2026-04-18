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
- Schema is **idempotent** — the entire `schema.sql` is re-applied on every `getDb()` call. New tables/columns must use `CREATE ... IF NOT EXISTS` / `INSERT OR IGNORE`. Column additions to existing tables use the `runMigrations()` pattern in `db.js` (see the `ALTER TABLE … ADD COLUMN error` migration for the template).
- Settings are key/value strings in the `settings` table, accessed via `getSetting` / `setSetting`. Defaults (invitation template, reminder interval, batch size, Gemini quota, admin phones, etc.) are seeded from `schema.sql`.
- Tables: `guests`, `messages` (incoming+outgoing log; `error` column captures Twilio failure detail), `reminders` (schedule+status), `settings`.

### Auth (`server.js`)
- `/api/*` — Bearer token against `DASHBOARD_TOKEN`, compared with `crypto.timingSafeEqual`.
  **Requests from `127.0.0.1` / `::1` bypass auth entirely** — localhost dev works with no token.
- `/dashboard/*` — static files; client-side JS stores token and adds it to API calls.
- `/webhooks/*` — no Bearer auth; Twilio signature validated when `NODE_ENV=production`.
- `app.set('trust proxy', true)` is required so `req.ip` reflects the real client behind Render's proxy.

### Phone normalization (`src/utils/phone.js`)
All numbers are normalized to E.164 Israeli format (+972…) at every entry point (API, webhook, admin command, Excel import). `guests.phone` is `UNIQUE` — duplicates are returned as `409 Conflict`.

### Admin WhatsApp commands (`src/services/admin.js`)
Phones listed in the `admin_phones` setting (comma-separated, normalized) can send Hebrew commands: `סטטוס`, `עזרה`, `שלח לכולם`, `שלח ל<קבוצה>`, `הוסף <שם> <טלפון> [חתן|כלה] [קבוצה]`, `עצור שליחה`, `המשך שליחה`. Admin messages are routed before guest-reply parsing.

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
