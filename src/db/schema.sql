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

CREATE TRIGGER IF NOT EXISTS guests_updated_at
  AFTER UPDATE ON guests
  FOR EACH ROW
BEGIN
  UPDATE guests SET updated_at = datetime('now') WHERE id = OLD.id;
END;

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guest_id INTEGER REFERENCES guests(id),
  direction TEXT NOT NULL CHECK(direction IN ('outgoing', 'incoming')),
  channel TEXT NOT NULL CHECK(channel IN ('whatsapp', 'sms')),
  content TEXT,
  status TEXT DEFAULT 'sent' CHECK(status IN ('sent', 'delivered', 'read', 'failed', 'received')),
  twilio_sid TEXT,
  error TEXT,
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
  ('invitation_template', 'שלום {{name}}, בשמחה רבה אנו מזמינים אתכם לחתונה של נתנאל ועמית! 🎊
📅 יום ראשון, 30 באוגוסט 2026
נשמח מאוד אם תוכלו להגיע!
אנא השיבו: מגיעים / לא מגיעים / עדיין לא יודעים'),
  ('reminder_template', 'היי {{name}}, עוד לא קיבלנו תשובה לגבי החתונה של נתנאל ועמית (30.8.2026) 💍
נשמח לדעת אם תוכלו להגיע!
אנא השיבו: מגיעים / לא מגיעים'),
  ('daily_summary_time', '20:00'),
  ('batch_size', '10'),
  ('batch_delay_seconds', '60'),
  ('whatsapp_enabled', 'true'),
  ('admin_phones', ''),
  ('milestone_thresholds', '50,100,150,200,250,300,350'),
  ('milestones_sent', ''),
  ('gemini_daily_limit', '50'),
  ('gemini_calls_today', '0'),
  ('gemini_calls_date', '');
