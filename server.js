const path = require('path');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const { createDatabase } = require('./src/database');
const { createHub } = require('./src/hub');
const { createNotificationService } = require('./src/services/notifications');
const { createChromeService } = require('./src/services/chrome');
const formatting = require('./src/utils/formatting');
const timeUtils = require('./src/utils/time');

const DB_PATH = process.env.DB_PATH || './dis.sqlite3';
const PORT = process.env.PORT || 3000;
// Required for signing SSO cookies shared across subdomains.
const SSO_SECRET = process.env.SSO_SECRET || null;
const AUTH_TOKEN_TTL_MS = 60 * 1000;
const AUTH_TOKENS = new Map();

const SMTP_HOST = process.env.SMTP_HOST || null;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER || null;
const SMTP_PASS = process.env.SMTP_PASS || null;
const SMTP_FROM = process.env.SMTP_FROM || (SMTP_USER ? `DIS BBS <${SMTP_USER}>` : null);

const KOFI_VERIFICATION_TOKEN = process.env.KOFI_VERIFICATION_TOKEN || null;
const KOFI_MONTHLY_GOAL = parseFloat(process.env.KOFI_MONTHLY_GOAL || '20');
const KOFI_URL = process.env.KOFI_URL || '';

let mailer = null;
try {
  const nodemailer = require('nodemailer');
  if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
    mailer = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
    console.log(`[mailer] SMTP configured: ${SMTP_HOST}:${SMTP_PORT}`);
  }
} catch (e) {
  console.warn('[mailer] nodemailer not available:', e.message);
}

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
// index.html holds all inline CSS/JS for the client (no separate bundle),
// so a stale cached copy means stale styling site-wide. Force it to always
// revalidate; other static assets (fonts, sounds, images) keep normal caching.
const staticOpts = {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
};
app.use(express.static(path.join(__dirname, 'public'), staticOpts));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use('/static', express.static(path.join(__dirname, 'public'), staticOpts));

const database = createDatabase({ dbPath: DB_PATH });
const { db, statements, helpers } = database;
module.exports.__db = db;

// Fast in-memory ban cache — populated at startup, updated on /ban
const BANNED_USERNAMES = new Set(
  db.prepare('SELECT username FROM ban_list WHERE username IS NOT NULL').all().map(r => r.username.toLowerCase())
);

const hubApi = createHub({ timeUtils, formatting });
const notifications = createNotificationService({
  statements,
  helpers,
  hub: hubApi,
  timeUtils,
});
const chrome = createChromeService({ db, nowEpoch: timeUtils.nowEpoch, dayKeyET: timeUtils.dayKeyET, hub: hubApi.hub, sendOps: hubApi.sendOps });

function fmtCr(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/* ======================= Box-drawing frame helper =======================
   Real ╔═╗/║ ║/╚═╝ box-drawing characters as literal text (not CSS borders),
   for a fixed-width titled frame. Reusable by any future feature that wants
   this look — see renderMenu's "MAIN MENU" frame for a usage example.

   title: plain text, wrapped in "[ ]" automatically.
   rows: array of rows; each row is an array of {text, cls} segments, where
     cls is an optional CSS class to color that segment (padding is applied
     to each segment's own text before joining, so column alignment survives
     per-segment coloring). Overlong rows are truncated with "…" rather than
     breaking the frame.
   totalWidth: fixed outer width in characters, including the border chars. */
function renderFrameRow(segments, innerWidth) {
  let used = 0;
  let html = '';
  for (const seg of segments) {
    if (used >= innerWidth) break;
    const remaining = innerWidth - used;
    let text = seg.text;
    if (text.length > remaining) {
      text = remaining > 1 ? text.slice(0, remaining - 1) + '…' : '';
      text = text.slice(0, remaining);
    }
    if (text.length) {
      html += seg.cls ? `<span class="${escapeHTML(seg.cls)}">${escapeHTML(text)}</span>` : escapeHTML(text);
      used += text.length;
    }
  }
  if (used < innerWidth) html += ' '.repeat(innerWidth - used);
  return html;
}
function renderBoxFrame(title, rows, totalWidth) {
  const innerWidth = totalWidth - 4; // 2 border chars + 1 padding space each side
  const titleTxt = `[ ${title} ]`;
  const available = totalWidth - 2 - titleTxt.length;
  const sideLen = Math.max(2, Math.floor(available / 2));
  const remainder = Math.max(0, available - sideLen * 2);
  // Absorb any odd leftover into the title's own trailing padding so the
  // two ═ runs stay exactly equal in length either side.
  const paddedTitle = remainder > 0 ? titleTxt + ' '.repeat(remainder) : titleTxt;
  const topRule = `<span class="frame-char">╔${'═'.repeat(sideLen)}${escapeHTML(paddedTitle)}${'═'.repeat(sideLen)}╗</span>`;
  const bottomRule = `<span class="frame-char">╚${'═'.repeat(totalWidth - 2)}╝</span>`;
  let html = `<div class="line frame-line">${topRule}</div>`;
  for (const segs of rows) {
    html += `<div class="line frame-line"><span class="frame-char">║</span> ${renderFrameRow(segs, innerWidth)} <span class="frame-char">║</span></div>`;
  }
  html += `<div class="line frame-line">${bottomRule}</div>`;
  return html;
}


const {
  hub: HUB,
  sendOps,
  makeApi,
  broadcastSystem,
  broadcastChatFrom,
  broadcastAdminChatFrom,
  usersCurrentlyInChat,
  usersCurrentlyInAdminChat,
} = hubApi;

const {
  sanitizeAndFormatDIS: _sanitizeAndFormatDIS,
  escapeHTML,
  visibleLengthDIS,
  stripDISFormatting,
  ALLOWED_COLORS,
} = formatting;

const {
  nowEpoch,
  dayKeyET,
  dayKeyAddDays,
  formatClockET,
  formatTimeET,
  formatStampET,
  dayHeadingET,
  msUntilNextMidnightET,
} = timeUtils;

const {
  notifyMentions,
  listMentionsForUser,
  markMentionsSeen,
  humanizeContext,
} = notifications;

const ANNOUNCEMENT_LIST_LIMIT = 50;
const ANNOUNCEMENT_MAX_LEN = 600;
const STATUS_FEED_LIMIT_CAP = 200;

const RESOURCES = {
  bismuth:     { label: 'Bismuth',     color: '#b39ddb', tier: 'common',    weight: 30 },
  cinnabar:    { label: 'Cinnabar',    color: '#c62828', tier: 'common',    weight: 25 },
  malachite:   { label: 'Malachite',   color: '#2e7d32', tier: 'uncommon',  weight: 18 },
  vitriol:     { label: 'Vitriol',     color: '#aeea00', tier: 'uncommon',  weight: 14 },
  brimstone:   { label: 'Brimstone',   color: '#f9a825', tier: 'rare',      weight: 8  },
  obsidian:    { label: 'Obsidian',    color: '#9e9e9e', tier: 'rare',      weight: 4  },
  alexandrite: { label: 'Alexandrite', color: '#6a1b9a', tier: 'very_rare', weight: 1  },
};

/* Dots and Boxes */
const DOTS_GRID   = 6;                          // 6x6 dots
const DOTS_COLS   = DOTS_GRID - 1;             // 5 squares per row
const DOTS_H_LINES = DOTS_GRID * DOTS_COLS;    // 30 horizontal lines
const DOTS_V_LINES = DOTS_COLS * DOTS_GRID;    // 30 vertical lines
const DOTS_TOTAL_LINES = DOTS_H_LINES + DOTS_V_LINES; // 60
const DOTS_SQUARES = DOTS_COLS * DOTS_COLS;    // 25

// Line index helpers
function dotsHIdx(row, col) { return row * DOTS_COLS + col; }
function dotsVIdx(row, col) { return DOTS_H_LINES + row * DOTS_GRID + col; }

// Returns array of [row,col] squares adjacent to a line index
function dotsSquaresForLine(lineIdx) {
  const sq = [];
  if (lineIdx < DOTS_H_LINES) {
    const row = Math.floor(lineIdx / DOTS_COLS);
    const col = lineIdx % DOTS_COLS;
    if (row > 0)            sq.push([row-1, col]);
    if (row < DOTS_COLS)    sq.push([row,   col]);
  } else {
    const v   = lineIdx - DOTS_H_LINES;
    const row = Math.floor(v / DOTS_GRID);
    const col = v % DOTS_GRID;
    if (col > 0)            sq.push([row, col-1]);
    if (col < DOTS_COLS)    sq.push([row, col]);
  }
  return sq;
}

// Returns true if all 4 edges of square (r,c) are drawn
function dotsSquareComplete(lines, r, c) {
  return lines[dotsHIdx(r,   c)] &&
         lines[dotsHIdx(r+1, c)] &&
         lines[dotsVIdx(r,   c)] &&
         lines[dotsVIdx(r,   c+1)];
}

const DOTS_CHROME_LINE    = 1;   // for drawing any line
const DOTS_CHROME_SQUARE  = 5;   // per square claimed
const DOTS_CHROME_WIN     = 50;  // bonus for most squares when board completes

const DOTS_PLAYER_COLORS = [
  '#00ffff','#ff00ff','#ffff00','#00ff88','#ff6600',
  '#ff3399','#33ccff','#aaff00','#ff4444','#bb88ff',
];
function dotsPlayerColor(username) {
  let hash = 0;
  for (let i = 0; i < username.length; i++) hash = (hash * 31 + username.charCodeAt(i)) & 0xffffffff;
  return DOTS_PLAYER_COLORS[Math.abs(hash) % DOTS_PLAYER_COLORS.length];
}

const RESOURCE_FLOORS = {
  bismuth: 3, cinnabar: 5, malachite: 10, vitriol: 15,
  brimstone: 25, obsidian: 40, alexandrite: 100,
};
const RESOURCE_CEILINGS = {
  bismuth: 10, cinnabar: 18, malachite: 35, vitriol: 50,
  brimstone: 85, obsidian: 130, alexandrite: 350,
};
const ROB_BASE_SUCCESS = {
  common: 0.30, uncommon: 0.45, rare: 0.60, very_rare: 0.85,
};
const ROB_STEAL_PCT = {
  common:    [0.02, 0.04],
  uncommon:  [0.04, 0.07],
  rare:      [0.07, 0.12],
  very_rare: [0.12, 0.18],
};
const ROB_RESOURCE_TIER = {};
for (const [key, val] of Object.entries(RESOURCES)) ROB_RESOURCE_TIER[key] = val.tier;

const GRAFFITI_COLS = 80;
const GRAFFITI_ROWS = 30;
const GRAFFITI_TOTAL = GRAFFITI_COLS * GRAFFITI_ROWS; // 2400

const GRAFFITI_PALETTE = [
  // blacks/greys/whites
  '#000000','#222222','#444444','#666666','#888888','#aaaaaa','#cccccc','#ffffff',
  // browns/earth tones
  '#3e1f00','#7b3f00','#c47a2b','#e8b87a',
  // skin tones
  '#ffcba4','#d4956a','#8d5524','#4a2912',
  // jewel/goth tones
  '#2d1b69','#880e4f','#ad1457','#b71c1c','#0d47a1','#1b5e20','#e65100','#004d40',
  // neons/brights
  '#ff00ff','#00ffff','#ff0000','#00ff00','#0000ff','#ffff00','#ff6600','#ff1493',
  // DIS resource colors
  '#b39ddb','#c62828','#2e7d32','#aeea00','#f9a825','#9e9e9e','#6a1b9a','#19c3c3'
];

/* Hack (terminal cracking) */
const HACK_WORDS = {
  5: ['PROXY','VIRUS','PIXEL','GHOST','STEEL','TOXIC','BYTES','GLOOM','BLACK','NIGHT',
      'SPARK','FLAME','CRAWL','CRASH','CHAOS','BLINK','SURGE','BLEED','RAVEN','GRAVE',
      'ASHEN','DREAD','WITCH','CURSE','SKULK','DECAY','GROAN','MOURN','DIRGE','BLEAK',
      'CRYPT','REBEL','FERAL','SCRAP','RUINS','SHARD','SMOKE','GRIME','SLASH','PROWL',
      'EXILE','STRAY','ROGUE','GLARE','SNARL','DWELL','PATCH','CLANK','GRIND','SMEAR'],

  6: ['CIPHER','GLITCH','BREACH','KERNEL','DAEMON','STATIC','SIGNAL','BINARY','MALICE',
      'SCRIPT','BUFFER','VECTOR','TROJAN','PACKET','SYNTAX','REBOOT','UPLOAD','ACCESS',
      'SHADOW','ROTTEN','COFFIN','SHROUD','PLAGUE','WRAITH','HOLLOW','FALLEN','WITHER',
      'SOMBER','DISMAL','MORBID','GRIEVE','LAMENT','VANDAL','OUTLAW','MUTANT','FRENZY',
      'RUCKUS','FIERCE','DEFACE','ERRANT','LURKER','WANTED','SCRAWL','RAVAGE','SULFUR',
      'MAYHEM','TANGLE','CINDER','PUTRID','NETHER'],

  7: ['NETWORK','DECRYPT','CORRUPT','EXPLOIT','CIRCUIT','MALWARE','COMPILE','EXECUTE',
      'ROOTKIT','COMMAND','PROCESS','SECTORS','RUNTIME','OFFLINE','INVALID','ABORTED',
      'PHANTOM','REMAINS','ROTTING','HAUNTED','MACABRE','OBSCURE','DESPAIR','TORMENT',
      'ANGUISH','FORLORN','GHASTLY','OUTCAST','DEFIANT','ABANDON','VAGRANT','RAMPAGE',
      'SUBVERT','PROWLER','INVADER','RAVAGED','WRECKER','CORRODE','NULLIFY','SEVERED',
      'BLACKEN','CORRODE','STAGGER','CRUMBLE','FESTIVE','DESOLATE','CARRION','TWISTED'],
};
const HACK_PAYOUTS = {
  5: [10, 8, 5, 3],
  6: [18, 14, 10, 5],
  7: [30, 22, 15, 8],
};
const HACK_FAIL_CONSOLATION = 2;
const HACK_NOISE_CHARSET = '!@#$%^&*()_+-=[]{}|;:,.<>?/~';
const HACK_NOISE_LEN = 900;

const {
  getSetting,
  setSetting,
  getUserByName,
  getUserIdByName,
  setLastLogin,
  getUserColor,
  setUserColor,
  clearUserColor,
  getUserDisplay,
  setUserDisplay,
  clearUserDisplay,
  getUserAboutById,
  getUserAboutByName,
  setUserAboutById,
  setUserSignupReason,
  insertDM,
  listDMsForUser,
  countUnreadDMs,
  markAllDMsRead,
  sweepExpiredDMs,
  insertSuggestion,
  listSuggestions,
  deleteSuggestionById,
  sweepExpiredSuggestions,
  insertStatusPost,
  listStatusPosts,
  listStatusPostsByUser,
  sweepExpiredStatusPosts,
  insertMessage,
  recentMessages,
  sweepExpiredMessages,
  insertTopic,
  deleteTopicById,
  selectTopicsList,
  selectTopic,
  selectCommentsForTopic,
  insertComment,
  updateTopicBump,
  sweepExpiredTopics,
  insertNewsPost,
  deleteNewsById,
  selectNewsList,
  selectNewsPost,
  selectNewsComments,
  insertNewsComment,
  bumpNewsPost,
  sweepExpiredNews,
  insertAdminMessage,
  recentAdminMessages,
  sweepExpiredAdminMessages,
  insertAnnouncement,
  listAnnouncements,
  deleteAnnouncementById,
  getActiveAnnouncementById,
  sweepExpiredAnnouncements,
  insertPoll,
  listActivePolls,
  listEndedPolls,
  getPollById,
  insertPollOption,
  listPollOptionsWithVotes,
  getPollOptionByIndex,
  countPollVotes,
  getPollVoteForUser,
  insertPollVote,
  endPollById,
  removePollById,
  sweepInactiveUsers,
  updateUserNorms,
  getUsersByNorm,
  listUsersBasic,
  countUsers,
  listUsersPage,
  insertPixelArt,
  listPixelArt,
  getPixelArtByName,
  getPixelArtById,
  getPixelArtEmoji,
  updatePixelArt,
  deletePixelArt,
  insertSynthPatch,
  listSynthPatches,
  listSynthPatchesWithData,
  getSynthPatchByName,
  getSynthPatchById,
  updateSynthPatch,
  deleteSynthPatch,
  insertTrackerSong,
  listTrackerSongs,
  getTrackerSongByName,
  getTrackerSongById,
  updateTrackerSong,
  deleteTrackerSong,
  insertPasswordResetToken,
  getPasswordResetToken,
  markPasswordResetTokenUsed,
  updateUserFingerprint,
  updateUserFingerprintOnRegister,
  insertBan,
  listBans,
  getBanById,
  deleteBanById,
  updateBanNote,
  checkBanByUsername,
  checkBanByIp,
  checkBanByFingerprint,
  getLastSeenAt,
  setLastSeenAt,
  countNewBoardTopics,
  countNewBoardComments,
  countNewLinkPosts,
  countNewPolls,
  countNewVotesOnUserPolls,
  countNewStatusPosts,
  countNewPixelArt,
  listRecentUsers,
  insertRegistrationRejection,
  listRegistrationRejections,
  wordleGetDaily,
  wordleSetDaily,
  wordleGetRandomWord,
  wordleGetGuesses,
  wordleCountGuesses,
  wordleInsertGuess,
  wordleGetResult,
  wordleUpsertResult,
  wordleGetStreak,
  wordleUpsertStreak,
  wordleLeaderCurrent,
  wordleLeaderBest,
  wordleGetTodaySolvers,
  gameFeedInsert,
  gameFeedList,
  insertDonation,
  getDonationByTxId,
  listRecentDonations,
  updateDonationAwarded,
  getUnlinkedDonationsByKofi,
  insertDonationLink,
  getDonationLinkByKofi,
  deleteDonationLink,
  listDonationsForMonthCalc,
  checkUserIsDonor,
} = statements;

/* ======================= Activity feed ======================= */
const stmtInsertActivity = db.prepare(
  'INSERT INTO activity_feed (category, event_type, message, created_at) VALUES (?, ?, ?, ?)'
);
function addActivityEvent(category, event_type, message) {
  try { stmtInsertActivity.run(category, event_type, message, nowEpoch()); } catch (e) {
    console.error('[activity]', e && e.message);
  }
}

let _lastLeader = null;
function checkLeaderChange() {
  try {
    const top = chrome.getLeaderboard(1);
    if (!top.length) return;
    const current = top[0].username;
    if (_lastLeader && _lastLeader !== current) {
      addActivityEvent('chrome', 'leaderboard', `🏆 ${current} just took the #1 spot on the chrome leaderboard!`);
    }
    _lastLeader = current;
  } catch {}
}

const stmtActivityFeed = db.prepare(
  'SELECT category, event_type, message, created_at FROM activity_feed ORDER BY created_at DESC LIMIT 20'
);
const stmtGamesFeed = db.prepare(
  "SELECT message, created_at FROM activity_feed WHERE category = 'games' ORDER BY created_at DESC LIMIT 8"
);
const stmtUserTransactions = db.prepare(
  'SELECT amount, reason, created_at FROM chrome_transactions WHERE username = ? ORDER BY created_at DESC LIMIT ?'
);
const stmtTotalUsers    = db.prepare('SELECT COUNT(1) AS n FROM chrome_balances');
const stmtGetChromeRow  = db.prepare('SELECT balance, last_stipend_at FROM chrome_balances WHERE username = ?');
const stmtUserRank      = db.prepare(
  'SELECT COUNT(1) AS rank FROM chrome_balances WHERE balance > (SELECT balance FROM chrome_balances WHERE username = ?)'
);

/* Mining */
const stmtCheckGridExists    = db.prepare('SELECT COUNT(1) AS n FROM mining_grid WHERE grid_date = ?');
const stmtInsertGridCell     = db.prepare('INSERT OR IGNORE INTO mining_grid (grid_date, cell_index, resource) VALUES (?, ?, ?)');
const stmtGetMiningGrid      = db.prepare('SELECT cell_index, resource, revealed_by FROM mining_grid WHERE grid_date = ? ORDER BY cell_index ASC');
const stmtGetMiningCell      = db.prepare('SELECT resource, revealed_by FROM mining_grid WHERE grid_date = ? AND cell_index = ?');
const stmtGetMiningClicks    = db.prepare('SELECT click_count FROM mining_clicks WHERE username = ? AND grid_date = ?');
const stmtRevealCell         = db.prepare('UPDATE mining_grid SET revealed_by = ?, revealed_at = ? WHERE grid_date = ? AND cell_index = ?');
const stmtUpsertMiningClicks = db.prepare('INSERT INTO mining_clicks (username, grid_date, click_count) VALUES (?, ?, 1) ON CONFLICT(username, grid_date) DO UPDATE SET click_count = click_count + 1');
const stmtUpsertResourceBal  = db.prepare('INSERT INTO resource_balances (username, resource, amount) VALUES (?, ?, 1) ON CONFLICT(username, resource) DO UPDATE SET amount = amount + 1');
const stmtGetResourceBals    = db.prepare('SELECT resource, amount FROM resource_balances WHERE username = ?');
const stmtGetResourceBal     = db.prepare('SELECT amount FROM resource_balances WHERE username = ? AND resource = ?');
const stmtDeductResourceBal  = db.prepare('UPDATE resource_balances SET amount = amount - ? WHERE username = ? AND resource = ?');
const stmtAddResourceBal     = db.prepare('INSERT INTO resource_balances (username, resource, amount) VALUES (?, ?, ?) ON CONFLICT(username, resource) DO UPDATE SET amount = amount + excluded.amount');

/* Rob */
const stmtInsertRobLog = db.prepare(
  'INSERT INTO rob_log (attacker, target, resource, success, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)'
);

/* Graffiti Wall */
const stmtGraffitiGetAll    = db.prepare('SELECT cell_index, color, painted_by FROM graffiti_wall ORDER BY cell_index ASC');
const stmtGraffitiPaint     = db.prepare('INSERT INTO graffiti_wall (cell_index, color, painted_by, painted_at) VALUES (?,?,?,?) ON CONFLICT(cell_index) DO UPDATE SET color=excluded.color, painted_by=excluded.painted_by, painted_at=excluded.painted_at');
const stmtGraffitiErase     = db.prepare('DELETE FROM graffiti_wall WHERE cell_index = ?');
const stmtGraffitiLastLog   = db.prepare('SELECT last_logged FROM graffiti_activity WHERE username = ?');
const stmtGraffitiUpsertLog = db.prepare('INSERT INTO graffiti_activity (username, last_logged) VALUES (?,?) ON CONFLICT(username) DO UPDATE SET last_logged=excluded.last_logged');

/* Hack (terminal cracking) */
const stmtHackGetLog = db.prepare('SELECT solved, attempts, chrome_won, word_length FROM hack_log WHERE username = ? AND play_date = ?');
const stmtHackUpsertLog = db.prepare(`
  INSERT INTO hack_log (username, play_date, solved, attempts, chrome_won, word_length)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(username, play_date) DO UPDATE SET
    solved = excluded.solved,
    attempts = excluded.attempts,
    chrome_won = excluded.chrome_won,
    word_length = excluded.word_length
`);

/* Dots and Boxes */
const stmtDotsActiveGame   = db.prepare('SELECT * FROM dots_game WHERE finished = 0 ORDER BY id DESC LIMIT 1');
const stmtDotsCreateGame   = db.prepare('INSERT INTO dots_game (started_at, ends_at, finished) VALUES (?,?,0)');
const stmtDotsFinishGame   = db.prepare('UPDATE dots_game SET finished = 1 WHERE id = ?');
const stmtDotsGetLines     = db.prepare('SELECT line_idx, drawn_by FROM dots_lines WHERE game_id = ?');
const stmtDotsInsertLine   = db.prepare('INSERT INTO dots_lines (game_id, line_idx, drawn_by, drawn_at) VALUES (?,?,?,?)');
const stmtDotsGetSquares   = db.prepare('SELECT sq_row, sq_col, claimed_by FROM dots_squares WHERE game_id = ?');
const stmtDotsInsertSquare = db.prepare('INSERT INTO dots_squares (game_id, sq_row, sq_col, claimed_by, claimed_at) VALUES (?,?,?,?,?)');
const stmtDotsGetTurn      = db.prepare('SELECT last_drew_at FROM dots_turns WHERE game_id = ? AND username = ?');
const stmtDotsUpsertTurn   = db.prepare('INSERT INTO dots_turns (game_id, username, last_drew_at) VALUES (?,?,?) ON CONFLICT(game_id, username) DO UPDATE SET last_drew_at = excluded.last_drew_at');
const stmtDotsLastDraw     = db.prepare('SELECT MAX(drawn_at) AS last FROM dots_lines WHERE game_id = ?');
const stmtDotsScores       = db.prepare('SELECT claimed_by, COUNT(1) AS squares FROM dots_squares WHERE game_id = ? GROUP BY claimed_by ORDER BY squares DESC LIMIT 5');
const stmtDotsLineCount    = db.prepare('SELECT COUNT(1) AS n FROM dots_lines WHERE game_id = ?');

/* Market */
const stmtGetAllMarketPrices = db.prepare('SELECT resource, current_price, previous_price, last_drift_date FROM market_prices');
const stmtGetMarketPrice     = db.prepare('SELECT resource, current_price, previous_price, last_drift_date FROM market_prices WHERE resource = ?');
const stmtDriftMarketPrice   = db.prepare('UPDATE market_prices SET previous_price = current_price, current_price = ?, last_drift_date = ? WHERE resource = ?');
const stmtNudgeMarketPrice   = db.prepare('UPDATE market_prices SET current_price = ? WHERE resource = ?');

const {
  refreshUserNormsByRow,
  resolveUserHandle,
  normalizeHandle,
  createUser,
  verifyLogin,
} = helpers;

const PRIVATE_IP_RE = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|::1$|fc00:|fd)/i;

// Returns true when the IP gives us no useful identity signal (internal/loopback/unset).
function isUnresolvableIp(ip) {
  if (!ip) return true;
  return /^(172\.|127\.|10\.|192\.168\.|::1$|::ffff:127\.|fc00:|fd)/i.test(ip);
}

function extractClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    for (const part of xff.split(',')) {
      const ip = part.trim();
      if (ip && !PRIVATE_IP_RE.test(ip)) return ip;
    }
  }
  return req.ip || req.socket?.remoteAddress || null;
}

function buildFingerprintHash(fields) {
  const str = [
    fields.userAgent || '',
    fields.acceptLanguage || '',
    fields.screenResolution || '',
    fields.timezone || '',
  ].join('|');
  if (str === '|||') return null; // No data at all — don't produce a matchable hash
  return crypto.createHash('sha256').update(str).digest('hex');
}

// Checks a connection's IP and fingerprint against the ban list; only a positive
// match on a present value can deny — missing data always passes through.
function checkBanForConnection(ip, fingerprintHash) {
  if (ip && checkBanByIp.get(ip)) return 'ip';
  if (fingerprintHash && checkBanByFingerprint.get(fingerprintHash)) return 'fingerprint';
  return null;
}

function logBanEnforcementDenial(username, ip, check) {
  console.log('[ban-enforcement] denied', { username: username || null, ip: ip || null, check });
}

function collectFingerprintFromReq(req, body) {
  const ip             = extractClientIp(req);
  const userAgent      = (req.headers['user-agent'] || '').slice(0, 512);
  const acceptLanguage = (req.headers['accept-language'] || '').slice(0, 128);
  const screenRes      = typeof body.screenResolution === 'string' ? body.screenResolution.slice(0, 32)  : null;
  const timezone       = typeof body.timezone         === 'string' ? body.timezone.slice(0, 64)          : null;
  const fpHash         = buildFingerprintHash({ userAgent, acceptLanguage, screenResolution: screenRes, timezone });
  return { ip, userAgent, acceptLanguage, screenResolution: screenRes, timezone, fpHash };
}

function pixelArtEmojiLookup(name){
  try { return getPixelArtEmoji.get(name) || null; } catch { return null; }
}

function sanitizeAndFormatDIS(text){
  return _sanitizeAndFormatDIS(text, pixelArtEmojiLookup);
}

function printDayDivider(batchApi, epochSec){
  const label = dayHeadingET(epochSec * 1000);
  batchApi.printHTML(`<span class="dim">── ${escapeHTML(label)} ──</span>`);
}

function makeAuthToken() {
  return crypto.randomBytes(32).toString('hex');
}

function base64UrlEncode(input) {
  return Buffer.from(input).toString('base64url');
}

function base64UrlDecode(input) {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function constantTimeEqual(a, b) {
  if (!Buffer.isBuffer(a)) a = Buffer.from(a);
  if (!Buffer.isBuffer(b)) b = Buffer.from(b);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function signAuthPayload(payload) {
  if (!SSO_SECRET) {
    throw new Error('SSO_SECRET is required to sign auth cookies');
  }
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', SSO_SECRET).update(body).digest();
  return `${body}.${signature.toString('base64url')}`;
}

function verifyAuthCookie(cookieValue) {
  if (!cookieValue || typeof cookieValue !== 'string') return null;
  const parts = cookieValue.split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  if (!body || !signature) return null;
  if (!SSO_SECRET) {
    throw new Error('SSO_SECRET is required to verify auth cookies');
  }
  let sigBuf;
  try {
    sigBuf = Buffer.from(signature, 'base64url');
  } catch (err) {
    return null;
  }
  const expected = crypto.createHmac('sha256', SSO_SECRET).update(body).digest();
  if (!constantTimeEqual(sigBuf, expected)) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(body));
    if (!payload || typeof payload.uid !== 'number' || typeof payload.u !== 'string') return null;
    return payload;
  } catch (err) {
    return null;
  }
}

function getCookie(req, name) {
  const header = req.headers && req.headers.cookie;
  if (!header) return null;
  const parts = header.split(';');
  for (const part of parts) {
    const [rawKey, ...rest] = part.split('=');
    if (!rawKey) continue;
    const key = rawKey.trim();
    if (key !== name) continue;
    return rest.join('=').trim();
  }
  return null;
}

const SSO_COOKIE_OPTIONS = {
  domain: '.disbbs.org',
  path: '/',
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  maxAge: 14 * 24 * 60 * 60 * 1000,
};

/* ======================= SVG Splash ======================= */
function splashSVG(){
  return [
    '<div class="svg-splash-wrap">',
    '<svg class="svg-splash" viewBox="0 0 1200 550" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Dead Internet Society">',
    '<defs>',
    '<linearGradient id="g1" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#19C3C3"/><stop offset="100%" stop-color="#CC66FF"/></linearGradient>',
    '<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>',
    '</defs>',
    '<rect width="1200" height="400" fill="#000"/>',
    '<rect x="30" y="30" width="1140" height="500" rx="8" ry="8" fill="none" stroke="url(#g1)" stroke-width="2"/>',
    '<g filter="url(#glow)" font-family="ui-monospace, Menlo, Consolas, monospace" font-weight="700" text-anchor="middle">',
    '<text x="600" y="260" font-size="84" fill="#f0f">DEAD INTERNET SOCIETY</text>',
    '</g>',
    '<g font-family="ui-monospace, Menlo, Consolas, monospace" text-anchor="middle">',
    '<text x="600" y="320" font-size="20" fill="#E6E6E6" opacity="0.9">no feeds • no infinite scroll • just people</text>',
    '<text x="600" y="352" font-size="16" fill="#19C3C3" opacity="0.9">punk-built • human-scale • honest connection</text>',
    '</g>',

    // Pride flag (left)
    '<g aria-label="Pride flag" transform="translate(360,490)">',
    '<rect x="0" y="0" width="96" height="30" rx="4" ry="4" fill="none" stroke="#222" stroke-width="1"/>',
    '<rect x="0" y="0"  width="96" height="5" fill="#E40303"/>',
    '<rect x="0" y="5" width="96" height="5" fill="#FF8C00"/>',
    '<rect x="0" y="10" width="96" height="5" fill="#FFED00"/>',
    '<rect x="0" y="15" width="96" height="5" fill="#008026"/>',
    '<rect x="0" y="20" width="96" height="5" fill="#004DFF"/>',
    '<rect x="0" y="25" width="96" height="5" fill="#750787"/>',
    '</g>',

    // Welcome text
    '<g font-family="ui-monospace, Menlo, Consolas, monospace" text-anchor="middle" aria-label="Welcome message">',
    '<text x="600" y="510" font-size="13" fill="#E6E6E6">You are loved.  You are welcome.</text>',
    '</g>',

    // Trans flag (right)
    '<g aria-label="Transgender flag" transform="translate(744,490)">',
    '<rect x="0" y="0" width="96" height="30" rx="4" ry="4" fill="none" stroke="#222" stroke-width="1"/>',
    '<rect x="0" y="0"  width="96" height="6" fill="#5BCEFA"/>',
    '<rect x="0" y="6" width="96" height="6" fill="#F5A9B8"/>',
    '<rect x="0" y="12" width="96" height="6" fill="#FFFFFF"/>',
    '<rect x="0" y="18" width="96" height="6" fill="#F5A9B8"/>',
    '<rect x="0" y="24" width="96" height="6" fill="#5BCEFA"/>',
    '</g>',

    '</svg>',
    '</div>'
  ].join('');
}

