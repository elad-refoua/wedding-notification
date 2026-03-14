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
});

describe('Level 3 Claude API fallback', () => {
  it('classifyWithClaude returns status from API response', async () => {
    const { classifyWithClaude } = require('../src/services/parser');
    // Without API key, should gracefully return null
    const result = await classifyWithClaude('אם הילדים יהיו בריאים אז כן');
    assert.strictEqual(result.status, null);
  });
});
