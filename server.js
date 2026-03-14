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
  console.log('Wedding server running on port ' + PORT);
});

module.exports = app;
