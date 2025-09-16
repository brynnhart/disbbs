// server.js (Flat Functions Edition)
// Dead Internet Society — Node/Express + WebSocket BBS (Single-Room)

const path = require('path');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto'); // invites


// Doors (optional; safe if missing on disk)
let DoorManager, tinyquestDoor, lordDoor, casinoDoor;
try {
  const DM = require('./doors/manager');     // our singleton module above
  DoorManager = DM?.DoorManager || DM;
  tinyquestDoor = require('./doors/tinyquest'); // factory or object, 
  lordDoor = require('./doors/lord');
  casinoDoor = require('./doors/casino');
} catch (e) {
  console.error('Doors load failed:', e && e.message ? e.message : e);
}



const DB_PATH = process.env.DB_PATH || './dis.sqlite3';
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use('/static', require('express').static(path.join(__dirname, 'public')));

/* ======================= DB Open + Pragmas ======================= */
const db = new Database(DB_PATH);
module.exports.__db = db;
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

/* ======================= Migrations (idempotent) ======================= */
db.exec(`
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER,
  preferred_color TEXT,
  display_name TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,              -- NULL = no expiry
  used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  used_at INTEGER,                 -- NULL = unused
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_invites_code       ON invites(code);
CREATE INDEX IF NOT EXISTS idx_invites_expires_at ON invites(expires_at);
CREATE INDEX IF NOT EXISTS idx_invites_used_at    ON invites(used_at);

/* DMs */
CREATE TABLE IF NOT EXISTS dm_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  recipient_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_dm_recipient_created ON dm_messages(recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dm_expires_at ON dm_messages(expires_at);
CREATE INDEX IF NOT EXISTS idx_dm_read_at ON dm_messages(read_at);

/* Suggestions */
CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_suggestions_expires ON suggestions(expires_at);
CREATE INDEX IF NOT EXISTS idx_suggestions_created ON suggestions(created_at DESC);

/* Commons Chat */
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_expires_at ON messages(expires_at);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

/* Board (topics & comments) */
CREATE TABLE IF NOT EXISTS board_topics (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  title             TEXT NOT NULL,
  creator_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        INTEGER NOT NULL,
  last_commented_at INTEGER NOT NULL,
  expires_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_board_topics_last  ON board_topics(last_commented_at);
CREATE INDEX IF NOT EXISTS idx_board_topics_exp   ON board_topics(expires_at);

CREATE TABLE IF NOT EXISTS board_comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id    INTEGER NOT NULL REFERENCES board_topics(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_board_comments_topic_created ON board_comments(topic_id, created_at);

/* News (posts & comments) */
CREATE TABLE IF NOT EXISTS news_posts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  title             TEXT NOT NULL,
  url               TEXT NOT NULL,
  tag               TEXT NOT NULL,
  user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        INTEGER NOT NULL,
  last_commented_at INTEGER NOT NULL,
  expires_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_news_posts_last  ON news_posts(last_commented_at);
CREATE INDEX IF NOT EXISTS idx_news_posts_exp   ON news_posts(expires_at);

CREATE TABLE IF NOT EXISTS news_comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id     INTEGER NOT NULL REFERENCES news_posts(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_news_comments_post_created ON news_comments(post_id, created_at);


/* Admin Chat (private, admins-only) */
CREATE TABLE IF NOT EXISTS admin_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_admin_messages_expires_at ON admin_messages(expires_at);
CREATE INDEX IF NOT EXISTS idx_admin_messages_created_at ON admin_messages(created_at);

CREATE TABLE IF NOT EXISTS users (
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   username TEXT NOT NULL UNIQUE COLLATE NOCASE,
   password_hash TEXT NOT NULL,
   is_admin INTEGER NOT NULL DEFAULT 0,
   created_at INTEGER NOT NULL,
   last_login_at INTEGER,
   preferred_color TEXT,
   display_name TEXT
);


`);


// === Mentions / Notifications bootstrap ===
let insertNotification, listNotificationsForUser, markAllNotificationsSeen;