/* ======================= State / Router ======================= */
// NAWS-style column negotiation: legacy clients (and the brief window before
// a client's first naws/init cols arrives) never send cols, so 80 stays the
// universal default and existing behavior is unchanged.
const DEFAULT_COLS = 80;
const MIN_COLS = 28;
const MAX_COLS = 200;
const MENU_TWO_COL_THRESHOLD = 78;
function clampCols(v){
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  if (!Number.isInteger(n)) return null;
  return Math.max(MIN_COLS, Math.min(MAX_COLS, n));
}

function makeInitialState(){
  return {
    authenticated:false,
    username:null,
    currentScreen:'splash',
    login:{ step:'username', tempUser:'' },
    register:null,
    userId:null,
    isAdmin:false,
    userColor:null,
    displayName:null,
    currentTopicId:null,
    currentNewsId:null,
    cols:DEFAULT_COLS
  };
}

function resetState(state){
  if (!state) return;
  const cols = state.cols;
  const fresh = makeInitialState();
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, fresh);
  if (typeof cols === 'number') state.cols = cols;
}

function removeUserPresence(api, state, { broadcast = true } = {}){
  if (!state || !state.username) return null;

  const ws = api?.ws;
  const username = state.username;
  const sockets = HUB.socketsByUser.get(username);
  let fullyRemoved = false;

  if (sockets) {
    if (ws && sockets.has(ws)) sockets.delete(ws);
    if (!sockets.size) {
      HUB.socketsByUser.delete(username);
      fullyRemoved = true;
    }
  } else {
    fullyRemoved = true;
  }

  if (fullyRemoved) {
    HUB.online.delete(username);
    if (broadcast) broadcastSystem(`${username} left`);
    return username;
  }

  return null;
}
function routeGo(api, state, name){
  state.currentScreen = name;
  if (api && api.ws) api.ws.__ctx = { state };
  switch(name){
    case 'splash': return renderSplash(api, state);
    case 'menu':   return renderMenu(api, state);
    case 'chat':   return renderChat(api, state);
    case 'about':  return renderAbout(api, state);
    case 'rules':  return renderRules(api, state);
    case 'polls':   return renderPolls(api, state);
    default:       api.print('Unknown screen: '+name, 'red');
  }
}
function requireAuth(api, state){
  if (!state.authenticated){
    api.print('You must be logged in. Returning to login…', 'yellow');
    routeGo(api, state, 'splash');
    return false;
  }
  return true;
}


/* ======================= Splash (login/register) ======================= */
function renderSplash(api, state){
  api.batch(b=>{
    b.clear();
    b.printHTML(splashSVG());
    b.print('Enter username to log in', 'cyan');
    b.print('or type /register <user> <pass> to create a new account.', 'dim');
    b.setInputType('text', 'Username or /register');
    b.setInputLimit(null);
  });
  state.login.step='username'; state.login.tempUser='';
}
function splashHandleCommand(cmd, api){
  if (cmd==='help'){ api.hr(); api.print('Splash commands:', 'yellow'); api.print('  /help','cyan'); api.print('  /clear','cyan'); api.print('  /register <user> <pass>','cyan'); return true; }
  if (cmd==='clear'){ api.clear(); return true; }
  return false;
}
function splashHandleRaw(text, api, state){
  if (state.login.step==='username'){
    if (!text){ api.print('Please enter a username.', 'dim'); return true; }
    state.login.tempUser = text;
    api.print('Enter password:', 'cyan'); api.setInputType('password', 'Password'); api.setInputLimit(null); state.login.step='password'; return true;
  }
  if (state.login.step==='password'){
    const user = verifyLogin(state.login.tempUser, text);
    if (user) {
      state.authenticated = true;
      state.userId   = user.id;
      state.username = user.username; // canonical case
      state.isAdmin  = !!user.is_admin;
      const authToken = makeAuthToken();
      AUTH_TOKENS.set(authToken, {
        userId: state.userId,
        username: state.username,
        isAdmin: state.isAdmin,
        expMs: Date.now() + AUTH_TOKEN_TTL_MS,
      });
      if (api && api.ws) {
        sendOps(api.ws, [{ op: 'auth', token: authToken }]);
      }

      // ensure normalization columns are up-to-date for this user
    


      // pull color + display name
      const rc = getUserColor.get(state.userId);
      state.userColor = rc ? rc.preferred_color : null;
      const dnRow = getUserDisplay.get(state.userId);
      state.displayName = dnRow && dnRow.display_name ? dnRow.display_name : state.username;

      refreshUserNormsByRow({ id: state.userId, username: state.username, display_name: state.displayName });

      // presence
      HUB.online.add(state.username);
      if (!HUB.socketsByUser.has(state.username)) HUB.socketsByUser.set(state.username, new Set());
      HUB.socketsByUser.get(state.username).add(api.ws);
      broadcastSystem(`${state.username} joined`);

      api.setInputType('text', 'Type here… try /help');
      api.setInputLimit(null);
      api.print('Login successful.', 'green');

      routeGo(api, state, 'menu');
    } else {
      api.print('Invalid credentials. Try again.', 'red');
      state.login.step='username'; state.login.tempUser='';
      api.print('Enter username:', 'cyan'); api.setInputType('text','Username'); api.setInputLimit(null);
    }
    return true;
  }
  return true;
}

/* ======================= Help ======================= */
function cmdHelp(api, state){
  api.hr();
  api.print('Global slash commands:', 'yellow');
  //api.print('  /register  Create an account: /register <user> <pass>', 'cyan');
  api.print('  /chat      Enter the Commons Chat', 'cyan');
  api.print('  /here      Show who is currently in the chat', 'cyan');
  api.print('  /post <text>  Share a short status update (swept after ~30 days)', 'cyan');
  api.print('  /feed [user]  View recent updates (optionally for a user)', 'cyan');
  api.print('  /polls      Enter the poll booth', 'cyan');
  api.print('  /newpoll <question> | <opt1> | <opt2> ...  Create a poll (2-5 options)', 'cyan');
  api.print('  /vote <poll id> <option #>  Vote in a poll', 'cyan');
  api.print('  /endpoll <id>   End your poll (or admin)', 'cyan');
  api.print('  /removepoll <id> Remove your poll (or admin)', 'cyan');
  api.print('  /dm        Send a direct message: /dm <user> <message>', 'cyan');
  api.print('  /messages  Show your recent direct messages', 'cyan');
  api.print('  /leave     Return to the main menu from a room', 'cyan');
  api.print('  /about     About Dead Internet Society', 'cyan');
  api.print('  /passwd    Change your password: /passwd <old> <new>', 'cyan');
  api.print('  /format    Show DIS-Markdown examples', 'cyan');
  api.print('  /colors    Show color swatches', 'cyan');
  api.print('  /setcolor  Set your chat color', 'cyan');
  api.print('  /color     Show your current color', 'cyan');
  api.print('  /colorreset Reset your chat color', 'cyan');
  api.print('  /setdisplay <name>  Set your display name (markdown allowed)', 'cyan');
  api.print('  /display            Show your display name', 'cyan');
  api.print('  /displayreset       Reset display name to your username', 'cyan');
  api.print('  /whoami    Show current user', 'cyan');
  api.print('  /who       List users currently online', 'cyan');
  api.print('  /users [page]  List members (username, display, last login, online)', 'cyan');


  api.print('  /suggest   Add a suggestion: /suggest <text>', 'cyan');
  api.print('  /suggestions  View all current suggestions', 'cyan');
  api.print('  /aboutme <text>    Set your profile about text (or /aboutme clear)', 'cyan');
  api.print('  /profile [user]    View a member profile (omit to view your own)', 'cyan');
  api.print('  /announcements     View site announcements', 'cyan');
  api.print('  /main      Return to Command Hub', 'cyan');
  api.print('  /logout    Sign out', 'cyan');
  api.print('  /draw      Open the pixel art editor (16×16)', 'cyan');
  api.print('  /art       Browse the pixel art library', 'cyan');
  api.print('  /editart <name or id>    Edit your own pixel art', 'cyan');
  api.print('  /deleteart <name or id>  Delete pixel art (yours; admins can delete any)', 'cyan');
  api.print('  /synth      Open the synth — design a sound and play it live', 'cyan');
  api.print('  /synth <name or id>      Load a patch from the library to play/tweak', 'cyan');
  api.print('  /patches    Browse the synth patch library', 'cyan');
  api.print('  /editpatch <name or id>    Edit your own synth patch', 'cyan');
  api.print('  /deletepatch <name or id>  Delete a synth patch (yours; admins can delete any)', 'cyan');
  api.print('  /tracker    Open the tracker — sequence patches into a 32-step song', 'cyan');
  api.print('  /tracker <name or id>    Load a song from the library to play/tweak', 'cyan');
  api.print('  /songs      Browse the song library', 'cyan');
  api.print('  /editsong <name or id>    Edit your own song', 'cyan');
  api.print('  /deletesong <name or id>  Delete a song (yours; admins can delete any)', 'cyan');
  api.print('  /games        Games menu', 'cyan');
  api.print('  /wordle       Daily word puzzle — same word for everyone, resets at midnight ET', 'cyan');
  api.print('  /wordle stats Leaderboard and today\'s results', 'cyan');
  api.print('  /slots        Nickel slots — 5 ₢ per spin', 'cyan');
  api.print('  /slots stats  Your slots statistics', 'cyan');
  api.print('  /blackjack    Simplified blackjack — bet ₢ against the house', 'cyan');
  api.print('  /blackjack stats  Your blackjack statistics', 'cyan');
  api.print('  /hack     daily terminal crack  •  new terminal every day', 'cyan');
  api.print('  /dots    community dots & boxes — draw lines, claim squares, earn ₢', 'cyan');
  api.print('  /donate       Support DIS — progress, top donors, how to donate', 'cyan');
  api.print('  /activity     Recent activity across DIS — games, community, chrome', 'cyan');
  api.print('  /chrome       Your chrome balance, transactions, and leaderboard', 'cyan');
  api.print('  /wallet [user]  Look up another user\'s chrome balance and rank', 'cyan');
  api.print('  /mining         Dig for resources in today\'s shared grid', 'cyan');
  api.print('  /market         Browse resource prices and your inventory', 'cyan');
  api.print('  /sell [resource] [amount]   Sell resources for chrome', 'cyan');
  api.print('  /buy  [resource] [amount]   Buy resources with chrome', 'cyan');
  api.print('  /rob  [user] [resource]     Steal chrome using a mined resource as bait', 'cyan');
  api.print('  /grind   earn 1 ₢. it\'s not much, but it\'s honest work.', 'cyan');
  api.print('  /graffiti   The shared graffiti wall — draw anything', 'cyan');

  if (state && state.isAdmin){
    api.hr(); api.print('Admin:', 'yellow');
    api.print('  /removesuggestion <#>  Remove a suggestion (from the current list)', 'cyan');
    api.print('  /retention <area> <days>   Set auto-delete retention (board/links/messages/posts/users)', 'cyan');
    api.print('  /adminchat   Admin live room (private)', 'cyan');
    api.print('  /announce <text>             Post a new announcement', 'cyan');
    api.print('  /removeannounce <id>         Remove an announcement', 'cyan');
    api.print('  /pinannounce <id>            Pin an announcement to /main (or /pinannounce clear)', 'cyan');
    api.print('  /newusers [n]                Most recent registrations with ban-list match check (default 20, max 50)', 'cyan');
    api.print('  /rejections                  Last 20 blocked registration attempts (no valid IP + incomplete fingerprint)', 'cyan');
    api.print('  /ban <username>              Ban user (deletes content, blocks IP + fingerprint)', 'cyan');
    api.print('  /banlist                     Show all ban list entries', 'cyan');
    api.print('  /unban <id>                  Remove a ban list entry by id', 'cyan');
    api.print('  /bannote <id> <text>         Add/update a note on a ban entry', 'cyan');
    api.print('  /checkuser <username>        Show fingerprint info + ban list matches for a user', 'cyan');
    api.print('  /purgeactivity <username>    Remove all activity feed entries mentioning a user', 'cyan');
    api.print('  /donations                   Recent donations with chrome awarded', 'cyan');
    api.print('  /linkdonor <kofi> <dis>      Link a Ko-fi name to a DIS account (retroactive award)', 'cyan');
    api.print('  /unlinkdonor <kofi>          Remove a Ko-fi name link', 'cyan');
  }
  api.hr();
  api.print('DIS-Markdown: **bold**, _italics_, __underline__, [dim]…[/dim], and color tags like [cyan]…[/cyan].', 'dim');
}


/* ======================= Pixel Art ======================= */
function isValidPixelColor(v){
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
}

function cmdDraw(api, state){
  if (!requireAuth(api, state)) return;
  sendOps(api.ws, [{ op: 'openPixelEditor' }]);
}

function cmdGraffiti(api, state) {
  if (!requireAuth(api, state)) return;
  sendOps(api.ws, [{ op: 'openGraffiti' }]);
}

function cmdArt(api, state, args){
  if (!requireAuth(api, state)) return;
  const rows = listPixelArt.all();
  api.batch(b => {
    b.clear();
    b.setInputLimit(null);
    b.hrTitled('Pixel Art Library');
    if (!rows.length){
      b.print('No pixel art yet. Use /draw to create some.', 'dim');
    } else {
      rows.forEach(r => {
        let data;
        try { data = JSON.parse(r.pixel_data); } catch { data = null; }
        if (!Array.isArray(data) || data.length !== 256) data = new Array(256).fill(null);
        const pixelsAttr = escapeHTML(JSON.stringify(data));
        b.printHTML(
          `<canvas class="pxa-thumb" width="32" height="32" data-pixels="${pixelsAttr}"></canvas> ` +
          `<span class="cyan">${escapeHTML(r.name)}</span> ` +
          `<span class="yellow">(#${escapeHTML(String(r.id))})</span> ` +
          `<span class="dim">by ${escapeHTML(r.creator_username)}</span>`
        );
      });
      b.hr();
      b.print('Create new: /draw  |  Edit your art: /editart <name or id>  |  Delete your art: /deleteart <name or id>', 'dim');
    }
  });
}

function handleSavePixelArt(saveMsg, api, state){
  if (!requireAuth(api, state)) return;
  const rawName = String(saveMsg.name || '').trim().toLowerCase();
  if (!rawName || !/^[a-z0-9-]{1,32}$/.test(rawName)){
    api.print('Invalid name. Use lowercase letters, numbers, and hyphens only (max 32 chars).', 'red');
    return;
  }
  const pixelData = saveMsg.pixel_data;
  if (!Array.isArray(pixelData) || pixelData.length !== 256){
    api.print('Invalid pixel data.', 'red');
    return;
  }
  for (const v of pixelData){
    if (v !== null && !isValidPixelColor(v)){
      api.print('Invalid pixel data: bad color value.', 'red');
      return;
    }
  }
  try {
    insertPixelArt.run(rawName, state.username, JSON.stringify(pixelData), nowEpoch());
    api.print(`Saved "${rawName}". View with: /art ${rawName}`, 'green');
  } catch(e){
    const emsg = (e && e.message) || '';
    if (emsg.toLowerCase().includes('unique')){
      api.print(`A piece named "${rawName}" already exists. Choose a different name.`, 'red');
    } else {
      console.error('Failed to save pixel art:', e);
      api.print('Failed to save pixel art.', 'red');
    }
  }
}

function findPixelArtByNameOrId(nameOrId){
  const trimmed = String(nameOrId || '').trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)){
    const row = getPixelArtById.get(parseInt(trimmed, 10));
    if (row) return row;
  }
  return getPixelArtByName.get(trimmed.toLowerCase()) || null;
}

function cmdEditArt(api, state, args){
  if (!requireAuth(api, state)) return;
  if (!args.length){ api.print('Usage: /editart <name or id>', 'yellow'); return; }
  const row = findPixelArtByNameOrId(args.join(' '));
  if (!row){ api.print('No art found with that name or id.', 'red'); return; }
  if (row.creator_username.toLowerCase() !== state.username.toLowerCase()){
    api.print('You can only edit your own art.', 'red'); return;
  }
  let pixelData;
  try { pixelData = typeof row.pixel_data === 'string' ? JSON.parse(row.pixel_data) : row.pixel_data; } catch { pixelData = null; }
  if (!Array.isArray(pixelData) || pixelData.length !== 256) pixelData = new Array(256).fill(null);
  sendOps(api.ws, [{ op: 'openPixelEditor', id: row.id, name: row.name, pixel_data: pixelData }]);
}

function cmdDeleteArt(api, state, args){
  if (!requireAuth(api, state)) return;
  if (!args.length){ api.print('Usage: /deleteart <name or id>', 'yellow'); return; }
  const row = findPixelArtByNameOrId(args.join(' '));
  if (!row){ api.print('No art found with that name or id.', 'red'); return; }
  if (row.creator_username.toLowerCase() !== state.username.toLowerCase() && !state.isAdmin){
    api.print('You can only delete your own art.', 'red'); return;
  }
  deletePixelArt.run(row.id);
  api.print(`Art "${row.name}" (#${row.id}) deleted.`, 'green');
}

function handleUpdatePixelArt(msg, api, state){
  if (!requireAuth(api, state)) return;
  const id = parseInt(msg.id, 10);
  if (!id || isNaN(id)){ api.print('Invalid art id.', 'red'); return; }
  const existing = getPixelArtById.get(id);
  if (!existing){ api.print('No art found with that id.', 'red'); return; }
  if (existing.creator_username.toLowerCase() !== state.username.toLowerCase()){
    api.print('You can only edit your own art.', 'red'); return;
  }
  const rawName = String(msg.name || '').trim().toLowerCase();
  if (!rawName || !/^[a-z0-9-]{1,32}$/.test(rawName)){
    api.print('Invalid name. Use lowercase letters, numbers, and hyphens only (max 32 chars).', 'red'); return;
  }
  const pixelData = msg.pixel_data;
  if (!Array.isArray(pixelData) || pixelData.length !== 256){
    api.print('Invalid pixel data.', 'red'); return;
  }
  for (const v of pixelData){
    if (v !== null && !isValidPixelColor(v)){
      api.print('Invalid pixel data: bad color value.', 'red'); return;
    }
  }
  const conflict = getPixelArtByName.get(rawName);
  if (conflict && conflict.id !== id){
    api.print(`A piece named "${rawName}" already exists. Choose a different name.`, 'red'); return;
  }
  try {
    updatePixelArt.run(rawName, JSON.stringify(pixelData), id);
    api.print('Art updated successfully.', 'green');
  } catch(e){
    console.error('Failed to update pixel art:', e);
    api.print('Failed to update pixel art.', 'red');
  }
}

/* ======================= Synth ======================= */
const SYNTH_WAVEFORMS      = ['sine', 'triangle', 'sawtooth', 'square'];
const SYNTH_FILTER_TYPES   = ['lowpass', 'highpass', 'bandpass'];
const SYNTH_MOD_DESTS      = ['filter', 'pitch', 'off'];
const SYNTH_LFO_DESTS      = ['pitch', 'filter', 'amp', 'off'];
const SYNTH_MAX_BYTES      = 2048;

// [min, max, isInteger]
const SYNTH_NUMERIC_FIELDS = {
  osc1_coarse:    [-24, 24, true],
  osc1_fine:      [-100, 100, false],
  osc1_level:     [0, 1, false],
  osc2_coarse:    [-24, 24, true],
  osc2_fine:      [-100, 100, false],
  osc2_level:     [0, 1, false],
  noise_level:    [0, 1, false],
  filter_cutoff:  [0, 1, false],
  filter_res:     [0, 1, false],
  filter_env_amt: [-1, 1, false],
  amp_a:          [0.001, 4, false],
  amp_d:          [0.001, 4, false],
  amp_s:          [0, 1, false],
  amp_r:          [0.001, 8, false],
  mod_a:          [0.001, 4, false],
  mod_d:          [0.001, 4, false],
  mod_amt:        [-1, 1, false],
  lfo_rate:       [0, 1, false],
  lfo_depth:      [0, 1, false],
  drive:          [0, 1, false],
  delay_send:     [0, 1, false],
  delay_time:     [0.05, 1, false],
  delay_fb:       [0, 0.85, false], // hard cap: feedback >= 1.0 is a volume runaway
  volume:         [0, 1, false],
};

const SYNTH_ENUM_FIELDS = {
  osc1_wave:   SYNTH_WAVEFORMS,
  osc2_wave:   SYNTH_WAVEFORMS,
  filter_type: SYNTH_FILTER_TYPES,
  mod_dest:    SYNTH_MOD_DESTS,
  lfo_wave:    SYNTH_WAVEFORMS,
  lfo_dest:    SYNTH_LFO_DESTS,
};

const SYNTH_ALLOWED_KEYS = ['v', ...Object.keys(SYNTH_NUMERIC_FIELDS), ...Object.keys(SYNTH_ENUM_FIELDS)];

// Returns a cleaned/clamped patch object, or null if the payload is malformed.
// Patch data is re-served to other users' browsers, so this is the single point
// of trust for anything coming off the wire.
function validatePatch(obj){
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  let raw;
  try { raw = JSON.stringify(obj); } catch { return null; }
  if (raw.length > SYNTH_MAX_BYTES) return null;
  if (obj.v !== 1) return null;

  for (const k of Object.keys(obj)) if (!SYNTH_ALLOWED_KEYS.includes(k)) return null;
  for (const k of SYNTH_ALLOWED_KEYS) if (!(k in obj)) return null;

  const out = { v: 1 };

  for (const [key, allowed] of Object.entries(SYNTH_ENUM_FIELDS)){
    if (typeof obj[key] !== 'string' || !allowed.includes(obj[key])) return null;
    out[key] = obj[key];
  }

  for (const [key, [min, max, isInt]] of Object.entries(SYNTH_NUMERIC_FIELDS)){
    const v = obj[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    let clamped = Math.min(max, Math.max(min, v));
    if (isInt) clamped = Math.round(clamped);
    out[key] = clamped;
  }

  return out;
}

function findSynthPatchByNameOrId(nameOrId){
  const trimmed = String(nameOrId || '').trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)){
    const row = getSynthPatchById.get(parseInt(trimmed, 10));
    if (row) return row;
  }
  return getSynthPatchByName.get(trimmed.toLowerCase()) || null;
}

function cmdSynth(api, state, args){
  if (!requireAuth(api, state)) return;
  if (!args.length){
    sendOps(api.ws, [{ op: 'openSynth' }]);
    return;
  }
  const row = findSynthPatchByNameOrId(args.join(' '));
  if (!row){ api.print('No patch found with that name or id.', 'red'); return; }
  let patchData;
  try { patchData = JSON.parse(row.patch_data); } catch { patchData = null; }
  const cleaned = validatePatch(patchData);
  if (!cleaned){ api.print('That patch is corrupted and cannot be loaded.', 'red'); return; }
  const owned = row.creator_username.toLowerCase() === state.username.toLowerCase();
  sendOps(api.ws, [{ op: 'openSynth', id: row.id, name: row.name, patch_data: cleaned, creator: row.creator_username, owned: owned, editMode: false }]);
}

function cmdPatches(api, state){
  if (!requireAuth(api, state)) return;
  const rows = listSynthPatches.all();
  api.batch(b => {
    b.clear();
    b.setInputLimit(null);
    b.print('── PATCH LIBRARY ────────────────────────────────', 'magenta');
    if (!rows.length){
      b.print('No patches yet. Use /synth to design one.', 'dim');
    } else {
      rows.forEach(r => {
        const nameCol = r.name.length >= 16 ? r.name.slice(0, 16) : r.name.padEnd(16);
        const byCol   = ('by ' + r.creator_username).padEnd(18);
        b.print(`  ${nameCol} ${byCol}${relativeTime(r.created_at)}`, 'cyan');
      });
      b.hr();
      b.print('Use /synth <name> to play one. /editpatch <name> to edit yours.', 'dim');
    }
  });
}

function cmdEditPatch(api, state, args){
  if (!requireAuth(api, state)) return;
  if (!args.length){ api.print('Usage: /editpatch <name or id>', 'yellow'); return; }
  const row = findSynthPatchByNameOrId(args.join(' '));
  if (!row){ api.print('No patch found with that name or id.', 'red'); return; }
  if (row.creator_username.toLowerCase() !== state.username.toLowerCase() && !state.isAdmin){
    api.print('You can only edit your own patch.', 'red'); return;
  }
  let patchData;
  try { patchData = JSON.parse(row.patch_data); } catch { patchData = null; }
  const cleaned = validatePatch(patchData);
  if (!cleaned){ api.print('That patch is corrupted and cannot be loaded.', 'red'); return; }
  const owned = row.creator_username.toLowerCase() === state.username.toLowerCase();
  sendOps(api.ws, [{ op: 'openSynth', id: row.id, name: row.name, patch_data: cleaned, creator: row.creator_username, owned: owned, editMode: true }]);
}

function cmdDeletePatch(api, state, args){
  if (!requireAuth(api, state)) return;
  if (!args.length){ api.print('Usage: /deletepatch <name or id>', 'yellow'); return; }
  const row = findSynthPatchByNameOrId(args.join(' '));
  if (!row){ api.print('No patch found with that name or id.', 'red'); return; }
  if (row.creator_username.toLowerCase() !== state.username.toLowerCase() && !state.isAdmin){
    api.print('You can only delete your own patch.', 'red'); return;
  }
  deleteSynthPatch.run(row.id);
  api.print(`Patch "${row.name}" (#${row.id}) deleted.`, 'green');
}

function handleSavePatch(msg, api, state){
  if (!requireAuth(api, state)) return;
  const rawName = String(msg.name || '').trim().toLowerCase();
  if (!rawName || !/^[a-z0-9-]{1,32}$/.test(rawName)){
    sendOps(api.ws, [{ op: 'synth_error', message: 'Invalid name. Use lowercase letters, numbers, and hyphens only (max 32 chars).' }]);
    return;
  }
  const cleaned = validatePatch(msg.patch_data);
  if (!cleaned){
    sendOps(api.ws, [{ op: 'synth_error', message: 'Invalid patch data.' }]);
    return;
  }
  try {
    const info = insertSynthPatch.run(rawName, state.username, JSON.stringify(cleaned), nowEpoch());
    sendOps(api.ws, [{ op: 'synth_saved', id: info.lastInsertRowid, name: rawName }]);
    addActivityEvent('community', 'synth_patch', `🎛 ${state.username} designed a new sound: ${rawName}`);
  } catch(e){
    const emsg = (e && e.message) || '';
    if (emsg.toLowerCase().includes('unique')){
      sendOps(api.ws, [{ op: 'synth_error', message: `A patch named "${rawName}" already exists. Choose a different name.` }]);
    } else {
      console.error('Failed to save synth patch:', e);
      sendOps(api.ws, [{ op: 'synth_error', message: 'Failed to save patch.' }]);
    }
  }
}

function handleUpdatePatch(msg, api, state){
  if (!requireAuth(api, state)) return;
  const id = parseInt(msg.id, 10);
  if (!id || isNaN(id)){
    sendOps(api.ws, [{ op: 'synth_error', message: 'Invalid patch id.' }]);
    return;
  }
  const existing = getSynthPatchById.get(id);
  if (!existing){
    sendOps(api.ws, [{ op: 'synth_error', message: 'No patch found with that id.' }]);
    return;
  }
  if (existing.creator_username.toLowerCase() !== state.username.toLowerCase() && !state.isAdmin){
    sendOps(api.ws, [{ op: 'synth_error', message: 'You can only edit your own patch.' }]);
    return;
  }
  const rawName = String(msg.name || '').trim().toLowerCase();
  if (!rawName || !/^[a-z0-9-]{1,32}$/.test(rawName)){
    sendOps(api.ws, [{ op: 'synth_error', message: 'Invalid name. Use lowercase letters, numbers, and hyphens only (max 32 chars).' }]);
    return;
  }
  const cleaned = validatePatch(msg.patch_data);
  if (!cleaned){
    sendOps(api.ws, [{ op: 'synth_error', message: 'Invalid patch data.' }]);
    return;
  }
  const conflict = getSynthPatchByName.get(rawName);
  if (conflict && conflict.id !== id){
    sendOps(api.ws, [{ op: 'synth_error', message: `A patch named "${rawName}" already exists. Choose a different name.` }]);
    return;
  }
  try {
    updateSynthPatch.run(rawName, JSON.stringify(cleaned), id);
    sendOps(api.ws, [{ op: 'synth_saved', id: id, name: rawName }]);
  } catch(e){
    console.error('Failed to update synth patch:', e);
    sendOps(api.ws, [{ op: 'synth_error', message: 'Failed to update patch.' }]);
  }
}

function handleGetPatchList(msg, api, state){
  if (!requireAuth(api, state)) return;
  const rows = listSynthPatchesWithData.all();
  const patches = [];
  for (const r of rows){
    let patchData;
    try { patchData = JSON.parse(r.patch_data); } catch { patchData = null; }
    const cleaned = validatePatch(patchData);
    if (!cleaned) continue; // skip corrupted library entries defensively
    patches.push({ id: r.id, name: r.name, creator: r.creator_username, patch_data: cleaned });
  }
  sendOps(api.ws, [{ op: 'patch_list', patches: patches }]);
}

/* ======================= Tracker ======================= */
const TRACKER_STEPS       = 32;
const TRACKER_TRACK_COUNT = 4;
const TRACKER_MAX_BYTES   = 16384;
const TRACKER_BPM_MIN     = 40;
const TRACKER_BPM_MAX     = 300;
const TRACKER_MIDI_MIN    = 12;
const TRACKER_MIDI_MAX    = 107;

// Reuses validatePatch for every embedded patch snapshot — one point of trust,
// same as the synth feature, since song data is re-served to other users' browsers.
function validateSong(obj){
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  let raw;
  try { raw = JSON.stringify(obj); } catch { return null; }
  if (raw.length > TRACKER_MAX_BYTES) return null;

  const allowedTopKeys = ['v', 'bpm', 'steps', 'tracks'];
  for (const k of Object.keys(obj)) if (!allowedTopKeys.includes(k)) return null;
  for (const k of allowedTopKeys) if (!(k in obj)) return null;

  if (obj.v !== 1) return null;
  if (obj.steps !== TRACKER_STEPS) return null;
  if (typeof obj.bpm !== 'number' || !Number.isFinite(obj.bpm)) return null;
  const bpm = Math.round(Math.min(TRACKER_BPM_MAX, Math.max(TRACKER_BPM_MIN, obj.bpm)));

  if (!Array.isArray(obj.tracks) || obj.tracks.length !== TRACKER_TRACK_COUNT) return null;

  const tracks = [];
  for (const t of obj.tracks){
    if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
    const allowedTrackKeys = ['patch_name', 'patch', 'cells'];
    for (const k of Object.keys(t)) if (!allowedTrackKeys.includes(k)) return null;
    for (const k of allowedTrackKeys) if (!(k in t)) return null;

    if (typeof t.patch_name !== 'string') return null;
    const patchName = t.patch_name.trim().slice(0, 32);

    const patch = validatePatch(t.patch);
    if (!patch) return null;

    if (!Array.isArray(t.cells) || t.cells.length !== TRACKER_STEPS) return null;
    const cells = [];
    for (const c of t.cells){
      if (c === null){ cells.push(null); continue; }
      if (typeof c !== 'number' || !Number.isFinite(c)) return null;
      cells.push(Math.round(Math.min(TRACKER_MIDI_MAX, Math.max(TRACKER_MIDI_MIN, c))));
    }
    tracks.push({ patch_name: patchName, patch: patch, cells: cells });
  }

  return { v: 1, bpm: bpm, steps: TRACKER_STEPS, tracks: tracks };
}

function findTrackerSongByNameOrId(nameOrId){
  const trimmed = String(nameOrId || '').trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)){
    const row = getTrackerSongById.get(parseInt(trimmed, 10));
    if (row) return row;
  }
  return getTrackerSongByName.get(trimmed.toLowerCase()) || null;
}

function cmdTracker(api, state, args){
  if (!requireAuth(api, state)) return;
  if (!args.length){
    sendOps(api.ws, [{ op: 'openTracker' }]);
    return;
  }
  const row = findTrackerSongByNameOrId(args.join(' '));
  if (!row){ api.print('No song found with that name or id.', 'red'); return; }
  let songData;
  try { songData = JSON.parse(row.song_data); } catch { songData = null; }
  const cleaned = validateSong(songData);
  if (!cleaned){ api.print('That song is corrupted and cannot be loaded.', 'red'); return; }
  const owned = row.creator_username.toLowerCase() === state.username.toLowerCase();
  sendOps(api.ws, [{ op: 'openTracker', id: row.id, name: row.name, song_data: cleaned, creator: row.creator_username, owned: owned, editMode: false }]);
}

