const test = require('node:test');
const assert = require('node:assert');

const time = require('../../src/utils/time');

test('ymdFromEpoch formats unix epoch seconds', () => {
  assert.strictEqual(time.ymdFromEpoch(0), '1970-01-01');
  assert.strictEqual(time.ymdFromEpoch(1704067200), '2024-01-01');
});

test('dayHeadingFromEpoch labels today and yesterday', () => {
  const realNow = Date.now;
  try {
    const anchor = Date.parse('2024-03-15T12:00:00Z');
    Date.now = () => anchor;
    const today = Math.floor(anchor / 1000);
    const yesterday = today - 86400;

    assert.strictEqual(time.dayHeadingFromEpoch(today), 'Today');
    assert.strictEqual(time.dayHeadingFromEpoch(yesterday), 'Yesterday');

    const earlier = Date.parse('2024-03-10T00:00:00Z') / 1000;
    const expected = new Date(earlier * 1000).toLocaleDateString();
    assert.strictEqual(time.dayHeadingFromEpoch(earlier), expected);
  } finally {
    Date.now = realNow;
  }
});