function ensureNotificationsSchema(){
  // 1) table + indexes
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      to_user_id   INTEGER NOT NULL,
      from_user_id INTEGER,
      kind         TEXT    NOT NULL,      -- e.g. 'mention'
      context      TEXT    NOT NULL,      -- 'chat', 'adminchat', 'topic:<id>', 'news:<id>'
      body         TEXT    NOT NULL,      -- raw text that triggered the notify
      created_at   INTEGER NOT NULL,
      seen_at      INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_notify_to_created ON notifications (to_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notify_to_unseen  ON notifications (to_user_id, seen_at);
  `);

  // 2) prepared statements
  insertNotification = db.prepare(`
    INSERT INTO notifications (to_user_id, from_user_id, kind, context, body, created_at, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `);

  listNotificationsForUser = db.prepare(`
    SELECT n.id, n.kind, n.context, n.body, n.created_at, n.seen_at,
         u.username AS from_username, u.display_name AS from_display
    FROM notifications n
    LEFT JOIN users u ON u.id = n.from_user_id
   WHERE n.to_user_id = ?
     AND n.kind = 'mention'
   ORDER BY (n.seen_at IS NULL) DESC, n.created_at DESC
   LIMIT ?
 `);

  markAllNotificationsSeen = db.prepare(`
    UPDATE notifications
       SET seen_at = strftime('%s','now')
     WHERE to_user_id = ? AND seen_at IS NULL
  `);
}

// call once at startup (where you set up other schema/seed):
ensureNotificationsSchema();


/* One-time, safe add of 'about' column for profiles (no-op if present) */
try {
  const hasAbout = db.prepare("PRAGMA table_info(users)").all().some(c => c.name === 'about');
  if (!hasAbout) {
    db.exec(`ALTER TABLE users ADD COLUMN about TEXT`);
  }
} catch (e) {
  console.error('Failed to add users.about column (ok if already exists):', e && e.message ? e.message : e);
}


/* One-time, safe add of normalization columns and indexes for fast lookup */
try {
  const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!cols.includes('username_norm')) {
    db.exec(`ALTER TABLE users ADD COLUMN username_norm TEXT`);
  }
  if (!cols.includes('display_name_norm')) {
    db.exec(`ALTER TABLE users ADD COLUMN display_name_norm TEXT`);
  }
} catch (e) {
  console.error('users.*_norm add failed (ok if already exists):', e && e.message ? e.message : e);
}

try {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_users_username_norm     ON users(username_norm);
    CREATE INDEX IF NOT EXISTS idx_users_display_name_norm ON users(display_name_norm);
  `);
} catch (e) {
  console.error('users.*_norm index create failed:', e && e.message ? e.message : e);
}



/* ======================= Prepared statements / settings ======================= */
const getSetting = db.prepare(`SELECT value FROM settings WHERE key=?`);
const setSetting = db.prepare(`
  INSERT INTO settings(key,value) VALUES(?,?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value
`);

/* Settings defaults */
defSetting('chat_retention_days', 7);
defSetting('dm_retention_days', 14);
defSetting('dm_max_len', 160);
defSetting('suggestion_retention_days', 60);
defSetting('suggestion_max_len', 400);
defSetting('board_inactive_days', 30);
defSetting('board_title_max_len', 120);
defSetting('board_reply_max_len', 600);
defSetting('board_list_limit', 100);
defSetting('news_inactive_days', 30);
defSetting('news_title_max_len', 120);
defSetting('news_reply_max_len', 600);
defSetting('news_list_limit', 150);
defSetting('admin_chat_retention_days', 7);
defSetting('about_max_len', 600);
defSetting('users_page_size', 20);


/* Users + auth */
const getUserByName = db.prepare(`SELECT * FROM users WHERE username = ?`);
const getUserIdByName = db.prepare(`SELECT id FROM users WHERE username = ?`);
const createUserStmt = db.prepare(`
  INSERT INTO users(username, password_hash, is_admin, created_at)
  VALUES (?, ?, ?, ?)
`);
const setLastLogin = db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`);
const getUserColor = db.prepare(`SELECT preferred_color FROM users WHERE id = ?`);
const setUserColor = db.prepare(`UPDATE users SET preferred_color = ? WHERE id = ?`);
const clearUserColor = db.prepare(`UPDATE users SET preferred_color = NULL WHERE id = ?`);
const getUserDisplay = db.prepare(`SELECT display_name FROM users WHERE id = ?`);
const setUserDisplay = db.prepare(`UPDATE users SET display_name = ? WHERE id = ?`);
const clearUserDisplay = db.prepare(`UPDATE users SET display_name = NULL WHERE id = ?`);

/* Profiles (About) */
const getUserAboutById   = db.prepare(`SELECT about FROM users WHERE id = ?`);
const getUserAboutByName = db.prepare(`SELECT about FROM users WHERE username = ?`);
const setUserAboutById   = db.prepare(`UPDATE users SET about = ? WHERE id = ?`);

/* Invites */
const insertInvite = db.prepare(`
  INSERT INTO invites (code, created_by, created_at, expires_at, note)
  VALUES (?, ?, strftime('%s','now'), ?, ?)
`);

const getInvite = db.prepare(`
  SELECT * FROM invites WHERE code = ?
`);


const redeemInvite = db.prepare(`
  UPDATE invites
     SET used_by = ?, used_at = strftime('%s','now')
   WHERE code = ? AND used_at IS NULL
`);


const sweepExpiredInvites = db.prepare(`DELETE FROM invites WHERE expires_at IS NOT NULL AND expires_at <= strftime('%s','now')`);

/* DMs */
const insertDM = db.prepare(`
  INSERT INTO dm_messages (sender_id, recipient_id, body, created_at, expires_at)
  VALUES (?, ?, ?, ?, ?)
`);
const listDMsForUser = db.prepare(`
  SELECT m.id, m.body, m.created_at, m.read_at,
         u.username AS sender, u.display_name, u.preferred_color
  FROM dm_messages m
  LEFT JOIN users u ON u.id = m.sender_id
  WHERE m.recipient_id = ?
    AND (m.expires_at IS NULL OR m.expires_at > strftime('%s','now'))
  ORDER BY (m.read_at IS NULL) DESC, m.created_at DESC
  LIMIT ?
`);
const markAllDMsRead = db.prepare(`
  UPDATE dm_messages SET read_at = strftime('%s','now')
  WHERE recipient_id = ? AND read_at IS NULL
`);
const sweepExpiredDMs = db.prepare(`
  DELETE FROM dm_messages WHERE expires_at IS NOT NULL AND expires_at <= strftime('%s','now')
`);

/* Suggestions */
const insertSuggestion = db.prepare(`
  INSERT INTO suggestions (user_id, body, created_at, expires_at)
  VALUES (?, ?, ?, ?)
`);
const listSuggestions = db.prepare(`
  SELECT s.id, s.body, s.created_at, u.username, u.display_name
  FROM suggestions s
  LEFT JOIN users u ON u.id = s.user_id
  WHERE (s.expires_at IS NULL OR s.expires_at > strftime('%s','now'))
  ORDER BY s.created_at DESC
  LIMIT 200
`);
const deleteSuggestionById = db.prepare(`DELETE FROM suggestions WHERE id = ?`);
const sweepExpiredSuggestions = db.prepare(`
  DELETE FROM suggestions WHERE expires_at IS NOT NULL AND expires_at <= strftime('%s','now')
`);

/* Commons Chat */
const insertMessage = db.prepare(`
  INSERT INTO messages (user_id, body, created_at, expires_at)
  VALUES (?, ?, ?, ?)
`);
const recentMessages = db.prepare(`
  SELECT m.id, m.body, m.created_at,
         u.username, u.display_name, u.preferred_color AS color
  FROM messages m
  LEFT JOIN users u ON u.id = m.user_id
  WHERE (m.expires_at IS NULL OR m.expires_at > strftime('%s','now'))
  ORDER BY m.created_at DESC
  LIMIT 200
`);
const sweepExpiredMessages = db.prepare(`
  DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at <= strftime('%s','now')
`);

/* Board */
const insertTopic = db.prepare(`
  INSERT INTO board_topics (title, creator_id, created_at, last_commented_at, expires_at)
  VALUES (?, ?, ?, ?, ?)
`);
const deleteTopicById = db.prepare(`DELETE FROM board_topics WHERE id = ?`);
const selectTopicsList = db.prepare(`
  SELECT t.id, t.title, t.created_at, t.last_commented_at,
         COUNT(c.id) AS comments
  FROM board_topics t
  LEFT JOIN board_comments c ON c.topic_id = t.id
  WHERE (t.expires_at IS NULL OR t.expires_at > strftime('%s','now'))
  GROUP BY t.id
  ORDER BY t.last_commented_at DESC
  LIMIT ?
`);
const selectTopic = db.prepare(`
  SELECT t.id, t.title, u.username AS creator, u.display_name
  FROM board_topics t
  LEFT JOIN users u ON u.id = t.creator_id
  WHERE t.id = ?
    AND (t.expires_at IS NULL OR t.expires_at > strftime('%s','now'))
`);
const selectCommentsForTopic = db.prepare(`
  SELECT c.id, c.body, c.created_at, u.username, u.display_name, u.preferred_color
  FROM board_comments c
  LEFT JOIN users u ON u.id = c.user_id
  WHERE c.topic_id = ?
  ORDER BY c.created_at ASC
  LIMIT 500
`);
const insertComment = db.prepare(`
  INSERT INTO board_comments (topic_id, user_id, body, created_at)
  VALUES (?, ?, ?, ?)
`);
const updateTopicBump = db.prepare(`
  UPDATE board_topics SET last_commented_at = ?, expires_at = ? WHERE id = ?
`);
const sweepExpiredTopics = db.prepare(`
  DELETE FROM board_topics
  WHERE expires_at IS NOT NULL AND expires_at <= strftime('%s','now')
`);

/* News */
const insertNewsPost = db.prepare(`
  INSERT INTO news_posts (title, url, tag, user_id, created_at, last_commented_at, expires_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const deleteNewsById = db.prepare(`DELETE FROM news_posts WHERE id = ?`);
const selectNewsList = db.prepare(`
  SELECT p.id, p.title, p.url, p.tag, p.created_at, p.last_commented_at,
         u.username, u.display_name, u.preferred_color,
         (SELECT COUNT(1) FROM news_comments nc WHERE nc.post_id = p.id) AS comments
    FROM news_posts p
    LEFT JOIN users u ON u.id = p.user_id
   WHERE (p.expires_at IS NULL OR p.expires_at > strftime('%s','now'))
   ORDER BY p.last_commented_at DESC
   LIMIT ?
`);
const selectNewsPost = db.prepare(`
  SELECT p.id, p.title, p.url, p.tag, u.username, u.display_name
    FROM news_posts p
    LEFT JOIN users u ON u.id = p.user_id
   WHERE p.id = ?
     AND (p.expires_at IS NULL OR p.expires_at > strftime('%s','now'))
`);
const selectNewsComments = db.prepare(`
  SELECT c.id, c.body, c.created_at, u.username, u.display_name, u.preferred_color
    FROM news_comments c
    LEFT JOIN users u ON u.id = c.user_id
   WHERE c.post_id = ?
   ORDER BY c.created_at ASC
   LIMIT 500
`);
const insertNewsComment = db.prepare(`
  INSERT INTO news_comments (post_id, user_id, body, created_at)
  VALUES (?, ?, ?, ?)
`);
const bumpNewsPost = db.prepare(`
  UPDATE news_posts SET last_commented_at = ?, expires_at = ? WHERE id = ?
`);
const sweepExpiredNews = db.prepare(`
  DELETE FROM news_posts
  WHERE expires_at IS NOT NULL AND expires_at <= strftime('%s','now')
`);



/* Admin Chat */
const insertAdminMessage = db.prepare(`
  INSERT INTO admin_messages (user_id, body, created_at, expires_at)
  VALUES (?, ?, ?, ?)
`);
const recentAdminMessages = db.prepare(`
  SELECT m.id, m.body, m.created_at,
         u.username, u.display_name, u.preferred_color AS color
    FROM admin_messages m
    LEFT JOIN users u ON u.id = m.user_id
   WHERE (m.expires_at IS NULL OR m.expires_at > strftime('%s','now'))
   ORDER BY m.created_at DESC
   LIMIT 200
`);
const sweepExpiredAdminMessages = db.prepare(`
  DELETE FROM admin_messages WHERE expires_at IS NOT NULL AND expires_at <= strftime('%s','now')
`);








/* Keep users.username_norm / display_name_norm up-to-date */
const updateUserNorms = db.prepare(`
  UPDATE users
     SET username_norm     = ?,
         display_name_norm = ?
   WHERE id = ?
`);

/* Indexed lookup by normalized name (falls back when fast username match fails) */
const getUsersByNorm = db.prepare(`
  SELECT * FROM users
   WHERE username_norm = ?
      OR display_name_norm = ?
   LIMIT 3
`);


const listUsersBasic = db.prepare(`
  SELECT id, username, display_name, last_login_at, created_at, is_admin
  FROM users
  ORDER BY username COLLATE NOCASE ASC
`);


/* Users listing */
const countUsers = db.prepare(`SELECT COUNT(1) AS n FROM users`);
const listUsersPage = db.prepare(`
  SELECT username, display_name, last_login_at
    FROM users
ORDER BY username COLLATE NOCASE ASC
   LIMIT ? OFFSET ?
`);






/* ======================= Seed admin ======================= */
if (!getUserIdByName.get('Punkyroo')) {
  const hash = bcrypt.hashSync('password', 10);
  createUserStmt.run('Punkyroo', hash, 1, nowEpoch());
}

/* ======================= HUB / Ops ======================= */
const HUB = {
  clients: new Set(),
  online: new Set(),
  socketsByUser: new Map() // username -> Set<WebSocket>
};

function sendOps(ws, ops){
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ops', ops }));
  }
}

function makeApi(ws){
  function _send(ops){ sendOps(ws, ops); }
  return {
    ws,

    // Basic output ops
    clear(){ _send([{ op:'clear' }]); },
    print(t, cls){ _send([{ op:'print', text:String(t||''), cls:cls||'' }]); },
    printHTML(h, cls){
      const op = { op:'printHTML', html:String(h||'') };
      if (cls) op.cls = cls;
      _send([op]);
    },
    hr(){ _send([{ op:'hr' }]); },

    // Input/Prompt controls
    setInputType(type, placeholder){ _send([{ op:'setInput', inputType:type, placeholder }]); },
    setPrompt(prefix){ _send([{ op:'setPrompt', prefix:String(prefix||'DIS>') }]); },

    // Batched ops (same API as above, but buffered)
    batch(fn){
      const ops = [];
      const b = {
        clear(){ ops.push({ op:'clear' }); },
        print(t, cls){ ops.push({ op:'print', text:String(t||''), cls:cls||'' }); },
        printHTML(h, cls){
          const op = { op:'printHTML', html:String(h||'') };
          if (cls) op.cls = cls;
          ops.push(op);
        },
        hr(){ ops.push({ op:'hr' }); },

        // Match the top-level API inside batch too:
        setInputType(type, placeholder){ ops.push({ op:'setInput', inputType:type, placeholder }); },
        setPrompt(prefix){ ops.push({ op:'setPrompt', prefix:String(prefix||'DIS>') }); }
      };
      fn(b);
      _send(ops);
    }
  };
}


function broadcastSystem(line){
  HUB.clients.forEach(ws => sendOps(ws, [{op:'print', text:line, cls:'dim'}]));
}
function broadcastChatFrom(htmlLine, fromUsername, createdAtSec){
  const from = (fromUsername || '').toLowerCase();
  HUB.clients.forEach((client) => {
    const st = client.__ctx?.state; if (!st) return;
    if (st.currentScreen !== 'chat') return;

    const u = (st.username || '').toLowerCase();
    const isMine = from && u === from;

    const ops = [];

    // Insert a day divider if needed (per socket)
    if (createdAtSec && client.__ctx) {
      const msgYmd = ymdFromEpoch(createdAtSec);
      if (client.__ctx.lastChatDay !== msgYmd) {
        const label = dayHeadingFromEpoch(createdAtSec);
        ops.push({ op:'printHTML', html:`<span class="dim">── ${escapeHTML(label)} ──</span>` });
        client.__ctx.lastChatDay = msgYmd;
      }
    }

    // Print the actual line once
    ops.push({ op:'printHTML', html: htmlLine, cls: isMine ? 'me' : undefined });

    sendOps(client, ops);
  });
}


/* ======================= DIS Markdown Helpers ======================= */
const ALLOWED_COLORS = ['red','green','yellow','blue','magenta','cyan','white'];
const COLOR_TAGS = ['dim', ...ALLOWED_COLORS];

function escapeHTML(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function disUnderline(s){ return s.replace(/__([^_]+)__/g,'<span class="u">$1</span>'); }
function disBold(s){ return s.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>'); }
function disItalics(s){ return s.replace(/(^|[^_])_([^_\n][^_]*?)_(?!_)/g,'$1<em>$2</em>'); }
function disDim(s){ return s.replace(/\[dim\]([\s\S]*?)\[\/dim\]/gi,'<span class="dim">$1</span>'); }
function disColors(s){
  return ALLOWED_COLORS.reduce((acc, c) => {
    const re = new RegExp(`\\[${c}\\]([\\s\\S]*?)\\[\\/${c}\\]`, 'gi');
    return acc.replace(re, `<span class="${c}">$1</span>`);
  }, s);
}
function sanitizeAndFormatDIS(text){
  let out = escapeHTML(text);
  out = disUnderline(out);
  out = disBold(out);
  out = disItalics(out);
  out = disDim(out);
  out = disColors(out);
  return out;
}
function stripDISFormatting(s){
  if (!s) return '';
  COLOR_TAGS.forEach(tag => {
    const open  = new RegExp(`\\[${tag}\\]`, 'gi');
    const close = new RegExp(`\\[\\/${tag}\\]`, 'gi');
    s = s.replace(open, '').replace(close, '');
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  s = s.replace(/(^|[^_])_([^_\n][^_]*?)_(?!_)/g, '$1$2');
  s = s.replace(/\[(?:\/)?[a-z]+\]/gi, '');
  return s;
}
function visibleLengthDIS(s){ return stripDISFormatting(String(s)).length; }

/* ======================= SVG Splash ======================= */
function splashSVG(){
  return [
    '<div class="svg-splash-wrap">',
    '<svg class="svg-splash" viewBox="0 0 1200 600" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Dead Internet Society">',
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
    '<text x="600" y="510" font-size="13" fill="#E6E6E6">You are loved.  You are welcome</text>',
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
function makeInitialState(){
  return {
    authenticated:false,
    username:null,
    currentScreen:'splash',
    login:{ step:'username', tempUser:'' },
    userId:null,
    isAdmin:false,
    userColor:null,
    displayName:null,
    currentTopicId:null,
    currentNewsId:null
  };
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
    b.print('or type /register <user> <pass> <invite> to create a new account.', 'dim');
    b.setInputType('text', 'Username or /register');
  });
  state.login.step='username'; state.login.tempUser='';
}
function splashHandleCommand(cmd, api){
  if (cmd==='help'){ api.hr(); api.print('Splash commands:', 'yellow'); api.print('  /help','cyan'); api.print('  /clear','cyan'); api.print('  /register <user> <pass> <invite>','cyan'); return true; }
  if (cmd==='clear'){ api.clear(); return true; }
  return false;
}
function splashHandleRaw(text, api, state){
  if (state.login.step==='username'){
    if (!text){ api.print('Please enter a username.', 'dim'); return true; }
    state.login.tempUser = text;
    api.print('Enter password:', 'cyan'); api.setInputType('password', 'Password'); state.login.step='password'; return true;
  }
  if (state.login.step==='password'){
    const user = verifyLogin(state.login.tempUser, text);
    if (user) {
      state.authenticated = true;
      state.userId   = user.id;
      state.username = user.username; // canonical case
      state.isAdmin  = !!user.is_admin;

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
      api.print('Login successful.', 'green');

    

      routeGo(api, state, 'menu');
    } else {
      api.print('Invalid credentials. Try again.', 'red');
      state.login.step='username'; state.login.tempUser='';
      api.print('Enter username:', 'cyan'); api.setInputType('text','Username');
    }
    return true;
  }
  return true;
}

/* ======================= Help ======================= */
function cmdHelp(api, state){
  api.hr();
  api.print('Global slash commands:', 'yellow');
  api.print('  /register  Create an account: /register <user> <pass> <invite>', 'cyan');
  api.print('  /chat      Enter the Commons Chat', 'cyan');
  api.print('  /here      Show who is currently in the chat', 'cyan');
  api.print('  /games     List available games', 'cyan');
  api.print('  /dm        Send a direct message: /dm <user> <message>', 'cyan');
  api.print('  /messages  Show your recent direct messages', 'cyan');
  api.print('  /leave     Leave the current game', 'cyan');
  api.print('  /about     About Dead Internet Society', 'cyan');
  api.print('  /rules     Community rules', 'cyan');
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
  api.print('  /main      Return to Command Hub', 'cyan');
  api.print('  /logout    Sign out', 'cyan');

  if (state && state.isAdmin){
    api.hr(); api.print('Admin:', 'yellow');
    api.print('  /makeinvite [days] [note]   Create a single-use invite', 'cyan');
    api.print('  /listinvites [unused|used|all]  Show recent invites', 'cyan');
    api.print('  /revokeinvite <code>        Expire an unused invite', 'cyan');
    api.print('  /removesuggestion <#>  Remove a suggestion (from the current list)', 'cyan');
    api.print('  /adminchat   Admin live room (private)', 'cyan');

  }
  api.hr();
  api.print('DIS-Markdown: **bold**, _italics_, __underline__, [dim]…[/dim], and color tags like [cyan]…[/cyan].', 'dim');
}

/* ======================= Menu ======================= */
function renderMenu(api, state){
  if (!requireAuth(api, state)) return;
  api.batch(b=>{
    b.clear();
    b.printHTML('<div class="banner"><div class="line"><span class="cyan">▄▄▄</span><span class="magenta"> Dead Internet Society </span><span class="cyan">▄▄▄</span></div><div class="line dim">Command Hub — use slash commands to navigate.</div></div>');
    b.print('Main Menu:', 'yellow');
    b.print('  /chat            Enter the Commons Chat', 'cyan');
    b.print('  /board           Bulletin board', 'cyan');
    b.print('  /news            Fark-like news links', 'cyan');
    b.print('  /games           List door games', 'cyan');
    b.print('  /messages        View your direct messages', 'cyan');
    b.print('  /about           About DIS', 'cyan');
    b.print('  /rules           Community rules', 'cyan');
    b.print('  /profile         View your profile (or /profile <user>)', 'cyan');
    b.print('  /logout          Sign out', 'cyan');
    b.hr();
    b.print('Tip: You can type these anywhere. /main returns here.', 'dim');
    b.print('For a full list of commands use /help command.', 'dim');
  });
}
function menuHandleRaw(text, api){ api.print('Use slash commands here. Try /chat, /board, /news or /help.', 'dim'); return true; }

/* ======================= Chat ======================= */
function renderChat(api, state){
  if (!requireAuth(api, state)) return;
  api.batch(b=>{
    b.clear();
    b.print('== The Commons Chat ==', 'magenta');
    b.print('Topic: One big room to hang out — be kind, be weird.', 'dim'); b.hr();

    const here = usersCurrentlyInChat();
    b.print(here.length ? `Here now (${here.length}): ${here.join(', ')}` : 'Nobody is here yet — say hi!', 'cyan');
    b.hr();

    const rows = recentMessages.all().reverse();
    if (rows.length === 0) {
      b.print('No messages yet. Type to chat. /leave to return.', 'dim');
    } else {
        let lastYmd = null;
      rows.forEach(r => {
        const thisYmd = ymdFromEpoch(r.created_at);
        if (thisYmd !== lastYmd) {
          printDayDivider(b, r.created_at);
          lastYmd = thisYmd;
        }
        const ts = new Date(r.created_at*1000).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
        const disp = r.display_name || r.username || 'anon';
        const safeBody = sanitizeAndFormatDIS(r.body);
        const bodyWithColor = r.color ? `<span style="color:${r.color}">${safeBody}</span>` : safeBody;
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

  const ts = new Date(created*1000).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
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
    b.print('== About Dead Internet Society ==', 'magenta'); b.hr();
    b.print('Punk-style middle finger to the modern feed.', 'white');
    b.print('No engagement farming. No surveillance. No dopamine casinos.', 'white');
    b.print('Small, hand-rolled, human-scale. ANSI glow, door games, weird rooms.', 'white'); b.hr();
    b.print('Design principles:', 'yellow');
    b.print('• Human first: rooms over feeds, presence over metrics.', 'cyan');
    b.print('• Anti-algorithm: no ranking engine shaping your mind.', 'cyan');
    b.print('• Data minimalism: collect the least, store the least.', 'cyan');
    b.print('• Minimal Use: no infinite scroll; we refuse to imprison attention.', 'cyan');
    b.hr(); b.print('Navigation: /main', 'dim');
  });
}
function renderRules(api, state){
  if (!requireAuth(api, state)) return;
  api.batch(b=>{
    b.clear();
    b.print('== Rules ==', 'magenta'); b.hr();
    b.print('Be kind. No bigotry. No harassment. No brigading.', 'white');
    b.print('We moderate for safety, not for virality.', 'white');
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
  api.print('█ RED','red'); api.print('█ GREEN','green'); api.print('█ YELLOW','yellow');
  api.print('█ BLUE','blue'); api.print('█ MAGENTA','magenta'); api.print('█ CYAN','cyan'); api.print('█ WHITE','white');
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
    b.print('== Message Board ==', 'magenta'); b.hr();
    if (rows.length === 0){
      b.print('No topics yet. Start one with /newtopic <title>.', 'dim');
    } else {
      b.print('Topics (most recently active first):', 'yellow');
      rows.forEach(r=>{
        const when = new Date(r.last_commented_at*1000).toLocaleString();
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
        const ts = new Date(c.created_at*1000).toLocaleString();
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
  const days = +(getSetting.get('board_inactive_days')?.value || 30);
  updateTopicBump.run(ts, ts + days*86400, topicId);

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
  const days = +(getSetting.get('board_inactive_days')?.value || 30);
  updateTopicBump.run(ts, ts + days*86400, state.currentTopicId);
  openTopic(api, state, state.currentTopicId);
}
function cmdNewTopic(api, state, args){
  if (!requireAuth(api, state)) return;
  const raw = (args||[]).join(' ').trim();
  if (!raw){ api.print('Usage: /newtopic <title>', 'yellow'); return; }
  const maxLen = +(getSetting.get('board_title_max_len')?.value || 120);
  if (visibleLengthDIS(raw) > maxLen){ api.print(`Title too long (max ${maxLen} visible chars).`, 'red'); return; }
  const ts = nowEpoch();
  const days = +(getSetting.get('board_inactive_days')?.value || 30);
  insertTopic.run(raw, state.userId || null, ts, ts, ts + days*86400);
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

/* ======================= News (List + Item) ======================= */
const NEWS_TAGS = [
  'Florida','Not News','Hero','Facepalm','Breaking','Obvious','Science!',
  'Oops','Money','Fail','Tech','Politics','World','Crime','Sports'
];
function isAllowedNewsTag(tag){ return NEWS_TAGS.includes(tag); }
function normalizeURL(u){
  try { const url = new URL(u.includes('://') ? u : 'https://' + u); return url.toString(); }
  catch { return null; }
}
function truncateUrl(u, max){ if (!u) return ''; return u.length<=max ? u : (u.slice(0, max-1)+'…'); }

function renderNewsList(api, state){
  if (!requireAuth(api, state)) return;
  const limit = +(getSetting.get('news_list_limit')?.value || 150);
  const rows = selectNewsList.all(limit);
  api.batch(b=>{
    b.clear();
    b.print('== DIS News ==', 'magenta'); b.hr();
    if (!rows.length){
      b.print('No news yet. Add one with /addnews <headline> <url> <tag>.', 'dim');
    } else {
      b.print('Recent links (most recently active first):', 'yellow');
      rows.forEach(r=>{
        const posterRaw = (r.display_name && r.display_name.trim()) ? r.display_name : (r.username || 'anon');
        const poster = sanitizeAndFormatDIS(posterRaw);
        const safeTitle = sanitizeAndFormatDIS(r.title);
        const urlShown = truncateUrl(r.url, 80);
        b.printHTML(`${r.id}. ${safeTitle}`);
        b.printHTML(`   <span class="dim">${escapeHTML(urlShown)}</span>  <span class="cyan">[${escapeHTML(r.tag)}]</span>  by &lt;${poster}&gt;  <span class="dim">(${r.comments} comments)</span>`);
      });
    }
    b.hr();
    b.print('Open: /news <id>    Add: /addnews <headline> <url> <tag>    Remove (admin): /removenews <id>', 'cyan');
    b.print('Tags: ' + NEWS_TAGS.join(', '), 'dim');
    b.setInputType('text', 'Use /news <id> or /addnews <headline> <url> <tag>');
  });
  state.currentScreen = 'news:list';
  state.currentNewsId = null;
}
function openNewsItem(api, state, id){
  const p = selectNewsPost.get(id);
  if (!p){ api.print('No such news item (maybe expired).', 'red'); return; }
  state.currentScreen = 'news:item';
  state.currentNewsId = id;

  const comments = selectNewsComments.all(id);
  const posterRaw = (p.display_name && p.display_name.trim()) ? p.display_name : (p.username || 'anon');
  const poster = sanitizeAndFormatDIS(posterRaw);

  api.batch(b=>{
    b.clear();
    b.printHTML(`== [${escapeHTML(p.tag)}] ${sanitizeAndFormatDIS(p.title)} ==`, 'magenta');
    b.printHTML(`<span class="dim">${escapeHTML(p.url)}</span>  by &lt;${poster}&gt;`);
    b.hr();
    if (!comments.length){
      b.print('No comments yet. Type to comment.', 'dim');
    } else {
      comments.forEach(c=>{
        const ts = new Date(c.created_at*1000).toLocaleString();
        const authorRaw = (c.display_name && c.display_name.trim()) ? c.display_name : (c.username || 'anon');
        const author = sanitizeAndFormatDIS(authorRaw);
        const body = sanitizeAndFormatDIS(c.body);
        const colored = c.preferred_color ? `<span style="color:${c.preferred_color}">${body}</span>` : body;
        b.printHTML(`[${escapeHTML(ts)}] &lt;${author}&gt; ${colored}`);
      });
    }
    b.hr();
    b.print('Type to comment. Commands: /news (back), /main', 'dim');
    b.setInputType('text', 'Type to comment… /news to go back');
  });
}
function newsListHandleCommand(cmd, api, state, args){
  if (!requireAuth(api, state)) return true;
  if (cmd === 'news' && args.length){
    const id = parseInt(args[0], 10);
    if (!id){ api.print('Usage: /news <id>', 'yellow'); return true; }
    openNewsItem(api, state, id); return true;
  }
  if (cmd === 'main' || cmd === 'menu'){ routeGo(api, state, 'menu'); return true; }
  return false;
}
function newsItemHandleRaw(text, api, state){
  if (!requireAuth(api, state)) return true;
  const body = (text||'').trim(); if (!body) return true;
  const newsId = state.currentNewsId;
  if (!newsId){ api.print('No news item open.', 'red'); return true; }

  const max = +(getSetting.get('news_comment_max_len')?.value || 600);
  if (visibleLengthDIS(body) > max){ api.print(`Too long (max ${max} visible chars).`, 'red'); return true; }

  const ts = nowEpoch();
  insertNewsComment.run(newsId, state.userId || null, body, ts);

  // FIX: pass 3 args to bumpNewsPost (last_commented_at, expires_at, id)
  const days = +(getSetting.get('news_inactive_days')?.value || 30);
  bumpNewsPost.run(ts, ts + days*86400, newsId);

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
  if (!raw){ api.print('Usage: /addnews <headline> <url> <tag>', 'yellow'); return; }
  const parts = raw.split(/\s+/);
  if (parts.length < 3){ api.print('Usage: /addnews <headline> <url> <tag>', 'yellow'); return; }
  const tag = parts.pop();
  const urlIn = parts.pop();
  const headline = parts.join(' ').trim();

  const maxLen = +(getSetting.get('news_title_max_len')?.value || 120);
  if (visibleLengthDIS(headline) > maxLen){ api.print(`Headline too long (max ${maxLen} visible chars).`, 'red'); return; }
  if (!isAllowedNewsTag(tag)){ api.print(`Unknown tag "${tag}". Allowed: ${NEWS_TAGS.join(', ')}`, 'red'); return; }
  const url = normalizeURL(urlIn);
  if (!url){ api.print('Invalid URL. Example: example.com or https://example.com/article', 'red'); return; }

  const ts = nowEpoch();
  const days = +(getSetting.get('news_inactive_days')?.value || 30);
  insertNewsPost.run(headline, url, tag, state.userId || null, ts, ts, ts + days*86400);
  api.print('News link added.', 'green');
  renderNewsList(api, state);
}
function cmdRemoveNews(api, state, args){
  if (!requireAuth(api, state)) return;
  if (!state.isAdmin){ api.print('Admin only.', 'red'); return; }
  const id = parseInt(args[0], 10);
  if (!id){ api.print('Usage: /removenews <id>', 'yellow'); return; }
  deleteNewsById.run(id);
  api.print(`Removed news #${id}.`, 'green');
  if (state.currentScreen && state.currentScreen.startsWith('news') && state.currentNewsId === id){
    renderNewsList(api, state);
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
  const created = row.created_at ? new Date(row.created_at*1000).toLocaleString() : '—';
  const last    = row.last_login_at ? new Date(row.last_login_at*1000).toLocaleString() : '—';

  api.hr();
  api.printHTML(`== Profile: &lt;${sanitizeAndFormatDIS(row.username)}&gt; ==`, 'magenta');
  api.printHTML(`Display: ${sanitizeAndFormatDIS(display)}`);
  api.printHTML(`Joined: <span class="dim">${escapeHTML(created)}</span>`);
  api.printHTML(`Last seen: <span class="dim">${escapeHTML(last)}</span>`);
  if (color) api.printHTML(`Chat color: <span style="color:${color}">${escapeHTML(color)}</span>`);
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


function cmdMakeInvite(api, state, args){
  if (!requireAuth(api, state)) return;
  if (!state.isAdmin) { api.print('Unknown command.', 'red'); return; }
  let days = 7, note = '';
  if (args && args.length) {
    const maybe = parseInt(args[0], 10);
    if (!Number.isNaN(maybe) && maybe >= 0) { days = maybe; note = args.slice(1).join(' ').trim(); }
    else { note = args.join(' ').trim(); }
  }
  const out = createInvite({ creatorId: state.userId, days, note });
  if (!out.ok) { api.print('Failed to create invite.', 'red'); return; }
  const expiresLine = out.expires_at ? new Date(out.expires_at*1000).toLocaleString() : 'never';
  api.print('Invite created:', 'green');
  api.print(`  Code: ${out.code}`, 'cyan');
  api.print(`  Expires: ${expiresLine}`, 'cyan');
  if (note) api.print(`  Note: ${note}`, 'cyan');
  api.print('Share this code privately. It can be used only once.', 'dim');
}
function cmdWho(api){
  const list = Array.from(HUB.online);
  api.print(list.length ? `Online: ${list.join(', ')}` : 'Nobody online', 'cyan');
}

function cmdListInvites(api, state, args){
  if (!requireAuth(api, state)) return;
  if (!state.isAdmin){ api.print('Unknown command.', 'red'); return; } // hidden to non-admins
  const mode = (args[0]||'unused').toLowerCase(); // unused|used|all
  let where = 'used_at IS NULL'; if (mode==='used') where='used_at IS NOT NULL'; else if (mode==='all') where='1=1';
  const rows = db.prepare(`SELECT code, created_at, expires_at, used_at, note FROM invites WHERE ${where} ORDER BY created_at DESC LIMIT 50`).all();
  if (!rows.length){ api.print('No invites found.', 'dim'); return; }
  api.hr(); api.print(`Invites (${mode}):`, 'yellow');
  rows.forEach(r=>{
    const exp = r.expires_at ? new Date(r.expires_at*1000).toLocaleString() : 'never';
    const used = r.used_at ? new Date(r.used_at*1000).toLocaleString() : '—';
    api.print(`• ${r.code}  exp:${exp}  used:${used}  ${r.note?'- '+r.note:''}`, r.used_at?'dim':'cyan');
  });
}

function cmdRevokeInvite(api, state, args){
  if (!requireAuth(api, state)) return;
  if (!state.isAdmin){ api.print('Unknown command.', 'red'); return; }
  const code = (args[0]||'').trim(); if (!code){ api.print('Usage: /revokeinvite <code>', 'yellow'); return; }
  const row = getInvite.get(code);
  if (!row){ api.print('No such invite.', 'red'); return; }
  if (row.used_at){ api.print('Invite already used; cannot revoke.', 'yellow'); return; }
  db.prepare(`UPDATE invites SET expires_at = strftime('%s','now') WHERE code = ? AND used_at IS NULL`).run(code);
  api.print('Invite revoked.', 'green');
}

/* ======================= DMs, Suggestions, Invites (brevity) ======================= */
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
  const place = humanizeContext(context);
  const notice = `@mention from ${fromName} in ${place}.`;

  sockets.forEach(ws=>{
    // optional: simple throttle so we don’t spam sounds if many mentions arrive at once
    const now = Date.now();
    if (!ws.__ctx) ws.__ctx = {};
    if (!ws.__ctx._lastMentionSound || now - ws.__ctx._lastMentionSound > 400) {
      ws.__ctx._lastMentionSound = now;
      sendOps(ws, [
        { op: 'audio', src: '/static/sounds/mention.wav', volume: 0.8 },
        { op: 'print', text: notice, cls: 'cyan' }
      ]);
    } else {
      // still show the text if throttled
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
    b.clear(); b.print('== Direct Messages ==','magenta'); b.hr();
    if (!rows.length){ b.print('No messages.', 'dim'); }
    else rows.forEach(r=>{
      const ts = new Date(r.created_at*1000).toLocaleString();
      const disp = (r.display_name && r.display_name.trim()) ? r.display_name : (r.sender || 'anon');
      const body = sanitizeAndFormatDIS(r.body);
      const colored = r.preferred_color ? `<span style="color:${r.preferred_color}">${body}</span>` : body;
      b.printHTML(`[${escapeHTML(ts)}] &lt;${sanitizeAndFormatDIS(disp)}&gt; ${colored}`);
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
  const ts = nowEpoch(); const days = +(getSetting.get('suggestion_retention_days')?.value || 60);
  insertSuggestion.run(state.userId || null, body, ts, ts + days*86400);
  api.print('Thanks for the suggestion.', 'green');
}
function cmdSuggestions(api, state){
  if (!requireAuth(api, state)) return;
  const rows = listSuggestions.all();
  api.batch(b=>{
    b.clear(); b.print('== Suggestions ==','magenta'); b.hr();
    if (!rows.length){ b.print('No suggestions yet.', 'dim'); }
    else rows.forEach(r=>{
      const ts = new Date(r.created_at*1000).toLocaleString();
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
    const last = r.last_login_at ? new Date(r.last_login_at*1000).toLocaleString() : '—';
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
  const rows = listNotificationsForUser.all(state.userId, limit);

  api.batch(b=>{
    b.clear();
    b.print('== Notifications ==','magenta'); b.hr();

    if (!rows.length){
      b.print('No notifications yet. Mention someone with @username in Chat/Boards/News.', 'dim');
    } else {
      rows.forEach(n=>{
        const when = new Date(n.created_at*1000).toLocaleString();
        const whoRaw = (n.from_display && n.from_display.trim()) ? n.from_display : (n.from_username || 'system');
        const ctx = n.context || 'somewhere';
        const body = sanitizeAndFormatDIS(n.body);
        const seen = n.seen_at ? '<span class="dim">seen</span>' : '<span class="yellow">NEW</span>';
        b.printHTML(`[${escapeHTML(when)}] ${seen} <span class="dim">(${escapeHTML(ctx)})</span> &lt;${sanitizeAndFormatDIS(whoRaw)}&gt; ${body}`);
      });
    }
    b.hr(); b.print('Tip: /notifications 200 for more.', 'dim');
  });

  // mark yours as read after viewing
  markAllNotificationsSeen.run(state.userId);
}




/* ======================= Doors (Games) ======================= */
function listDoors(){ return DoorManager?.list?.() || []; }

function cmdGames(api, state){
  if (!requireAuth(api, state)) return;
  const doors = listDoors();
  api.batch(b=>{
    b.clear(); b.print('== Door Games ==','magenta'); b.hr();
    if (!doors.length){ b.print('No doors installed.', 'dim'); }
    else doors.forEach(m => b.print(`${m.id} — ${m.name || m.id}`));
    b.hr(); b.print('Play with /play <door>', 'cyan');
  });
}

function cmdPlay(api, state, args){
  if (!requireAuth(api, state)) return;
  const want = String((args[0]||'').trim().toLowerCase());
  if (!want){ api.print('Usage: /play <door>', 'yellow'); return; }

  const doors = listDoors();
  const match = doors.find(d => String(d.id).toLowerCase() === want);
  if (!match){
    api.print('No such door.', 'red');
    if (doors.length) api.print(`Available: ${doors.map(d=>d.id).join(', ')}`, 'dim');
    return;
  }

  state.currentScreen = `door:${match.id}`;
  try {
    DoorManager.enter(match.id, api, state, []);
  } catch (e) {
    api.print(`Failed to enter door: ${e && e.message ? e.message : String(e)}`, 'red');
  }
}


/* ======================= Splash: Register & Invites ======================= */
function cmdRegister(api, state, args){
  const [username, password, inviteCode] = args || [];

  if (!username || !password || !inviteCode) {
    api.print('Usage: /register <username> <password> <invite>', 'yellow');
    return;
  }
  if (password.length < 6) {
    api.print('Password must be at least 6 characters.', 'yellow');
    return;
  }

  // 1) validate invite
  const vi = validateInvite(inviteCode);
  if (!vi.ok) {
    const why = vi.reason === 'no_such' ? 'Invite not found.'
              : vi.reason === 'used'    ? 'Invite already used.'
              : vi.reason === 'expired' ? 'Invite expired.'
              : 'Invalid invite.';
    api.print(why, 'red');
    return;
  }

  // 2) create the account (re-use your existing createUser)
  const res = createUser(username, password);
  if (!res.ok) {
    api.print('That username is taken.', 'red');
    return;
  }

  // 3) redeem invite (single-use)
  try {
    const newUser = findUserByName.get(username);
    const changed = redeemInvite.run(newUser.id, inviteCode).changes;
    if (!changed) {
      api.print('Invite could not be redeemed (race condition). Try another.', 'red');
      // Rollback user creation here only if you want strict semantics.
      return;
    }
  } catch(e) {
    api.print('Invite redemption failed. Try another code.', 'red');
    return;
  }

  // 4) success messages differ based on session state
  if (state && state.authenticated) {
    api.print(`Account created: ${username}. You remain logged in as ${state.username}.`, 'green');
  } else {
    api.print('Account created. Please log in with your new credentials.', 'green');
  }
}

function cmdPasswd(api, state, args){
  if (!requireAuth(api, state)) return;
  const [oldp, newp] = args || [];
  if (!oldp || !newp){ api.print('Usage: /passwd <old> <new>', 'yellow'); return; }
  if (newp.length < 6){ api.print('New password must be at least 6 characters.', 'yellow'); return; }
  const u = findUserByName.get(state.username);
  if (!u || !bcrypt.compareSync(oldp, u.password_hash)){ api.print('Old password incorrect.', 'red'); return; }
  const hash = bcrypt.hashSync(newp, 10);
  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hash, u.id);
  api.print('Password updated.', 'green');
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
    case 'topic':        if (args.length) openTopic(api, state, parseInt(args[0],10)||0); else api.print('Usage: /topic <id>', 'yellow'); return true;
    case 'newtopic':     return (cmdNewTopic(api, state, args), true);
    // Admin-only removal by list index or id (cmdRemoveTopic should enforce admin)
    case 'removetopic':  return (cmdRemoveTopic(api, state, args), true);

    /* News */
    case 'news':         if (args.length) openNewsItem(api, state, parseInt(args[0],10)||0); else renderNewsList(api, state); return true;
    case 'addnews':      cmdAddNews(api, state, args); return true;
    case 'removenews':   cmdRemoveNews(api, state, args); return true;

    /* Doors / Games */
    case 'games':        cmdGames(api, state); return true;
    case 'play':         cmdPlay(api, state, args); return true;

    /* DMs / Suggestions */
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

    /* Invites + Register */
    case 'makeinvite':   return (cmdMakeInvite(api, state, args), true);
    case 'listinvites':  return (cmdListInvites(api, state, args), true);
    case 'revokeinvite': return (cmdRevokeInvite(api, state, args), true);
    case 'register':     cmdRegister(api, state, args); return true;

    /* Notifications */
    case 'notifications': cmdNotifications(api, state, args); return true;

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

    default:
      return false;
  }
}


/* ======================= WS handling (containerized doors) ======================= */
wss.on('connection', (ws) => {
  HUB.clients.add(ws);
  const api = makeApi(ws);
  const state = makeInitialState();
  ws.__ctx = { state };

  // Defaults
  api.setPrompt && api.setPrompt('DIS>');
  api.setInputType && api.setInputType('text', 'type /help for commands');

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;

    // Parse once
    let msg; try { msg = JSON.parse(String(data)); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    // Handshake
    if (msg.type === 'init') { routeGo(api, state, 'splash'); return; }
    if (msg.type !== 'input') return;

    const raw = String(msg.raw || '').trim();
    if (!raw) return;

    const inDoor = !!(state.currentScreen && state.currentScreen.startsWith('door:'));
    const doorId = inDoor ? state.currentScreen.slice(5) : null;

    // Slash commands
    if (raw.startsWith('/')) {
      const [head, ...rest] = raw.slice(1).split(/\s+/);
      const cmd  = head.toLowerCase();
      const args = rest;

      if (inDoor) {
        // Only /leave escapes; everything else is door-local
        const handled = DoorManager?.dispatch?.(doorId, 'command', cmd, api, state, args);
        if (handled === 'leave') {
          try { DoorManager?.leave?.(api, state); } catch {}
          api.setPrompt && api.setPrompt('DIS>');
          api.setInputType && api.setInputType('text', 'type /help for commands'); // reset hint
          routeGo(api, state, 'menu');
          return;
        }
        if (handled) return;
        api.print('You are inside a game. Use /leave to return to the BBS.', 'yellow');
        return;
      }

      // Global commands outside doors first (e.g., /chat, /news, /board, etc.)
      if (handleGlobalCommand && handleGlobalCommand(cmd, api, state, args)) return;

      // Optional screen-local commands
      const localHandled =
           (state.currentScreen === 'splash'     && splashHandleCommand && splashHandleCommand(cmd, api, state, args))
        || (state.currentScreen === 'chat'       && chatHandleCommand && chatHandleCommand(cmd, api, state, args))
        || (state.currentScreen === 'adminchat'  && adminChatHandleCommand && adminChatHandleCommand(cmd, api, state, args))
        || (state.currentScreen === 'topic'      && topicHandleCommand && topicHandleCommand(cmd, api, state, args))
        || (state.currentScreen === 'news:list'  && newsListHandleCommand && newsListHandleCommand(cmd, api, state, args))
        || (state.currentScreen === 'news:item'  && newsItemHandleCommand && newsItemHandleCommand(cmd, api, state, args))
        || false;

      if (localHandled) return;
      api.print(`Unknown command: /${cmd}`, 'red');
      return;
    }

    // Raw input
    if (inDoor) {
      const consumed = DoorManager?.dispatch?.(doorId, 'raw', raw, api, state);
      if (consumed) return;
      api.print('Game did not accept input. Use /leave to exit.', 'yellow');
      return;
    }

    // === Raw input outside a door → route by current screen ===
    if (state.currentScreen === 'splash')     { splashHandleRaw && splashHandleRaw(raw, api, state); return; }
    if (state.currentScreen === 'chat')       { chatHandleRaw && chatHandleRaw(raw, api, state);     return; }
    if (state.currentScreen === 'adminchat')  { adminChatHandleRaw && adminChatHandleRaw(raw, api, state); return; }
    if (state.currentScreen === 'topic')      { topicHandleRaw && topicHandleRaw(raw, api, state);   return; }
    if (state.currentScreen === 'news:item')  { newsItemHandleRaw && newsItemHandleRaw(raw, api, state); return; }
    if (state.currentScreen === 'board')      { api.print('Use /topic <id> or /newtopic <title>.', 'dim'); return; }

    // Fallback
    api.print('Use /help for commands.', 'dim');
  });

  ws.on('close', () => {
    HUB.clients.delete(ws);
    try { DoorManager?.leave?.(api, state); } catch {}
    // your existing close cleanup can remain here
  });

  ws.on('error', (err) => console.error('WS error:', err));
});



/* ======================= Sweepers ======================= */
function runBoardSweep(){ try { sweepExpiredTopics.run(); } catch {} }
function runNewsSweep(){ try { sweepExpiredNews.run(); } catch {} }
function runChatSweep(){ try { sweepExpiredMessages.run(); } catch {} }
function runDMSweep(){ try { sweepExpiredDMs.run(); } catch {} }
function runInviteSweep(){ try { sweepExpiredInvites.run(); } catch {} }
function runSuggestionSweep(){ try { sweepExpiredSuggestions.run(); } catch {} }
function runAdminChatSweep(){ try { sweepExpiredAdminMessages.run(); } catch {} }


setInterval(()=>{
  runChatSweep(); runDMSweep(); runInviteSweep(); runSuggestionSweep(); runBoardSweep(); runNewsSweep(); runAdminChatSweep();
}, 10 * 60 * 1000);

/* ======================= Doors boot (optional) ======================= */
if (DoorManager && typeof DoorManager.register === 'function') {
  try {
    if (tinyquestDoor) {
      if (typeof tinyquestDoor === 'function') {
        DoorManager.register('tinyquest', tinyquestDoor, { name: 'TinyQuest' });
      } else {
        DoorManager.register(tinyquestDoor); // expects { id:'tinyquest', name:'TinyQuest', create(...) }
      }
    }
    const listed = DoorManager.list ? DoorManager.list() : [];
    console.log('[doors] registered:', listed.map(d => d.id).join(', ') || '(none)');
  } catch (e) {
    console.error('TinyQuest register failed:', e && e.message ? e.message : e);
  }
  try {
    if (lordDoor) {
      if (typeof lordDoor === 'function') {
        DoorManager.register('LORD', lordDoor, { name: 'Legend of the Redux Dragon' });
      } else {
        DoorManager.register(lordDoor); // expects { id:'tinyquest', name:'TinyQuest', create(...) }
      }
    }
    const listed = DoorManager.list ? DoorManager.list() : [];
    console.log('[doors] registered:', listed.map(d => d.id).join(', ') || '(none)');
  } catch (e) {
    console.error('Legend of the Redux Dragon register failed:', e && e.message ? e.message : e);
  }
  try {
    if (casinoDoor) {
      if (typeof casinoDoor === 'function') {
        DoorManager.register('LORD', casinoDoor, { name: 'Casino' });
      } else {
        DoorManager.register(casinoDoor); // expects { id:'tinyquest', name:'TinyQuest', create(...) }
      }
    }
    const listed = DoorManager.list ? DoorManager.list() : [];
    console.log('[doors] registered:', listed.map(d => d.id).join(', ') || '(none)');
  } catch (e) {
    console.error('Casino register failed:', e && e.message ? e.message : e);
  }
}




/* ======================= Helpers ======================= */
function resetBBSUI(api, state, placeholder){
  if (api.setPrompt) api.setPrompt('DIS>');
  if (api.setInputType) api.setInputType('text', placeholder || 'type /help for commands');
}


function nowEpoch(){ return Math.floor(Date.now()/1000); }
function retentionSeconds(){
  const days = +(getSetting.get('chat_retention_days')?.value || 7);
  return days > 0 ? days*86400 : 0; // 0 means never expire
}
function usersCurrentlyInChat(){
  const arr = [];
  HUB.clients.forEach(ws=>{
    const st = ws.__ctx?.state;
    if (st && st.currentScreen === 'chat' && st.username) arr.push(st.username);
  });
  return arr.sort((a,b)=>a.localeCompare(b));
}
function verifyLogin(usernameInput, passwordInput){
  const name = String(usernameInput||'').trim();
  const pass = String(passwordInput||'');
  if (!name || !pass) return null;
  const user = getUserByName.get(name);
  if (!user) return null;
  if (!bcrypt.compareSync(pass, user.password_hash)) return null;
  setLastLogin.run(nowEpoch(), user.id);
  return user;
}
function doLogout(api, state){
  const u = state.username;
  if (u){
    const set = HUB.socketsByUser.get(u);
    if (set){ set.delete(api.ws); if (set.size===0){ HUB.socketsByUser.delete(u); HUB.online.delete(u); } }
    broadcastSystem(`${u} left`);
  }
  Object.assign(state, makeInitialState());
  routeGo(api, state, 'splash');
}
function defSetting(key, val){
  if (!getSetting.get(key)) setSetting.run(key, String(val));
}
function generateInviteCode(){
  return crypto.randomBytes(6).toString('base64url'); // ~8 chars URL-safe
}

function createInvite({ creatorId, days, note }) {
  const expires_at = (typeof days === 'number' && days > 0) ? (nowEpoch() + days*86400) : null;
  const code = makeInviteCode();
  try {
    insertInvite.run(code, creatorId || null, expires_at, note || null);
    return { ok:true, code, expires_at };
  } catch (e) {
    return { ok:false, err: e && e.message ? e.message : String(e) };
  }
}

function makeInviteCode() {
  // 20 bytes (160 bits) → 40 hex chars → group for readability
  const hex = crypto.randomBytes(20).toString('hex').toUpperCase(); // e.g. 'A1B2...'
  return hex.match(/.{1,4}/g).join('-'); // 'A1B2-...-...'
}

function validateInvite(code) {
  const row = getInvite.get(code);
  if (!row) return { ok:false, reason:'no_such' };
  if (row.used_at) return { ok:false, reason:'used' };
  if (row.expires_at && row.expires_at <= nowEpoch()) return { ok:false, reason:'expired' };
  return { ok:true, invite: row };
}

const findUserByName = db.prepare(`SELECT * FROM users WHERE username = ?`);
function verifyLogin(username, password) {
  const u = findUserByName.get(username);
  if (!u) return null;
  if (!bcrypt.compareSync(password, u.password_hash)) return null;
  db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).run(nowEpoch(), u.id);
  return u;
}
// Create a new user account (usernames are UNIQUE COLLATE NOCASE in schema)
// Returns { ok:true, id } on success; { ok:false, reason:'exists' } if taken.
function createUser(username, password, opts = {}) {
  const existing = findUserByName.get(username);
  if (existing) return { ok: false, reason: 'exists' };

  const isAdmin = opts.isAdmin ? 1 : 0; // default non-admin
  const hash = bcrypt.hashSync(password, 10);

  try {
    db.prepare(`
      INSERT INTO users (username, password_hash, is_admin, created_at)
      VALUES (?, ?, ?, strftime('%s','now'))
    `).run(username, hash, isAdmin);

    const row = db.prepare(`SELECT id FROM users WHERE username = ?`).get(username);
    return { ok: true, id: row.id };
  } catch (e) {
    // If some other constraint hits
    if ((e && e.message || '').toLowerCase().includes('unique')) {
      return { ok:false, reason:'exists' };
    }
    throw e;
  }
}

function normalizeHandle(s){
  if (!s) return '';
  const plain = stripDISFormatting(String(s));
  return plain.replace(/\s+/g, ' ').trim().toLowerCase();
}

/* Refresh normalization columns for a single user row */
function refreshUserNormsByRow(row){
  const u = row.username || '';
  const d = row.display_name || null;
  updateUserNorms.run(normalizeHandle(u), d ? normalizeHandle(d) : null, row.id);
}

/* One-time backfill of normalization columns on boot (idempotent) */
try {
  const rows = db.prepare(`SELECT id, username, display_name FROM users`).all();
  for (const r of rows) refreshUserNormsByRow(r);
} catch(e) {
  console.error('Norm backfill issue:', e && e.message ? e.message : e);
}

/**
 * Resolve any typed handle (username or display name, any case, DIS-markdown allowed)
 * Returns:
 *   { row }             — unique match
 *   { ambiguous:[…] }   — several candidates, provide usernames to disambiguate
 *   null                — not found / empty
 */
function resolveUserHandle(anyName){
  if (!anyName) return null;

  // Fast path: try exact username first (users.username is UNIQUE COLLATE NOCASE)
  const fast = getUserByName.get(String(anyName).trim());
  if (fast) return { row: fast };

  const needle = normalizeHandle(anyName);
  if (!needle) return null;

  const rows = getUsersByNorm.all(needle, needle);
  if (rows.length === 1) return { row: rows[0] };
  if (rows.length > 1)   return { ambiguous: rows.map(r => ({ id:r.id, username:r.username })) };
  return null;
}

// --- Day grouping helpers ---
function ymdFromEpoch(sec){
  const d = new Date(sec * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${dd}`;
}
function ymdToday(){ return ymdFromEpoch(nowEpoch()); }
function ymdYesterday(){ return ymdFromEpoch(nowEpoch() - 86400); }
function dayHeadingFromEpoch(sec){
  const ymd = ymdFromEpoch(sec);
  if (ymd === ymdToday()) return 'Today';
  if (ymd === ymdYesterday()) return 'Yesterday';
  // Fallback to locale date
  return new Date(sec*1000).toLocaleDateString();
}
function printDayDivider(batchApi, epochSec){
  const label = dayHeadingFromEpoch(epochSec);
  // A subtle divider with a label
  batchApi.printHTML(`<span class="dim">── ${escapeHTML(label)} ──</span>`);
}



function humanizeContext(ctx){
  if (!ctx) return 'somewhere';
  if (ctx === 'chat') return 'Chat';
  if (ctx === 'adminchat') return 'Admin Chat';
  const mTopic = /^topic:(\d+)$/.exec(ctx);
  if (mTopic) return `Topic #${mTopic[1]}`;
  const mNews = /^news:(\d+)$/.exec(ctx);
  if (mNews) return `News #${mNews[1]}`;
  return ctx;
}

function notifyMentions(rawText, fromUserRow, context){
  try {
    const handles = extractMentionsFromText(rawText);
    if (!handles.length) return;

    const created = nowEpoch();
    const fromId = fromUserRow ? fromUserRow.id : null;
    const fromName = fromUserRow ? (fromUserRow.username || 'someone') : 'someone';

    handles.forEach(h=>{
      const resolved = resolveUserHandle(h); // {row} | {ambiguous} | null
      if (!resolved || resolved.ambiguous) return;

      const target = resolved.row;
      if (!target || (fromId && target.id === fromId)) return; // don't notify self

      // 1) persist
      insertNotification.run(target.id, fromId, 'mention', context, rawText, created);

      // 2) live ping if online
      const sockets = HUB.socketsByUser.get(target.username); // keyed by canonical username【turn26file11†server.js†L70-L71】
      if (sockets && sockets.size){
        const place = humanizeContext(context);
        const notice = `🔔 ${fromName} mentioned you in ${place}.`;
        sockets.forEach(ws => {
          sendOps(ws, [{ op:'beep' }, { op:'print', text: notice, cls:'cyan' }]); // UI: add a 'beep' handler client-side
        });
      }
    });
  } catch(e){
    // swallow – notifications are best-effort
  }
}

// Return array of raw handles typed after '@', de-duped (case-insensitive)
function extractMentionsFromText(raw){
  if (!raw) return [];
  const found = new Set();
  const rx = /(^|[\s.,;:!?()[\]{}"'])@([A-Za-z0-9_\-./[\]]{2,32})/g; // tokeny usernames
  let m;
  while ((m = rx.exec(raw)) !== null) {
    const handle = m[2];
    if (handle) found.add(handle.toLowerCase());
  }
  return Array.from(found);
}





function todayYMD(){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${dd}`;
}
function nowEpoch(){ return Math.floor(Date.now()/1000); } // remove if already defined above


function retentionSecondsAdmin(){
  const days = +(getSetting.get('admin_chat_retention_days')?.value || 7);
  return days > 0 ? days*86400 : 0;
}

function usersCurrentlyInAdminChat(){
  const arr = [];
  HUB.clients.forEach(ws=>{
    const st = ws.__ctx?.state;
    if (st && st.currentScreen === 'adminchat' && st.username && st.isAdmin) arr.push(st.username);
  });
  return arr.sort((a,b)=>a.localeCompare(b));
}

function broadcastAdminChatFrom(htmlLine, fromUsername, createdAtSec){
  const from = (fromUsername || '').toLowerCase();
  HUB.clients.forEach((client) => {
    const st = client.__ctx?.state; if (!st) return;
    if (!st.isAdmin) return;
    if (st.currentScreen !== 'adminchat') return;

    const u = (st.username || '').toLowerCase();
    const isMine = from && u === from;

    const ops = [];

    // Optional: day divider for admin chat too
    if (createdAtSec && client.__ctx) {
      const msgYmd = ymdFromEpoch(createdAtSec);
      if (client.__ctx.lastAdminChatDay !== msgYmd) {
        const label = dayHeadingFromEpoch(createdAtSec);
        ops.push({ op:'printHTML', html:`<span class="dim">── ${escapeHTML(label)} ──</span>` });
        client.__ctx.lastAdminChatDay = msgYmd;
      }
    }

    ops.push({ op:'printHTML', html: htmlLine, cls: isMine ? 'me' : undefined });
    sendOps(client, ops);
  });
}



/* ======================= Admin Chat (admins only) ======================= */
function renderAdminChat(api, state){
  if (!requireAuth(api, state)) return;
  if (!state.isAdmin){ api.print('Unknown command.', 'red'); return; } // keep it discreet

  api.batch(b=>{
    b.clear();
    b.print('== Admin Ops Chat ==', 'magenta');
    b.print('Private room for sysops / moderators.', 'dim'); b.hr();

    const here = usersCurrentlyInAdminChat();
    b.print(here.length ? `Here now (${here.length}): ${here.join(', ')}` : 'No admins here yet — say hi!', 'cyan');
    b.hr();

    const rows = recentAdminMessages.all().reverse();
    if (!rows.length){
      b.print('No messages yet. Type to chat. /leave returns to menu.', 'dim');
    } else {
      let lastYmd = null;
      rows.forEach(r=>{
        const thisYmd = ymdFromEpoch(r.created_at);
        if (thisYmd !== lastYmd) {
          printDayDivider(b, r.created_at);
          lastYmd = thisYmd;
        }
        const ts = new Date(r.created_at*1000).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
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

  const ts = new Date(created*1000).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
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







/* ======================= Start ======================= */
server.listen(PORT, ()=> {
  console.log(`DIS BBS listening on http://localhost:${PORT}`);
});