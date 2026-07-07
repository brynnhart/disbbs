const test = require('node:test');
const assert = require('node:assert');

const time = require('../../src/utils/time');

// Newer ICU/CLDR data renders a narrow no-break space (U+202F) before
// AM/PM instead of a regular space; normalize so these tests don't flake
// across Node/ICU versions.
function norm(s) {
  return s.replace(/ /g, ' ');
}

test('dayKeyET interprets the instant in America/New_York, not UTC', () => {
  // 2024-01-01T00:00:00Z is still 2023-12-31 in Eastern Standard Time
  // (UTC-5 in January) — this is exactly the bug this module fixes: the
  // old ymdFromEpoch/UTC-based day key would have called this 2024-01-01.
  assert.strictEqual(time.dayKeyET(Date.UTC(2024, 0, 1, 0, 0, 0)), '2023-12-31');
  // 2024-01-01T05:00:00Z is 2024-01-01T00:00:00 EST — the actual ET
  // midnight boundary in winter.
  assert.strictEqual(time.dayKeyET(Date.UTC(2024, 0, 1, 5, 0, 0)), '2024-01-01');
});

test('dayKeyET follows the DST-shifted boundary in summer (EDT, UTC-4)', () => {
  // 2024-07-04T03:30:00Z is 2024-07-03T23:30:00 EDT — still July 3rd.
  assert.strictEqual(time.dayKeyET(Date.UTC(2024, 6, 4, 3, 30, 0)), '2024-07-03');
  // 2024-07-04T04:30:00Z is 2024-07-04T00:30:00 EDT — now July 4th. The
  // UTC boundary moved an hour earlier than the winter case above because
  // of DST — a fixed-offset implementation would get one of these wrong.
  assert.strictEqual(time.dayKeyET(Date.UTC(2024, 6, 4, 4, 30, 0)), '2024-07-04');
});

test('dayKeyAddDays does pure calendar math, including across a leap day', () => {
  assert.strictEqual(time.dayKeyAddDays('2024-03-01', -1), '2024-02-29');
  assert.strictEqual(time.dayKeyAddDays('2023-03-01', -1), '2023-02-28');
  assert.strictEqual(time.dayKeyAddDays('2024-12-31', 1), '2025-01-01');
});

test('timePartsET returns board-time hour/minute/second and dayKey together', () => {
  const parts = time.timePartsET(Date.UTC(2024, 0, 1, 0, 0, 0)); // see dayKeyET test above
  assert.deepStrictEqual(parts, { h: 19, m: 0, s: 0, dayKey: '2023-12-31' });
});

test('formatClockET renders 24h HH:MM:SS in board time', () => {
  assert.strictEqual(time.formatClockET(Date.UTC(2024, 0, 1, 0, 0, 0)), '19:00:00');
  assert.strictEqual(time.formatClockET(Date.UTC(2024, 0, 1, 5, 0, 0)), '00:00:00');
});

test('formatTimeET renders a short 12h time in board time', () => {
  assert.strictEqual(norm(time.formatTimeET(Date.UTC(2024, 0, 1, 0, 0, 0))), '07:00 PM');
});

test('formatStampET renders board-time date and time together', () => {
  const stamp = norm(time.formatStampET(Date.UTC(2024, 0, 1, 0, 0, 0)));
  assert.ok(stamp.includes('12/31/2023'), `expected board date in: ${stamp}`);
  assert.ok(stamp.includes('7:00:00 PM'), `expected board time in: ${stamp}`);
});

test('dayHeadingET labels today and yesterday relative to board time, falls back to the day key', () => {
  const realNow = Date.now;
  try {
    const anchorMs = Date.UTC(2024, 2, 15, 16, 0, 0); // 2024-03-15 noon EDT
    Date.now = () => anchorMs;

    assert.strictEqual(time.dayHeadingET(anchorMs), 'Today');
    assert.strictEqual(time.dayHeadingET(anchorMs - 24 * 3600 * 1000), 'Yesterday');

    const earlierMs = Date.UTC(2024, 2, 10, 16, 0, 0);
    assert.strictEqual(time.dayHeadingET(earlierMs), '2024-03-10');
  } finally {
    Date.now = realNow;
  }
});

test('msUntilNextMidnightET finds the exact board-time day boundary, not a fixed +24h', () => {
  // A calm midday instant: next boundary must be in the future and must
  // actually land on the next calendar day (board time).
  const noonMs = Date.UTC(2024, 5, 15, 16, 0, 0); // 2024-06-15 noon EDT
  const untilMidnight = time.msUntilNextMidnightET(noonMs);
  assert.ok(untilMidnight > 0);
  assert.strictEqual(time.dayKeyET(noonMs + untilMidnight), '2024-06-16');
  assert.strictEqual(time.dayKeyET(noonMs + untilMidnight - 1000), '2024-06-15');

  // Spring-forward day (2024-03-10) is only 23 real hours long in ET.
  const springForwardMidnightMs = Date.UTC(2024, 2, 10, 5, 0, 0); // 00:00 EST
  const springSpan = time.msUntilNextMidnightET(springForwardMidnightMs);
  assert.ok(Math.abs(springSpan - 23 * 3600 * 1000) <= 1000, `expected ~23h, got ${springSpan}ms`);

  // Fall-back day (2024-11-03) is 25 real hours long in ET.
  const fallBackMidnightMs = Date.UTC(2024, 10, 3, 4, 0, 0); // 00:00 EDT
  const fallSpan = time.msUntilNextMidnightET(fallBackMidnightMs);
  assert.ok(Math.abs(fallSpan - 25 * 3600 * 1000) <= 1000, `expected ~25h, got ${fallSpan}ms`);
});

test('nowEpoch returns whole seconds', () => {
  const before = Math.floor(Date.now() / 1000);
  const got = time.nowEpoch();
  const after = Math.floor(Date.now() / 1000);
  assert.ok(Number.isInteger(got));
  assert.ok(got >= before && got <= after);
});
