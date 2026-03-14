'use strict';

const { describe, it, beforeEach, afterEach, before } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DB_MODULE_PATH = path.join(__dirname, '..', 'src', 'db', 'db.js');
const SCHEMA_PATH    = path.join(__dirname, '..', 'src', 'db', 'schema.sql');
const GEMINI_PATH    = path.join(__dirname, '..', 'src', 'services', 'gemini.js');

// ---------------------------------------------------------------------------
// In-memory DB helpers
//
// db.js is a singleton pointing at a real file.  We patch its exported
// functions to redirect all DB access to a fresh in-memory database for
// every test, then restore them afterwards.
// ---------------------------------------------------------------------------

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);
  return db;
}

function injectTestDb(testDb) {
  const dbModule = require(DB_MODULE_PATH);
  const orig = {
    getDb:      dbModule.getDb,
    getSetting: dbModule.getSetting,
    setSetting: dbModule.setSetting,
    closeDb:    dbModule.closeDb,
  };
  dbModule.getDb      = () => testDb;
  dbModule.getSetting = (key) => {
    const row = testDb.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  };
  dbModule.setSetting = (key, value) => {
    testDb.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
  };
  dbModule.closeDb    = () => {};
  return orig;
}

function restoreDbModule(orig) {
  const dbModule = require(DB_MODULE_PATH);
  Object.assign(dbModule, orig);
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function mockFetchResponse(body, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

function geminiApiResponse(payload) {
  return {
    candidates: [{
      content: { parts: [{ text: JSON.stringify(payload) }] },
    }],
  };
}

function getTodayDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
}

/**
 * Seed rate-limit rows that gemini.js expects (not in schema defaults).
 */
function seedRateLimitSettings(db, { callsToday = 0, dailyLimit = 50, date = null } = {}) {
  const today = date !== null ? date : getTodayDate();
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('gemini_calls_today', String(callsToday));
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('gemini_daily_limit', String(dailyLimit));
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('gemini_calls_date',  today);
}

/** Return a fresh require() of the gemini module, bypassing the cache. */
function freshGemini() {
  delete require.cache[require.resolve(GEMINI_PATH)];
  return require(GEMINI_PATH);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('classifyWithGemini', () => {
  let originalFetch;
  let originalApiKey;
  let testDb;
  let origDbExports;

  before(() => {
    delete require.cache[require.resolve(GEMINI_PATH)];
  });

  beforeEach(() => {
    originalFetch  = global.fetch;
    originalApiKey = process.env.GEMINI_API_KEY;

    process.env.GEMINI_API_KEY = 'test-key';

    testDb = createTestDb();
    origDbExports = injectTestDb(testDb);
    seedRateLimitSettings(testDb); // default: 0 of 50 used today
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = originalApiKey;
    }
    restoreDbModule(origDbExports);
    testDb.close();
    delete require.cache[require.resolve(GEMINI_PATH)];
  });

  // -------------------------------------------------------------------------
  // Classification
  // -------------------------------------------------------------------------

  describe('classification', () => {
    it('returns coming result with numComing mapped from num_coming', async () => {
      global.fetch = () => mockFetchResponse(
        geminiApiResponse({ status: 'coming', num_coming: 3, confidence: 0.95 })
      );
      const { classifyWithGemini } = freshGemini();
      const result = await classifyWithGemini('something ambiguous');
      assert.deepStrictEqual(result, { status: 'coming', numComing: 3, confidence: 0.95 });
    });

    it('returns not_coming result with numComing null', async () => {
      global.fetch = () => mockFetchResponse(
        geminiApiResponse({ status: 'not_coming', num_coming: null, confidence: 0.85 })
      );
      const { classifyWithGemini } = freshGemini();
      const result = await classifyWithGemini('something ambiguous');
      assert.deepStrictEqual(result, { status: 'not_coming', numComing: null, confidence: 0.85 });
    });

    it('returns undecided result', async () => {
      global.fetch = () => mockFetchResponse(
        geminiApiResponse({ status: 'undecided', num_coming: null, confidence: 0.7 })
      );
      const { classifyWithGemini } = freshGemini();
      const result = await classifyWithGemini('something ambiguous');
      assert.deepStrictEqual(result, { status: 'undecided', numComing: null, confidence: 0.7 });
    });
  });

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  describe('validation', () => {
    it('returns null for invalid status opted_out', async () => {
      global.fetch = () => mockFetchResponse(
        geminiApiResponse({ status: 'opted_out', num_coming: null, confidence: 0.9 })
      );
      const { classifyWithGemini } = freshGemini();
      assert.strictEqual(await classifyWithGemini('something'), null);
    });

    it('returns null when confidence is above 1', async () => {
      global.fetch = () => mockFetchResponse(
        geminiApiResponse({ status: 'coming', num_coming: null, confidence: 1.5 })
      );
      const { classifyWithGemini } = freshGemini();
      assert.strictEqual(await classifyWithGemini('something'), null);
    });

    it('returns null when confidence is below 0', async () => {
      global.fetch = () => mockFetchResponse(
        geminiApiResponse({ status: 'coming', num_coming: null, confidence: -0.1 })
      );
      const { classifyWithGemini } = freshGemini();
      assert.strictEqual(await classifyWithGemini('something'), null);
    });

    it('returns null when confidence is not a number', async () => {
      global.fetch = () => mockFetchResponse(
        geminiApiResponse({ status: 'coming', num_coming: null, confidence: 'high' })
      );
      const { classifyWithGemini } = freshGemini();
      assert.strictEqual(await classifyWithGemini('something'), null);
    });

    it('sets numComing to null when num_coming is 100 (out of range) but still returns a result', async () => {
      global.fetch = () => mockFetchResponse(
        geminiApiResponse({ status: 'coming', num_coming: 100, confidence: 0.9 })
      );
      const { classifyWithGemini } = freshGemini();
      const result = await classifyWithGemini('something');
      assert.ok(result !== null, 'should not be null - status and confidence are valid');
      assert.strictEqual(result.status, 'coming');
      assert.strictEqual(result.numComing, null);
      assert.strictEqual(result.confidence, 0.9);
    });

    it('sets numComing to null when num_coming is 0 (below range)', async () => {
      global.fetch = () => mockFetchResponse(
        geminiApiResponse({ status: 'coming', num_coming: 0, confidence: 0.9 })
      );
      const { classifyWithGemini } = freshGemini();
      const result = await classifyWithGemini('something');
      assert.ok(result !== null);
      assert.strictEqual(result.numComing, null);
    });

    it('accepts num_coming at lower boundary 1', async () => {
      global.fetch = () => mockFetchResponse(
        geminiApiResponse({ status: 'coming', num_coming: 1, confidence: 0.9 })
      );
      const { classifyWithGemini } = freshGemini();
      const result = await classifyWithGemini('something');
      assert.ok(result !== null);
      assert.strictEqual(result.numComing, 1);
    });

    it('accepts num_coming at upper boundary 50', async () => {
      global.fetch = () => mockFetchResponse(
        geminiApiResponse({ status: 'coming', num_coming: 50, confidence: 0.9 })
      );
      const { classifyWithGemini } = freshGemini();
      const result = await classifyWithGemini('something');
      assert.ok(result !== null);
      assert.strictEqual(result.numComing, 50);
    });

    it('returns null for malformed non-JSON text in model response', async () => {
      global.fetch = () => Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          candidates: [{
            content: { parts: [{ text: 'This is not valid JSON!' }] },
          }],
        }),
      });
      const { classifyWithGemini } = freshGemini();
      assert.strictEqual(await classifyWithGemini('something'), null);
    });

    it('returns null when candidates array is empty', async () => {
      global.fetch = () => mockFetchResponse({ candidates: [] });
      const { classifyWithGemini } = freshGemini();
      assert.strictEqual(await classifyWithGemini('something'), null);
    });
  });

  // -------------------------------------------------------------------------
  // No API key
  // -------------------------------------------------------------------------

  describe('no API key', () => {
    it('returns null and does not call fetch when no key in env or DB', async () => {
      delete process.env.GEMINI_API_KEY;
      // DB has no gemini_api_key row (not in schema defaults)

      let fetchCalled = false;
      global.fetch = () => { fetchCalled = true; return mockFetchResponse({}); };

      const { classifyWithGemini } = freshGemini();
      const result = await classifyWithGemini('something');

      assert.strictEqual(result, null);
      assert.strictEqual(fetchCalled, false, 'fetch must not be called without an API key');
    });

    it('uses the DB gemini_api_key when env var is absent', async () => {
      delete process.env.GEMINI_API_KEY;
      const dbModule = require(DB_MODULE_PATH);
      dbModule.setSetting('gemini_api_key', 'db-stored-key');

      let fetchUrl = '';
      global.fetch = (url) => {
        fetchUrl = url;
        return mockFetchResponse(
          geminiApiResponse({ status: 'coming', num_coming: null, confidence: 0.9 })
        );
      };

      const { classifyWithGemini } = freshGemini();
      const result = await classifyWithGemini('something');

      assert.ok(fetchUrl.includes('db-stored-key'), 'URL should include the DB-stored key');
      assert.ok(result !== null);
      assert.strictEqual(result.status, 'coming');
    });
  });

  // -------------------------------------------------------------------------
  // Rate limiting
  // -------------------------------------------------------------------------

  describe('rate limiting', () => {
    it('returns null and does not call fetch when daily limit is reached', async () => {
      seedRateLimitSettings(testDb, { callsToday: 50, dailyLimit: 50 });

      let fetchCalled = false;
      global.fetch = () => { fetchCalled = true; return mockFetchResponse({}); };

      const { classifyWithGemini } = freshGemini();
      const result = await classifyWithGemini('something');

      assert.strictEqual(result, null);
      assert.strictEqual(fetchCalled, false, 'fetch must not be called when limit is reached');
    });

    it('succeeds when one call remains before the daily limit', async () => {
      seedRateLimitSettings(testDb, { callsToday: 49, dailyLimit: 50 });

      global.fetch = () => mockFetchResponse(
        geminiApiResponse({ status: 'coming', num_coming: 2, confidence: 0.88 })
      );

      const { classifyWithGemini } = freshGemini();
      const result = await classifyWithGemini('something');

      assert.ok(result !== null);
      assert.strictEqual(result.status, 'coming');

      const dbModule = require(DB_MODULE_PATH);
      assert.strictEqual(
        dbModule.getSetting('gemini_calls_today'), '50',
        'counter should be incremented to 50 after the call'
      );
    });

    it('resets counter and proceeds when gemini_calls_date is in the past', async () => {
      seedRateLimitSettings(testDb, { callsToday: 50, dailyLimit: 50, date: '2000-01-01' });

      global.fetch = () => mockFetchResponse(
        geminiApiResponse({ status: 'undecided', num_coming: null, confidence: 0.6 })
      );

      const { classifyWithGemini } = freshGemini();
      const result = await classifyWithGemini('something');

      const dbModule = require(DB_MODULE_PATH);
      assert.strictEqual(
        dbModule.getSetting('gemini_calls_today'), '1',
        'counter should be 1 after date reset and a single call'
      );
      assert.strictEqual(
        dbModule.getSetting('gemini_calls_date'), getTodayDate(),
        'date should be updated to today'
      );
      assert.ok(result !== null);
      assert.strictEqual(result.status, 'undecided');
    });

    it('increments the counter on each successful call', async () => {
      seedRateLimitSettings(testDb, { callsToday: 0, dailyLimit: 50 });

      global.fetch = () => mockFetchResponse(
        geminiApiResponse({ status: 'coming', num_coming: null, confidence: 0.9 })
      );

      const { classifyWithGemini } = freshGemini();
      await classifyWithGemini('first');
      await classifyWithGemini('second');
      await classifyWithGemini('third');

      const dbModule = require(DB_MODULE_PATH);
      assert.strictEqual(dbModule.getSetting('gemini_calls_today'), '3');
    });
  });

  // -------------------------------------------------------------------------
  // API errors
  // -------------------------------------------------------------------------

  describe('API errors', () => {
    it('returns null when fetch returns HTTP 401', async () => {
      global.fetch = () => mockFetchResponse({ error: 'Unauthorized' }, 401);
      const { classifyWithGemini } = freshGemini();
      assert.strictEqual(await classifyWithGemini('something'), null);
    });

    it('returns null when fetch returns HTTP 500', async () => {
      global.fetch = () => mockFetchResponse({ error: 'Internal Server Error' }, 500);
      const { classifyWithGemini } = freshGemini();
      assert.strictEqual(await classifyWithGemini('something'), null);
    });

    it('returns null when fetch throws a network error', async () => {
      global.fetch = () => Promise.reject(new Error('Network failure'));
      const { classifyWithGemini } = freshGemini();
      assert.strictEqual(await classifyWithGemini('something'), null);
    });

    it('returns null when fetch throws an AbortError (simulated timeout)', async () => {
      global.fetch = () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        return Promise.reject(err);
      };
      const { classifyWithGemini } = freshGemini();
      assert.strictEqual(await classifyWithGemini('something'), null);
    });
  });
});
