require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { getDb } = require('./src/db/db');

const app = express();
const PORT = process.env.PORT || 3860;

// Trust reverse proxy (Render, etc.) so req.ip reflects real client IP
app.set('trust proxy', true);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Auth middleware for API routes
// Localhost bypass is DEV-ONLY. In production `trust proxy = true` makes req.ip reflect
// X-Forwarded-For, which an attacker can spoof ("X-Forwarded-For: 127.0.0.1"). So we only
// honor the localhost shortcut when NODE_ENV is not production AND check req.socket too.
function authMiddleware(req, res, next) {
  if (process.env.NODE_ENV !== 'production') {
    const socketAddr = req.socket?.remoteAddress;
    if (socketAddr === '127.0.0.1' || socketAddr === '::1' || socketAddr === '::ffff:127.0.0.1') {
      return next();
    }
  }
  const token = req.headers.authorization?.replace('Bearer ', '');
  const expected = process.env.DASHBOARD_TOKEN;
  if (token && expected) {
    const a = Buffer.from(token, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return next();
    }
  }
  res.status(401).json({ error: 'Unauthorized' });
}

app.use('/api', authMiddleware, require('./src/routes/api'));
// Dashboard static files — no server-side auth; client-side JS handles token
app.use('/dashboard', express.static(path.join(__dirname, 'dashboard')));

// Twilio webhooks (no auth middleware — validated via Twilio signature)
app.use('/webhooks', require('./src/routes/webhooks'));

// Root redirect to dashboard
app.get('/', (req, res) => {
  res.redirect('/dashboard/');
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Initialize DB on startup
getDb();

const { startScheduledJobs } = require('./src/services/reminder');
startScheduledJobs();

app.listen(PORT, () => {
  console.log('Wedding server running on port ' + PORT);
});

module.exports = app;
