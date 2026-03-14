const { describe, it } = require('node:test');
const assert = require('node:assert');
const { parseReply } = require('../src/services/parser');

describe('Hebrew reply parser', () => {
  it('parses "כן" as coming', () => assert.strictEqual(parseReply('כן').status, 'coming'));
  it('parses "בטח נגיע" as coming', () => assert.strictEqual(parseReply('בטח נגיע').status, 'coming'));
  it('parses "מגיעים!" as coming', () => assert.strictEqual(parseReply('מגיעים!').status, 'coming'));
  it('parses "לא נוכל" as not_coming', () => assert.strictEqual(parseReply('לא נוכל').status, 'not_coming'));
  it('parses "לצערנו לא" as not_coming', () => assert.strictEqual(parseReply('לצערנו לא').status, 'not_coming'));
  it('parses "עוד לא יודעים" as undecided', () => assert.strictEqual(parseReply('עוד לא יודעים').status, 'undecided'));
  it('parses "לא בטוח" as undecided (not not_coming)', () => assert.strictEqual(parseReply('לא בטוח').status, 'undecided'));
  it('parses "אולי" as undecided', () => assert.strictEqual(parseReply('אולי').status, 'undecided'));
  it('extracts number from "נבוא 4"', () => {
    const r = parseReply('נבוא 4');
    assert.strictEqual(r.status, 'coming');
    assert.strictEqual(r.numComing, 4);
  });
  it('extracts number from "מגיעים 2"', () => {
    const r = parseReply('מגיעים 2');
    assert.strictEqual(r.status, 'coming');
    assert.strictEqual(r.numComing, 2);
  });
  it('parses "הסר" as opted_out', () => assert.strictEqual(parseReply('הסר').status, 'opted_out'));
  it('parses "stop" as opted_out', () => assert.strictEqual(parseReply('stop').status, 'opted_out'));
  it('parses "חידוש" as re_enable', () => assert.strictEqual(parseReply('חידוש').status, 're_enable'));
  it('returns null for "מה השעה?"', () => assert.strictEqual(parseReply('מה השעה?').status, null));
  it('extracts Hebrew word number from "נגיע שלושה"', () => {
    const r = parseReply('נגיע שלושה');
    assert.strictEqual(r.status, 'coming');
    assert.strictEqual(r.numComing, 3);
  });
  it('extracts Hebrew word number from "מגיעים שניים"', () => {
    const r = parseReply('מגיעים שניים');
    assert.strictEqual(r.status, 'coming');
    assert.strictEqual(r.numComing, 2);
  });
});

describe('Ambiguous messages', () => {
  it('returns null status for ambiguous messages (escalated to admins)', () => {
    const result = parseReply('צריך לראות מה המצב עם הסידורים');
    assert.strictEqual(result.status, null);
  });
});
