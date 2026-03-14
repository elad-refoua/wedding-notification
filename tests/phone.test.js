const { describe, it } = require('node:test');
const assert = require('node:assert');
const { normalizePhone, isValidPhone } = require('../src/utils/phone');

describe('Phone normalization', () => {
  it('converts 05X to +9725X', () => {
    assert.strictEqual(normalizePhone('0501234567'), '+972501234567');
  });
  it('strips dashes and spaces', () => {
    assert.strictEqual(normalizePhone('050-123-4567'), '+972501234567');
    assert.strictEqual(normalizePhone('050 123 4567'), '+972501234567');
  });
  it('keeps +972 format as-is', () => {
    assert.strictEqual(normalizePhone('+972501234567'), '+972501234567');
  });
  it('handles 972 without plus', () => {
    assert.strictEqual(normalizePhone('972501234567'), '+972501234567');
  });
  it('returns null for invalid numbers', () => {
    assert.strictEqual(normalizePhone('hello'), null);
    assert.strictEqual(normalizePhone('123'), null);
    assert.strictEqual(normalizePhone(''), null);
  });
});

describe('Phone validation', () => {
  it('validates E.164 Israeli numbers', () => {
    assert.strictEqual(isValidPhone('+972501234567'), true);
    assert.strictEqual(isValidPhone('+972521234567'), true);
    assert.strictEqual(isValidPhone('bad'), false);
  });
});