function cmdSongs(api, state){
  if (!requireAuth(api, state)) return;
  const rows = listTrackerSongs.all();
  api.batch(b => {
    b.clear();
    b.setInputLimit(null);
    b.print('── SONG LIBRARY ─────────────────────────────────', 'magenta');
    if (!rows.length){
      b.print('No songs yet. Use /tracker to compose one.', 'dim');
    } else {
      rows.forEach(r => {
        const nameCol = r.name.length >= 18 ? r.name.slice(0, 18) : r.name.padEnd(18);
        const byCol   = ('by ' + r.creator_username).padEnd(18);
        b.print(`  ${nameCol} ${byCol}${relativeTime(r.created_at)}`, 'cyan');
      });
      b.hr();
      b.print('Use /tracker <name> to play one. /editsong <name> to edit yours.', 'dim');
    }
  });
}

function cmdEditSong(api, state, args){
  if (!requireAuth(api, state)) return;
  if (!args.length){ api.print('Usage: /editsong <name or id>', 'yellow'); return; }
  const row = findTrackerSongByNameOrId(args.join(' '));
  if (!row){ api.print('No song found with that name or id.', 'red'); return; }
  if (row.creator_username.toLowerCase() !== state.username.toLowerCase() && !state.isAdmin){
    api.print('You can only edit your own song.', 'red'); return;
  }
  let songData;
  try { songData = JSON.parse(row.song_data); } catch { songData = null; }
  const cleaned = validateSong(songData);
  if (!cleaned){ api.print('That song is corrupted and cannot be loaded.', 'red'); return; }
  const owned = row.creator_username.toLowerCase() === state.username.toLowerCase();
  sendOps(api.ws, [{ op: 'openTracker', id: row.id, name: row.name, song_data: cleaned, creator: row.creator_username, owned: owned, editMode: true }]);
}

function cmdDeleteSong(api, state, args){
  if (!requireAuth(api, state)) return;
  if (!args.length){ api.print('Usage: /deletesong <name or id>', 'yellow'); return; }
  const row = findTrackerSongByNameOrId(args.join(' '));
  if (!row){ api.print('No song found with that name or id.', 'red'); return; }
  if (row.creator_username.toLowerCase() !== state.username.toLowerCase() && !state.isAdmin){
    api.print('You can only delete your own song.', 'red'); return;
  }
  deleteTrackerSong.run(row.id);
  api.print(`Song "${row.name}" (#${row.id}) deleted.`, 'green');
}

function handleSaveSong(msg, api, state){
  if (!requireAuth(api, state)) return;
  const rawName = String(msg.name || '').trim().toLowerCase();
  if (!rawName || !/^[a-z0-9-]{1,32}$/.test(rawName)){
    sendOps(api.ws, [{ op: 'tracker_error', message: 'Invalid name. Use lowercase letters, numbers, and hyphens only (max 32 chars).' }]);
    return;
  }
  const cleaned = validateSong(msg.song_data);
  if (!cleaned){
    sendOps(api.ws, [{ op: 'tracker_error', message: 'Invalid song data.' }]);
    return;
  }
  try {
    const info = insertTrackerSong.run(rawName, state.username, JSON.stringify(cleaned), nowEpoch());
    sendOps(api.ws, [{ op: 'tracker_saved', id: info.lastInsertRowid, name: rawName }]);
    addActivityEvent('community', 'tracker_song', `🎶 ${state.username} composed a new track: ${rawName}`);
  } catch(e){
    const emsg = (e && e.message) || '';
    if (emsg.toLowerCase().includes('unique')){
      sendOps(api.ws, [{ op: 'tracker_error', message: `A song named "${rawName}" already exists. Choose a different name.` }]);
    } else {
      console.error('Failed to save tracker song:', e);
      sendOps(api.ws, [{ op: 'tracker_error', message: 'Failed to save song.' }]);
    }
  }
}

function handleUpdateSong(msg, api, state){
  if (!requireAuth(api, state)) return;
  const id = parseInt(msg.id, 10);
  if (!id || isNaN(id)){
    sendOps(api.ws, [{ op: 'tracker_error', message: 'Invalid song id.' }]);
    return;
  }
  const existing = getTrackerSongById.get(id);
  if (!existing){
    sendOps(api.ws, [{ op: 'tracker_error', message: 'No song found with that id.' }]);
    return;
  }
  if (existing.creator_username.toLowerCase() !== state.username.toLowerCase() && !state.isAdmin){
    sendOps(api.ws, [{ op: 'tracker_error', message: 'You can only edit your own song.' }]);
    return;
  }
  const rawName = String(msg.name || '').trim().toLowerCase();
  if (!rawName || !/^[a-z0-9-]{1,32}$/.test(rawName)){
    sendOps(api.ws, [{ op: 'tracker_error', message: 'Invalid name. Use lowercase letters, numbers, and hyphens only (max 32 chars).' }]);
    return;
  }
  const cleaned = validateSong(msg.song_data);
  if (!cleaned){
    sendOps(api.ws, [{ op: 'tracker_error', message: 'Invalid song data.' }]);
    return;
  }
  const conflict = getTrackerSongByName.get(rawName);
  if (conflict && conflict.id !== id){
    sendOps(api.ws, [{ op: 'tracker_error', message: `A song named "${rawName}" already exists. Choose a different name.` }]);
    return;
  }
  try {
    updateTrackerSong.run(rawName, JSON.stringify(cleaned), id);
    sendOps(api.ws, [{ op: 'tracker_saved', id: id, name: rawName }]);
  } catch(e){
    console.error('Failed to update tracker song:', e);
    sendOps(api.ws, [{ op: 'tracker_error', message: 'Failed to update song.' }]);
  }
}

/* ======================= Menu ======================= */
function renderMenu(api, state){
  if (!requireAuth(api, state)) return;

  const now = nowEpoch();
  const uid = state.userId;
  const uname = state.username;

  // Read previous last_seen_at, then immediately stamp now so it's set even if something throws below.
  const seenRow  = getLastSeenAt.get(uid);
  const prevSeen = seenRow ? (seenRow.last_seen_at || null) : null;
  setLastSeenAt.run(now, uid);

  // Compute "what's new" only when there's a previous timestamp (null = first visit).
  let newItems = null;
  if (prevSeen) {
    try {
      const boardTopics   = countNewBoardTopics.get(prevSeen, uid).n;
      const boardComments = countNewBoardComments.get(prevSeen, uid).n;
      const boardTotal    = boardTopics + boardComments;
      const newLinks      = countNewLinkPosts.get(prevSeen, uid).n;
      const newPolls      = countNewPolls.get(prevSeen, uid).n;
      const newVotes      = countNewVotesOnUserPolls.get(prevSeen, uid, uid).n;
      const newStatus     = countNewStatusPosts.get(prevSeen, uid).n;
      const newArt        = countNewPixelArt.get(prevSeen, uname).n;
      const unreadDMs     = countUnreadDMs.get(uid)?.count || 0;
      if (boardTotal || newLinks || newPolls || newVotes || newStatus || newArt || unreadDMs) {
        newItems = { boardTotal, newLinks, newPolls, newVotes, newStatus, newArt, unreadDMs };
      }
    } catch (e) {
      console.error('[renderMenu] whats-new query failed:', e && e.message);
    }
  }

  const unreadCount = newItems ? newItems.unreadDMs : (countUnreadDMs.get(uid)?.count || 0);

  let chromeDailyMsg = null;
  let chromeStiMsg = null;
  try {
    const daily = chrome.getDailyBonus(uname);
    if (daily.awarded) {
      chromeDailyMsg = `daily bonus: +${daily.amount} ₢  •  balance: ${fmtCr(daily.newBalance)} ₢`;
    }
    const stipend = chrome.checkStipend(uname);
    if (stipend.awarded) {
      chromeStiMsg = `daily stipend: +${stipend.amount} ₢  •  balance: ${fmtCr(stipend.newBalance)} ₢`;
    }
  } catch (e) {
    console.error('[renderMenu] chrome daily check failed:', e && e.message);
  }

  api.batch(b=>{
    b.clear();
    b.setInputLimit(null);
    b.printHTML('<div class="banner"><div class="line term-titlebar-text">DEADNET</div><div class="line dim">(C) 1997-∞ DEAD INTERNET SOCIETY</div><div class="line dim">type a /command to launch something.</div></div>');
    if (unreadCount > 0) {
      const label = unreadCount === 1 ? 'message' : 'messages';
      b.printHTML(`<span class="main-alert">!! NEW DIRECT MESSAGES: ${unreadCount} unread ${label}. !!</span>`);
    }
    if (chromeDailyMsg) b.print(chromeDailyMsg, 'yellow');
    if (chromeStiMsg)   b.print(chromeStiMsg, 'yellow');
    if (newItems) {
      b.print('── since your last visit ──', 'dim');
      const pl = (n, word) => `${n} ${word}${n !== 1 ? 's' : ''}`;
      if (newItems.boardTotal) b.print(`  ${pl(newItems.boardTotal, 'new board post')}`, 'cyan');
      if (newItems.newLinks)   b.print(`  ${pl(newItems.newLinks,   'new link')}`, 'cyan');
      if (newItems.newPolls)   b.print(`  ${pl(newItems.newPolls,   'new poll')}`, 'cyan');
      if (newItems.newVotes)   b.print(`  ${pl(newItems.newVotes,   'new vote')} on your polls`, 'cyan');
      if (newItems.newStatus)  b.print(`  ${pl(newItems.newStatus,  'new status post')}`, 'cyan');
      if (newItems.newArt)     b.print(`  ${pl(newItems.newArt,     'new pixel art')}`, 'cyan');
      if (newItems.unreadDMs)  b.print(`  ${pl(newItems.unreadDMs,  'unread direct message')}`, 'yellow');
    }
    {
      const progLeft = [
        ['/chat', 'Commons Chat'],
        ['/messages', 'Direct messages'],
        ['/feed [user]', 'Community updates'],
        ['/board', 'Bulletin board'],
        ['/links', 'Link share'],
        ['/polls', 'Poll booth'],
        ['/art', 'Pixel art library'],
        ['/graffiti', 'Shared graffiti wall'],
        ['/games', 'Launch a game'],
      ];
      const progRight = [
        ['/chrome', 'Balance & transactions'],
        ['/mining', 'Dig for resources'],
        ['/market', 'Prices & inventory'],
        ['/activity', 'Site activity'],
        ['/profile', 'Your profile'],
        ['/announcements', 'Sysop announcements'],
        ['/suggestions', 'Bugs & feature ideas'],
        ['/about', 'About DIS'],
      ];
      const padTo = (s, n) => s + ' '.repeat(Math.max(1, n - s.length));
      const cols = clampCols(state.cols) || DEFAULT_COLS;
      const rows = [];
      let boxWidth;
      if (cols >= MENU_TWO_COL_THRESHOLD) {
        // Enough columns for the classic two-pair layout — keep it at its
        // designed width of 80 even if cols is a couple chars short (78-79);
        // .frame-line's overflow-x:auto is the fallback for that sliver.
        const CMD_W1 = 15, DESC_W1 = 22, CMD_W2 = 17;
        boxWidth = 80;
        for (let i = 0; i < progLeft.length; i++) {
          const [lc, ld] = progLeft[i];
          const right = progRight[i];
          const segs = [
            { text: padTo(lc, CMD_W1), cls: 'menu-cmd' },
            { text: padTo(ld, DESC_W1), cls: 'menu-desc' },
          ];
          if (right) {
            segs.push({ text: padTo(right[0], CMD_W2), cls: 'menu-cmd' });
            segs.push({ text: right[1], cls: 'menu-desc' });
          }
          rows.push(segs);
        }
      } else {
        // Narrow viewport: one [command, description] pair per row, sized
        // to the actual negotiated width instead of the fixed 80.
        boxWidth = Math.min(80, cols);
        const allProgs = progLeft.concat(progRight);
        const cmdW = Math.max(...allProgs.map(([c]) => c.length)) + 2;
        for (const [c, d] of allProgs) {
          rows.push([
            { text: padTo(c, cmdW), cls: 'menu-cmd' },
            { text: d, cls: 'menu-desc' },
          ]);
        }
      }
      b.printHTML(renderBoxFrame('MAIN MENU', rows, boxWidth));
    }
    //b.hr();
    b.print('/command works from anywhere. /main to come home. /help for everything.', 'dim');
    {
      // Important-announcement slot: only the single pinned announcement
      // (via the existing generic settings table — no schema change), if
      // one is set and still active. Renders nothing at all otherwise.
      try {
        const pinnedRow = getSetting.get('pinned_announcement_id');
        const pinnedId = pinnedRow && pinnedRow.value ? parseInt(pinnedRow.value, 10) : null;
        if (pinnedId) {
          const announcement = getActiveAnnouncementById.get(pinnedId);
          if (announcement) {
            const text = stripDISFormatting(announcement.body).slice(0, 140);
            b.printHTML(`<span class="main-alert">!! ${escapeHTML(text)} — /announcements !!</span>`);
          }
        }
      } catch (e) {
        console.error('[renderMenu] pinned announcement lookup failed:', e && e.message);
      }
    }
    b.printHTML('<div id="main-flavor"></div>');
  });
}
function menuHandleRaw(text, api){ api.print('Type a /command to launch something. Try /chat, /board, /games or /help.', 'dim'); return true; }

/* ======================= Announcements ======================= */
function fetchActiveAnnouncements(){
  const limit = Math.max(1, Math.min(200, ANNOUNCEMENT_LIST_LIMIT));
  return listAnnouncements.all(limit);
}

function printAnnouncements(api, rows){
  api.batch(b => {
    b.hr();
    b.hrTitled('Announcements');

    if (!rows.length){
      b.print('No announcements at this time.', 'dim');
    } else {
      rows.forEach(r => {
        const when = r.created_at ? formatStampET(r.created_at * 1000) : '';
        const whoRaw = (r.display_name && r.display_name.trim()) ? r.display_name : (r.username || 'system');
        const safeBody = sanitizeAndFormatDIS(r.body || '');
        const header = `<span class="yellow">[#${escapeHTML(String(r.id))}]</span>` +
                       (when ? ` <span class="dim">${escapeHTML(when)}</span>` : '') +
                       ` &lt;${sanitizeAndFormatDIS(whoRaw)}&gt;`;
        b.printHTML(`${header} — ${safeBody}`);
      });
    }

    b.hr();
  });
}

function cmdAnnouncements(api, state){
  if (!requireAuth(api, state)) return;
  const rows = fetchActiveAnnouncements();
  printAnnouncements(api, rows);
}

function cmdAnnounce(api, state, args){
  if (!requireAuth(api, state)) return;
  if (!state.isAdmin){ api.print('Unknown command.', 'red'); return; }

  const text = (args || []).join(' ').trim();
  if (!text){ api.print('Usage: /announce <announcement text>', 'yellow'); return; }
  if (text.length > ANNOUNCEMENT_MAX_LEN){
    api.print(`Announcement too long (max ${ANNOUNCEMENT_MAX_LEN} characters).`, 'red');
    return;
  }

  const created = nowEpoch();
  const daysRow = getSetting.get('announcement_retention_days');
  const parsedRetention = daysRow && daysRow.value != null ? parseInt(daysRow.value, 10) : NaN;
  const retentionDays = Number.isFinite(parsedRetention) ? parsedRetention : 30;
  const expires = retentionDays > 0 ? created + retentionDays * 86400 : null;

  try {
    insertAnnouncement.run(state.userId || null, text, created, expires);
  } catch (e) {
    console.error('Failed to insert announcement:', e && e.message ? e.message : e);
    api.print('Failed to create announcement.', 'red');
    return;
  }

  api.print('Announcement posted.', 'green');
  cmdAnnouncements(api, state);
}

function cmdRemoveAnnouncement(api, state, args){
  if (!requireAuth(api, state)) return;
  if (!state.isAdmin){ api.print('Unknown command.', 'red'); return; }

  const id = parseInt(args && args[0], 10);
  if (!id){ api.print('Usage: /removeannounce <id#>', 'yellow'); return; }

  try {
    const info = deleteAnnouncementById.run(id);
    if (info.changes){
      api.print(`Announcement #${id} removed.`, 'green');
      cmdAnnouncements(api, state);
    } else {
      api.print('Announcement not found.', 'red');
    }
  } catch (e) {
    console.error('Failed to remove announcement:', e && e.message ? e.message : e);
    api.print('Failed to remove announcement.', 'red');
  }
}

function cmdPinAnnouncement(api, state, args){
  if (!requireAuth(api, state)) return;
  if (!state.isAdmin){ api.print('Unknown command.', 'red'); return; }

  const arg = args && args[0];
  if (!arg){ api.print('Usage: /pinannounce <id#>  (or /pinannounce clear)', 'yellow'); return; }

  if (arg === 'clear'){
    setSetting.run('pinned_announcement_id', '');
    api.print('Pinned announcement cleared.', 'green');
    return;
  }

  const id = parseInt(arg, 10);
  if (!id){ api.print('Usage: /pinannounce <id#>  (or /pinannounce clear)', 'yellow'); return; }

  const row = getActiveAnnouncementById.get(id);
  if (!row){ api.print('Announcement not found (or expired).', 'red'); return; }

  setSetting.run('pinned_announcement_id', String(id));
  api.print(`Announcement #${id} pinned to /main.`, 'green');
}

/* ======================= Polls ======================= */
function formatPollPercent(votes, total){
  if (!total) return '0%';
  return `${Math.round((votes / total) * 100)}%`;
}

function getPollOptionsSummary(pollId){
  const options = listPollOptionsWithVotes.all(pollId);
  const total = options.reduce((sum, opt) => sum + (Number(opt.votes) || 0), 0);
  return { options, total };
}

function renderPolls(api, state){
  if (!requireAuth(api, state)) return;
  const activePolls = listActivePolls.all();
  const endedPolls = listEndedPolls.all(20);

  api.batch(b => {
    b.clear();
    b.setInputLimit(null);
    b.hrTitled('Polls');

    if (!activePolls.length){
      b.print('No active polls. Create one with /newpoll <question> | <opt1> | <opt2> ...', 'dim');
    } else {
      b.print('Active polls:', 'yellow');
      activePolls.forEach((poll) => {
        const safeQuestion = sanitizeAndFormatDIS(poll.question || '');
        b.printHTML(`<span class="yellow">[#${escapeHTML(String(poll.id))}]</span> ${safeQuestion}`);

        const { options, total } = getPollOptionsSummary(poll.id);
        options.forEach((opt) => {
          const safeOpt = sanitizeAndFormatDIS(opt.option_text || '');
          const votes = Number(opt.votes) || 0;
          const percent = formatPollPercent(votes, total);
          b.printHTML(`  ${escapeHTML(String(opt.option_index))}. ${safeOpt} <span class="dim">(${percent}, ${votes} vote${votes === 1 ? '' : 's'})</span>`);
        });
      });
    }

    b.hr();
    b.hrTitled('Ended Polls');

    if (!endedPolls.length){
      b.print('No polls have ended yet.', 'dim');
    } else {
      endedPolls.forEach((poll) => {
        const safeQuestion = sanitizeAndFormatDIS(poll.question || '');
        const { options, total } = getPollOptionsSummary(poll.id);
        const maxVotes = options.reduce((max, opt) => Math.max(max, Number(opt.votes) || 0), 0);
        const parts = options.map((opt) => {
          const safeOpt = sanitizeAndFormatDIS(opt.option_text || '');
          const votes = Number(opt.votes) || 0;
          const percent = formatPollPercent(votes, total);
          const text = `${opt.option_index}) ${safeOpt} ${percent} (${votes})`;
          if (maxVotes > 0 && votes === maxVotes) {
            return `<span class="green">${text}</span>`;
          }
          return text;
        });
        b.printHTML(`<span class="yellow">[#${escapeHTML(String(poll.id))}]</span> ${safeQuestion} <span class="dim">—</span> ${parts.join(' <span class="dim">|</span> ')}`);
      });
    }

    b.hr();
    b.print('Commands: /vote <poll id> <option #>  /newpoll <question> | <opt1> | <opt2> ...', 'cyan');
    b.print('Owner/admin: /endpoll <id>  /removepoll <id>   /main to leave', 'cyan');
    b.setInputType('text', 'Use /vote or /newpoll');
  });

  state.currentScreen = 'polls';
}

function splitPollParts(raw){
  if (!raw || !raw.includes('|')) return [];
  return raw.split('|').map(part => part.trim()).filter(Boolean);
}

function cmdNewPoll(api, state, args){
  if (!requireAuth(api, state)) return;
  const raw = (args || []).join(' ').trim();
  if (!raw){
    api.print('Usage: /newpoll <question> | <opt1> | <opt2> [| <opt3> ...]', 'yellow');
    api.print('Tip: Use "|" to separate items. Example: /newpoll Best snack? | Popcorn | Pretzels', 'dim');
    return;
  }

  const parts = splitPollParts(raw);
  if (!parts.length){
    api.print('Polls require "|" separators between the question and each option.', 'yellow');
    api.print('Example: /newpoll Best snack? | Popcorn | Pretzels', 'dim');
    return;
  }
  const question = parts[0];
  const options = parts.slice(1);

  if (!question){
    api.print('Poll question is required.', 'yellow');
    return;
  }
  if (options.length < 2 || options.length > 5){
    api.print('Polls need 2 to 5 options. Use "|" to separate items.', 'yellow');
    return;
  }

  try {
    const createPoll = db.transaction(() => {
      const createdAt = nowEpoch();
      const info = insertPoll.run(question, state.userId || null, createdAt);
      options.forEach((opt, idx) => {
        insertPollOption.run(info.lastInsertRowid, idx + 1, opt);
      });
      return info.lastInsertRowid;
    });
    const pollId = createPoll();
    api.print(`Poll #${pollId} created.`, 'green');
    renderPolls(api, state);
  } catch (e) {
    console.error('Failed to create poll:', e && e.message ? e.message : e);
    api.print('Failed to create poll.', 'red');
  }
}

function cmdVote(api, state, args){
  if (!requireAuth(api, state)) return;
  const pollId = parseInt(args[0], 10);
  const optionNum = parseInt(args[1], 10);
  if (!pollId || !optionNum){
    api.print('Usage: /vote <poll id> <option #>', 'yellow');
    return;
  }

  const poll = getPollById.get(pollId);
  if (!poll){
    api.print('Poll not found.', 'red');
    return;
  }
  if (poll.ended_at){
    api.print('That poll has ended.', 'red');
    return;
  }

  const existing = getPollVoteForUser.get(pollId, state.userId);
  if (existing){
    api.print('You already voted in this poll.', 'yellow');
    return;
  }

  const opt = getPollOptionByIndex.get(pollId, optionNum);
  if (!opt){
    api.print('Invalid option number.', 'red');
    return;
  }

  try {
    insertPollVote.run(pollId, opt.id, state.userId, nowEpoch());
    api.print('Vote recorded.', 'green');
    renderPolls(api, state);
  } catch (e) {
    console.error('Failed to record vote:', e && e.message ? e.message : e);
    api.print('Failed to record vote.', 'red');
  }
}

function canManagePoll(poll, state){
  if (!poll || !state) return false;
  return state.isAdmin || (!!poll.creator_id && poll.creator_id === state.userId);
}

function cmdEndPoll(api, state, args){
  if (!requireAuth(api, state)) return;
  const pollId = parseInt(args[0], 10);
  if (!pollId){
    api.print('Usage: /endpoll <id>', 'yellow');
    return;
  }
  const poll = getPollById.get(pollId);
  if (!poll){
    api.print('Poll not found.', 'red');
    return;
  }
  if (!canManagePoll(poll, state)){
    api.print('Only the poll creator or an admin can end this poll.', 'red');
    return;
  }
  if (poll.ended_at){
    api.print('That poll is already ended.', 'yellow');
    return;
  }
  const info = endPollById.run(nowEpoch(), state.userId || null, pollId);
  if (!info.changes){
    api.print('Poll not updated.', 'red');
    return;
  }
  api.print(`Poll #${pollId} ended.`, 'green');
  renderPolls(api, state);
}

function cmdRemovePoll(api, state, args){
  if (!requireAuth(api, state)) return;
  const pollId = parseInt(args[0], 10);
  if (!pollId){
    api.print('Usage: /removepoll <id>', 'yellow');
    return;
  }
  const poll = getPollById.get(pollId);
  if (!poll){
    api.print('Poll not found.', 'red');
    return;
  }
  if (!canManagePoll(poll, state)){
    api.print('Only the poll creator or an admin can remove this poll.', 'red');
    return;
  }
  const info = removePollById.run(pollId);
  if (!info.changes){
    api.print('Poll not removed.', 'red');
    return;
  }
  api.print(`Poll #${pollId} removed.`, 'green');
  if (state.currentScreen === 'poll') renderPolls(api, state);
}

/* ======================= Status Posts / Feed ======================= */
function getStatusFeedLimit(){
  const row = getSetting.get('status_feed_limit');
  const parsed = row && row.value != null ? parseInt(row.value, 10) : NaN;
  const fallback = 50;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(STATUS_FEED_LIMIT_CAP, parsed));
}

const STATUS_NAME_COLOR_CLASS_RE = new RegExp(`class\\s*=\\s*"(?:${ALLOWED_COLORS.map(c => 'uc-' + c).join('|')})"`, 'i');
const STATUS_NAME_COLOR_STYLE_RE = /style\s*=\s*"[^"]*color\s*:/i;

function statusDisplayHasExplicitColor(html){
  if (!html) return false;
  return STATUS_NAME_COLOR_CLASS_RE.test(html) || STATUS_NAME_COLOR_STYLE_RE.test(html);
}

function formatStatusDisplayName(row){
  const fallback = (row.username && row.username.trim()) ? row.username : 'anon';
  const source = (row.display_name && row.display_name.trim()) ? row.display_name : fallback;
  let formatted = sanitizeAndFormatDIS(source);
  if (!formatted){
    formatted = sanitizeAndFormatDIS(fallback);
  }
  if (row.color && formatted && !statusDisplayHasExplicitColor(formatted)){
    formatted = `<span style="color:${escapeHTML(row.color)}">${formatted}</span>`;
  }
  return formatted;
}

function printStatusFeed(api, rows, opts = {}){
  const headingText = opts.headingText || 'Status Feed';
  const emptyMessage = opts.emptyMessage || 'No updates yet. Share one with /post <text>.';

  api.batch(b => {
    b.clear();
    b.hr();
    b.hrTitled(headingText);

    if (!rows.length){
      b.print(emptyMessage, 'dim');
    } else {
      let lastYmd = null;
      rows.forEach(r => {
        const thisYmd = dayKeyET(r.created_at * 1000);
        if (thisYmd !== lastYmd) {
          printDayDivider(b, r.created_at);
          lastYmd = thisYmd;
        }

        const timeLabel = formatTimeET(r.created_at * 1000);
        const safeDisp = formatStatusDisplayName(r);
        const safeBody = sanitizeAndFormatDIS(r.body || '');
        const coloredBody = r.color ? `<span style="color:${r.color}">${safeBody}</span>` : safeBody;
        b.printHTML(`[${escapeHTML(timeLabel)}] &lt;${safeDisp}&gt; ${coloredBody}`);
      });
    }

    b.hr();
  });
}

function cmdFeed(api, state, args){
  if (!requireAuth(api, state)) return;

  const limit = getStatusFeedLimit();
  const targetRaw = (args || []).join(' ').trim();

  if (!targetRaw){
    const rows = listStatusPosts.all(limit);
    printStatusFeed(api, rows, {
      headingText: 'Status Feed',
      emptyMessage: 'No updates yet. Share one with /post <text>.',
    });
    return;
  }

  const lookup = targetRaw.startsWith('@') ? targetRaw.slice(1) : targetRaw;
  let resolved = null;
  try {
    resolved = resolveUserHandle ? resolveUserHandle(lookup) : null;
  } catch (e) {
    resolved = null;
  }

  if (!resolved){
    api.print('No such user.', 'red');
    return;
  }
  if (resolved.ambiguous){
    const opts = resolved.ambiguous.map(r => r.username).join(', ');
    api.print('That matches multiple users. Be more specific: ' + opts, 'yellow');
    return;
  }

  const userRow = resolved.row;
  const rows = listStatusPostsByUser.all(userRow.id, limit);
  const labelSource = (userRow.display_name && userRow.display_name.trim()) ? userRow.display_name : userRow.username;
  let labelText = stripDISFormatting(labelSource || '');
  if (!labelText.trim()) labelText = userRow.username || 'that user';
  const headingText = (userRow.id && state.userId && userRow.id === state.userId)
    ? 'Your Updates'
    : `Posts by ${labelText}`;
  const emptyMessage = (userRow.id && state.userId && userRow.id === state.userId)
    ? 'You have not posted anything yet. Share one with /post <text>.'
    : 'No updates from that user yet.';

  printStatusFeed(api, rows, { headingText, emptyMessage });
}

function cmdPost(api, state, args){
  if (!requireAuth(api, state)) return;

  const text = (args || []).join(' ').trim();
  if (!text){
    api.print('Usage: /post <update text>', 'yellow');
    return;
  }

  const maxRow = getSetting.get('status_max_len');
  const parsedMax = maxRow && maxRow.value != null ? parseInt(maxRow.value, 10) : NaN;
  const maxLen = Number.isFinite(parsedMax) ? parsedMax : 280;
  if (text.length > maxLen){
    api.print(`Update too long (max ${maxLen} characters).`, 'red');
    return;
  }

  const created = nowEpoch();
  const daysRow = getSetting.get('status_retention_days');
  const parsedDays = daysRow && daysRow.value != null ? parseInt(daysRow.value, 10) : NaN;
  const retentionDays = Number.isFinite(parsedDays) ? parsedDays : 30;
  const expires = retentionDays > 0 ? (created + retentionDays * 86400) : null;

  try {
    insertStatusPost.run(state.userId || null, text, created, expires);
  } catch (e) {
    console.error('Failed to insert status post:', e && e.message ? e.message : e);
    api.print('Failed to publish update.', 'red');
    return;
  }

  const fromRow = { id: state.userId, username: state.username };
  notifyMentions(text, fromRow, 'status');

  api.print('Update posted. Use /feed to see recent updates.', 'green');
}

/* ======================= Chat ======================= */
function renderChat(api, state){
  if (!requireAuth(api, state)) return;
  const chatMaxLen = +(getSetting.get('chat_max_len')?.value || 400);
  api.batch(b=>{
    b.clear();
    b.setInputLimit(chatMaxLen);
    b.hrTitled('The Commons Chat');

    const here = usersCurrentlyInChat();
    b.print(here.length ? `Here now (${here.length}): ${here.join(', ')}` : 'Nobody is here yet — say hi!', 'cyan');
    b.hr();

    const historyShown = +(getSetting.get('chat_history_shown')?.value || 20);
    const rows = recentMessages.all(historyShown).reverse();
    if (rows.length === 0) {
      b.print('No messages yet. Type to chat. /leave to return.', 'dim');
    } else {
        let lastYmd = null;
      rows.forEach(r => {
        const thisYmd = dayKeyET(r.created_at * 1000);
        if (thisYmd !== lastYmd) {
          printDayDivider(b, r.created_at);
          lastYmd = thisYmd;
        }
        const ts = formatTimeET(r.created_at * 1000);
        const usernameRaw = typeof r.username === 'string' ? r.username : '';
        const displaySource = r.display_name && typeof r.display_name === 'string' ? r.display_name.trim() : '';
        const disp = displaySource || usernameRaw || 'anon';
        const color = r.color || '';
        const safeBody = sanitizeAndFormatDIS(r.body);
        const bodyWithColor = color ? `<span style="color:${color}">${safeBody}</span>` : safeBody;
        const html = `[${ts}] &lt;${sanitizeAndFormatDIS(disp)}&gt; ${bodyWithColor}`;
        const mine = state.username && r.username && state.username.toLowerCase() === r.username.toLowerCase();
        b.printHTML(html, mine ? 'me' : undefined);
      });
      // Remember the last printed day for this socket so live updates can insert dividers accurately
      if (api.ws && api.ws.__ctx) api.ws.__ctx.lastChatDay = lastYmd;
    }

    b.hr();
    b.print('Type to chat. /leave exits. Try **bold**, _italics_, __underline__, [cyan]color[/cyan].', 'dim');
  });
}
function chatHandleCommand(cmd, api, state){
  if (!requireAuth(api, state)) return true;
  if (cmd==='leave' || cmd==='menu' || cmd==='main'){ routeGo(api, state, 'menu'); return true; }
  if (cmd==='here'){ api.print('Here: ' + usersCurrentlyInChat().join(', '), 'cyan'); return true; }
  return false;
}
function chatHandleRaw(text, api, state){
  if (!requireAuth(api, state)) return true;
  const msgText = (text||'').trim(); if (!msgText) return true;

  // limits
  const max = +(getSetting.get('chat_max_len')?.value || 400);
  if (msgText.length > max){ api.print(`Too long (max ${max}).`, 'red'); return true; }

  const uid = state.userId || null;
  const created = nowEpoch();
  const ttl = +(getSetting.get('chat_retention_days')?.value || 7) * 86400;
  const expires = ttl > 0 ? (created + ttl) : null;

  insertMessage.run(uid, msgText, created, expires); // your existing prepared INSERT

  const ts = formatTimeET(created * 1000);
  const disp = state.displayName || state.username || 'anon';
  const safeBody = sanitizeAndFormatDIS(msgText);
  const bodyWithColor = state.userColor ? `<span style="color:${state.userColor}">${safeBody}</span>` : safeBody;
  const html = `[${ts}] &lt;${sanitizeAndFormatDIS(disp)}&gt; ${bodyWithColor}`;

  broadcastChatFrom(html, state.username || '', created); // your existing broadcast with day dividers

  // === NEW: mentions → notify
  const fromRow = { id: uid, username: state.username };
  notifyMentions(msgText, fromRow, 'chat');

  return true;
}


