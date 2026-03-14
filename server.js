require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { getDb } = require('./src/db/db');

const app = express();
const PORT = process.env.PORT || 3860;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Auth middleware for API/dashboard routes
function authMiddleware(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
    return next();
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
app.use('/dashboard', authMiddleware, express.static(path.join(__dirname, 'dashboard')));

// Twilio webhooks (no auth middleware — validated via Twilio signature)
app.use('/webhooks', require('./src/routes/webhooks'));

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
