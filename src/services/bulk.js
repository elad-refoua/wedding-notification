/**
 * In-process bulk-send coordination.
 *
 * Because the Cloud Run service runs with --max-instances=1, in-process state is
 * the ONLY lock we need. If that limit ever rises, move this to a SQLite row-lock.
 *
 * - `tryLock(name)` — returns true if the lock was acquired, false if something is
 *   already running. Non-blocking.
 * - `release(name)` — always call from a finally so crashes don't leave the lock held.
 * - `status()` — returns { bulk_send: boolean, retry_failed: boolean } for the dashboard.
 * - Unified `bulkSend(guests, bodyFor, opts)` helper used by both /send-invitations
 *   and /retry-failed. Handles batchSize + batchDelay pacing and never throws.
 */

const { getSetting } = require('../db/db');

const _locks = new Map(); // name -> { since: Date, total, done, ok, fail, lastGuestName }

function tryLock(name, meta) {
  if (_locks.has(name)) return false;
  _locks.set(name, { since: new Date(), total: meta?.total || 0, done: 0, ok: 0, fail: 0, lastGuestName: null });
  return true;
}

function release(name) {
  _locks.delete(name);
}

function updateProgress(name, patch) {
  const cur = _locks.get(name);
  if (!cur) return;
  Object.assign(cur, patch);
}

function status() {
  const entries = {};
  for (const [name, data] of _locks.entries()) {
    entries[name] = {
      running: true,
      since: data.since.toISOString(),
      total: data.total || 0,
      done: data.done || 0,
      ok: data.ok || 0,
      fail: data.fail || 0,
      last_guest_name: data.lastGuestName
    };
  }
  return { jobs: entries, any_running: _locks.size > 0 };
}

/**
 * Run sendToGuest across a list of guests with batch pacing.
 * bodyFor(guest) → string body
 * opts.channel? / opts.templateSidFor(guest)? → per-guest {templateSid, templateVariables}
 * onProgress?(index, total, lastResult) — optional callback for progress tracking
 * Returns { ok, fail, total }. Never throws — per-guest errors are logged via twilio.js.
 */
async function bulkSend(guests, bodyFor, opts, onProgress) {
  const { sendToGuest } = require('./twilio');
  opts = opts || {};
  const batchSize = parseInt(getSetting('batch_size') || '10');
  const batchDelay = parseInt(getSetting('batch_delay_seconds') || '60') * 1000;
  let ok = 0, fail = 0;

  for (let i = 0; i < guests.length; i++) {
    const g = guests[i];
    let result = null;
    try {
      const sendOpts = { channel: opts.channel };
      if (opts.templateSidFor) Object.assign(sendOpts, opts.templateSidFor(g));
      result = await sendToGuest(g, bodyFor(g), sendOpts);
      if (result && result.delivered) ok++;
      else fail++;
    } catch (e) {
      fail++;
      console.error('bulkSend iteration failed for guest ' + g.id + ':', e.message);
    }
    if (onProgress) {
      try { onProgress(i + 1, guests.length, result); } catch (_) {}
    }
    if ((i + 1) % batchSize === 0 && i < guests.length - 1) {
      await new Promise(r => setTimeout(r, batchDelay));
    }
  }
  return { ok, fail, total: guests.length };
}

module.exports = { tryLock, release, updateProgress, status, bulkSend };