/* ======================= About / Rules ======================= */
function renderAbout(api, state){
  if (!requireAuth(api, state)) return;
  api.batch(b=>{
    b.clear();
    b.setInputLimit(null);
    b.hrTitled('About Dead Internet Society');
    b.print('The internet has largely become the bane of modern human existence.  What was once supposed to be a repository of knowledge and unlimited human connection has become a swirling cesspool of algorithm-driven content gluttony, consumerism, competitive idiocy, and bots emotionally abusing bots.  The internet as it once was, and what was once promised to us, is dead.  So we built something else... smaller... ours.', 'white');
    b.print(' ', 'white');
    b.print('-- PunkyRoo, sysop', 'dim');
    b.print(' ', 'white');
    b.print(' ', 'white');
    b.hrTitled('RULES');
    b.print(' ', 'white');
    b.print('Dont be a badger-sized dickhole.', 'white');
    b.print('No racism/bigotry.', 'white');
    b.print('No explicit conversation or content.', 'white');
    b.print(' ', 'white');
    b.hrTitled('SYSTEM');
    b.print(' ', 'white');
    b.print('Running DEADNET UNIFIED ACCESS SYSTEM v0.13 on a node nobody quite remembers building.', 'dim');
    b.print('Display font: Web IBM VGA 8x16, from the Ultimate Oldschool PC Font Pack by VileR (CC BY-SA 4.0) — int10h.org/oldschool-pc-fonts', 'dim');
    b.print('All times board time (US Eastern).', 'dim');
    b.print(' ', 'white');
    b.hr(); b.print('Navigation: /main', 'dim');
  });
}
function renderRules(api, state){
  if (!requireAuth(api, state)) return;
  api.batch(b=>{
    b.clear();
    b.setInputLimit(null);
    b.hrTitled('Rules');
    b.print('One rule that covers everything: be a person worth being around.', 'white');
    b.print('No bigotry. No harassment. We moderate for safety, not virality.', 'white');
    b.hr(); b.print('Navigation: /main', 'dim');
  });
}
function aboutHandleCommand(cmd, api){ if (cmd==='menu'||cmd==='main'){ routeGo(api, {}, 'menu'); return true; } return false; }
function rulesHandleCommand(cmd, api){ if (cmd==='menu'||cmd==='main'){ routeGo(api, {}, 'menu'); return true; } return false; }

function cmdWho(api){
  const list = Array.from(HUB.online);
  api.print(list.length ? `Online: ${list.join(', ')}` : 'Nobody online', 'cyan');
}

function cmdHere(api, state){
  if (!requireAuth(api, state)) return;
  const here = usersCurrentlyInChat();
  api.print(here.length ? `Here now (${here.length}): ${here.join(', ')}` : 'Nobody is in chat right now.', 'cyan');
}

function cmdColors(api){
  // Previews the [color] chat tags (uc- classes), not system print colors —
  // these are the swatches available via [red]...[/red] etc in DIS-Markdown.
  api.print('█ RED','uc-red'); api.print('█ GREEN','uc-green'); api.print('█ YELLOW','uc-yellow');
  api.print('█ BLUE','uc-blue'); api.print('█ MAGENTA','uc-magenta'); api.print('█ CYAN','uc-cyan'); api.print('█ WHITE','uc-white');
}

function cmdFormat(api){
  api.hr();
  api.print('DIS-Markdown examples (sanitized & rendered):', 'yellow');
  ['**Bold** and _italics_ and __underline__.',
   'Mixing: **bold and _italic_** plus [cyan]color[/cyan] and [dim]dim[/dim].',
   'Colors: [red]red[/red] [green]green[/green] [yellow]yellow[/yellow] [blue]blue[/blue] [magenta]magenta[/magenta] [cyan]cyan[/cyan] [white]white[/white]',
   'Safety: <script>alert(1)</script> will be escaped.'
  ].forEach(ex => api.printHTML(sanitizeAndFormatDIS(ex)));
  api.hr(); api.print('Use these in Chat; everything is sanitized first.', 'dim');
}


/* ======================= Board (List + Topic) ======================= */
function renderBoard(api, state){
  if (!requireAuth(api, state)) return;
  const limit = +(getSetting.get('board_list_limit')?.value || 100);
  const rows = selectTopicsList.all(limit);

  api.batch(b=>{
    b.clear();
    b.setInputLimit(null);
    b.hrTitled('Message Board');
    if (rows.length === 0){
      b.print('No topics yet. Start one with /newtopic <title>.', 'dim');
    } else {
      b.print('Topics (most recently active first):', 'yellow');
      rows.forEach(r=>{
        const when = formatStampET(r.last_commented_at * 1000);
        const safeTitle = sanitizeAndFormatDIS(r.title);
        b.printHTML(`${r.id}. ${safeTitle}  <span class="dim">(${r.comments} repl${r.comments === 1 ? 'y' : 'ies'}, active ${escapeHTML(when)})</span>`);
      });
    }
    b.hr();
    b.print('Open: /topic <id>   Start: /newtopic <title>   Back: /main', 'cyan');
    b.setInputType('text', 'Use /topic <id> or /newtopic <title>');
  });

  state.currentScreen = 'board';
  state.currentTopicId = null;
}
function openTopic(api, state, topicId){
  const t = selectTopic.get(topicId);
  if (!t){ api.print('No such topic (maybe expired).', 'red'); return; }
  state.currentScreen = 'topic';
  state.currentTopicId = topicId;

  const maxLen = +(getSetting.get('topic_comment_max_len')?.value || 600);

  const comments = selectCommentsForTopic.all(topicId);
  const posterRaw = (t.display_name && t.display_name.trim()) ? t.display_name : (t.creator || 'anon');
  const poster = sanitizeAndFormatDIS(posterRaw);

  api.batch(b=>{
    b.clear();
    b.printHTML(`== Topic #${t.id}: ${sanitizeAndFormatDIS(t.title)} ==`, 'magenta');
    b.printHTML(`<span class="dim">by &lt;${poster}&gt;</span>`); b.hr();
    if (comments.length === 0){
      b.print('No replies yet. Type to reply.', 'dim');
    } else {
      comments.forEach(c=>{
        const ts = formatStampET(c.created_at * 1000);
        const authorRaw = (c.display_name && c.display_name.trim()) ? c.display_name : (c.username || 'anon');
        const author = sanitizeAndFormatDIS(authorRaw);
        const body = sanitizeAndFormatDIS(c.body);
        const coloredBody = c.preferred_color ? `<span style="color:${c.preferred_color}">${body}</span>` : body;
        b.printHTML(`[${escapeHTML(ts)}] &lt;${author}&gt; ${coloredBody}`);
      });
    }
    b.hr();
    b.print('Type to reply. Commands: /board (back), /main', 'dim');
    b.setInputType('text', 'Type to reply… /board to go back');
    b.setInputLimit(maxLen);
  });
}
function boardHandleCommand(cmd, api, state, args){
  if (!requireAuth(api, state)) return true;
  if (cmd === 'main' || cmd === 'menu'){ routeGo(api, state, 'menu'); return true; }
  if (cmd === 'topic'){
    const id = parseInt(args[0], 10);
    if (!id){ api.print('Usage: /topic <id>', 'yellow'); return true; }
    openTopic(api, state, id); return true;
  }
  return false;
}
function topicHandleCommand(cmd, api, state, args){
  if (!requireAuth(api, state)) return true;
  if (cmd === 'board'){ renderBoard(api, state); return true; }
  if (cmd === 'main' || cmd === 'menu'){ routeGo(api, state, 'menu'); return true; }
  if (cmd === 'reply'){ // optional alias
    const raw = (args||[]).join(' ').trim();
    return topicPostRaw(raw, api, state), true;
  }
  return false;
}
function topicHandleRaw(text, api, state){
  if (!requireAuth(api, state)) return true;
  const body = (text||'').trim(); if (!body) return true;
  const topicId = state.currentTopicId;
  if (!topicId){ api.print('No topic open.', 'red'); return true; }

  const max = +(getSetting.get('topic_comment_max_len')?.value || 600);
  if (visibleLengthDIS(body) > max){ api.print(`Too long (max ${max} visible chars).`, 'red'); return true; }

  const ts = nowEpoch();
  insertComment.run(topicId, state.userId || null, body, ts);
  const days = +(getSetting.get('board_inactive_days')?.value || 0);
  updateTopicBump.run(ts, days > 0 ? ts + days*86400 : null, topicId);

  // re-render topic so commenter sees their post immediately
  openTopic(api, state, topicId);

  // mentions → notify
  const fromRow = { id: state.userId || null, username: state.username };
  notifyMentions(body, fromRow, `topic:${topicId}`);

  return true;
}


function topicPostRaw(raw, api, state){
  if (!state.currentTopicId){ api.print('No topic open.', 'red'); return; }
  const maxLen = +(getSetting.get('board_reply_max_len')?.value || 600);
  const visible = visibleLengthDIS(raw);
  if (visible > maxLen){ api.print(`Reply too long (max ${maxLen} visible chars).`, 'red'); return; }
  const ts = nowEpoch();
  insertComment.run(state.currentTopicId, state.userId || null, raw, ts);
  const days = +(getSetting.get('board_inactive_days')?.value || 0);
  updateTopicBump.run(ts, days > 0 ? ts + days*86400 : null, state.currentTopicId);
  openTopic(api, state, state.currentTopicId);
}
function cmdNewTopic(api, state, args){
  if (!requireAuth(api, state)) return;
  const raw = (args||[]).join(' ').trim();
  if (!raw){ api.print('Usage: /newtopic <title>', 'yellow'); return; }
  const maxLen = +(getSetting.get('board_title_max_len')?.value || 120);
  if (visibleLengthDIS(raw) > maxLen){ api.print(`Title too long (max ${maxLen} visible chars).`, 'red'); return; }
  const ts = nowEpoch();
  const days = +(getSetting.get('board_inactive_days')?.value || 0);
  insertTopic.run(raw, state.userId || null, ts, ts, days > 0 ? ts + days*86400 : null);
  addActivityEvent('community', 'board_topic', `📋 ${state.username} started a new topic: ${raw}`);
  api.print('Topic created.', 'green');
  renderBoard(api, state);
}
function cmdRemoveTopic(api, state, args){
  if (!requireAuth(api, state)) return;
  if (!state.isAdmin){ api.print('Admin only.', 'red'); return; }
  const id = parseInt(args[0], 10);
  if (!id){ api.print('Usage: /removetopic <id>', 'yellow'); return; }
  deleteTopicById.run(id);
  api.print(`Removed topic #${id}.`, 'green');
  if (state.currentScreen === 'topic' && state.currentTopicId === id){
    renderBoard(api, state);
  }
}

/* ======================= Links (List + Item) ======================= */
function normalizeURL(u){
  try { const url = new URL(u.includes('://') ? u : 'https://' + u); return url.toString(); }
  catch { return null; }
}

function renderNewsList(api, state){
  if (!requireAuth(api, state)) return;
  const limit = +(getSetting.get('news_list_limit')?.value || 150);
  const rows = selectNewsList.all(limit);
  api.batch(b=>{
    b.clear();
    b.setInputLimit(null);
    b.hrTitled('Link Share');
    if (!rows.length){
      b.print('No links yet. Add one with /addlink <headline> <url>.', 'dim');
    } else {
      b.print('Recent links (most recently active first):', 'yellow');
      rows.forEach(r=>{
        const posterRaw = (r.display_name && r.display_name.trim()) ? r.display_name : (r.username || 'anon');
        const poster = sanitizeAndFormatDIS(posterRaw);
        const safeTitle = sanitizeAndFormatDIS(r.title);
        const normalizedUrl = normalizeURL(r.url) || r.url;
        const safeUrl = escapeHTML(normalizedUrl);
        b.printHTML(`${r.id}. <a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeTitle}</a>`);
        b.printHTML(`   by &lt;${poster}&gt;  <span class="dim">(${r.comments} comments)</span>`);
      });
    }
    b.hr();
    b.print('Open: /links <id>    Add: /addlink <headline> <url>    Remove (admin): /removelink <id>', 'cyan');
    b.setInputType('text', 'Use /links <id> or /addlink <headline> <url>');
  });
  state.currentScreen = 'news:list';
  state.currentNewsId = null;
}
function openNewsItem(api, state, id){
  const p = selectNewsPost.get(id);
  if (!p){ api.print('No such link (maybe expired).', 'red'); return; }
  state.currentScreen = 'news:item';
  state.currentNewsId = id;

  const maxLen = +(getSetting.get('news_comment_max_len')?.value || 600);

  const comments = selectNewsComments.all(id);
  const posterRaw = (p.display_name && p.display_name.trim()) ? p.display_name : (p.username || 'anon');
  const poster = sanitizeAndFormatDIS(posterRaw);

  api.batch(b=>{
    b.clear();
    b.printHTML(`== Link #${p.id}: ${sanitizeAndFormatDIS(p.title)} ==`, 'magenta');
    b.printHTML(`<span class="dim">${escapeHTML(p.url)}</span>  by &lt;${poster}&gt;`);
    b.hr();
    if (!comments.length){
      b.print('No comments yet. Type to comment.', 'dim');
    } else {
      comments.forEach(c=>{
        const ts = formatStampET(c.created_at * 1000);
        const authorRaw = (c.display_name && c.display_name.trim()) ? c.display_name : (c.username || 'anon');
        const author = sanitizeAndFormatDIS(authorRaw);
        const body = sanitizeAndFormatDIS(c.body);
        const colored = c.preferred_color ? `<span style="color:${c.preferred_color}">${body}</span>` : body;
        b.printHTML(`[${escapeHTML(ts)}] &lt;${author}&gt; ${colored}`);
      });
    }
    b.hr();
    b.print('Type to comment. Commands: /links (back), /main', 'dim');
    b.setInputType('text', 'Type to comment… /links to go back');
    b.setInputLimit(maxLen);
  });
}
function newsListHandleCommand(cmd, api, state, args){
  if (!requireAuth(api, state)) return true;
  if (cmd === 'links' && args.length){
    const id = parseInt(args[0], 10);
    if (!id){ api.print('Usage: /links <id>', 'yellow'); return true; }
    openNewsItem(api, state, id); return true;
  }
  if (cmd === 'main' || cmd === 'menu'){ routeGo(api, state, 'menu'); return true; }
  return false;
}
function newsItemHandleRaw(text, api, state){
  if (!requireAuth(api, state)) return true;
  const body = (text||'').trim(); if (!body) return true;
  const newsId = state.currentNewsId;
  if (!newsId){ api.print('No link open.', 'red'); return true; }

  const max = +(getSetting.get('news_comment_max_len')?.value || 600);
  if (visibleLengthDIS(body) > max){ api.print(`Too long (max ${max} visible chars).`, 'red'); return true; }

  const ts = nowEpoch();
  insertNewsComment.run(newsId, state.userId || null, body, ts);

  const days = +(getSetting.get('news_inactive_days')?.value || 0);
  bumpNewsPost.run(ts, days > 0 ? ts + days*86400 : null, newsId);

  // re-render so commenter sees their post
  openNewsItem(api, state, newsId);

  // mentions → notify
  const fromRow = { id: state.userId || null, username: state.username };
  notifyMentions(body, fromRow, `news:${newsId}`);

  return true;
}


function cmdAddNews(api, state, args){
  if (!requireAuth(api, state)) return;
  const raw = (args||[]).join(' ').trim();
  if (!raw){ api.print('Usage: /addlink <headline> <url>', 'yellow'); return; }
  const parts = raw.split(/\s+/);
  if (parts.length < 2){ api.print('Usage: /addlink <headline> <url>', 'yellow'); return; }
  const urlIn = parts.pop();
  const headline = parts.join(' ').trim();

  const maxLen = +(getSetting.get('news_title_max_len')?.value || 120);
  if (visibleLengthDIS(headline) > maxLen){ api.print(`Headline too long (max ${maxLen} visible chars).`, 'red'); return; }
  if (!headline){ api.print('Headline required.', 'yellow'); return; }
  const url = normalizeURL(urlIn);
  if (!url){ api.print('Invalid URL. Example: example.com or https://example.com/article', 'red'); return; }

  const ts = nowEpoch();
  const days = +(getSetting.get('news_inactive_days')?.value || 0);
  insertNewsPost.run(headline, url, 'link', state.userId || null, ts, ts, days > 0 ? ts + days*86400 : null);
  addActivityEvent('community', 'links', `🔗 ${state.username} shared a link: ${headline}`);
  api.print('Link added.', 'green');
  renderNewsList(api, state);
}
function cmdRemoveNews(api, state, args){
  if (!requireAuth(api, state)) return;
  if (!state.isAdmin){ api.print('Admin only.', 'red'); return; }
  const id = parseInt(args[0], 10);
  if (!id){ api.print('Usage: /removelink <id>', 'yellow'); return; }
  deleteNewsById.run(id);
  api.print(`Removed link #${id}.`, 'green');
  if (state.currentScreen && state.currentScreen.startsWith('news') && state.currentNewsId === id){
    renderNewsList(api, state);
  }
}

/* ======================= Wordle helpers ======================= */
// Also the shared day-key for /hack (see getDailyHack, which is handed
// this same string by every one of its callers). Board time
// (America/New_York), not UTC — the puzzle now resets at board midnight.
function getWordleDate() {
  return dayKeyET();
}

function getYesterday() {
  return dayKeyAddDays(dayKeyET(), -1);
}

function getDailyWord() {
  const today = getWordleDate();
  const row = wordleGetDaily.get(today);
  if (row) return row.word;
  const picked = wordleGetRandomWord.get();
  if (!picked) return null;
  wordleSetDaily.run(today, picked.word);
  return picked.word;
}

function scoreGuess(guess, answer) {
  const result = new Array(5).fill('absent');
  const answerChars = answer.split('');
  const used = new Array(5).fill(false);
  for (let i = 0; i < 5; i++) {
    if (guess[i] === answerChars[i]) { result[i] = 'correct'; used[i] = true; }
  }
  for (let i = 0; i < 5; i++) {
    if (result[i] === 'correct') continue;
    for (let j = 0; j < 5; j++) {
      if (!used[j] && guess[i] === answerChars[j]) { result[i] = 'present'; used[j] = true; break; }
    }
  }
  return result.map((r, i) => ({ letter: guess[i], result: r }));
}

function buildWordleEmojiGrid(guessRows) {
  return guessRows.map(g => {
    const parsed = typeof g.result_json === 'string' ? JSON.parse(g.result_json) : g.result;
    return parsed.map(r => r.result === 'correct' ? '🟩' : r.result === 'present' ? '🟨' : '⬛').join('');
  }).join('\n');
}

/* ======================= Games ======================= */
function renderGames(api, state){
  if (!requireAuth(api, state)) return;
  const today = getWordleDate();
  const streakRow  = wordleGetStreak.get(state.username);
  const resultRow  = wordleGetResult.get(state.username, today);
  const feedRows   = stmtGamesFeed.all();
  const streak     = streakRow ? streakRow.current_streak : 0;
  const playedToday = !!resultRow;
  const hackRow    = stmtHackGetLog.get(state.username, today);

  let jackpot = 500;
  try { jackpot = chrome.getJackpot(); } catch {}

  api.batch(b=>{
    b.clear();
    b.setInputLimit(null);
    b.hrTitled('Games');
    const wordleStatus = playedToday
      ? (resultRow.solved ? `✓ played today (solved in ${resultRow.guesses})` : '✓ played today')
      : `your streak: ${streak} day${streak !== 1 ? 's' : ''}  •  /wordle stats for leaderboard`;
    b.print('  /wordle      daily word puzzle — new word every day, same for everyone', 'cyan');
    b.print(`             ${wordleStatus}`, playedToday ? 'green' : 'dim');
    b.print('  /slots      nickel slots — 5 ₢ per spin', 'cyan');
    b.printHTML(`             <span class="yellow">jackpot: ${escapeHTML(fmtCr(jackpot))} ₢ 💀</span>`);
    const playerBalance = chrome.getBalance(state.username);
    b.print('  /blackjack     simplified blackjack', 'cyan');
    b.printHTML(`             <span class="yellow">your balance: ${escapeHTML(fmtCr(playerBalance))} ₢</span>`);
    
    b.print('  /mining      Dig for resources in today\'s shared grid', 'cyan');
    b.print('  /hack        daily terminal crack — new terminal every day', 'cyan');
    if (hackRow) {
      if (hackRow.solved) {
        b.print(`             ✓ cracked today (attempt ${hackRow.attempts}, +${hackRow.chrome_won} ₢)`, 'green');
      } else {
        b.print('             ✗ locked out today', 'red');
      }
    }
    b.print('  /dots       community dots & boxes — claim squares, earn ₢', 'cyan');
    const dotsGame = stmtDotsActiveGame.get();
    if (dotsGame) {
      const dotsCount = stmtDotsLineCount.get(dotsGame.id).n;
      const dotsScores = stmtDotsScores.all(dotsGame.id);
      const leader = dotsScores.length ? dotsScores[0] : null;
      b.print(`             ${dotsCount}/${DOTS_TOTAL_LINES} lines drawn${leader ? '  •  leader: ' + leader.claimed_by + ' (' + leader.squares + ' sq)' : ''}`, 'dim');
    }
    b.hr();
    if (feedRows.length) {
      b.print('── recent activity ──', 'dim');
      for (const f of feedRows) {
        b.print(`  ${f.message}`, 'cyan');
      }
      b.hr();
    }
    b.print('/leave to return to the main menu  •  /chrome for your balance', 'dim');
  });
  state.currentScreen = 'games';
}

function gamesHandleCommand(cmd, api, state){
  if (!requireAuth(api, state)) return true;
  if (cmd === 'leave' || cmd === 'menu' || cmd === 'main'){ routeGo(api, state, 'menu'); return true; }
  return false;
}

/* ======================= Activity / Chrome / Wallet views ======================= */
function relativeTime(ts) {
  const diff = nowEpoch() - ts;
  if (diff < 60)      return 'just now';
  if (diff < 3600)    return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)   return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 172800)  return 'yesterday';
  return `${Math.floor(diff / 86400)} days ago`;
}

function txEmoji(reason) {
  if (/daily bonus|stipend/i.test(reason)) return '📅';
  if (/donation|welcome/i.test(reason))    return '💙';
  if (/slots/i.test(reason))               return '🎰';
  if (/wordle/i.test(reason))              return '🟩';
  if (/blackjack/i.test(reason))           return '🃏';
  return '💸';
}

function renderActivity(api, state) {
  if (!requireAuth(api, state)) return;
  const rows = stmtActivityFeed.all();
  api.batch(b => {
    b.clear();
    b.setInputLimit(null);
    b.hrTitled('Activity');
    if (!rows.length) {
      b.print('no activity yet.', 'dim');
    } else {
      for (const r of rows) {
        const t   = relativeTime(r.created_at).padStart(12);
        const msg = r.message.slice(0, 66).padEnd(66);
        b.print(`${msg}  ${t}`, 'cyan');
      }
    }
    b.hr();
    b.print('— /activity to refresh  •  /games  /chrome  /board for focused views —', 'dim');
  });
}

function renderChrome(api, state) {
  if (!requireAuth(api, state)) return;
  const username = state.username;
  const balance  = chrome.getBalance(username);
  const txRows   = stmtUserTransactions.all(username, 6);
  const leaders  = chrome.getLeaderboard(10);

  api.batch(b => {
    b.clear();
    b.setInputLimit(null);
    b.hrTitled('Chrome');
    b.print(`  your balance:  ${fmtCr(balance)} ₢`, 'cyan');
    b.hr();
    b.print('── your recent transactions ──', 'dim');
    if (!txRows.length) {
      b.print('  no transactions yet.', 'dim');
    } else {
      for (const tx of txRows) {
        const emoji   = txEmoji(tx.reason);
        const sign    = tx.amount >= 0 ? `+${fmtCr(tx.amount)}` : `${fmtCr(tx.amount)}`;
        const t       = relativeTime(tx.created_at).padStart(12);
        const reason  = tx.reason.slice(0, 28).padEnd(28);
        const signStr = `${sign} ₢`.padStart(12);
        b.print(`  ${emoji} ${reason}  ${signStr}    ${t}`, tx.amount >= 0 ? 'cyan' : 'dim');
      }
    }
    b.hr();
    b.print('── chrome leaderboard ──', 'dim');
    if (!leaders.length) {
      b.print('  no data yet.', 'dim');
    } else {
      leaders.forEach((r, i) => {
        b.printHTML(`  ${escapeHTML(String(i + 1) + '.')} ${escapeHTML(r.username.padEnd(16))} ${escapeHTML(fmtCr(r.balance))} ₢`);
      });
    }
    b.hr();
    b.print("— /chrome to refresh  •  /wallet [user] to view someone's balance —", 'dim');
  });
}

function cmdWallet(api, state, args) {
  if (!requireAuth(api, state)) return;
  const target = ((args && args[0]) || '').trim();
  if (!target) { api.print('Usage: /wallet <username>', 'yellow'); return; }
  const row = db.prepare('SELECT username, balance FROM chrome_balances WHERE LOWER(username) = LOWER(?)').get(target);
  if (!row) { api.print(`no user found: ${target}`, 'red'); return; }
  const rankRow = stmtUserRank.get(row.username);
  const rank    = (rankRow ? rankRow.rank : 0) + 1;
  const total   = stmtTotalUsers.get().n;
  api.batch(b => {
    b.clear();
    b.setInputLimit(null);
    b.hrTitled(`Wallet: ${row.username}`);
    b.print(`  balance:  ${fmtCr(row.balance)} ₢`, 'cyan');
    b.print(`  rank:     #${rank} of ${total} users`, 'cyan');
    b.hr();
    b.print('— /chrome for your own balance —', 'dim');
  });
}

function cmdWordle(api, state, args){
  if (!requireAuth(api, state)) return;
  const sub = (args || '').trim().toLowerCase();

  if (sub === 'stats') {
    const today = getWordleDate();
    api.batch(b => {
      b.hr();
      b.print('== Wordle Leaderboard ==', 'magenta');
      b.print('Current streaks:', 'yellow');
      const cur = wordleLeaderCurrent.all();
      if (!cur.length) { b.print('  No streaks yet.', 'dim'); }
      else { cur.forEach((r,i) => b.print(`  ${i+1}. ${r.username}  ${r.current_streak} day${r.current_streak !== 1 ? 's' : ''}`, 'cyan')); }
      b.hr();
      b.print('Best streaks ever:', 'yellow');
      const best = wordleLeaderBest.all();
      if (!best.length) { b.print('  No records yet.', 'dim'); }
      else { best.forEach((r,i) => b.print(`  ${i+1}. ${r.username}  ${r.best_streak} day${r.best_streak !== 1 ? 's' : ''}`, 'cyan')); }
      b.hr();
      b.print(`Today's solvers (${today}):`, 'yellow');
      const solvers = wordleGetTodaySolvers.all(today);
      if (!solvers.length) { b.print('  Nobody has solved it yet. Be the first!', 'dim'); }
      else { solvers.forEach((r,i) => b.print(`  ${i+1}. ${r.username}  in ${r.guesses} guess${r.guesses !== 1 ? 'es' : ''}`, 'cyan')); }
      b.hr();
    });
    return;
  }

  if (sub !== '') {
    api.print('usage: /wordle — play today\'s puzzle', 'dim');
    api.print('       /wordle stats — leaderboard and today\'s results', 'dim');
    return;
  }

  const today = getWordleDate();
  const dailyWord = getDailyWord();
  if (!dailyWord) { api.print('Wordle is unavailable right now.', 'red'); return; }

  const guessRows = wordleGetGuesses.all(state.username, today);
  const resultRow = wordleGetResult.get(state.username, today);
  const streakRow = wordleGetStreak.get(state.username);

  const guesses = guessRows.map(g => ({
    guess: g.guess,
    result: JSON.parse(g.result_json),
  }));

  sendOps(api.ws, [{
    op: 'openWordle',
    state: {
      guesses,
      gameOver:   !!resultRow,
      solved:     resultRow ? !!resultRow.solved : false,
      dailyWord:  resultRow ? dailyWord : null,
      streak:     streakRow ? streakRow.current_streak : 0,
      bestStreak: streakRow ? streakRow.best_streak : 0,
      fromScreen: state.currentScreen,
      // Board-time (America/New_York) day key for the client's share-text —
      // additive field, existing clients that ignore it are unaffected.
      // Without this the client fell back to computing its own date via
      // `new Date().toISOString()`, which could drift a day from the
      // server's actual puzzle date right around either midnight.
      dayKey: today,
    },
  }]);
}

function handleWordleGuess(msg, api, state) {
  if (!requireAuth(api, state)) return;
  const guess = typeof msg.guess === 'string' ? msg.guess.trim().toLowerCase() : '';

  if (!/^[a-z]{5}$/.test(guess)) {
    sendOps(api.ws, [{ op: 'wordleError', message: 'Guess must be a 5-letter word.' }]); return;
  }
  const today = getWordleDate();
  const dailyWord = getDailyWord();
  if (!dailyWord) { sendOps(api.ws, [{ op: 'wordleError', message: 'Wordle is unavailable.' }]); return; }

  if (wordleGetResult.get(state.username, today)) {
    sendOps(api.ws, [{ op: 'wordleError', message: 'You have already played today.' }]); return;
  }

  const guessNum = wordleCountGuesses.get(state.username, today).n + 1;
  if (guessNum > 6) {
    sendOps(api.ws, [{ op: 'wordleError', message: 'No guesses remaining.' }]); return;
  }

  const result = scoreGuess(guess, dailyWord);
  wordleInsertGuess.run(state.username, today, guessNum, guess, JSON.stringify(result), nowEpoch());

  const solved = guess === dailyWord;
  const failed = !solved && guessNum === 6;

  if (solved || failed) {
    wordleUpsertResult.run(state.username, today, solved ? 1 : 0, guessNum, nowEpoch());

    const streakRow = wordleGetStreak.get(state.username);
    let cur  = streakRow ? streakRow.current_streak : 0;
    let best = streakRow ? streakRow.best_streak    : 0;
    if (solved) {
      cur = (streakRow && streakRow.last_played_date === getYesterday()) ? cur + 1 : 1;
      if (cur > best) best = cur;
    } else {
      cur = 0;
    }
    wordleUpsertStreak.run(state.username, cur, best, today);

    const allRows = wordleGetGuesses.all(state.username, today);
    const emojiGrid = buildWordleEmojiGrid(allRows);

    const WORDLE_CHROME_PAYOUTS = [0, 50, 40, 30, 20, 15, 10];
    const chromeEarned = solved ? (WORDLE_CHROME_PAYOUTS[guessNum] || 0) : 0;
    let newChromeBalance = 0;
    if (chromeEarned > 0) {
      try { newChromeBalance = chrome.award(state.username, chromeEarned, `wordle solve in ${guessNum}`); } catch {}
    }

    const feedMsg = solved
      ? `${state.username} solved today's Wordle in ${guessNum} guess${guessNum !== 1 ? 'es' : ''} and earned ${chromeEarned} ₢! 🟩`
      : `${state.username} was defeated by today's Wordle 💀`;
    try { gameFeedInsert.run(state.username, solved ? 'wordle_solved' : 'wordle_failed', feedMsg, nowEpoch()); } catch {}
    if (solved && guessNum <= 2) {
      addActivityEvent('games', 'wordle_ace', `🟩 ${state.username} solved today's Wordle in ${guessNum} guess${guessNum === 1 ? '' : 'es'}!`);
    }

    sendOps(api.ws, [{
      op:        'wordleGuessResult',
      result,
      guessNum,
      solved,
      failed,
      dailyWord,
      streak:    cur,
      bestStreak: best,
      emojiGrid: `DIS Wordle ${today}\n${guessNum}/6\n${emojiGrid}`,
      chromeEarned,
      newChromeBalance,
    }]);
  } else {
    sendOps(api.ws, [{ op: 'wordleGuessResult', result, guessNum, solved: false, failed: false }]);
  }
}

/* ======================= Slots machine ======================= */
const SLOTS_SYMBOLS = ['🍒', '🔔', '⭐', '💎', '💀'];
const SLOTS_WEIGHTS = [30, 25, 20, 15, 10];
const SLOTS_COST    = 5;

function pickSlotSymbol() {
  let r = Math.floor(Math.random() * 100);
  for (let i = 0; i < SLOTS_WEIGHTS.length; i++) {
    r -= SLOTS_WEIGHTS[i];
    if (r < 0) return SLOTS_SYMBOLS[i];
  }
  return SLOTS_SYMBOLS[0];
}

