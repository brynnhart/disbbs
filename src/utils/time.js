'use strict';

// Single time authority for the whole app. Storage stays epoch
// seconds/ms in UTC everywhere (DB columns, wire payloads) — only
// *interpretation* and *display* happen in board time.
//
// Board time is always America/New_York via Intl.DateTimeFormat, never a
// fixed UTC offset and never process.env.TZ / the host's system-local
// clock. Fixed offsets drift wrong twice a year (DST); system-local
// depends on how the container happens to be configured (this server has
// run in Toronto reporting either UTC or America/Toronto) — neither is
// safe to depend on for "what day is it on the board".
const BOARD_TIME_ZONE = 'America/New_York';

// Formatter construction isn't free; these are pure functions of the
// timeZone, never of the instant being formatted, so build each once.
const DAY_KEY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: BOARD_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
}); // en-CA's date format is YYYY-MM-DD, exactly the key format we want.
const PARTS_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: BOARD_TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
});
const SHORT_TIME_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: BOARD_TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: true,
});
const STAMP_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: BOARD_TIME_ZONE,
  month: 'numeric', day: 'numeric', year: 'numeric',
  hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
});

function nowEpoch(){
  return Math.floor(Date.now()/1000);
}

function resolveMs(ms){
  return typeof ms === 'number' ? ms : Date.now();
}

// 'YYYY-MM-DD' for the given instant (default: now), in board time.
function dayKeyET(ms){
  return DAY_KEY_FMT.format(new Date(resolveMs(ms)));
}

// Pure calendar arithmetic on a 'YYYY-MM-DD' key — never touches a real
// instant or timezone, so it's DST-immune by construction (it's just
// Gregorian date math, done via a UTC-anchored Date used purely as a
// calendar calculator).
function dayKeyAddDays(dayKey, delta){
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

// {h, m, s, dayKey} for the given instant, in board time.
function timePartsET(ms){
  const parts = PARTS_FMT.formatToParts(new Date(resolveMs(ms)));
  const get = (type) => { const p = parts.find(x => x.type === type); return p ? p.value : ''; };
  return {
    h: parseInt(get('hour'), 10),
    m: parseInt(get('minute'), 10),
    s: parseInt(get('second'), 10),
    dayKey: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

// 'HH:MM:SS' 24h, board time — e.g. footer clock ("20:35:50 ET").
function formatClockET(ms){
  const p = timePartsET(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(p.h)}:${pad(p.m)}:${pad(p.s)}`;
}

// Short display time, e.g. "10:36 AM" — chat/board/status timestamps.
function formatTimeET(ms){
  return SHORT_TIME_FMT.format(new Date(resolveMs(ms)));
}

// Full date+time, e.g. "7/7/2026, 10:36:17 AM" — mirrors the shape of the
// old toLocaleString() output, just pinned to board time instead of
// whatever locale/timezone the server host happens to report.
function formatStampET(ms){
  return STAMP_FMT.format(new Date(resolveMs(ms)));
}

// 'Today' / 'Yesterday' / 'YYYY-MM-DD', board time.
function dayHeadingET(ms){
  const key = dayKeyET(ms);
  const todayKey = dayKeyET();
  if (key === todayKey) return 'Today';
  if (key === dayKeyAddDays(todayKey, -1)) return 'Yesterday';
  return key;
}

// ms from `ms` (default: now) until the next board-time calendar day
// begins. Scans forward for the actual dayKeyET() change rather than
// assuming +24h — Eastern calendar days are 23h or 25h across a DST
// transition, so fixed-interval math is wrong twice a year. This never
// assumes a fixed offset; it only asks (via Intl, i.e. the IANA tz
// database) which calendar day a given instant falls on.
function msUntilNextMidnightET(ms){
  const t = resolveMs(ms);
  const currentKey = dayKeyET(t);
  let lo = t;
  let hi = t + 25 * 3600 * 1000; // no ET calendar day exceeds 25h
  while (dayKeyET(hi) === currentKey) hi += 3600 * 1000;
  while (hi - lo > 1000) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (dayKeyET(mid) === currentKey) lo = mid; else hi = mid;
  }
  return hi - t;
}

module.exports = {
  BOARD_TIME_ZONE,
  nowEpoch,
  dayKeyET,
  dayKeyAddDays,
  timePartsET,
  formatClockET,
  formatTimeET,
  formatStampET,
  dayHeadingET,
  msUntilNextMidnightET,
};
