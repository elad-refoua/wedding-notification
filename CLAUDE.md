# Wedding Notification System

## Project Overview
Automated wedding invitation & RSVP management system for **Netanel & Amit's wedding (August 30, 2026, ~400 guests)**.
Sends invitations via WhatsApp/SMS, auto-classifies Hebrew replies, manages reminders, provides a Hebrew RTL dashboard.

## Tech Stack
- **Runtime:** Node.js + Express (port 3860)
- **Database:** SQLite via better-sqlite3 (WAL mode, `guests.db`)
- **Messaging:** Twilio (SMS + WhatsApp)
- **AI:** Google Gemini 2.0 Flash (Level 3 reply parsing fallback)
- **Dashboard:** Vanilla HTML/CSS/JS, dark theme, Hebrew RTL
- **Deployment:** Render.com free tier (auto-deploy from GitHub master)
- **URL:** https://wedding-notification.onrender.com

## Architecture
```
server.js (Express, auth, scheduled jobs)
├── src/routes/api.js          REST API (auth required)
├── src/routes/webhooks.js     Twilio webhooks (no auth, Twilio signature validation)
├── src/services/
│   ├── twilio.js              SMS/WhatsApp send
│   ├── parser.js              3-level Hebrew reply parser
│   ├── gemini.js              Gemini 2.0 Flash AI client
│   ├── admin.js               Hebrew admin WhatsApp commands
│   ├── reminder.js            Scheduled reminders + daily summary
│   └── importer.js            Excel import/export
├── src/db/
│   ├── db.js                  SQLite singleton + settings helpers
│   └── schema.sql             Tables: guests, messages, reminders, settings
├── src/utils/phone.js         Israeli phone normalization
└── dashboard/                 8 HTML pages (login, index, guests, messages, reminders, settings, export, guide)
```

## Running
```bash
npm install
node server.js          # Start server
node --test tests/*.test.js   # Run tests (72 tests, 15 suites)
```

## Auth
- Dashboard login: password = `DASHBOARD_TOKEN` env var
- API: Bearer token in Authorization header
- Localhost: bypasses auth for local development
- Cloud: `trust proxy` enabled for Render's reverse proxy

## Key Flows
1. **Upload guests** → Excel import via dashboard or API
2. **Send invitations** → Dashboard button or WhatsApp "שלח לכולם"
3. **Auto-classify replies** → Keywords → Numbers → Gemini AI → Admin escalation
4. **Auto-reminders** → Every N days to non-responders (hourly check)

## Environment Variables
```
TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
DASHBOARD_TOKEN
GEMINI_API_KEY
WEBHOOK_BASE_URL=https://wedding-notification.onrender.com
TZ=Asia/Jerusalem
NODE_ENV=production
```

## Rules
- Never use menti infrastructure (GCP project `menti-hipaa-org`, domain `mentiverse.ai`) for this project
- Always use Opus 4.6 for subagents
- Keep project memory updated after every significant change
- Dashboard must work for non-technical users (Amit, Netanel)
- Gemini is the only approved AI fallback — don't add other AI services
- Hebrew RTL throughout the dashboard