function evalSlots(reels) {
  const counts = {};
  let skulls = 0;
  for (const s of reels) {
    counts[s] = (counts[s] || 0) + 1;
    if (s === '💀') skulls++;
  }
  const maxCount = Math.max(...Object.values(counts));
  if (skulls === 5)   return { type: 'jackpot',     payout: 0   };
  if (maxCount === 5) return { type: 'five',         payout: 100 };
  if (maxCount >= 4)  return { type: 'four',         payout: 20  };  // was 30
  if (skulls >= 3)    return { type: 'three_skull',  payout: 12  };  // was 20
  if (maxCount >= 3)  return { type: 'three',        payout: 7   };  // was 8
  if (skulls >= 2)    return { type: 'two_skull',    payout: 4   };  // was 6
  if (skulls === 1)   return { type: 'one_skull',    payout: 0   };
  return                     { type: 'loss',         payout: 0   };
}

function handleSlotsGetState(api, state) {
  if (!requireAuth(api, state)) return;
  sendOps(api.ws, [{
    op:      'slots_state',
    jackpot: chrome.getJackpot(),
    balance: chrome.getBalance(state.username),
  }]);
}

function handleSlotsSpin(msg, api, state) {
  if (!requireAuth(api, state)) return;
  const username = state.username;

  const spendResult = chrome.spend(username, SLOTS_COST, 'slots spin');
  if (!spendResult.success) {
    sendOps(api.ws, [{ op: 'slots_result', error: 'not enough chrome to spin. come back tomorrow for your daily stipend.' }]);
    return;
  }

  const reels = Array.from({ length: 5 }, pickSlotSymbol);
  const outcome = evalSlots(reels);
  let payout = 0;
  let jackpotWon = false;
  let jackpotAmount = 0;
  let newBalance = spendResult.newBalance;
  let message = '';

  if (outcome.type === 'jackpot') {
    const claimed = chrome.claimJackpot(username);
    jackpotWon    = true;
    jackpotAmount = claimed.amount;
    newBalance    = claimed.newBalance;
    message       = `JACKPOT! you won ${fmtCr(jackpotAmount)} ₢! 💀`;
    const feedMsg = `🎰 ${username} hit the jackpot and won ${fmtCr(jackpotAmount)} ₢! 💀`;
    broadcastSystem(feedMsg);
    try { gameFeedInsert.run(username, 'slots_jackpot', feedMsg, nowEpoch()); } catch {}
    addActivityEvent('games', 'slots_jackpot', feedMsg);
  } else if (outcome.payout > 0) {
    newBalance = chrome.award(username, outcome.payout, 'slots win');
    payout     = outcome.payout;
    if (outcome.type === 'five') {
      message = `five of a kind! you won ${fmtCr(payout)} ₢! ⭐`;
      try { gameFeedInsert.run(username, 'slots_five', `${username} hit five of a kind on slots and won 100 ₢! ⭐`, nowEpoch()); } catch {}
      addActivityEvent('games', 'slots_five', `⭐ ${username} hit five of a kind on slots and won 100 ₢!`);
    } else if (outcome.type === 'four') {
      message = `four of a kind! you won ${fmtCr(payout)} ₢!`;
    } else if (outcome.type === 'three_skull') {
      message = `three skulls! you won ${fmtCr(payout)} ₢! 💀`;
    } else if (outcome.type === 'three') {
      message = `three of a kind! you won ${fmtCr(payout)} ₢!`;
    } else if (outcome.type === 'two_skull') {
      message = `two skulls! you won ${fmtCr(payout)} ₢! 💀`;
    }
  } else if (outcome.type === 'one_skull') {
    chrome.addToJackpot(1);
    message = `one skull — you lost 5 ₢. 1 ₢ added to jackpot. 💀`;
  } else {
    chrome.addToJackpot(2);
    message = 'no match. you lost 5 ₢. 2 ₢ added to jackpot.';
  }

  sendOps(api.ws, [{
    op:           'slots_result',
    reels,
    payout,
    newBalance,
    jackpotWon,
    jackpotAmount,
    message,
    jackpot:      chrome.getJackpot(),
  }]);
}

function cmdSlots(api, state, args) {
  if (!requireAuth(api, state)) return;
  const sub = ((args && args[0]) || '').trim().toLowerCase();

  if (sub === 'stats') {
    const username = state.username;
    const spins   = db.prepare(`SELECT COUNT(1) AS n FROM chrome_transactions WHERE username = ? AND reason = 'slots spin'`).get(username);
    const earned  = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM chrome_transactions WHERE username = ? AND reason IN ('slots win', 'slots jackpot')`).get(username);
    const biggest = db.prepare(`SELECT COALESCE(MAX(amount), 0) AS top FROM chrome_transactions WHERE username = ? AND reason IN ('slots win', 'slots jackpot')`).get(username);
    const totalSpins  = spins   ? spins.n     : 0;
    const totalEarned = earned  ? earned.total : 0;
    const totalSpent  = totalSpins * SLOTS_COST;
    const net         = totalEarned - totalSpent;
    const biggestWin  = biggest ? biggest.top  : 0;
    api.batch(b => {
      b.hr();
      b.print('== slots stats ==', 'magenta');
      b.print(`  total spins:   ${fmtCr(totalSpins)}`, 'cyan');
      b.print(`  total spent:   ${fmtCr(totalSpent)} ₢`, 'cyan');
      b.print(`  total earned:  ${fmtCr(totalEarned)} ₢`, 'cyan');
      b.print(`  net:           ${net >= 0 ? '+' : ''}${fmtCr(net)} ₢`, net >= 0 ? 'green' : 'red');
      b.print(`  biggest win:   ${fmtCr(biggestWin)} ₢`, 'cyan');
      b.hr();
    });
    return;
  }

  if (sub !== '') {
    api.print('usage: /slots — play nickel slots', 'dim');
    api.print('       /slots stats — your slots statistics', 'dim');
    return;
  }

  sendOps(api.ws, [{ op: 'openSlots' }]);
}

/* ======================= Mining ======================= */
const VEIN_SPECS = [
  { resource: 'bismuth',     count: 6, minLen: 6,  maxLen: 12 },
  { resource: 'cinnabar',    count: 6, minLen: 6,  maxLen: 12 },
  { resource: 'malachite',   count: 4, minLen: 4,  maxLen: 8  },
  { resource: 'vitriol',     count: 4, minLen: 4,  maxLen: 8  },
  { resource: 'brimstone',   count: 2, minLen: 3,  maxLen: 5  },
  { resource: 'obsidian',    count: 2, minLen: 3,  maxLen: 5  },
  { resource: 'alexandrite', count: 1, minLen: 2,  maxLen: 3  },
];
const DIRS8 = [
  { dc: -1, dr: -1 }, { dc: 0, dr: -1 }, { dc: 1, dr: -1 },
  { dc: -1, dr:  0 },                     { dc: 1, dr:  0 },
  { dc: -1, dr:  1 }, { dc: 0, dr:  1 }, { dc: 1, dr:  1 },
];
let _gridDateCached = null;

function ensureGridForToday() {
  const today = dayKeyET(); // board time (America/New_York) — see src/utils/time.js
  if (_gridDateCached === today) return;
  const existing = stmtCheckGridExists.get(today);
  if (existing && existing.n > 0) { _gridDateCached = today; return; }

  const grid = new Array(800).fill(null);
  function rInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

  for (const spec of VEIN_SPECS) {
    for (let v = 0; v < spec.count; v++) {
      let row = rInt(0, 19);
      let col = rInt(0, 39);
      const len = rInt(spec.minLen, spec.maxLen);
      let dir = DIRS8[Math.floor(Math.random() * DIRS8.length)];
      for (let step = 0; step < len; step++) {
        const idx = row * 40 + col;
        if (grid[idx] !== null) break;
        grid[idx] = spec.resource;
        if (Math.random() < 0.25) dir = DIRS8[Math.floor(Math.random() * DIRS8.length)];
        const nr = row + dir.dr;
        const nc = col + dir.dc;
        if (nr < 0 || nr >= 20 || nc < 0 || nc >= 40) break;
        row = nr; col = nc;
      }
    }
  }

  const insertAll = db.transaction(() => {
    for (let i = 0; i < 800; i++) stmtInsertGridCell.run(today, i, grid[i]);
  });
  insertAll();
  _gridDateCached = today;
}

function miningClickCost(clicksUsed) {
  const next = clicksUsed + 1;
  if (next <= 10) return 0;
  if (next === 11) return 2;
  if (next === 12) return 4;
  if (next === 13) return 6;
  if (next === 14) return 10;
  return 15;
}

function buildMiningInventory(username) {
  const inv = {};
  for (const key of Object.keys(RESOURCES)) inv[key] = 0;
  for (const row of stmtGetResourceBals.all(username)) {
    if (inv[row.resource] !== undefined) inv[row.resource] = row.amount;
  }
  return inv;
}

function handleMiningGetState(api, state) {
  if (!requireAuth(api, state)) return;
  applyDailyMarketDrift();
  const username = state.username;
  const today = dayKeyET(); // board time (America/New_York) — see src/utils/time.js
  ensureGridForToday();
  const gridRows = stmtGetMiningGrid.all(today);
  const clickRow = stmtGetMiningClicks.get(username, today);
  const clicksUsed = clickRow ? clickRow.click_count : 0;
  const cells = gridRows.map(r => ({
    index:      r.cell_index,
    revealed:   r.revealed_by !== null,
    resource:   r.revealed_by !== null ? r.resource : null,
    revealedBy: r.revealed_by,
  }));
  sendOps(api.ws, [{
    op:                  'mining_state',
    cells,
    clicksUsed,
    freeClicksRemaining: Math.max(0, 10 - clicksUsed),
    nextClickCost:       miningClickCost(clicksUsed),
    balance:             chrome.getBalance(username),
    inventory:           buildMiningInventory(username),
  }]);
}

function handleMiningClick(msg, api, state) {
  if (!requireAuth(api, state)) return;
  const username  = state.username;
  const cellIndex = typeof msg.cellIndex === 'number' ? Math.floor(msg.cellIndex) : -1;
  if (cellIndex < 0 || cellIndex > 799) {
    sendOps(api.ws, [{ op: 'error', message: 'invalid cell.' }]); return;
  }
  const today = dayKeyET(); // board time (America/New_York) — see src/utils/time.js
  ensureGridForToday();
  const cell = stmtGetMiningCell.get(today, cellIndex);
  if (!cell || cell.revealed_by !== null) {
    sendOps(api.ws, [{ op: 'error', message: 'cell not available.' }]); return;
  }
  const clickRow  = stmtGetMiningClicks.get(username, today);
  const clicksUsed = clickRow ? clickRow.click_count : 0;
  const cost = miningClickCost(clicksUsed);
  if (cost > 0) {
    const spend = chrome.spend(username, cost, 'mining click');
    if (!spend.success) {
      sendOps(api.ws, [{ op: 'error', message: 'not enough chrome to dig deeper today.' }]); return;
    }
  }
  stmtRevealCell.run(username, nowEpoch(), today, cellIndex);
  stmtUpsertMiningClicks.run(username, today);
  if (cell.resource) {
    stmtUpsertResourceBal.run(username, cell.resource);
    if (cell.resource === 'alexandrite') {
      addActivityEvent('chrome', 'mining_rare', `💎 ${username} struck alexandrite while mining!`);
    }
  }

  HUB.clients.forEach(ws => sendOps(ws, [{
    op: 'mining_cell_revealed',
    cellIndex,
    resource: cell.resource || null,
    revealedBy: username,
  }]));

  const newClicksUsed = clicksUsed + 1;
  sendOps(api.ws, [{
    op:                  'mining_result',
    cellIndex,
    resource:            cell.resource || null,
    balance:             chrome.getBalance(username),
    inventory:           buildMiningInventory(username),
    clicksUsed:          newClicksUsed,
    freeClicksRemaining: Math.max(0, 10 - newClicksUsed),
    nextClickCost:       miningClickCost(newClicksUsed),
  }]);
}

function cmdMining(api, state) {
  if (!requireAuth(api, state)) return;
  sendOps(api.ws, [{ op: 'openMining' }]);
}

/* ======================= Hack (terminal cracking) ======================= */
function hackSeededRng(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822519);
    h = Math.imul(h ^ (h >>> 13), 3266489917);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

function hackRandInt(rng, n) {
  return Math.floor(rng() * n);
}

function hackShuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = hackRandInt(rng, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

let _hackDailyCache = { date: null, data: null };

function getDailyHack(dateStr) {
  if (_hackDailyCache.date === dateStr && _hackDailyCache.data) return _hackDailyCache.data;

  const rng = hackSeededRng(`hack:${dateStr}`);
  const epochDay = Math.floor(Date.parse(`${dateStr}T00:00:00Z`) / 86400000);
  const lengths = [5, 6, 7];
  const wordLength = lengths[((epochDay % 3) + 3) % 3];

  // Defensive: the curated lists may contain stray duplicates/mismatched lengths — filter to be safe.
  const pool = Array.from(new Set((HACK_WORDS[wordLength] || []).filter(w => w.length === wordLength)));
  hackShuffle(pool, rng);
  const password = pool[0];
  const decoys = pool.slice(1, 12);
  const words = hackShuffle([password, ...decoys], rng);

  const noiseChars = [];
  for (let i = 0; i < HACK_NOISE_LEN; i++) {
    noiseChars.push(HACK_NOISE_CHARSET[hackRandInt(rng, HACK_NOISE_CHARSET.length)]);
  }

  const occupied = [];
  function canPlace(start, len) {
    if (start < 0 || start + len > HACK_NOISE_LEN) return false;
    const bufStart = Math.max(0, start - 1);
    const bufEnd = Math.min(HACK_NOISE_LEN, start + len + 1);
    for (const [os, oe] of occupied) {
      if (bufStart < oe && os < bufEnd) return false;
    }
    return true;
  }
  function place(str) {
    let start = -1;
    for (let tries = 0; tries < 500; tries++) {
      const candidate = hackRandInt(rng, HACK_NOISE_LEN - str.length + 1);
      if (canPlace(candidate, str.length)) { start = candidate; break; }
    }
    if (start === -1) {
      for (let s = 0; s <= HACK_NOISE_LEN - str.length; s++) {
        if (canPlace(s, str.length)) { start = s; break; }
      }
    }
    if (start === -1) return;
    for (let i = 0; i < str.length; i++) noiseChars[start + i] = str[i];
    occupied.push([start, start + str.length]);
  }

  function randToken(open, close) {
    let inner = '';
    for (let i = 0; i < 4; i++) inner += HACK_NOISE_CHARSET[hackRandInt(rng, HACK_NOISE_CHARSET.length)];
    return `${open}${inner}${close}`;
  }
  const dudToken   = randToken('(', ')');
  const resetToken = randToken('[', ']');

  words.forEach(w => place(w));
  place(dudToken);
  place(resetToken);

  const data = {
    wordLength,
    password,
    decoys,
    words,
    noise: noiseChars.join(''),
    brackets: [
      { token: dudToken, effect: 'dud' },
      { token: resetToken, effect: 'reset' },
    ],
  };
  _hackDailyCache = { date: dateStr, data };
  return data;
}

const hackSessions = new Map(); // username -> in-progress session state for today's terminal

function getOrCreateHackSession(username, dateStr) {
  const existing = hackSessions.get(username);
  if (existing && existing.date === dateStr) return existing;
  const daily = getDailyHack(dateStr);
  const session = {
    date:        dateStr,
    wordLength:  daily.wordLength,
    password:    daily.password,
    decoys:      daily.decoys.slice(),
    words:       daily.words.slice(),
    noise:       daily.noise,
    brackets:    daily.brackets.map(b => ({ token: b.token, effect: b.effect, used: false })),
    guessed:     [],
    attemptsUsed: 0,
    removedWord: null,
    over:        false,
    solved:      false,
  };
  hackSessions.set(username, session);
  return session;
}

function handleHackGetState(api, state) {
  if (!requireAuth(api, state)) return;
  const username = state.username;
  const today = getWordleDate();
  const logRow = stmtHackGetLog.get(username, today);

  if (logRow) {
    hackSessions.delete(username);
    sendOps(api.ws, [{
      op:            'hack_state',
      alreadyPlayed: true,
      solved:        !!logRow.solved,
      attemptsUsed:  logRow.attempts,
      chromeWon:     logRow.chrome_won,
    }]);
    return;
  }

  const session = getOrCreateHackSession(username, today);
  sendOps(api.ws, [{
    op:                 'hack_state',
    alreadyPlayed:      false,
    solved:             false,
    attemptsUsed:       session.attemptsUsed,
    chromeWon:          0,
    wordLength:         session.wordLength,
    noise:              session.noise,
    words:              session.words,
    brackets:           session.brackets.map(b => b.token),
    attemptsRemaining:  4 - session.attemptsUsed,
    guesses:            session.guessed,
    usedBrackets:       session.brackets.filter(b => b.used).map(b => b.token),
    removedWord:        session.removedWord,
  }]);
}

function handleHackGuess(msg, api, state) {
  if (!requireAuth(api, state)) return;
  const username = state.username;
  const today = getWordleDate();

  if (stmtHackGetLog.get(username, today)) {
    sendOps(api.ws, [{ op: 'hack_error', message: 'You have already played today.' }]); return;
  }

  const session = getOrCreateHackSession(username, today);
  if (session.over) {
    sendOps(api.ws, [{ op: 'hack_error', message: 'Terminal session already ended.' }]); return;
  }
  if (session.attemptsUsed >= 4) {
    sendOps(api.ws, [{ op: 'hack_error', message: 'No attempts remaining.' }]); return;
  }

  const raw = typeof msg.word === 'string' ? msg.word.trim().toUpperCase() : '';
  if (!session.words.includes(raw)) {
    sendOps(api.ws, [{ op: 'hack_error', message: 'Not a valid password candidate.' }]); return;
  }
  if (session.guessed.some(g => g.word === raw)) {
    sendOps(api.ws, [{ op: 'hack_error', message: 'You already tried that word.' }]); return;
  }

  const password = session.password;
  let likeness = 0;
  for (let i = 0; i < password.length; i++) {
    if (raw[i] === password[i]) likeness++;
  }
  const correct = raw === password;

  session.attemptsUsed++;
  session.guessed.push({ word: raw, likeness });
  const attemptsRemaining = 4 - session.attemptsUsed;

  let gameOver = false;
  let chromeWon = 0;

  if (correct) {
    gameOver = true;
    session.over = true;
    session.solved = true;
    const payoutTable = HACK_PAYOUTS[session.wordLength] || HACK_PAYOUTS[5];
    chromeWon = payoutTable[session.attemptsUsed - 1] || payoutTable[payoutTable.length - 1];
    try { chrome.award(username, chromeWon, `hack solve in ${session.attemptsUsed}`); } catch {}
    try { stmtHackUpsertLog.run(username, today, 1, session.attemptsUsed, chromeWon, session.wordLength); }
    catch (e) { console.error('[hack] log failed:', e && e.message); }

    addActivityEvent('games', 'hack_solved', `💻 ${username} cracked today's terminal`);
    if (session.attemptsUsed === 1) {
      addActivityEvent('games', 'hack_ace', `💻 ${username} cracked the terminal on the first try!`);
    }
    hackSessions.delete(username);
  } else if (attemptsRemaining <= 0) {
    gameOver = true;
    session.over = true;
    session.solved = false;
    chromeWon = HACK_FAIL_CONSOLATION;
    try { chrome.award(username, chromeWon, 'hack fail consolation'); } catch {}
    try { stmtHackUpsertLog.run(username, today, 0, session.attemptsUsed, chromeWon, session.wordLength); }
    catch (e) { console.error('[hack] log failed:', e && e.message); }
    hackSessions.delete(username);
  }

  sendOps(api.ws, [{
    op:    'hack_result',
    word:  raw,
    correct,
    likeness,
    attemptsRemaining,
    gameOver,
    solved: correct,
    chromeWon,
    password: gameOver ? password : undefined,
  }]);
}

function handleHackBracket(msg, api, state) {
  if (!requireAuth(api, state)) return;
  const username = state.username;
  const today = getWordleDate();

  if (stmtHackGetLog.get(username, today)) {
    sendOps(api.ws, [{ op: 'hack_error', message: 'You have already played today.' }]); return;
  }

  const session = hackSessions.get(username);
  if (!session || session.date !== today || session.over) {
    sendOps(api.ws, [{ op: 'hack_error', message: 'No active terminal session.' }]); return;
  }

  const token = typeof msg.token === 'string' ? msg.token : '';
  const bracket = session.brackets.find(b => b.token === token);
  if (!bracket || bracket.used) {
    sendOps(api.ws, [{ op: 'hack_error', message: 'Invalid or already-used bracket.' }]); return;
  }
  bracket.used = true;

  if (bracket.effect === 'dud') {
    const candidates = session.decoys.filter(w =>
      !session.guessed.some(g => g.word === w) && w !== session.removedWord
    );
    const pool = candidates.length ? candidates : session.decoys.filter(w => w !== session.removedWord);
    const removeWord = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
    session.removedWord = removeWord;
    sendOps(api.ws, [{ op: 'hack_bracket', token, effect: 'dud', removeWord }]);
    return;
  }

  if (bracket.effect === 'reset') {
    session.attemptsUsed = Math.max(0, session.attemptsUsed - 1);
    const attemptsRemaining = 4 - session.attemptsUsed;
    sendOps(api.ws, [{ op: 'hack_bracket', token, effect: 'reset', attemptsRemaining }]);
    return;
  }
}

function cmdHack(api, state) {
  if (!requireAuth(api, state)) return;
  sendOps(api.ws, [{ op: 'openHack' }]);
}

/* ======================= Dots and Boxes ======================= */
// nowEpoch() has 1-second resolution; turn eligibility relies on strict
// timestamp ordering (lastDraw.last > myTurn.last_drew_at), so two moves
// landing in the same wall-clock second would otherwise tie and wrongly
// block the next legitimate turn. Guarantee strictly increasing values
// per game instead of touching the shared nowEpoch() behavior.
const _dotsLastTimestamp = new Map(); // gameId -> last used monotonic timestamp
function dotsNextTimestamp(gameId) {
  const now = nowEpoch();
  const prev = _dotsLastTimestamp.get(gameId) || 0;
  const next = now > prev ? now : prev + 1;
  _dotsLastTimestamp.set(gameId, next);
  return next;
}

function dotsGetOrCreateGame() {
  let game = stmtDotsActiveGame.get();
  const now = nowEpoch();
  if (!game || now > game.ends_at) {
    if (game) stmtDotsFinishGame.run(game.id);
    stmtDotsCreateGame.run(now, now + 7 * 86400);
    game = stmtDotsActiveGame.get();
  }
  return game;
}

// Build full board state from DB for a given game_id
function dotsBuildState(gameId) {
  const lines   = new Array(DOTS_TOTAL_LINES).fill(null);
  const squares = {};
  for (const r of stmtDotsGetLines.all(gameId))   lines[r.line_idx] = r.drawn_by;
  for (const s of stmtDotsGetSquares.all(gameId)) squares[`${s.sq_row},${s.sq_col}`] = s.claimed_by;
  const scores = stmtDotsScores.all(gameId);
  return { lines, squares, scores };
}

// Build { username: color } for everyone who has drawn a line or claimed a square this game
function dotsBuildPlayerColors(gameId) {
  const usernames = new Set();
  for (const r of stmtDotsGetLines.all(gameId))   usernames.add(r.drawn_by);
  for (const s of stmtDotsScores.all(gameId))     usernames.add(s.claimed_by);
  const colors = {};
  for (const u of usernames) colors[u] = dotsPlayerColor(u);
  return colors;
}

function cmdDots(api, state) {
  if (!requireAuth(api, state)) return;
  sendOps(api.ws, [{ op: 'openDots' }]);
}

/* ======================= Market ======================= */
function applyDailyMarketDrift() {
  const today = dayKeyET(); // board time (America/New_York) — see src/utils/time.js
  const rows  = stmtGetAllMarketPrices.all();
  for (const row of rows) {
    if (row.last_drift_date === today) continue;
    const floor   = RESOURCE_FLOORS[row.resource];
    const ceiling = RESOURCE_CEILINGS[row.resource];
    if (!floor || !ceiling) continue;
    const pct      = 0.10 + Math.random() * 0.10;
    const sign     = Math.random() < 0.5 ? 1 : -1;
    const newPrice = Math.max(floor, Math.min(ceiling, row.current_price * (1 + sign * pct)));
    stmtDriftMarketPrice.run(newPrice, today, row.resource);
  }
}

function buildMarketPrices() {
  const rows   = stmtGetAllMarketPrices.all();
  const prices = {};
  for (const row of rows) {
    const cur  = row.current_price;
    const prev = row.previous_price;
    let trend  = 'stable';
    if (prev != null) {
      if (cur > prev * 1.01) trend = 'rising';
      else if (cur < prev * 0.99) trend = 'falling';
    }
    prices[row.resource] = { price: Math.round(cur), trend };
  }
  return prices;
}

function renderMarket(api, state, flash) {
  if (!requireAuth(api, state)) return;
  applyDailyMarketDrift();
  const username  = state.username;
  const prices    = buildMarketPrices();
  const inventory = buildMiningInventory(username);
  const balance   = chrome.getBalance(username);
  api.batch(b => {
    b.clear();
    b.setInputLimit(null);
    b.hrTitled('Market');
    if (flash) { b.printHTML(flash); b.hr(); }
    for (const key of Object.keys(RESOURCES)) {
      const r   = RESOURCES[key];
      const p   = prices[key] || { price: 0, trend: 'stable' };
      const inv = inventory[key] || 0;
      const name     = r.label.padEnd(13);
      const priceStr = (fmtCr(p.price) + ' ₢').padEnd(10);
      let trendColor, trendStr;
      if      (p.trend === 'rising')  { trendColor = '#4caf50'; trendStr = '↑ rising  '; }
      else if (p.trend === 'falling') { trendColor = '#f44336'; trendStr = '↓ falling '; }
      else                            { trendColor = '#555555'; trendStr = '↔ stable  '; }
      b.printHTML(
        `  <span style="color:${r.color}">${escapeHTML(name)}</span>` +
        `  <span style="color:#aaa">${escapeHTML(priceStr)}</span>` +
        `  <span style="color:${trendColor}">${escapeHTML(trendStr)}</span>` +
        `  you have: <span style="color:${r.color}">${escapeHTML(String(inv))}</span>`
      );
    }
    b.hr();
    b.print(`  your balance: ${fmtCr(balance)} ₢`, 'cyan');
    b.hr();
    b.print('— /sell [resource] [amount]  •  /buy [resource] [amount]  •  /market to refresh —', 'dim');
  });
}

function cmdMarketSell(api, state, args) {
  if (!requireAuth(api, state)) return;
  const username = state.username;
  const resource = String((args && args[0]) || '').toLowerCase().trim();
  const amount   = Math.floor(Number((args && args[1]) || 0));
  if (!RESOURCES[resource] || amount < 1) {
    api.print('usage: /sell [resource] [amount]   e.g. /sell cinnabar 3', 'yellow'); return;
  }
  const balRow = stmtGetResourceBal.get(username, resource);
  const have   = balRow ? balRow.amount : 0;
  if (have < amount) {
    api.print(`you don't have that much ${RESOURCES[resource].label} to sell.`, 'red'); return;
  }
  const priceRow   = stmtGetMarketPrice.get(resource);
  const payout     = Math.round(priceRow.current_price * amount);
  stmtDeductResourceBal.run(amount, username, resource);
  chrome.award(username, payout, `market sell: ${resource}`);
  const newPrice = Math.max(RESOURCE_FLOORS[resource], priceRow.current_price * 0.975);
  stmtNudgeMarketPrice.run(newPrice, resource);
  if (resource === 'alexandrite') {
    addActivityEvent('chrome', 'market_alexandrite', `🔮 ${username} sold alexandrite on the market!`);
  }
  const newBalance = chrome.getBalance(username);
  const { label, color } = RESOURCES[resource];
  const flash = `  sold ${escapeHTML(String(amount))} <span style="color:${color}">${escapeHTML(label)}</span> for ${escapeHTML(fmtCr(payout))} ₢.  your balance: ${escapeHTML(fmtCr(newBalance))} ₢`;
  renderMarket(api, state, flash);
}

function cmdMarketBuy(api, state, args) {
  if (!requireAuth(api, state)) return;
  const username = state.username;
  const resource = String((args && args[0]) || '').toLowerCase().trim();
  const amount   = Math.floor(Number((args && args[1]) || 0));
  if (!RESOURCES[resource] || amount < 1) {
    api.print('usage: /buy [resource] [amount]   e.g. /buy cinnabar 3', 'yellow'); return;
  }
  const priceRow = stmtGetMarketPrice.get(resource);
  const cost     = Math.round(priceRow.current_price * amount);
  const spend    = chrome.spend(username, cost, `market buy: ${resource}`);
  if (!spend.success) {
    api.print('not enough chrome for that.', 'red'); return;
  }
  stmtAddResourceBal.run(username, resource, amount);
  const newPrice = Math.min(RESOURCE_CEILINGS[resource], priceRow.current_price * 1.025);
  stmtNudgeMarketPrice.run(newPrice, resource);
  if (resource === 'alexandrite') {
    addActivityEvent('chrome', 'market_alexandrite', `🔮 ${username} bought alexandrite on the market!`);
  }
  const newBalance = chrome.getBalance(username);
  const { label, color } = RESOURCES[resource];
  const flash = `  bought ${escapeHTML(String(amount))} <span style="color:${color}">${escapeHTML(label)}</span> for ${escapeHTML(fmtCr(cost))} ₢.  your balance: ${escapeHTML(fmtCr(newBalance))} ₢`;
  renderMarket(api, state, flash);
}

/* ======================= Rob ======================= */
const robCooldowns = new Map(); // 'attacker:target' → last attempt timestamp (ms)

function attemptRob(attackerUsername, targetUsername, resource) {
  if (!RESOURCES[resource]) return { error: `unknown resource: ${resource}.` };

  const { label, color, tier } = RESOURCES[resource];

  const attackerRes = stmtGetResourceBal.get(attackerUsername, resource);
  if (!attackerRes || attackerRes.amount < 1) {
    return { error: `you don't have any ${label} to use.` };
  }

  const targetRow = db.prepare('SELECT username FROM chrome_balances WHERE LOWER(username) = LOWER(?)').get(targetUsername);
  if (!targetRow) return { error: `no user found: ${targetUsername}.` };

  const resolvedTarget = targetRow.username;
  if (resolvedTarget.toLowerCase() === attackerUsername.toLowerCase()) {
    return { error: 'you can\'t rob yourself.' };
  }

  const targetBalance   = chrome.getBalance(resolvedTarget);
  if (targetBalance === 0) return { error: `${resolvedTarget} has nothing worth stealing.` };

  const attackerBalance = chrome.getBalance(attackerUsername);
  const ratio    = attackerBalance > 0 ? targetBalance / attackerBalance : 1.6;
  const adjRatio = Math.max(0.4, Math.min(1.6, ratio));
  const odds     = Math.max(0.05, Math.min(0.90, ROB_BASE_SUCCESS[tier] * adjRatio));

  stmtDeductResourceBal.run(1, attackerUsername, resource);

  if (Math.random() < odds) {
    const [pctMin, pctMax] = ROB_STEAL_PCT[tier];
    const pct    = pctMin + Math.random() * (pctMax - pctMin);
    const amount = Math.min(targetBalance, Math.max(1, Math.round(targetBalance * pct)));
    chrome.spend(resolvedTarget, amount, `robbed by ${attackerUsername}`);
    chrome.award(attackerUsername, amount, `robbed ${resolvedTarget}`);
    stmtInsertRobLog.run(attackerUsername, resolvedTarget, resource, 1, amount, nowEpoch());
    addActivityEvent('chrome', 'robbery', `💀 ${attackerUsername} robbed ${resolvedTarget} for ${fmtCr(amount)} ₢!`);
    return { success: true, amount, odds, resolvedTarget };
  } else {
    stmtInsertRobLog.run(attackerUsername, resolvedTarget, resource, 0, 0, nowEpoch());
    return { success: false, odds, resolvedTarget };
  }
}

function cmdGrind(api, state) {
  if (!requireAuth(api, state)) return;
  chrome.award(state.username, 1, 'grind');
  const balance = chrome.getBalance(state.username);
  api.print(`you grind for a moment... +1 ₢  (balance: ${balance} ₢)`, 'dim');
}

function cmdRob(api, state, args) {
  if (!requireAuth(api, state)) return;
  const attackerUsername = state.username;
  const targetUsername   = String((args && args[0]) || '').trim();
  const resource         = String((args && args[1]) || '').toLowerCase().trim();

  if (!targetUsername || !resource) {
    api.print('usage: /rob [username] [resource]   e.g. /rob marmalade cinnabar', 'yellow');
    return;
  }

  const cooldownKey = `${attackerUsername.toLowerCase()}:${targetUsername.toLowerCase()}`;
  const lastAttempt = robCooldowns.get(cooldownKey);
  if (lastAttempt && (Date.now() - lastAttempt) < 5 * 60 * 1000) {
    api.print(`you need to lay low before trying ${targetUsername} again. wait a few minutes.`, 'yellow');
    return;
  }

  const result = attemptRob(attackerUsername, targetUsername, resource);

  if (result.error) {
    api.print(result.error, 'red');
    return;
  }

  robCooldowns.set(cooldownKey, Date.now());

  const { label, color } = RESOURCES[resource];
  const newBalance = chrome.getBalance(attackerUsername);

  if (result.success) {
    api.batch(b => {
      b.printHTML(
        `you robbed ${escapeHTML(result.resolvedTarget)} for ${escapeHTML(fmtCr(result.amount))} ₢ ` +
        `using <span style="color:${color}">${escapeHTML(label)}</span>!  ` +
        `your balance: ${escapeHTML(fmtCr(newBalance))} ₢`
      );
    });
  } else {
    api.print(`the robbery failed. ${result.resolvedTarget} noticed nothing.  your balance: ${fmtCr(newBalance)} ₢`, 'dim');
  }
}

/* ======================= Blackjack ======================= */
const blackjackHands = new Map();

const BJ_SUITS = ['♠', '♥', '♦', '♣'];
const BJ_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function bjBuildDeck() {
  const deck = [];
  for (const suit of BJ_SUITS) {
    for (const rank of BJ_RANKS) deck.push({ rank, suit });
  }
  return deck;
}

function bjShuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function bjHandValue(hand) {
  let value = 0, aces = 0;
  for (const card of hand) {
    if (card.rank === 'A') { value += 11; aces++; }
    else if (card.rank === 'J' || card.rank === 'Q' || card.rank === 'K') value += 10;
    else value += parseInt(card.rank, 10);
  }
  while (value > 21 && aces > 0) { value -= 10; aces--; }
  return value;
}

function bjIsNatural(hand) {
  if (hand.length !== 2) return false;
  const hasAce = hand.some(c => c.rank === 'A');
  const hasTen = hand.some(c => c.rank === '10' || c.rank === 'J' || c.rank === 'Q' || c.rank === 'K');
  return hasAce && hasTen;
}

function handleBlackjackGetState(api, state) {
  if (!requireAuth(api, state)) return;
  const hand = blackjackHands.get(state.username);
  const balance = chrome.getBalance(state.username);
  if (!hand) {
    sendOps(api.ws, [{ op: 'blackjack_state', status: 'betting', balance }]);
    return;
  }
  sendOps(api.ws, [{
    op: 'blackjack_state',
    playerHand: hand.playerHand,
    dealerVisible: [hand.dealerHand[0]],
    playerValue: bjHandValue(hand.playerHand),
    status: 'playing',
    bet: hand.bet,
    balance,
  }]);
}

function handleBlackjackDeal(msg, api, state) {
  if (!requireAuth(api, state)) return;
  const username = state.username;
  const balance = chrome.getBalance(username);

  if (balance <= 0) {
    sendOps(api.ws, [{ op: 'blackjack_state', status: 'betting', balance, error: 'not enough chrome to play. come back tomorrow for your daily stipend.' }]);
    return;
  }

  const bet = parseInt(msg.bet, 10);
  if (!bet || bet < 1 || bet > balance) {
    sendOps(api.ws, [{ op: 'blackjack_state', status: 'betting', balance, error: `invalid bet. minimum 1 ₢, maximum ${fmtCr(balance)} ₢.` }]);
    return;
  }

  const deck = bjShuffle(bjBuildDeck());
  const playerHand = [deck.pop(), deck.pop()];
  const dealerHand = [deck.pop(), deck.pop()];

  if (bjIsNatural(playerHand)) {
    const payout = Math.floor(bet * 1.5);
    const newBalance = chrome.award(username, payout, 'blackjack natural');
    const feedMsg = `${username} hit blackjack and won ${fmtCr(payout)} ₢! 🃏`;
    try { gameFeedInsert.run(username, 'blackjack_natural', feedMsg, nowEpoch()); } catch {}
    sendOps(api.ws, [{
      op: 'blackjack_result',
      playerHand,
      dealerHand,
      playerValue: bjHandValue(playerHand),
      dealerValue: bjHandValue(dealerHand),
      result: 'blackjack',
      payout,
      newBalance,
    }]);
    return;
  }

  blackjackHands.set(username, { deck, playerHand, dealerHand, bet, status: 'playing' });
  sendOps(api.ws, [{
    op: 'blackjack_state',
    playerHand,
    dealerVisible: [dealerHand[0]],
    playerValue: bjHandValue(playerHand),
    status: 'playing',
    bet,
    balance,
  }]);
}

function handleBlackjackHit(msg, api, state) {
  if (!requireAuth(api, state)) return;
  const username = state.username;
  const hand = blackjackHands.get(username);
  if (!hand || hand.status !== 'playing') {
    sendOps(api.ws, [{ op: 'blackjack_state', status: 'betting', balance: chrome.getBalance(username) }]);
    return;
  }
  hand.playerHand.push(hand.deck.pop());
  const playerValue = bjHandValue(hand.playerHand);
  if (playerValue > 21) {
    const spendResult = chrome.spend(username, hand.bet, 'blackjack loss');
    blackjackHands.delete(username);
    sendOps(api.ws, [{
      op: 'blackjack_result',
      playerHand: hand.playerHand,
      dealerHand: hand.dealerHand,
      playerValue,
      dealerValue: bjHandValue(hand.dealerHand),
      result: 'bust',
      payout: 0,
      newBalance: spendResult.success ? spendResult.newBalance : chrome.getBalance(username),
    }]);
    return;
  }
  sendOps(api.ws, [{
    op: 'blackjack_state',
    playerHand: hand.playerHand,
    dealerVisible: [hand.dealerHand[0]],
    playerValue,
    status: 'playing',
    bet: hand.bet,
    balance: chrome.getBalance(username),
  }]);
}

function handleBlackjackStand(msg, api, state) {
  if (!requireAuth(api, state)) return;
  const username = state.username;
  const hand = blackjackHands.get(username);
  if (!hand || hand.status !== 'playing') {
    sendOps(api.ws, [{ op: 'blackjack_state', status: 'betting', balance: chrome.getBalance(username) }]);
    return;
  }

  while (bjHandValue(hand.dealerHand) <= 16) hand.dealerHand.push(hand.deck.pop());

  const playerValue = bjHandValue(hand.playerHand);
  const dealerValue = bjHandValue(hand.dealerHand);
  blackjackHands.delete(username);

  let result, payout, newBalance;
  if (dealerValue > 21 || playerValue > dealerValue) {
    payout = hand.bet;
    newBalance = chrome.award(username, payout, 'blackjack win');
    result = 'win';
    if (hand.bet > 100) {
      const feedMsg = `${username} won ${fmtCr(payout)} ₢ at blackjack! 🃏`;
      try { gameFeedInsert.run(username, 'blackjack_win', feedMsg, nowEpoch()); } catch {}
    }
  } else {
    payout = 0;
    const spendResult = chrome.spend(username, hand.bet, 'blackjack loss');
    newBalance = spendResult.success ? spendResult.newBalance : chrome.getBalance(username);
    result = playerValue === dealerValue ? 'tie' : 'lose';
  }

  sendOps(api.ws, [{
    op: 'blackjack_result',
    playerHand: hand.playerHand,
    dealerHand: hand.dealerHand,
    playerValue,
    dealerValue,
    result,
    payout,
    newBalance,
  }]);
}

function cmdBlackjack(api, state, args) {
  if (!requireAuth(api, state)) return;
  const sub = ((args && args[0]) || '').trim().toLowerCase();

  if (sub === 'stats') {
    const username = state.username;
    const wins    = db.prepare(`SELECT COUNT(1) AS n FROM chrome_transactions WHERE username = ? AND reason IN ('blackjack win', 'blackjack natural')`).get(username);
    const losses  = db.prepare(`SELECT COUNT(1) AS n FROM chrome_transactions WHERE username = ? AND reason = 'blackjack loss'`).get(username);
    const net     = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM chrome_transactions WHERE username = ? AND reason IN ('blackjack win', 'blackjack natural', 'blackjack loss')`).get(username);
    const biggest = db.prepare(`SELECT COALESCE(MAX(amount), 0) AS top FROM chrome_transactions WHERE username = ? AND reason IN ('blackjack win', 'blackjack natural')`).get(username);
    const totalWins   = wins.n   || 0;
    const totalLosses = losses.n || 0;
    const totalHands  = totalWins + totalLosses;
    const winRate     = totalHands > 0 ? Math.round((totalWins / totalHands) * 100) : 0;
    const netChrome   = net.total || 0;
    const biggestWin  = biggest.top || 0;
    api.batch(b => {
      b.hr();
      b.print('== blackjack stats ==', 'magenta');
      b.print(`  total hands:   ${fmtCr(totalHands)}`, 'cyan');
      b.print(`  wins:          ${fmtCr(totalWins)}`, 'cyan');
      b.print(`  losses:        ${fmtCr(totalLosses)}`, 'cyan');
      b.print(`  win rate:      ${winRate}%`, 'cyan');
      b.print(`  net chrome:    ${netChrome >= 0 ? '+' : ''}${fmtCr(netChrome)} ₢`, netChrome >= 0 ? 'green' : 'red');
      b.print(`  biggest win:   ${fmtCr(biggestWin)} ₢`, 'cyan');
      b.hr();
    });
    return;
  }

  if (sub !== '') {
    api.print('usage: /blackjack — play simplified blackjack', 'dim');
    api.print('       /blackjack stats — your statistics', 'dim');
    return;
  }

  const balance = chrome.getBalance(state.username);
  sendOps(api.ws, [{ op: 'openBlackjack', balance }]);
}

/* ======================= Donations (/donate, /donations, /linkdonor) ======================= */
// "This month" is a board-time (America/New_York) boundary. SQLite's
// strftime('now') is UTC-only and can't apply DST rules, so the month
// match happens here in JS via dayKeyET instead of in the query.
function computeMonthDonationSummary() {
  const monthKey = dayKeyET().slice(0, 7); // 'YYYY-MM', board time
  const rows = listDonationsForMonthCalc.all()
    .filter(r => dayKeyET(r.created_at * 1000).slice(0, 7) === monthKey);

  const totalAmount = rows.reduce((sum, r) => sum + r.amount, 0);
  const totalCount = new Set(rows.map(r => r.kofi_transaction_id)).size;

  const byDonor = new Map();
  for (const r of rows) {
    if (!r.dis_username) continue;
    byDonor.set(r.dis_username, (byDonor.get(r.dis_username) || 0) + r.amount);
  }
  const topDonors = Array.from(byDonor, ([dis_username, total]) => ({ dis_username, total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  return { totalAmount, totalCount, topDonors };
}

function cmdDonate(api, state) {
  if (!requireAuth(api, state)) return;
  const { totalAmount, topDonors } = computeMonthDonationSummary();

  const pct = KOFI_MONTHLY_GOAL > 0 ? (totalAmount / KOFI_MONTHLY_GOAL) * 100 : 0;
  const filled = Math.min(20, Math.round((Math.min(100, pct) / 100) * 20));
  const empty = 20 - filled;
  const barContent = `<span class="cyan">${'█'.repeat(filled)}</span><span class="dim">${'░'.repeat(empty)}</span>`;

  let goalNote = '';
  if (pct >= 100) goalNote = pct > 100 ? `  +${Math.round(pct - 100)}% over goal ♥` : '  goal reached! ♥';

  api.batch(b => {
    b.clear();
    b.hr();
    b.print('  == Support DIS ==', 'magenta');
    b.hr();
    b.print('  DIS is a handmade space. no ads, no investors,', 'white');
    b.print('  no algorithm — just people.', 'white');
    b.print(' ', 'dim');
    b.printHTML(`  this month: [${barContent}]  ${escapeHTML(Math.round(pct).toString())}%${escapeHTML(goalNote)}`);
    b.printHTML(`  <span class="dim">$${escapeHTML(totalAmount.toFixed(2))} raised of $${escapeHTML(KOFI_MONTHLY_GOAL.toFixed(0))} goal</span>`);
    if (topDonors.length > 0) {
      b.print(' ', 'dim');
      b.print('  ── top supporters this month ──', 'dim');
      for (let i = 0; i < topDonors.length; i++) {
        const d = topDonors[i];
        b.printHTML(`  ${i + 1}. <span class="cyan">${escapeHTML(d.dis_username)}</span>  <span class="dim">$${escapeHTML(d.total.toFixed(2))}</span>`);
      }
    }
    b.print(' ', 'dim');
    b.print('  ── how to donate ──', 'dim');
    if (KOFI_URL) {
      b.print(`  ${KOFI_URL}`, 'cyan');
    } else {
      b.print('  visit our Ko-fi page | https://ko-fi.com/punkyroo', 'cyan');
    }
    b.print('  include your DIS username in the message field', 'yellow');
    b.print('  to earn 100 ₢ per dollar donated.', 'cyan');
    b.print(' ', 'dim');
    b.print('  no pressure. ever. ♥', 'dim');
    b.hr();
  });
}

function cmdDonations(api, state) {
  if (!requireAuth(api, state)) return;
  if (!state.isAdmin) { api.print('Unknown command.', 'red'); return; }
  const rows = listRecentDonations.all(20);
  api.batch(b => {
    b.hr();
    b.print('== recent donations (last 20) ==', 'magenta');
    b.hr();
    if (!rows.length) {
      b.print('No donations yet.', 'dim');
    } else {
      for (const r of rows) {
        const date = dayKeyET(r.created_at * 1000);
        const who = r.dis_username || '(unlinked)';
        const cr = r.chrome_awarded > 0 ? `+${fmtCr(r.chrome_awarded)} ₢` : '—';
        b.printHTML(`<span class="dim">${escapeHTML(date)}</span>  <span class="yellow">${escapeHTML(r.kofi_name)}</span> → <span class="cyan">${escapeHTML(who)}</span>  $${escapeHTML(r.amount.toFixed(2))}  ${escapeHTML(cr)}`);
        if (r.message) {
          b.printHTML(`  <span class="dim">"${escapeHTML(r.message.slice(0, 80))}"</span>`);
        }
      }
    }
    b.hr();
  });
}

function cmdLinkDonor(api, state, args) {
  if (!requireAuth(api, state)) return;
  if (!state.isAdmin) { api.print('Unknown command.', 'red'); return; }
  const kofiName = ((args && args[0]) || '').trim();
  const disName  = ((args && args[1]) || '').trim();
  if (!kofiName || !disName) {
    api.print('Usage: /linkdonor <kofi_name> <dis_username>', 'yellow');
    return;
  }
  const user = getUserByName.get(disName);
  if (!user) { api.print(`No DIS user found: ${disName}`, 'red'); return; }

  insertDonationLink.run(kofiName, user.username, nowEpoch());
  api.print(`Linked ko-fi "${kofiName}" → ${user.username}`, 'green');

  const unlinked = getUnlinkedDonationsByKofi.all(kofiName);
  if (unlinked.length > 0) {
    let totalAwarded = 0;
    for (const d of unlinked) {
      const cr = Math.floor(d.amount * 100);
      if (cr > 0) { chrome.award(user.username, cr, 'donation bonus'); totalAwarded += cr; }
      updateDonationAwarded.run(user.username, cr, d.id);
    }
    if (totalAwarded > 0) {
      api.print(`Retroactively awarded ${fmtCr(totalAwarded)} ₢ for ${unlinked.length} prior donation(s).`, 'yellow');
      const sockets = HUB.socketsByUser.get(user.username);
      if (sockets) {
        const ops = [{ op: 'print', text: `💙 thank you for your donation! you've been awarded ${fmtCr(totalAwarded)} ₢`, cls: 'cyan' }];
        for (const ws of sockets) { try { sendOps(ws, ops); } catch {} }
      }
    }
  }
}

function cmdUnlinkDonor(api, state, args) {
  if (!requireAuth(api, state)) return;
  if (!state.isAdmin) { api.print('Unknown command.', 'red'); return; }
  const kofiName = ((args && args[0]) || '').trim();
  if (!kofiName) { api.print('Usage: /unlinkdonor <kofi_name>', 'yellow'); return; }
  const info = deleteDonationLink.run(kofiName);
  if (info.changes) {
    api.print(`Removed link for ko-fi name "${kofiName}".`, 'green');
  } else {
    api.print(`No link found for ko-fi name "${kofiName}".`, 'red');
  }
}

/* ======================= Profiles (/aboutme, /profile) ======================= */
function cmdAboutMe(api, state, args){
  if (!requireAuth(api, state)) return;
  const raw = (args||[]).join(' ').trim();
  const max = +(getSetting.get('about_max_len')?.value || 600);

  if (!raw || /^clear$/i.test(raw)) {
    setUserAboutById.run(null, state.userId);
    api.print('About text cleared.', 'green');
    return;
  }
  const visible = visibleLengthDIS(raw);
  if (visible > max) {
    api.print(`About too long (max ${max} visible chars).`, 'red');
    return;
  }
  setUserAboutById.run(raw, state.userId);
  api.print('About updated.', 'green');
  api.printHTML('Preview: ' + sanitizeAndFormatDIS(raw));
}


function cmdProfile(api, state, args){
  if (!requireAuth(api, state)) return;
  const whoTyped = (args && args[0]) ? args[0].trim() : state.username;
  if (!whoTyped) { api.print('Usage: /profile [username]', 'yellow'); return; }

  const resolved = resolveUserHandle(whoTyped);
  if (!resolved){ api.print('No such user.', 'red'); return; }
  if (resolved.ambiguous){
    const opts = resolved.ambiguous.map(r => r.username).join(', ');
    api.print('That matches multiple users. Be more specific: ' + opts, 'yellow');
    return;
  }
  const row = resolved.row;

  const dispRow = getUserDisplay.get(row.id);
  const display = (dispRow && dispRow.display_name) ? dispRow.display_name : row.username;
  const colorRow = getUserColor.get(row.id);
  const color = colorRow ? colorRow.preferred_color : null;
  const aboutRow = getUserAboutById.get(row.id);
  const aboutRaw = aboutRow ? aboutRow.about : null;
  const created = row.created_at ? formatStampET(row.created_at * 1000) : '—';
  const last    = row.last_login_at ? formatStampET(row.last_login_at * 1000) : '—';

  api.hrTitled(`Profile: <${row.username}>`);
  api.printHTML(`Display: ${sanitizeAndFormatDIS(display)}`);
  api.printHTML(`Joined: <span class="dim">${escapeHTML(created)}</span>`);
  api.printHTML(`Last seen: <span class="dim">${escapeHTML(last)}</span>`);
  if (color) api.printHTML(`Chat color: <span style="color:${color}">${escapeHTML(color)}</span>`);
  try {
    const chromeBal = chrome.getBalance(row.username);
    api.printHTML(`chrome: <span class="yellow">${escapeHTML(fmtCr(chromeBal))} ₢</span>`);
  } catch {}
  try {
    if (checkUserIsDonor.get(row.username)) api.print('supporter ♥', 'cyan');
  } catch {}
  api.hr();
  if (aboutRaw && String(aboutRaw).trim()) {
    const safe = sanitizeAndFormatDIS(String(aboutRaw));
    const colored = color ? `<span style="color:${color}">${safe}</span>` : safe;
    api.printHTML(colored);
  } else {
    api.print('No about text yet.', 'dim');
  }
  api.hr();
  const me = state.username && row.username && state.username.toLowerCase() === row.username.toLowerCase();
  if (me){
    api.print('Tip: Update yours with /aboutme <text>  •  Clear with /aboutme clear', 'dim');
  } else {
    api.print('Tip: View your profile with /profile', 'dim');
  }
}




/* ======================= Colors + Display Name ======================= */
function cmdSetColor(api, state, args){
  if (!requireAuth(api, state)) return;
  const raw = (args||[]).join(' ').trim();
  if (!raw){ api.print('Usage: /setcolor <#RRGGBB | name>', 'yellow'); return; }
  const color = normalizeColor(raw);
  if (!color){ api.print('Invalid color. Try #19c3c3 or "cyan".', 'red'); return; }
  setUserColor.run(color, state.userId);
  state.userColor = color;
  api.print(`Color set to ${color}.`, 'green');
}
function cmdShowColor(api, state){
  if (!requireAuth(api, state)) return;
  api.printHTML(`Current color: <span style="color:${state.userColor||'inherit'}">${escapeHTML(state.userColor||'(none)')}</span>`);
}
function cmdColorReset(api, state){
  if (!requireAuth(api, state)) return;
  clearUserColor.run(state.userId);
  state.userColor = null;
  api.print('Color reset.', 'green');
}
function normalizeColor(s){
  s = String(s).trim().toLowerCase();
  const NAMED = { red:'#ff4545', green:'#2fd44f', yellow:'#e3c600', blue:'#3aa0ff', magenta:'#cc66ff', cyan:'#19c3c3', white:'#ffffff' };
  if (s in NAMED) return NAMED[s];
  if (/^#?[0-9a-f]{6}$/i.test(s)) return s.startsWith('#') ? s : ('#'+s);
  return null;
}

/* Display name (markdown-allowed, length checks count visible chars only) */
function cmdSetDisplay(api, state, args){
  if (!requireAuth(api, state)) return;
  const raw = (args||[]).join(' ').trim();

  if (!raw){
    api.print('Usage: /setdisplay <name>', 'yellow');
    return;
  }
  // Optionally enforce a visible-length limit if you keep one for names
  const vis = visibleLengthDIS(raw);
  if (vis < 1){
    api.print('That name is effectively empty after formatting. Try letters/numbers.', 'red');
    return;
  }

  const n = normalizeHandle(raw);
  const clash = db.prepare(`SELECT username FROM users WHERE username_norm = ? AND id <> ? LIMIT 1`).get(n, state.userId);
  if (clash){
    api.print(`Heads up: that looks identical to @${clash.username} when formatting is removed.`, 'yellow');
    // allow anyway, or return to block—it’s your call
  }


  setUserDisplay.run(raw, state.userId);
  state.displayName = raw;

  // keep normalization columns synced
  refreshUserNormsByRow({ id: state.userId, username: state.username, display_name: state.displayName });

  api.printHTML('Display name set to: ' + sanitizeAndFormatDIS(raw), 'green');
}


function cmdRetention(api, state, args){
  if (!requireAuth(api, state)) return;
  if (!state.isAdmin){ api.print('Unknown command.', 'red'); return; }

  const keys = {
    board: 'board_inactive_days',
    news: 'news_inactive_days',
    links: 'news_inactive_days',
    messages: 'dm_retention_days',
    dms: 'dm_retention_days',
    posts: 'status_retention_days',
    status: 'status_retention_days',
    users: 'user_inactive_days',
    accounts: 'user_inactive_days',
  };

  if (!args || !args.length){
    api.hr();
    api.print('Auto-delete retention (days):', 'yellow');
    Object.entries({
      board: keys.board,
      links: keys.links,
      messages: keys.messages,
      posts: keys.posts,
      users: keys.users,
    }).forEach(([label, key]) => {
      const value = Number(getSetting.get(key)?.value || 0);
      api.print(`  ${label}: ${value} day${value === 1 ? '' : 's'}`, 'cyan');
    });
    api.print('Set with: /retention <board|links|messages|posts|users> <days>. Use 0 to disable.', 'dim');
    return;
  }

  if (args.length < 2){
    api.print('Usage: /retention <board|links|messages|posts|users> <days>', 'yellow');
    return;
  }

  const area = String(args[0] || '').trim().toLowerCase();
  const key = keys[area];
  if (!key){
    api.print('Unknown retention area. Use: board, links, messages, posts, users.', 'yellow');
    return;
  }

  const daysRaw = Number(args[1]);
  if (!Number.isFinite(daysRaw) || daysRaw < 0){
    api.print('Days must be 0 or a positive number.', 'yellow');
    return;
  }

  const days = Math.floor(daysRaw);
  setSetting.run(key, String(days));
  api.print(`Retention updated: ${area} → ${days} day${days === 1 ? '' : 's'}.`, 'green');
}

/* ======================= DMs & Suggestions ======================= */
function cmdDM(api, state, args){
  if (!requireAuth(api, state)) return;

  // --- parse args ---
  const toTyped = (args && args[0]) ? String(args[0]).trim() : '';
  if (!toTyped){
    api.print('Usage: /dm <user> <message>', 'yellow');
    return;
  }

  // --- resolve recipient: username OR display name ---
  let resolved = null;
  try {
    if (typeof resolveUserHandle === 'function') {
      resolved = resolveUserHandle(toTyped);
    } else {
      // Fallback: direct username lookup if resolver not wired yet
      const row = getUserByName.get(toTyped);
      if (row) resolved = { row };
    }
  } catch (e) {
    resolved = null;
  }

  if (!resolved){
    api.print('No such user.', 'red');
    return;
  }
  if (resolved.ambiguous){
    const opts = resolved.ambiguous.map(r => r.username).join(', ');
    api.print('That name matches multiple users. Be more specific: ' + opts, 'yellow');
    return;
  }

  const recipient = resolved.row; // full users row (id, username, etc.)

  // --- message body + limits ---
  const body = args.slice(1).join(' ').trim();
  if (!body){
    api.print('Message empty.', 'yellow');
    return;
  }
  const max = +(getSetting.get('dm_max_len')?.value || 160);
  if (body.length > max){
    api.print(`DM too long (max ${max}).`, 'red');
    return;
  }

  // --- insert DM with retention ---
  const ts = nowEpoch();
  const days = +(getSetting.get('dm_retention_days')?.value || 14);
  const expiresAt = days > 0 ? (ts + days * 86400) : null;
  insertDM.run(state.userId || null, recipient.id, body, ts, expiresAt);

  api.print('Sent.', 'green');

  // --- live notify recipient if online ---
  // socketsByUser is keyed by canonical username
  const canonical = recipient.username;
  const sockets = HUB.socketsByUser.get(canonical);
  if (sockets && sockets.size){
    const fromName = (state.displayName && state.displayName.trim())
      ? state.displayName
      : (state.username || 'someone');
    const noticeHTML = `📬 DM from ${sanitizeAndFormatDIS(fromName)}.`;


    sockets.forEach(ws=>{
      const now = Date.now();
      if (!ws.__ctx) ws.__ctx = {};

      if (!ws.__ctx._lastMentionSound || now - ws.__ctx._lastMentionSound > 400) {
        ws.__ctx._lastMentionSound = now;
        sendOps(ws, [
          { op: 'audio', src: '/static/sounds/mention.wav', volume: 0.8 },
          { op: 'print', text: notice, cls: 'cyan' }
        ]);
      } else {
        sendOps(ws, [{ op: 'print', text: notice, cls: 'cyan' }]);
      }
    });
  }
}



function cmdMessages(api, state){
  if (!requireAuth(api, state)) return;
  const rows = listDMsForUser.all(state.userId, 200);
  markAllDMsRead.run(state.userId);
  api.batch(b=>{
    b.clear(); b.hrTitled('Direct Messages');
    if (!rows.length){ b.print('No messages.', 'dim'); }
    else rows.forEach(r=>{
      const ts = formatStampET(r.created_at * 1000);
      const disp = (r.display_name && r.display_name.trim()) ? r.display_name : (r.sender || 'anon');
      const body = sanitizeAndFormatDIS(r.body);
      const colored = r.preferred_color ? `<span style="color:${r.preferred_color}">${body}</span>` : body;
      const isUnread = !r.read_at;
      const status = isUnread ? '<span style="color:#ff6b6b;font-weight:bold;">NEW</span> ' : '';
      b.printHTML(`${status}[${escapeHTML(ts)}] &lt;${sanitizeAndFormatDIS(disp)}&gt; ${colored}`);
    });
    b.hr(); b.print('Use /dm <user> <message> to send. /main to leave.', 'dim');
  });
}
function cmdSuggest(api, state, args){
  if (!requireAuth(api, state)) return;
  const body = (args||[]).join(' ').trim();
  if (!body){ api.print('Usage: /suggest <text>', 'yellow'); return; }
  const max = +(getSetting.get('suggestion_max_len')?.value || 400);
  if (body.length > max){ api.print(`Too long (max ${max}).`, 'red'); return; }
  const ts = nowEpoch(); const days = +(getSetting.get('suggestion_retention_days')?.value || 0);
  insertSuggestion.run(state.userId || null, body, ts, days > 0 ? ts + days*86400 : null);
  api.print('Thanks for the suggestion.', 'green');
}
function cmdSuggestions(api, state){
  if (!requireAuth(api, state)) return;
  const rows = listSuggestions.all();
  api.batch(b=>{
    b.clear(); b.hrTitled('Suggestions');
    if (!rows.length){ b.print('No suggestions yet.', 'dim'); }
    else rows.forEach(r=>{
      const ts = formatStampET(r.created_at * 1000);
      b.printHTML(`${r.id}. ${sanitizeAndFormatDIS(r.body)} <span class="dim">(${escapeHTML(ts)} by ${escapeHTML(r.username||'anon')})</span>`);
    });
    b.hr(); b.print('Admin: /removesuggestion <id>', 'dim');
  });
}
function cmdRemoveSuggestion(api, state, args){
  if (!requireAuth(api, state)) return;
  if (!state.isAdmin){ api.print('Admin only.', 'red'); return; }
  const id = parseInt(args[0],10); if (!id){ api.print('Usage: /removesuggestion <id>', 'yellow'); return; }
  deleteSuggestionById.run(id); api.print('Removed.', 'green');
}

function cmdUsers(api, state, args){
  if (!requireAuth(api, state)) return;

  // parse page number (default 1)
  let page = parseInt((args && args[0]) || '1', 10);
  if (Number.isNaN(page) || page < 1) page = 1;

  const per = +(getSetting.get('users_page_size')?.value || 20);
  const total = (countUsers.get()?.n) || 0;
  const pages = Math.max(1, Math.ceil(total / per));
  if (page > pages) page = pages;

  const offset = (page - 1) * per;
  const rows = listUsersPage.all(per, offset);

  api.hr();
  api.print(`== Members (${total}) — page ${page}/${pages} ==`, 'yellow');

  if (!rows.length){
    api.print('No users yet.', 'dim');
    return;
  }

  rows.forEach(r => {
    const disp = r.display_name || r.username;
    const last = r.last_login_at ? formatStampET(r.last_login_at * 1000) : '—';
    const isOnline = HUB.online.has(r.username); // your presence set
    const statusHTML = isOnline ? '<span style="color:#2fd44f">online</span>'
                                : '<span class="dim">offline</span>';

    // username is literal; display name may contain DIS-Markdown
    api.printHTML(
      `• &lt;${escapeHTML(r.username)}&gt; — ` +
      `${sanitizeAndFormatDIS(disp)} — ` +
      `last: <span class="dim">${escapeHTML(last)}</span> — ${statusHTML}`
    );
  });

  api.hr();
  const prev = page > 1 ? `/users ${page-1}` : '';
  const next = page < pages ? `/users ${page+1}` : '';
  if (prev || next) {
    api.print(`Navigate: ${prev}${prev && next ? '  |  ' : ''}${next}`, 'dim');
  } else {
    api.print('End of list.', 'dim');
  }
}


function cmdNotifications(api, state, args){
  if (!requireAuth(api, state)) return;
  const limit = Math.max(1, Math.min(200, parseInt(args && args[0], 10) || 50));
  const rows = listMentionsForUser(state.userId, limit);

  api.batch(b=>{
    b.clear();
    b.print('== Notifications ==','magenta'); b.hr();

    if (!rows.length){
      b.print('No notifications yet. Mention someone with @username in Chat/Boards/Links.', 'dim');
    } else {
      rows.forEach(n=>{
        const when = formatStampET(n.created_at * 1000);
        const whoRaw = (n.from_display && n.from_display.trim()) ? n.from_display : (n.from_username || 'system');
        const ctxLabel = humanizeContext(n.context);
        const body = sanitizeAndFormatDIS(n.body);
        const seen = n.seen_at ? '<span class="dim">seen</span>' : '<span class="yellow">NEW</span>';
        b.printHTML(`[${escapeHTML(when)}] ${seen} <span class="dim">(${escapeHTML(ctxLabel)})</span> &lt;${sanitizeAndFormatDIS(whoRaw)}&gt; ${body}`);
      });
    }
    b.hr(); b.print('Tip: /notifications 200 for more.', 'dim');
  });

  // mark yours as read after viewing
  markMentionsSeen(state.userId);
}




/* ======================= Splash: Register ======================= */
function cmdRegister(api, state, args){
  api.print('Registration is not available via this method.', 'red');
  return;
  const [username, password] = args || [];

  if (!username || !password) {
    api.print('Usage: /register <username> <password>', 'yellow');
    return;
  }
  if (password.length < 6) {
    api.print('Password must be at least 6 characters.', 'yellow');
    return;
  }

  // Pre-check username availability before asking the question
  const existing = getUserByName.get(username);
  if (existing) {
    api.print('That username is taken.', 'red');
    return;
  }

  state.register = { step: 'question', username, password };
  api.print('One question before we continue:', 'cyan');
  api.print('What brought you to DIS?', 'cyan');
  api.setInputType('text', 'What brought you to DIS?');
  api.setInputLimit(null);
}

function handleRegisterAnswer(answer, api, state){
  if (!state.register || state.register.step !== 'question') return false;

  const { username, password } = state.register;
  state.register = null;

  if (!answer || !answer.trim()) {
    api.print('Please tell us what brought you to DIS.', 'dim');
    state.register = { step: 'question', username, password };
    return true;
  }

  const res = createUser(username, password);
  if (!res.ok) {
    api.print('That username is already taken. Try /register again with a different name.', 'red');
    // Return to login prompt
    state.login.step = 'username';
    api.print('Enter username:', 'cyan');
    api.setInputType('text', 'Username');
    api.setInputLimit(null);
    return true;
  }

  try {
    setUserSignupReason.run(answer.trim(), res.id);
  } catch (e) {
    console.error('Failed to save signup reason:', e && e.message ? e.message : e);
  }

  try {
    chrome.award(username, 100, 'welcome bonus');
  } catch (e) {
    console.error('[register] chrome welcome award failed:', e && e.message);
  }

  if (state && state.authenticated) {
    api.print(`Account created: ${username}. You remain logged in as ${state.username}.`, 'green');
    api.print("You've been awarded 100 chrome (₢) to get started.", 'yellow');
  } else {
    api.print('Account created. Please log in with your new credentials.', 'green');
    api.print("You've been awarded 100 chrome (₢) to get started.", 'yellow');
    state.login.step = 'username';
    api.print('Enter username:', 'cyan');
    api.setInputType('text', 'Username');
    api.setInputLimit(null);
  }
  return true;
}

function cmdPasswd(api, state, args){
  if (!requireAuth(api, state)) return;
  const [oldp, newp] = args || [];
  if (!oldp || !newp){ api.print('Usage: /passwd <old> <new>', 'yellow'); return; }
  if (newp.length < 6){ api.print('New password must be at least 6 characters.', 'yellow'); return; }
  const u = getUserByName.get(state.username);
  if (!u || !bcrypt.compareSync(oldp, u.password_hash)){ api.print('Old password incorrect.', 'red'); return; }
  const hash = bcrypt.hashSync(newp, 10);
  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hash, u.id);
  api.print('Password updated.', 'green');
}



/* ======================= Admin: recent registrations ======================= */
function cmdNewUsers(api, state, args) {
  if (!requireAuth(api, state)) return;
  if (!state.isAdmin) { api.print('Unknown command.', 'red'); return; }

  const requested = parseInt(args[0], 10);
  const limit = (!isNaN(requested) && requested > 0) ? Math.min(requested, 50) : 20;

  const rows = listRecentUsers.all(limit);
  if (!rows.length) { api.print('No users found.', 'dim'); return; }

  api.print(`== Recent Registrations (${rows.length}) ==`, 'magenta');
  api.hr();

  for (const r of rows) {
    const dt    = new Date(r.created_at * 1000);
    // Forensic timestamp stays UTC intentionally (host log correlation) —
    // do not migrate to board time.
    const stamp = dt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const ua    = r.user_agent ? r.user_agent.slice(0, 60) + (r.user_agent.length > 60 ? '…' : '') : '—';
    const ip    = r.registration_ip || '—';
    const hasEmail = r.email ? 'yes' : 'no';

    const hitIp = r.registration_ip ? checkBanByIp.get(r.registration_ip) : null;
    const hitFp = r.fingerprint_hash ? checkBanByFingerprint.get(r.fingerprint_hash) : null;
    const hitLoginIp = r.last_login_ip && r.last_login_ip !== r.registration_ip
      ? checkBanByIp.get(r.last_login_ip) : null;
    const banned = hitIp || hitFp || hitLoginIp;

    const prefix = banned ? '[BAN MATCH] ' : '';
    const color  = banned ? 'red' : 'cyan';

    api.print(`${prefix}${stamp}  ${r.username}`, color);
    api.print(`  ip:${ip}  email:${hasEmail}  ua:${ua}`, banned ? 'red' : 'dim');
    if (banned) {
      const reasons = [
        hitIp      ? `reg IP matches ban #${hitIp.id}`      : null,
        hitLoginIp ? `login IP matches ban #${hitLoginIp.id}` : null,
        hitFp      ? `fingerprint matches ban #${hitFp.id}` : null,
      ].filter(Boolean).join(', ');
      api.print(`  !! ${reasons}`, 'red');
    }
  }

  api.hr();
}

/* ======================= Admin: registration rejections ======================= */
function cmdRejections(api, state) {
  if (!requireAuth(api, state)) return;
  if (!state.isAdmin) { api.print('Unknown command.', 'red'); return; }

  const rows = listRegistrationRejections.all(20);
  api.batch(b => {
    b.hr();
    b.print('== Last 20 registration rejections ==', 'magenta');
    if (!rows.length) {
      b.print('No rejections logged.', 'dim');
    } else {
      for (const r of rows) {
        // Forensic timestamp stays UTC intentionally (host log correlation) —
        // do not migrate to board time.
        const stamp = new Date(r.created_at * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
        const ua    = (r.user_agent || '').slice(0, 80);
        b.print(`${stamp}  ${r.username || '(none)'}`, 'cyan');
        b.print(`  ip:${r.ip || '(none)'}  ua:${ua || '—'}`, 'dim');
      }
    }
    b.hr();
  });
}

/* ======================= Admin ban commands ======================= */
function cmdBan(api, state, args) {
  if (!requireAuth(api, state)) return;
  if (!state.isAdmin) { api.print('Unknown command.', 'red'); return; }

  const targetName = (args[0] || '').trim();
  if (!targetName) { api.print('Usage: /ban <username>', 'yellow'); return; }
  if (targetName.toLowerCase() === state.username.toLowerCase()) {
    api.print('You cannot ban yourself.', 'red'); return;
  }

  const target = getUserByName.get(targetName);
  if (!target) { api.print(`User not found: ${targetName}`, 'red'); return; }
  if (target.is_admin) { api.print('Cannot ban an admin account.', 'red'); return; }

  const userId = target.id;
  const now = nowEpoch();

  // Count and delete content in one transaction
  const summary = db.transaction(() => {
    const chatMsgs      = db.prepare('SELECT COUNT(1) AS n FROM messages      WHERE user_id = ?').get(userId).n;
    const boardTopics   = db.prepare('SELECT COUNT(1) AS n FROM board_topics  WHERE creator_id = ?').get(userId).n;
    const boardComments = db.prepare('SELECT COUNT(1) AS n FROM board_comments WHERE user_id = ?').get(userId).n;
    const linkPosts     = db.prepare('SELECT COUNT(1) AS n FROM news_posts    WHERE user_id = ?').get(userId).n;
    const linkComments  = db.prepare('SELECT COUNT(1) AS n FROM news_comments  WHERE user_id = ?').get(userId).n;
    const pollVotes     = db.prepare('SELECT COUNT(1) AS n FROM poll_votes    WHERE user_id = ?').get(userId).n;
    const pollsCreated  = db.prepare('SELECT COUNT(1) AS n FROM polls         WHERE creator_id = ?').get(userId).n;
    const statusPosts   = db.prepare('SELECT COUNT(1) AS n FROM status_posts  WHERE user_id = ?').get(userId).n;
    const dmSent        = db.prepare('SELECT COUNT(1) AS n FROM dm_messages   WHERE sender_id = ?').get(userId).n;
    const pxArt         = db.prepare('SELECT COUNT(1) AS n FROM pixel_art     WHERE creator_username = ?').get(target.username).n;

    db.prepare('DELETE FROM messages       WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM board_comments WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM board_topics   WHERE creator_id = ?').run(userId);
    db.prepare('DELETE FROM news_comments  WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM news_posts     WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM poll_votes     WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM polls          WHERE creator_id = ?').run(userId);
    db.prepare('DELETE FROM status_posts   WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM dm_messages    WHERE sender_id = ?').run(userId);
    db.prepare('DELETE FROM pixel_art      WHERE creator_username = ?').run(target.username);
    db.prepare('DELETE FROM notifications  WHERE to_user_id = ? OR from_user_id = ?').run(userId, userId);
    db.prepare("DELETE FROM activity_feed WHERE message LIKE ?").run(`%${target.username}%`);
    db.prepare("DELETE FROM game_feed     WHERE message LIKE ? OR username = ?").run(`%${target.username}%`, target.username);
    db.prepare('DELETE FROM graffiti_wall WHERE painted_by = ?').run(target.username);
    db.prepare('DELETE FROM graffiti_activity WHERE username = ?').run(target.username);
    db.prepare('DELETE FROM chrome_balances    WHERE username = ?').run(target.username);
    db.prepare('DELETE FROM chrome_transactions WHERE username = ?').run(target.username);
    db.prepare('DELETE FROM dots_lines   WHERE drawn_by  = ?').run(target.username);
    db.prepare('DELETE FROM dots_squares WHERE claimed_by = ?').run(target.username);
    db.prepare('DELETE FROM dots_turns   WHERE username   = ?').run(target.username);

    insertBan.run(now, state.username, target.username, target.registration_ip || null, target.fingerprint_hash || null, null);
    if (target.last_login_ip && target.last_login_ip !== target.registration_ip) {
      insertBan.run(now, state.username, target.username, target.last_login_ip, null, null);
    }
    BANNED_USERNAMES.add(target.username.toLowerCase());

    db.prepare('INSERT INTO ban_log (created_at, banned_by, username, chat_msgs, board_topics, board_comments, link_posts, link_comments, poll_votes, polls_created, status_posts, dm_sent, pixel_art) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      now, state.username, target.username,
      chatMsgs, boardTopics, boardComments, linkPosts, linkComments,
      pollVotes, pollsCreated, statusPosts, dmSent, pxArt
    );

    db.prepare('DELETE FROM users WHERE id = ?').run(userId);

    return { chatMsgs, boardTopics, boardComments, linkPosts, linkComments, pollVotes, pollsCreated, statusPosts, dmSent, pxArt };
  })();

  // Force-close any live sockets for the banned user
  const sockets = HUB.socketsByUser.get(target.username);
  if (sockets) {
    for (const ws of sockets) {
      try { ws.close(4003, 'banned'); } catch {}
    }
    HUB.socketsByUser.delete(target.username);
  }
  HUB.online.delete(target.username);

  // Invalidate any pending auth tokens for the banned user
  for (const [token, record] of AUTH_TOKENS.entries()) {
    if (record.username.toLowerCase() === target.username.toLowerCase()) {
      AUTH_TOKENS.delete(token);
    }
  }

  api.print(`Banned: ${target.username}`, 'red');
  api.print(`  IP: ${target.registration_ip || '(none on record)'}`, 'dim');
  api.print(`  Fingerprint: ${target.fingerprint_hash ? target.fingerprint_hash.slice(0, 16) + '…' : '(none on record)'}`, 'dim');
  api.print(`  Deleted: ${summary.chatMsgs} chat msgs, ${summary.boardTopics} topics, ${summary.boardComments} board replies, ${summary.linkPosts} links, ${summary.linkComments} link comments, ${summary.pollVotes} votes, ${summary.pollsCreated} polls, ${summary.statusPosts} status posts, ${summary.dmSent} DMs sent, ${summary.pxArt} pixel art`, 'dim');
  broadcastSystem(`${target.username} has been removed.`);
}

function cmdPurgeActivity(api, state, args) {
  if (!requireAuth(api, state)) return;
  if (!state.isAdmin) { api.print('Unknown command.', 'red'); return; }
  const targetName = (args[0] || '').trim();
  if (!targetName) { api.print('Usage: /purgeactivity <username>', 'yellow'); return; }
  const r1 = db.prepare("DELETE FROM activity_feed WHERE message LIKE ?").run(`%${targetName}%`);
  const r2 = db.prepare("DELETE FROM game_feed WHERE message LIKE ? OR username = ?").run(`%${targetName}%`, targetName);
  api.print(`Purged activity: ${r1.changes} activity_feed rows, ${r2.changes} game_feed rows mentioning ${targetName}.`, 'green');
}

function cmdPurgeChrome(api, state, args) {
  if (!requireAuth(api, state)) return;
  if (!state.isAdmin) { api.print('Unknown command.', 'red'); return; }
  const targetName = (args[0] || '').trim();
  if (!targetName) { api.print('usage: /purgechrome <username>', 'yellow'); return; }
  const r1 = db.prepare('DELETE FROM chrome_balances WHERE username = ?').run(targetName);
  const r2 = db.prepare('DELETE FROM chrome_transactions WHERE username = ?').run(targetName);
  api.print(`Purged chrome: ${r1.changes} balance rows, ${r2.changes} transaction rows for ${targetName}.`, 'green');
}

function cmdBanList(api, state) {
  if (!requireAuth(api, state)) return;
  if (!state.isAdmin) { api.print('Unknown command.', 'red'); return; }
  const rows = listBans.all();
  if (!rows.length) { api.print('Ban list is empty.', 'dim'); return; }
  api.print('== Ban List ==', 'magenta');
  api.hr();
  for (const r of rows) {
    const date = dayKeyET(r.created_at * 1000);
    const fp   = r.fingerprint_hash ? r.fingerprint_hash.slice(0, 12) + '…' : '—';
    const ip   = r.ip || '—';
    const note = r.notes ? `  note: ${r.notes}` : '';
    api.print(`[${r.id}] ${r.username || '—'}  ip:${ip}  fp:${fp}  ${date}  by:${r.banned_by}${note}`, 'cyan');
  }
  api.hr();
}

function cmdUnban(api, state, args) {
  if (!requireAuth(api, state)) return;
  if (!state.isAdmin) { api.print('Unknown command.', 'red'); return; }
  const id = parseInt(args[0], 10);
  if (!id) { api.print('Usage: /unban <id>', 'yellow'); return; }
  const row = getBanById.get(id);
  if (!row) { api.print(`No ban entry with id ${id}.`, 'red'); return; }
  deleteBanById.run(id);
  api.print(`Removed ban entry ${id} (was: ${row.username || '—'} / ${row.ip || '—'}).`, 'green');
}

function cmdBanNote(api, state, args) {
  if (!requireAuth(api, state)) return;
  if (!state.isAdmin) { api.print('Unknown command.', 'red'); return; }
  const id   = parseInt(args[0], 10);
  const note = args.slice(1).join(' ').trim();
  if (!id || !note) { api.print('Usage: /bannote <id> <note text>', 'yellow'); return; }
  const row = getBanById.get(id);
  if (!row) { api.print(`No ban entry with id ${id}.`, 'red'); return; }
  updateBanNote.run(note, id);
  api.print(`Note updated on ban entry ${id}.`, 'green');
}

function cmdCheckUser(api, state, args) {
  if (!requireAuth(api, state)) return;
  if (!state.isAdmin) { api.print('Unknown command.', 'red'); return; }
  const targetName = (args[0] || '').trim();
  if (!targetName) { api.print('Usage: /checkuser <username>', 'yellow'); return; }
  const user = getUserByName.get(targetName);
  if (!user) { api.print(`User not found: ${targetName}`, 'red'); return; }

  api.print(`== ${user.username} ==`, 'magenta');
  api.print(`  registration_ip:  ${user.registration_ip  || '(none)'}`, 'cyan');
  api.print(`  last_login_ip:    ${user.last_login_ip    || '(none)'}`, 'cyan');
  api.print(`  user_agent:       ${user.user_agent       || '(none)'}`, 'cyan');
  api.print(`  accept_language:  ${user.accept_language  || '(none)'}`, 'cyan');
  api.print(`  fingerprint_hash: ${user.fingerprint_hash || '(none)'}`, 'cyan');

  const hitUsername = user.username         ? checkBanByUsername.get(user.username)         : null;
  const hitRegIp    = user.registration_ip  ? checkBanByIp.get(user.registration_ip)        : null;
  const hitLoginIp  = user.last_login_ip    ? checkBanByIp.get(user.last_login_ip)          : null;
  const hitFp       = user.fingerprint_hash ? checkBanByFingerprint.get(user.fingerprint_hash) : null;

  const hits = [
    hitUsername ? `username (ban id ${hitUsername.id})`  : null,
    hitRegIp    ? `reg IP (ban id ${hitRegIp.id})`       : null,
    hitLoginIp  ? `login IP (ban id ${hitLoginIp.id})`   : null,
    hitFp       ? `fingerprint (ban id ${hitFp.id})`     : null,
  ].filter(Boolean);

  if (hits.length) {
    api.print(`  BAN MATCHES: ${hits.join(', ')}`, 'red');
  } else {
    api.print('  No ban list matches.', 'dim');
  }
}

/* ======================= Logout ======================= */
function doLogout(api, state){
  if (!state || !state.authenticated){
    api.print('You are not logged in.', 'yellow');
    return;
  }

  removeUserPresence(api, state);
  resetState(state);

  if (api && api.ws) {
    api.ws.__ctx = { state };
    sendOps(api.ws, [
      { op: 'print', text: 'Logging out…', cls: 'yellow' },
      { op: 'reload' }
    ]);
    setTimeout(() => {
      try { api.ws.close(4001, 'logout'); } catch {}
    }, 50);
  }
}



/* ======================= Global command router ======================= */
function handleGlobalCommand(cmd, api, state, args){
  switch (cmd) {
    /* Navigation */
    case 'main':
    case 'menu':         routeGo(api, state, 'menu'); return true;
    case 'chat':         routeGo(api, state, 'chat'); return true;
    case 'about':        routeGo(api, state, 'about'); return true;
    case 'rules':        routeGo(api, state, 'rules'); return true;
    case 'board':        renderBoard(api, state); return true;
    case 'polls':         renderPolls(api, state); return true;
    case 'topic':        if (args.length) openTopic(api, state, parseInt(args[0],10)||0); else api.print('Usage: /topic <id>', 'yellow'); return true;
    case 'newtopic':     return (cmdNewTopic(api, state, args), true);
    // Admin-only removal by list index or id (cmdRemoveTopic should enforce admin)
    case 'removetopic':  return (cmdRemoveTopic(api, state, args), true);

    /* Links */
    case 'links':        if (args.length) openNewsItem(api, state, parseInt(args[0],10)||0); else renderNewsList(api, state); return true;
    case 'addlink':      cmdAddNews(api, state, args); return true;
    case 'removelink':   cmdRemoveNews(api, state, args); return true;

    /* Pixel Art */
    case 'draw':         cmdDraw(api, state); return true;
    case 'art':          cmdArt(api, state, args); return true;
    case 'editart':      cmdEditArt(api, state, args); return true;
    case 'deleteart':    cmdDeleteArt(api, state, args); return true;

    /* Synth */
    case 'synth':        cmdSynth(api, state, args); return true;
    case 'patches':      cmdPatches(api, state); return true;
    case 'editpatch':    cmdEditPatch(api, state, args); return true;
    case 'deletepatch':  cmdDeletePatch(api, state, args); return true;

    /* Tracker */
    case 'tracker':      cmdTracker(api, state, args); return true;
    case 'songs':        cmdSongs(api, state); return true;
    case 'editsong':     cmdEditSong(api, state, args); return true;
    case 'deletesong':   cmdDeleteSong(api, state, args); return true;

    /* Graffiti Wall */
    case 'graffiti':     cmdGraffiti(api, state); return true;
    case 'wall':         cmdGraffiti(api, state); return true;

    /* Activity / Economy */
    case 'activity': renderActivity(api, state); return true;
    case 'chrome':   renderChrome(api, state); return true;
    case 'wallet':   cmdWallet(api, state, args); return true;
    case 'mining':   cmdMining(api, state); return true;
    case 'market':   renderMarket(api, state); return true;
    case 'sell':     cmdMarketSell(api, state, args); return true;
    case 'buy':      cmdMarketBuy(api, state, args);  return true;
    case 'rob':      cmdRob(api, state, args);        return true;
    case 'grind':    cmdGrind(api, state);             return true;

    /* Games */
    case 'games':    renderGames(api, state); return true;
    case 'wordle':   cmdWordle(api, state, args[0]); return true;
    case 'slots':     cmdSlots(api, state, args); return true;
    case 'blackjack': cmdBlackjack(api, state, args); return true;
    case 'hack':      cmdHack(api, state); return true;
    case 'dots':      cmdDots(api, state); return true;

    /* Donations */
    case 'donate':       cmdDonate(api, state); return true;
    case 'donations':    cmdDonations(api, state); return true;
    case 'linkdonor':    cmdLinkDonor(api, state, args); return true;
    case 'unlinkdonor':  cmdUnlinkDonor(api, state, args); return true;

    /* DMs / Suggestions */
    case 'post':         cmdPost(api, state, args); return true;
    case 'feed':         cmdFeed(api, state, args); return true;
    case 'newpoll':      cmdNewPoll(api, state, args); return true;
    case 'vote':         cmdVote(api, state, args); return true;
    case 'endpoll':      cmdEndPoll(api, state, args); return true;
    case 'removepoll':   cmdRemovePoll(api, state, args); return true;
    case 'dm':           cmdDM(api, state, args); return true;
    case 'messages':     cmdMessages(api, state); return true;
    case 'suggest':      cmdSuggest(api, state, args); return true;
    case 'suggestions':  cmdSuggestions(api, state); return true;
    case 'removesuggestion': cmdRemoveSuggestion(api, state, args); return true;

    /* Colors + Display (compat: support both old/new handler names) */
    case 'setcolor':     cmdSetColor(api, state, args); return true;
    case 'color':        (typeof cmdShowColor === 'function' ? cmdShowColor : cmdColor)(api, state); return true;
    case 'colorreset':   cmdColorReset(api, state); return true;
    case 'setdisplay':   cmdSetDisplay(api, state, args); return true;
    case 'display':      (typeof cmdShowDisplay === 'function' ? cmdShowDisplay : cmdDisplay)(api, state); return true;
    case 'displayreset': cmdDisplayReset(api, state); return true;

    /* Register */
    case 'retention':    return (cmdRetention(api, state, args), true);
    case 'register':     cmdRegister(api, state, args); return true;

    /* Notifications */
    case 'notifications': cmdNotifications(api, state, args); return true;
    case 'announcements': cmdAnnouncements(api, state); return true;
    case 'announce':      cmdAnnounce(api, state, args); return true;
    case 'removeannounce': cmdRemoveAnnouncement(api, state, args); return true;
    case 'pinannounce':   cmdPinAnnouncement(api, state, args); return true;

    /* Misc */
    case 'whoami':       api.print(`You are ${state.username}${state.isAdmin ? ' (admin)' : ''}`); return true;
    case 'who':          return (cmdWho(api, state), true);      // extra arg is fine if handler only expects one
    case 'format':       return (cmdFormat(api), true);
    case 'here':         return (cmdHere(api, state), true);
    case 'logout':       doLogout(api, state); return true;
    case 'colors':       return (cmdColors(api), true);
    case 'help':         cmdHelp(api, state); return true;
    case 'passwd':       return (cmdPasswd(api, state, args), true);
    case 'aboutme':      return (cmdAboutMe(api, state, args), true);
    case 'profile':      return (cmdProfile(api, state, args), true);
    case 'users':        cmdUsers(api, state, args); return true;

    /* Admin Chat entry (kept hidden for non-admins) */
    case 'adminchat':
      if (state.isAdmin) renderAdminChat(api, state);
      else api.print('Unknown command.', 'red');
      return true;

    /* Admin ban / blacklist */
    case 'newusers':    cmdNewUsers(api, state, args); return true;
    case 'rejections':  cmdRejections(api, state); return true;
    case 'ban':           cmdBan(api, state, args); return true;
    case 'banlist':       cmdBanList(api, state); return true;
    case 'unban':         cmdUnban(api, state, args); return true;
    case 'bannote':       cmdBanNote(api, state, args); return true;
    case 'checkuser':     cmdCheckUser(api, state, args); return true;
    case 'purgeactivity': cmdPurgeActivity(api, state, args); return true;
    case 'purgechrome':   cmdPurgeChrome(api, state, args); return true;

    default:
      return false;
  }
}


/* ======================= WS handling ======================= */
const HEARTBEAT_MS = 30_000;
function markAlive() { this.isAlive = true; }

function authenticateWsFromUserRow(ws, api, state, userRow) {
  state.authenticated = true;
  state.userId = userRow.id;
  state.username = userRow.username;
  state.isAdmin = !!userRow.is_admin;
  const rc = getUserColor.get(state.userId);
  state.userColor = rc ? rc.preferred_color : null;
  const dnRow = getUserDisplay.get(state.userId);
  state.displayName = dnRow && dnRow.display_name ? dnRow.display_name : state.username;
  refreshUserNormsByRow({ id: state.userId, username: state.username, display_name: state.displayName });
  HUB.online.add(state.username);
  if (!HUB.socketsByUser.has(state.username)) HUB.socketsByUser.set(state.username, new Set());
  HUB.socketsByUser.get(state.username).add(ws);
  broadcastSystem(`${state.username} joined`);
  setLastLogin.run(nowEpoch(), state.userId);
  sendOps(ws, [{ op: 'status', chrome: chrome.getBalance(state.username) }]);

  // Update fingerprint on every login so IP/UA stays current
  try {
    const ip = ws.__ip || null;
    const ua = ws.__ua || null;
    const lang = ws.__acceptLanguage || null;
    if (ip || ua) {
      updateUserFingerprint.run(ip, ip, ua, lang, null, state.userId);
    }
  } catch (e) {
    console.error('[auth] fingerprint update failed:', e && e.message);
  }
}

const heartbeatTimer = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, HEARTBEAT_MS);

wss.on('close', () => {
  clearInterval(heartbeatTimer);
});


wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', markAlive);

  HUB.clients.add(ws);

  // Capture connection metadata for fingerprint updates
  ws.__ip = req.headers['fly-client-ip'] ||
            (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : null) ||
            req.socket?.remoteAddress ||
            null;
  ws.__ua = req.headers['user-agent'] || null;
  ws.__acceptLanguage = req.headers['accept-language'] || null;

  const api = makeApi(ws);
  const state = makeInitialState();
  ws.__ctx = { state };

  // Defaults
  api.setPrompt && api.setPrompt('DIS>');
  api.setInputType && api.setInputType('text', 'type /help for commands');

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    ws.isAlive = true;

    // Parse once
    let msg; try { msg = JSON.parse(String(data)); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    // NAWS-style column negotiation. Additive: legacy clients that never
    // send this keep state.cols at its DEFAULT_COLS default from
    // makeInitialState, so nothing changes for them.
    if (msg.type === 'naws') {
      const cols = clampCols(msg.cols);
      if (cols != null) {
        const wasNarrow = state.cols < MENU_TWO_COL_THRESHOLD;
        const isNarrow = cols < MENU_TWO_COL_THRESHOLD;
        state.cols = cols;
        if (wasNarrow !== isNarrow && state.currentScreen === 'menu') {
          renderMenu(api, state);
        }
      }
      return;
    }

    // Handshake
    if (msg.type === 'init') {
      const initCols = clampCols(msg.cols);
      if (initCols != null) state.cols = initCols;
      // Path 1: web-login token sent in the init message
      if (typeof msg.token === 'string' && msg.token) {
        const record = AUTH_TOKENS.get(msg.token);
        if (record && record.expMs > Date.now()) {
          AUTH_TOKENS.delete(msg.token);
          const userRow = getUserByName.get(record.username);
          if (userRow) {
            // Check if user is banned before authenticating
            if (BANNED_USERNAMES.has(userRow.username.toLowerCase())) {
              sendOps(ws, [{ op: 'error', message: 'This account has been suspended.' }]);
              try { ws.close(4003, 'banned'); } catch {}
              return;
            }
            const banHit = checkBanForConnection(ws.__ip, userRow.fingerprint_hash);
            if (banHit) {
              logBanEnforcementDenial(userRow.username, ws.__ip, banHit);
              sendOps(ws, [{ op: 'error', message: 'This account has been suspended.' }]);
              try { ws.close(4003, 'banned'); } catch {}
              return;
            }
            authenticateWsFromUserRow(ws, api, state, userRow);
            routeGo(api, state, 'menu');
            return;
          }
        }
      }
      // Path 2: SSO cookie (set by /api/auth/complete after web login)
      if (SSO_SECRET) {
        const cookieValue = getCookie(req, 'disbbs_auth');
        if (cookieValue) {
          let payload = null;
          try { payload = verifyAuthCookie(cookieValue); } catch {}
          if (payload) {
            const userRow = getUserByName.get(payload.u);
            if (userRow) {
              // Check if user is banned before authenticating
              if (BANNED_USERNAMES.has(userRow.username.toLowerCase())) {
                sendOps(ws, [{ op: 'error', message: 'This account has been suspended.' }]);
                try { ws.close(4003, 'banned'); } catch {}
                return;
              }
              const banHit = checkBanForConnection(ws.__ip, userRow.fingerprint_hash);
              if (banHit) {
                logBanEnforcementDenial(userRow.username, ws.__ip, banHit);
                sendOps(ws, [{ op: 'error', message: 'This account has been suspended.' }]);
                try { ws.close(4003, 'banned'); } catch {}
                return;
              }
              authenticateWsFromUserRow(ws, api, state, userRow);
              routeGo(api, state, 'menu');
              return;
            }
          }
        }
      }
      // Path 3: fallback to terminal login
      routeGo(api, state, 'splash');
      return;
    }

    if (msg.type === 'save_pixel_art')   { handleSavePixelArt(msg, api, state); return; }
    if (msg.type === 'update_pixel_art') { handleUpdatePixelArt(msg, api, state); return; }
    if (msg.type === 'save_patch')       { handleSavePatch(msg, api, state); return; }
    if (msg.type === 'update_patch')     { handleUpdatePatch(msg, api, state); return; }
    if (msg.type === 'get_patch_list')   { handleGetPatchList(msg, api, state); return; }
    if (msg.type === 'save_song')        { handleSaveSong(msg, api, state); return; }
    if (msg.type === 'update_song')      { handleUpdateSong(msg, api, state); return; }
    if (msg.type === 'wordle_guess')     { handleWordleGuess(msg, api, state); return; }
    if (msg.type === 'slots_spin')       { handleSlotsSpin(msg, api, state); return; }
    if (msg.type === 'slots_getstate')   { handleSlotsGetState(api, state); return; }
    if (msg.type === 'mining_getstate')  { handleMiningGetState(api, state); return; }
    if (msg.type === 'mining_click')     { handleMiningClick(msg, api, state); return; }
    if (msg.type === 'hack_getstate')    { handleHackGetState(api, state); return; }
    if (msg.type === 'hack_guess')       { handleHackGuess(msg, api, state); return; }
    if (msg.type === 'hack_bracket')     { handleHackBracket(msg, api, state); return; }
    if (msg.type === 'blackjack_deal')     { handleBlackjackDeal(msg, api, state); return; }
    if (msg.type === 'blackjack_hit')      { handleBlackjackHit(msg, api, state); return; }
    if (msg.type === 'blackjack_stand')    { handleBlackjackStand(msg, api, state); return; }
    if (msg.type === 'blackjack_getstate') { handleBlackjackGetState(api, state); return; }

    if (msg.type === 'dots_getstate') {
      if (!requireAuth(api, state)) return;
      const game = dotsGetOrCreateGame();
      const board = dotsBuildState(game.id);
      const myTurn = stmtDotsGetTurn.get(game.id, state.username);
      const lastDraw = stmtDotsLastDraw.get(game.id);
      // Can draw if: never drew in this game, OR someone else drew after our last draw
      const canDraw = !myTurn || (lastDraw && lastDraw.last > myTurn.last_drew_at);
      const playerColors = dotsBuildPlayerColors(game.id);
      sendOps(api.ws, [{ op: 'dots_state', gameId: game.id, endsAt: game.ends_at, ...board, playerColors, canDraw, username: state.username }]);
      return;
    }

    if (msg.type === 'dots_draw') {
      if (!requireAuth(api, state)) return;
      const username = state.username;
      const game = dotsGetOrCreateGame();
      const now = dotsNextTimestamp(game.id);

      // Validate line index
      if (!Number.isInteger(msg.lineIdx) || msg.lineIdx < 0 || msg.lineIdx >= DOTS_TOTAL_LINES) {
        sendOps(api.ws, [{ op: 'dots_error', message: 'invalid line.' }]); return;
      }

      // Check line not already drawn
      const existingLines = dotsBuildState(game.id).lines;
      if (existingLines[msg.lineIdx] !== null) {
        sendOps(api.ws, [{ op: 'dots_error', message: 'line already drawn.' }]); return;
      }

      // Check turn eligibility
      const myTurn = stmtDotsGetTurn.get(game.id, username);
      const lastDraw = stmtDotsLastDraw.get(game.id);
      const canDraw = !myTurn || (lastDraw && lastDraw.last > myTurn.last_drew_at);
      if (!canDraw) {
        sendOps(api.ws, [{ op: 'dots_error', message: 'wait for another player to draw before your next turn.' }]); return;
      }

      // Draw the line
      stmtDotsInsertLine.run(game.id, msg.lineIdx, username, now);

      // Award line chrome
      try { chrome.award(username, DOTS_CHROME_LINE, 'dots: drew a line'); } catch {}

      // Check for completed squares
      const newSquares = [];
      for (const [r, c] of dotsSquaresForLine(msg.lineIdx)) {
        const board = dotsBuildState(game.id);
        if (!board.squares[`${r},${c}`] && dotsSquareComplete(board.lines, r, c)) {
          stmtDotsInsertSquare.run(game.id, r, c, username, now);
          newSquares.push({ r, c, claimedBy: username });
          try { chrome.award(username, DOTS_CHROME_SQUARE, 'dots: claimed square'); } catch {}
        }
      }

      // Only spend the turn lock if this draw did NOT complete a square — completing a
      // square grants a bonus turn, so the turn record intentionally stays unadvanced,
      // letting the same user draw again immediately (canDraw checks last_drew_at against
      // the newly-updated global last-draw time from this very line).
      if (newSquares.length === 0) {
        stmtDotsUpsertTurn.run(game.id, username, now);
      }

      // Build updated board state
      const updated = dotsBuildState(game.id);
      const lineCount = stmtDotsLineCount.get(game.id).n;
      const gameComplete = lineCount >= DOTS_TOTAL_LINES;
      const playerColors = dotsBuildPlayerColors(game.id);

      // Activity event for big square chains
      if (newSquares.length >= 3) {
        addActivityEvent('games', 'dots_chain', `🟦 ${username} claimed ${newSquares.length} squares in one move on the dots board!`);
      }

      // Broadcast to ALL connected clients
      HUB.clients.forEach(ws => sendOps(ws, [{
        op: 'dots_update',
        gameId: game.id,
        lineIdx: msg.lineIdx,
        drawnBy: username,
        newSquares,
        scores: updated.scores,
        playerColors,
        canDraw: false,  // each client recalculates their own canDraw on receipt
        gameComplete,
      }]));

      // Handle game completion
      if (gameComplete) {
        stmtDotsFinishGame.run(game.id);
        // Find winner (most squares)
        const scores = updated.scores;
        if (scores.length) {
          const winner = scores[0].claimed_by;
          const winnerSquares = scores[0].squares;
          try { chrome.award(winner, DOTS_CHROME_WIN, 'dots: board winner'); } catch {}
          addActivityEvent('games', 'dots_winner', `🟦 ${winner} won the dots board with ${winnerSquares} squares and earned ${DOTS_CHROME_WIN} ₢!`);
          // Broadcast game over then reset
          const newGame = dotsGetOrCreateGame();
          const newBoard = dotsBuildState(newGame.id);
          HUB.clients.forEach(ws => sendOps(ws, [{
            op: 'dots_newgame',
            gameId: newGame.id,
            endsAt: newGame.ends_at,
            winner,
            winnerSquares,
            winnerChrome: DOTS_CHROME_WIN,
            ...newBoard,
            playerColors: {},
            canDraw: true,
          }]));
        }
      }

      return;
    }

    if (msg.type === 'graffiti_getstate') {
      if (!requireAuth(api, state)) return;
      const cells = stmtGraffitiGetAll.all();
      sendOps(api.ws, [{ op: 'graffiti_state', cells }]);
      return;
    }

    if (msg.type === 'graffiti_paint') {
      if (!requireAuth(api, state)) return;
      const strokes = Array.isArray(msg.strokes) ? msg.strokes.slice(0, 9) : [];
      const valid = strokes.filter(s =>
        Number.isInteger(s.index) && s.index >= 0 && s.index < GRAFFITI_TOTAL &&
        isValidPixelColor(s.color) && GRAFFITI_PALETTE.includes(s.color)
      );
      if (!valid.length) return;
      const now = nowEpoch();
      for (const s of valid) {
        stmtGraffitiPaint.run(s.index, s.color, state.username, now);
      }
      HUB.clients.forEach(ws => sendOps(ws, [{ op: 'graffiti_painted', strokes: valid, by: state.username }]));
      const lastLog = stmtGraffitiLastLog.get(state.username);
      const todayYmd = dayKeyET(now * 1000); // board time (America/New_York)
      if (!lastLog || dayKeyET(lastLog.last_logged * 1000) !== todayYmd) {
        stmtGraffitiUpsertLog.run(state.username, now);
        addActivityEvent('community', 'graffiti', `🎨 ${state.username} tagged the graffiti wall`);
      }
      return;
    }

    if (msg.type === 'graffiti_erase') {
      if (!requireAuth(api, state)) return;
      const strokes = Array.isArray(msg.strokes) ? msg.strokes.slice(0, 9) : [];
      const validIndices = strokes
        .filter(s => Number.isInteger(s.index) && s.index >= 0 && s.index < GRAFFITI_TOTAL)
        .map(s => s.index);
      if (!validIndices.length) return;
      for (const idx of validIndices) {
        stmtGraffitiErase.run(idx);
      }
      HUB.clients.forEach(ws => sendOps(ws, [{ op: 'graffiti_erased', indices: validIndices, by: state.username }]));
      return;
    }

    if (msg.type !== 'input') return;

    const raw = String(msg.raw || '').trim();
    if (!raw) return;

    // Slash commands
    if (raw.startsWith('/')) {
      const [head, ...rest] = raw.slice(1).split(/\s+/);
      const cmd  = head.toLowerCase();
      const args = rest;

      // Global commands first (e.g., /chat, /links, /board, etc.)
      if (handleGlobalCommand && handleGlobalCommand(cmd, api, state, args)) return;

      // Optional screen-local commands
      const localHandled =
           (state.currentScreen === 'splash'     && splashHandleCommand && splashHandleCommand(cmd, api, state, args))
        || (state.currentScreen === 'chat'       && chatHandleCommand && chatHandleCommand(cmd, api, state, args))
        || (state.currentScreen === 'adminchat'  && adminChatHandleCommand && adminChatHandleCommand(cmd, api, state, args))
        || (state.currentScreen === 'topic'      && topicHandleCommand && topicHandleCommand(cmd, api, state, args))
        || (state.currentScreen === 'news:list'  && newsListHandleCommand && newsListHandleCommand(cmd, api, state, args))
        || (state.currentScreen === 'news:item'  && newsItemHandleCommand && newsItemHandleCommand(cmd, api, state, args))
        || (state.currentScreen === 'games'      && gamesHandleCommand   && gamesHandleCommand(cmd, api, state))
        || false;

      if (localHandled) return;
      api.print(`Unknown command: /${cmd}`, 'red');
      return;
    }

    // Raw input
    // === Raw input → route by current screen ===
    if (state.register && state.register.step === 'question') { handleRegisterAnswer(raw, api, state); return; }
    if (state.currentScreen === 'splash')     { splashHandleRaw && splashHandleRaw(raw, api, state); return; }
    if (state.currentScreen === 'chat')       { chatHandleRaw && chatHandleRaw(raw, api, state);     return; }
    if (state.currentScreen === 'adminchat')  { adminChatHandleRaw && adminChatHandleRaw(raw, api, state); return; }
    if (state.currentScreen === 'topic')      { topicHandleRaw && topicHandleRaw(raw, api, state);   return; }
    if (state.currentScreen === 'news:item')  { newsItemHandleRaw && newsItemHandleRaw(raw, api, state); return; }
    if (state.currentScreen === 'board')      { api.print('Use /topic <id> or /newtopic <title>.', 'dim'); return; }
    if (state.currentScreen === 'poll')       { api.print('Use /vote <poll id> <option #> or /newpoll <question> | <opt1> | <opt2> ...', 'dim'); return; }

    // Fallback
    api.print('Use /help for commands.', 'dim');
  });

  ws.on('close', () => {
    HUB.clients.delete(ws);
    removeUserPresence(api, state);
  });

  ws.on('error', (err) => console.error('WS error:', err));
});



/* ======================= Sweepers ======================= */
function runBoardSweep(){ try { sweepExpiredTopics.run(); } catch {} }
function runNewsSweep(){ try { sweepExpiredNews.run(); } catch {} }
function runChatSweep(){ try { sweepExpiredMessages.run(); } catch {} }
function runDMSweep(){ try { sweepExpiredDMs.run(); } catch {} }
function runSuggestionSweep(){ try { sweepExpiredSuggestions.run(); } catch {} }
function runStatusPostSweep(){ try { sweepExpiredStatusPosts.run(); } catch {} }
function runAdminChatSweep(){ try { sweepExpiredAdminMessages.run(); } catch {} }
function runAnnouncementSweep(){ try { sweepExpiredAnnouncements.run(); } catch {} }
function runInactiveUserSweep(){
  try {
    const maxAgeSeconds = inactiveUserAgeSeconds();
    if (maxAgeSeconds > 0) {
      sweepInactiveUsers.run(maxAgeSeconds);
    }
  } catch {}
}


setInterval(()=>{
  runChatSweep(); runDMSweep();
}, 10 * 60 * 1000);


function retentionSecondsAdmin(){
  const days = +(getSetting.get('admin_chat_retention_days')?.value || 7);
  return days > 0 ? days*86400 : 0;
}

function inactiveUserAgeSeconds(){
  const days = +(getSetting.get('user_inactive_days')?.value || 0);
  return days > 0 ? days*86400 : 0;
}



/* ======================= Admin Chat (admins only) ======================= */
function renderAdminChat(api, state){
  if (!requireAuth(api, state)) return;
  if (!state.isAdmin){ api.print('Unknown command.', 'red'); return; } // keep it discreet

  api.batch(b=>{
    b.clear();
    b.setInputLimit(null);
    b.print('== Admin Ops Chat ==', 'magenta');
    b.print('Private room for sysops / moderators.', 'dim'); b.hr();

    const here = usersCurrentlyInAdminChat();
    b.print(here.length ? `Here now (${here.length}): ${here.join(', ')}` : 'No admins here yet — say hi!', 'cyan');
    b.hr();

    const rows = recentAdminMessages.all().reverse();
    if (!rows.length){
      b.print('No messages yet. Type to chat. /main returns to menu.', 'dim');
    } else {
      let lastYmd = null;
      rows.forEach(r=>{
        const thisYmd = dayKeyET(r.created_at * 1000);
        if (thisYmd !== lastYmd) {
          printDayDivider(b, r.created_at);
          lastYmd = thisYmd;
        }
        const ts = formatTimeET(r.created_at * 1000);
        const disp = r.display_name || r.username || 'anon';
        const safeBody = sanitizeAndFormatDIS(r.body);
        const bodyWithColor = r.color ? `<span style="color:${r.color}">${safeBody}</span>` : safeBody;
        const html = `[${ts}] &lt;${sanitizeAndFormatDIS(disp)}&gt; ${bodyWithColor}`;
        const mine = state.username && r.username && state.username.toLowerCase() === r.username.toLowerCase();
        b.printHTML(html, mine ? 'me' : undefined);
      });
      if (api.ws && api.ws.__ctx) api.ws.__ctx.lastAdminChatDay = lastYmd;
    }

    b.hr();
    b.print('Type to chat. /leave exits. Markdown + colors allowed.', 'dim');
  });

  state.currentScreen = 'adminchat';
}

function adminChatHandleCommand(cmd, api, state){
  if (!requireAuth(api, state)) return true;
  if (!state.isAdmin){ api.print('Unknown command.', 'red'); return true; }
  if (cmd === 'leave' || cmd === 'menu' || cmd === 'main'){ routeGo(api, state, 'menu'); return true; }
  if (cmd === 'here'){ api.print('Here: ' + usersCurrentlyInAdminChat().join(', '), 'cyan'); return true; }
  return false;
}

function adminChatHandleRaw(text, api, state){
  if (!requireAuth(api, state)) return true;
  if (!state.isAdmin){ api.print('Unknown command.', 'red'); return true; }
  const msgText = (text||'').trim(); if (!msgText) return true;

  const uid = state.userId || null;
  const created = nowEpoch();
  const ttl = retentionSecondsAdmin(); const expires = ttl > 0 ? (created + ttl) : null;
  insertAdminMessage.run(uid, msgText, created, expires);

  const ts = formatTimeET(created * 1000);
  const disp = state.displayName || state.username || 'anon';
  const safeBody = sanitizeAndFormatDIS(msgText);
  const bodyWithColor = state.userColor ? `<span style="color:${state.userColor}">${safeBody}</span>` : safeBody;
  const html = `[${ts}] &lt;${sanitizeAndFormatDIS(disp)}&gt; ${bodyWithColor}`;

  // broadcast (includes per-socket day divider handling in your broadcast helper)
  broadcastAdminChatFrom(html, state.username || '', created);

  // === NEW: mentions → notify
  const fromRow = { id: uid, username: state.username };
  notifyMentions(msgText, fromRow, 'adminchat');

  return true;
}

app.post('/api/auth/complete', (req, res) => {
  if (!SSO_SECRET) {
    res.status(500).json({ ok: false, error: 'SSO_SECRET is not set' });
    return;
  }
  const token = req.body && typeof req.body.token === 'string' ? req.body.token : null;
  if (!token) {
    res.status(401).json({ ok: false });
    return;
  }
  const record = AUTH_TOKENS.get(token);
  if (!record) {
    res.status(401).json({ ok: false });
    return;
  }
  AUTH_TOKENS.delete(token);
  if (record.expMs <= Date.now()) {
    res.status(401).json({ ok: false });
    return;
  }
  let cookieValue;
  try {
    cookieValue = signAuthPayload({
      uid: record.userId,
      u: record.username,
      a: !!record.isAdmin,
      iat: Math.floor(Date.now() / 1000),
    });
  } catch (err) {
    res.status(500).json({ ok: false });
    return;
  }
  res.cookie('disbbs_auth', cookieValue, SSO_COOKIE_OPTIONS);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('disbbs_auth', {
    domain: SSO_COOKIE_OPTIONS.domain,
    path: SSO_COOKIE_OPTIONS.path,
    httpOnly: SSO_COOKIE_OPTIONS.httpOnly,
    secure: SSO_COOKIE_OPTIONS.secure,
    sameSite: SSO_COOKIE_OPTIONS.sameSite,
  });
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const cookieValue = getCookie(req, 'disbbs_auth');
  if (!cookieValue) {
    res.json({ user: null });
    return;
  }
  let payload;
  try {
    payload = verifyAuthCookie(cookieValue);
  } catch (err) {
    res.status(500).json({ user: null });
    return;
  }
  if (!payload) {
    res.json({ user: null });
    return;
  }
  res.json({
    user: {
      id: payload.uid,
      username: payload.u,
      isAdmin: !!payload.a,
    },
  });
});

app.get('/healthz', (req, res) => {
  // Liveness only — don't touch DB or do any work
  res.type('text').send('ok');
});

const stmtTotalMembers = db.prepare('SELECT COUNT(1) AS n FROM users');

app.get('/api/stats', (req, res) => {
  try {
    const members = stmtTotalMembers.get().n;
    const online  = HUB.online.size;
    res.json({ members, online });
  } catch (e) {
    res.json({ members: 0, online: 0 });
  }
});




/* ======================= REST Auth endpoints ======================= */
app.post('/api/login', (req, res) => {
  const username = req.body && typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = req.body && typeof req.body.password === 'string' ? req.body.password : '';
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'Username and password are required.' });
  }
  const user = verifyLogin(username, password);
  if (!user) {
    return res.status(401).json({ ok: false, error: 'Invalid username or password.' });
  }

  const fp = collectFingerprintFromReq(req, req.body || {});

  const banHit = checkBanForConnection(fp.ip, fp.fpHash);
  if (banHit) {
    logBanEnforcementDenial(user.username, fp.ip, banHit);
    return res.status(401).json({ ok: false, error: 'Invalid username or password.' });
  }

  try {
    updateUserFingerprint.run(fp.ip, fp.ip, fp.userAgent, fp.acceptLanguage, fp.fpHash, user.id);
  } catch (e) {
    console.error('[login] fingerprint update failed:', e && e.message);
  }

  const authToken = makeAuthToken();
  AUTH_TOKENS.set(authToken, {
    userId: user.id,
    username: user.username,
    isAdmin: !!user.is_admin,
    expMs: Date.now() + AUTH_TOKEN_TTL_MS,
  });
  res.json({ ok: true, token: authToken, username: user.username });
});

app.post('/api/register', (req, res) => {
  console.log('[register attempt]', {
    username: req.body && req.body.username,
    ip: req.ip,
    socket: req.socket?.remoteAddress,
    xff: req.headers['x-forwarded-for'],
    ua: req.headers['user-agent'],
    flyClientIp: req.headers['fly-client-ip'],
    cfConnectingIp: req.headers['cf-connecting-ip'],
    incompleteFp: req.body && req.body.incompleteFp,
  });
  const username     = req.body && typeof req.body.username     === 'string' ? req.body.username.trim()     : '';
  const password     = req.body && typeof req.body.password     === 'string' ? req.body.password            : '';
  const email        = req.body && typeof req.body.email        === 'string' ? req.body.email.trim()        : '';
  const signupReason = req.body && typeof req.body.signupReason === 'string' ? req.body.signupReason.trim() : '';

  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'Username and password are required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters.' });
  }
  if (!signupReason) {
    return res.status(400).json({ ok: false, error: 'Please tell us what brought you to DIS.' });
  }

  const fp = collectFingerprintFromReq(req, req.body || {});

  // Ban checks — username first (specific), then IP/fingerprint (generic)
  if (checkBanByUsername.get(username)) {
    return res.status(403).json({ ok: false, error: 'That username is not available.' });
  }
  const usernameLower = username.toLowerCase();
  const BLOCKED_USERNAME_SUBSTRINGS = ['hitler', 'nazi', 'n4zi'];
  if (BLOCKED_USERNAME_SUBSTRINGS.some(b => usernameLower.includes(b))) {
    return res.status(403).json({ ok: false, error: 'That username is not available.' });
  }
  if (fp.ip && checkBanByIp.get(fp.ip)) {
    return res.status(403).json({ ok: false, error: 'Registration is not available.' });
  }
  if (fp.fpHash && checkBanByFingerprint.get(fp.fpHash)) {
    return res.status(403).json({ ok: false, error: 'Registration is not available.' });
  }

  const ipUnresolvable = isUnresolvableIp(fp.ip);
  const hasNoUserAgent = !fp.userAgent || fp.userAgent.trim() === '';
  const clientIncompleteFp = req.body && req.body.incompleteFp === true;

  // Block if: no real IP and no user agent (headless/scripted client)
  // Block if: no real IP and client explicitly signals incomplete fingerprint
  // Block if: no real IP and no fingerprint hash at all (nothing to identify the client)
  const hasNoFingerprint = !fp.fpHash;
  const shouldBlock = (ipUnresolvable && hasNoUserAgent) ||
                      (ipUnresolvable && clientIncompleteFp) ||
                      (ipUnresolvable && hasNoFingerprint);

  if (shouldBlock) {
    console.log('[register blocked]', { username, reason: { ipUnresolvable, hasNoUserAgent, clientIncompleteFp } });
    const rawIp = fp.ip || req.socket?.remoteAddress || req.ip || '';
    try {
      insertRegistrationRejection.run(nowEpoch(), rawIp, fp.userAgent || '', username);
    } catch (e) {
      console.error('[register] rejection log failed:', e && e.message);
    }
    return res.status(403).json({ ok: false, error: 'Registration is currently unavailable. Please try again with a standard browser and connection.' });
  }

  const result = createUser(username, password);
  if (!result.ok) {
    if (result.reason === 'exists') {
      return res.status(409).json({ ok: false, error: 'That username is already taken.' });
    }
    return res.status(500).json({ ok: false, error: 'Registration failed.' });
  }

  try { setUserSignupReason.run(signupReason, result.id); } catch {}
  if (email) {
    try { db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, result.id); } catch {}
  }
  try {
    updateUserFingerprintOnRegister.run(fp.ip, fp.ip, fp.userAgent, fp.acceptLanguage, fp.fpHash, result.id);
  } catch (e) {
    console.error('[register] fingerprint store failed:', e && e.message);
  }
  try {
    chrome.award(username, 100, 'welcome bonus');
  } catch (e) {
    console.error('[api/register] chrome welcome award failed:', e && e.message);
  }
  addActivityEvent('community', 'registration', `👤 ${username} just joined DIS!`);
  checkLeaderChange();

  const user = getUserByName.get(username);
  const authToken = makeAuthToken();
  AUTH_TOKENS.set(authToken, {
    userId: user.id,
    username: user.username,
    isAdmin: !!user.is_admin,
    expMs: Date.now() + AUTH_TOKEN_TTL_MS,
  });
  console.log('[register success]', { username, ip: fp.ip, ua: fp.userAgent });
  res.json({ ok: true, token: authToken, username: user.username });
});

/* ======================= Wordle REST endpoints ======================= */
app.get('/api/wordle/leaderboard', (req, res) => {
  const today = getWordleDate();
  res.json({
    currentStreaks: wordleLeaderCurrent.all(),
    bestStreaks:    wordleLeaderBest.all(),
    todaySolvers:  wordleGetTodaySolvers.all(today),
    date:          today,
  });
});

/* ======================= Password recovery ======================= */
function resetPasswordPageHtml({ invalid, token }) {
  const errorBlock = invalid
    ? `<div class="msg err">${escapeHTML(invalid)}</div>`
    : '';
  const formBlock = invalid ? '' : `
    <div class="field">
      <label for="new-pw">New password <span class="hint">min 6 characters</span></label>
      <input id="new-pw" type="password" autocomplete="new-password">
    </div>
    <div class="field">
      <label for="confirm-pw">Confirm new password</label>
      <input id="confirm-pw" type="password" autocomplete="new-password">
    </div>
    <button id="reset-btn" type="button">Set New Password</button>
    <div id="reset-err" class="msg err" hidden></div>`;
  const tokenJs = invalid ? '' : `var TOKEN=${JSON.stringify(token)};`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Password Reset — Dead Internet Society</title>
<style>
  :root{--bg:#000;--fg:#e6e6e6;--cyan:#19c3c3;--mag:#cc66ff;--red:#ff4545}
  html,body{height:100%;background:var(--bg);color:var(--fg);
    font:14px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
    margin:0;display:flex;align-items:center;justify-content:center;
    padding:24px;box-sizing:border-box}
  .card{width:100%;max-width:360px;border:1px solid #1a1a1a;border-radius:8px;
    background:#050505;padding:28px 24px}
  h1{font-size:13px;color:var(--mag);letter-spacing:2px;margin:0 0 3px;text-transform:uppercase}
  .sub{font-size:11px;color:#555;margin-bottom:22px}
  .field{display:flex;flex-direction:column;gap:5px;margin-bottom:14px}
  .field label{font-size:10px;color:#777;letter-spacing:.8px;text-transform:uppercase}
  .hint{font-size:10px;color:#444;text-transform:none;letter-spacing:0}
  .field input{background:#0c0c0c;color:var(--fg);border:1px solid #1a1a1a;
    outline:0;padding:9px 11px;border-radius:5px;font:inherit;caret-color:var(--cyan)}
  .field input:focus{border-color:#2e2e2e}
  button{appearance:none;border:1px solid var(--cyan);background:rgba(25,195,195,.07);
    color:var(--cyan);font:inherit;font-size:13px;padding:10px;border-radius:5px;
    cursor:pointer;width:100%;letter-spacing:.4px;transition:background .12s}
  button:hover{background:rgba(25,195,195,.14)}
  button:disabled{opacity:.4;cursor:not-allowed}
  .msg{font-size:12px;padding:8px 11px;border-radius:4px;margin-bottom:14px;line-height:1.45}
  .msg.err{background:rgba(255,69,69,.08);border:1px solid rgba(255,69,69,.35);color:var(--red)}
  .back{font-size:12px;color:#555;margin-top:14px;text-align:center}
  .back a{color:var(--cyan);text-decoration:none}
  .back a:hover{text-decoration:underline}
</style>
</head>
<body>
<div class="card">
  <h1>Dead Internet Society</h1>
  <div class="sub">password reset</div>
  ${errorBlock}
  ${formBlock}
  <div class="back"><a href="/">Back to login</a></div>
</div>
<script>
${tokenJs}
(function(){
  var btn=document.getElementById('reset-btn');
  var errEl=document.getElementById('reset-err');
  function showErr(m){if(errEl){errEl.textContent=m;errEl.hidden=false;}}
  if(!btn)return;
  function submit(){
    var pw=(document.getElementById('new-pw')||{}).value||'';
    var cp=(document.getElementById('confirm-pw')||{}).value||'';
    if(pw.length<6){showErr('Password must be at least 6 characters.');return;}
    if(pw!==cp){showErr('Passwords do not match.');return;}
    btn.disabled=true;
    fetch('/api/reset-password',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token:TOKEN,password:pw})
    }).then(function(r){return r.json();}).then(function(d){
      if(d.ok){window.location.href='/?reset=success';}
      else{showErr(d.error||'Reset failed.');btn.disabled=false;}
    }).catch(function(){showErr('Connection error. Try again.');btn.disabled=false;});
  }
  btn.addEventListener('click',submit);
  ['new-pw','confirm-pw'].forEach(function(id){
    var el=document.getElementById(id);
    if(el)el.addEventListener('keydown',function(e){if(e.key==='Enter')submit();});
  });
})();
</script>
</body>
</html>`;
}

app.post('/api/forgot-password', async (req, res) => {
  const raw = req.body && typeof req.body.usernameOrEmail === 'string'
    ? req.body.usernameOrEmail.trim() : '';
  if (!raw) {
    return res.status(400).json({ ok: false, error: 'Please enter your username or email address.' });
  }

  // Look up by username first, then by email
  let user = getUserByName.get(raw);
  if (!user) {
    user = db.prepare(
      'SELECT * FROM users WHERE email IS NOT NULL AND LOWER(email) = LOWER(?)'
    ).get(raw);
  }

  if (!user) {
    // Return a vague but honest response — the account just isn't found
    return res.json({ ok: true, message: 'If that account exists, a recovery email has been sent.' });
  }

  if (!user.email) {
    return res.json({
      ok: false,
      error: 'No email address is on file for this account. Contact the admin for help.',
    });
  }

  if (!mailer) {
    return res.status(503).json({ ok: false, error: 'Email is not configured on this server.' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const createdAt = nowEpoch();

  try {
    insertPasswordResetToken.run(user.username, token, createdAt);
  } catch (e) {
    console.error('[forgot-password] DB insert failed:', e && e.message);
    return res.status(500).json({ ok: false, error: 'Could not create reset token.' });
  }

  const baseUrl = process.env.SITE_URL || `${req.protocol}://${req.get('host')}`;
  const resetUrl = `${baseUrl}/api/reset-password?token=${token}`;

  try {
    await mailer.sendMail({
      from: SMTP_FROM,
      to: user.email,
      subject: 'Dead Internet Society — password recovery',
      text: [
        `Hi ${user.username},`,
        '',
        'Someone requested a password reset for your Dead Internet Society account.',
        '',
        `Reset link (valid for 1 hour):\n${resetUrl}`,
        '',
        'If you did not request this, ignore this email — your password has not changed.',
        '',
        '— DIS sysop',
      ].join('\n'),
      html: `<pre style="font-family:monospace;font-size:14px;line-height:1.5">`
        + `Hi ${escapeHTML(user.username)},\n\n`
        + `Someone requested a password reset for your Dead Internet Society account.\n\n`
        + `Reset link (valid for 1 hour):\n`
        + `<a href="${escapeHTML(resetUrl)}">${escapeHTML(resetUrl)}</a>\n\n`
        + `If you did not request this, ignore this email.\n\n`
        + `— DIS sysop</pre>`,
    });
  } catch (e) {
    console.error('[forgot-password] sendMail failed:', e && e.message);
    return res.status(500).json({ ok: false, error: 'Failed to send email. Try again later.' });
  }

  res.json({ ok: true, message: 'Recovery email sent. Check your inbox (and spam folder).' });
});

app.get('/api/reset-password', (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token.trim() : '';
  if (!token) {
    return res.send(resetPasswordPageHtml({ invalid: 'Missing reset token.' }));
  }
  const row = getPasswordResetToken.get(token);
  if (!row) {
    return res.send(resetPasswordPageHtml({ invalid: 'Invalid or expired reset link.' }));
  }
  if (row.used_at) {
    return res.send(resetPasswordPageHtml({ invalid: 'This reset link has already been used.' }));
  }
  if (nowEpoch() - row.created_at > 3600) {
    return res.send(resetPasswordPageHtml({ invalid: 'This reset link has expired (valid for 1 hour).' }));
  }
  res.send(resetPasswordPageHtml({ token }));
});

app.post('/api/reset-password', (req, res) => {
  const token    = req.body && typeof req.body.token    === 'string' ? req.body.token.trim()    : '';
  const password = req.body && typeof req.body.password === 'string' ? req.body.password        : '';

  if (!token || !password) {
    return res.status(400).json({ ok: false, error: 'Token and new password are required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters.' });
  }

  const row = getPasswordResetToken.get(token);
  if (!row || row.used_at || (nowEpoch() - row.created_at > 3600)) {
    return res.status(410).json({ ok: false, error: 'Invalid or expired reset link.' });
  }

  const user = getUserByName.get(row.username);
  if (!user) {
    return res.status(404).json({ ok: false, error: 'Account not found.' });
  }

  const hash = bcrypt.hashSync(password, 10);
  try {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
    markPasswordResetTokenUsed.run(nowEpoch(), token);
  } catch (e) {
    console.error('[reset-password] DB update failed:', e && e.message);
    return res.status(500).json({ ok: false, error: 'Password update failed.' });
  }

  res.json({ ok: true });
});

/* ======================= Ko-fi Webhook ======================= */
app.post('/api/kofi/webhook', (req, res) => {
  const raw = req.body && req.body.data;
  if (!raw) {
    console.warn('[kofi] webhook received with no data field');
    return res.status(200).json({ ok: true });
  }

  let payload;
  try { payload = JSON.parse(raw); }
  catch (e) {
    console.warn('[kofi] webhook JSON parse failed:', e.message);
    return res.status(200).json({ ok: true });
  }

  if (!KOFI_VERIFICATION_TOKEN || payload.verification_token !== KOFI_VERIFICATION_TOKEN) {
    console.warn('[kofi] webhook verification failed');
    return res.status(401).json({ error: 'unauthorized' });
  }

  const txId     = String(payload.kofi_transaction_id || '').trim();
  const kofiName = String(payload.from_name || '').trim();
  const amount   = parseFloat(payload.amount) || 0;
  const message  = String(payload.message || '').trim();

  if (!txId || !kofiName) return res.status(200).json({ ok: true });

  if (getDonationByTxId.get(txId)) return res.status(200).json({ ok: true, duplicate: true });

  // Username match: scan message words, then fall back to donation_links table
  let disUsername = null;
  if (message) {
    const words = message.split(/\s+/);
    for (const word of words) {
      const cleaned = word.replace(/[^a-zA-Z0-9_-]/g, '');
      if (!cleaned) continue;
      const user = getUserByName.get(cleaned);
      if (user) { disUsername = user.username; break; }
    }
  }
  if (!disUsername) {
    const link = getDonationLinkByKofi.get(kofiName);
    if (link) disUsername = link.dis_username;
  }

  const chromeAmount = Math.floor(amount * 100);
  const now = nowEpoch();

  insertDonation.run(txId, kofiName, disUsername || null, amount, message, disUsername ? chromeAmount : 0, now);

  if (disUsername && chromeAmount > 0) {
    try { chrome.award(disUsername, chromeAmount, 'donation bonus'); } catch (e) {
      console.error('[kofi] chrome award failed:', e && e.message);
    }
    checkLeaderChange();

    const sockets = HUB.socketsByUser.get(disUsername);
    if (sockets) {
      const ops = [{ op: 'print', text: `💙 thank you for your donation! you've been awarded ${fmtCr(chromeAmount)} ₢`, cls: 'cyan' }];
      for (const ws of sockets) { try { sendOps(ws, ops); } catch {} }
    }

    try { gameFeedInsert.run(disUsername, 'donation', `💙 ${disUsername} supported DIS and earned ${fmtCr(chromeAmount)} ₢!`, now); } catch {}
    addActivityEvent('chrome', 'donation', `💙 ${disUsername} supported DIS and earned ${fmtCr(chromeAmount)} ₢!`);
  }

  console.log(`[kofi] donation: ${kofiName} $${amount}${disUsername ? ` → ${disUsername} +${chromeAmount}₢` : ' (unlinked)'}`);
  return res.status(200).json({ ok: true });
});

/* ======================= Start ======================= */
server.listen(PORT, ()=> {
  console.log(`DIS BBS listening on http://localhost:${PORT}`);

  // Sanity check for the board-time (America/New_York) migration: makes it
  // obvious at a glance in server logs whether reset scheduling is landing
  // where it should, regardless of what timezone this host itself reports.
  const bootMs = Date.now();
  const utcNow = new Date(bootMs).toISOString();
  const boardNow = formatStampET(bootMs) + ' ET';
  const msToMidnight = msUntilNextMidnightET(bootMs);
  const hoursToMidnight = (msToMidnight / 3600000).toFixed(2);
  console.log(`[time] UTC now: ${utcNow}  |  board time now: ${boardNow}  |  next board midnight in ${hoursToMidnight}h (${msToMidnight}ms)`);
});
