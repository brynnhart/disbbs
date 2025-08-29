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
let DoorManager, guessDoor, lordDoor;
try {
  ({ DoorManager } = require('./doors/manager'));
  guessDoor = require('./doors/guess');
  lordDoor = require('./doors/lord');
} catch (_) {}

const DB_PATH = process.env.DB_PATH || './dis.sqlite3';
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

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

/* Invites (single-use) */
CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  used_at INTEGER,
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
`);

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

/* Invites */
const insertInvite = db.prepare(`
  INSERT INTO invites (code, created_by, created_at, expires_at, note)
  VALUES (?, ?, ?, ?, ?)
`);
const useInvite = db.prepare(`
  UPDATE invites SET used_by=?, used_at=? WHERE code=? AND used_at IS NULL
`);
const getInvite = db.prepare(`SELECT * FROM invites WHERE code = ?`);
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
    clear(){ _send([{op:'clear'}]); },
    print(t,cls){ _send([{op:'print', text:String(t||''), cls:cls||''}]); },
    printHTML(h,cls){
      const op = {op:'printHTML', html:String(h||'')};
      if (cls) op.cls = cls;
      _send([op]);
    },
    hr(){ _send([{op:'hr'}]); },
    setInputType(type, placeholder){ _send([{op:'setInput', inputType:type, placeholder}]); },
    batch(fn){
      const ops=[];
      const b={
        clear(){ ops.push({op:'clear'}); },
        print(t,cls){ ops.push({op:'print', text:String(t||''), cls:cls||''}); },
        printHTML(h,cls){ const op={op:'printHTML', html:String(h||'')}; if (cls) op.cls=cls; ops.push(op); },
        hr(){ ops.push({op:'hr'}); },
        setInputType(type, placeholder){ ops.push({op:'setInput', inputType:type, placeholder}); }
      };
      fn(b); _send(ops);
    }
  };
}
function broadcastSystem(line){
  HUB.clients.forEach(ws => sendOps(ws, [{op:'print', text:line, cls:'dim'}]));
}
function broadcastChatFrom(htmlLine, fromUsername){
  const from = (fromUsername || '').toLowerCase();
  HUB.clients.forEach((client) => {
    const st = client.__ctx?.state; if (!st) return;
    if (st.currentScreen !== 'chat') return;
    const u = (st.username || '').toLowerCase();
    const isMine = from && u === from;
    sendOps(client, [{ op:'printHTML', html: htmlLine, cls: isMine ? 'me' : undefined }]);
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

      // pull color + display name
      const rc = getUserColor.get(state.userId);
      state.userColor = rc ? rc.preferred_color : null;
      const dnRow = getUserDisplay.get(state.userId);
      state.displayName = dnRow && dnRow.display_name ? dnRow.display_name : state.username;

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
  api.print('  /suggest   Add a suggestion: /suggest <text>', 'cyan');
  api.print('  /suggestions  View all current suggestions', 'cyan');
  api.print('  /main      Return to Command Hub', 'cyan');
  api.print('  /logout    Sign out', 'cyan');

  if (state && state.isAdmin){
    api.hr(); api.print('Admin:', 'yellow');
    api.print('  /makeinvite [days] [note]   Create a single-use invite', 'cyan');
    api.print('  /listinvites [unused|used|all]  Show recent invites', 'cyan');
    api.print('  /revokeinvite <code>        Expire an unused invite', 'cyan');
    api.print('  /removesuggestion <#>  Remove a suggestion (from the current list)', 'cyan');
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
      rows.forEach(r => {
        const ts = new Date(r.created_at*1000).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
        const disp = r.display_name || r.username || 'anon';
        const safeBody = sanitizeAndFormatDIS(r.body);
        const bodyWithColor = r.color ? `<span style="color:${r.color}">${safeBody}</span>` : safeBody;
        const html = `[${ts}] &lt;${sanitizeAndFormatDIS(disp)}&gt; ${bodyWithColor}`;
        const mine = state.username && r.username && state.username.toLowerCase() === r.username.toLowerCase();
        b.printHTML(html, mine ? 'me' : undefined);
      });
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
  const uid = state.userId || null;
  const created = nowEpoch();
  const ttl = retentionSeconds(); const expires = ttl > 0 ? (created + ttl) : null;
  insertMessage.run(uid, msgText, created, expires);

  const ts = new Date(created*1000).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
  const disp = state.displayName || state.username || 'anon';
  const safeBody = sanitizeAndFormatDIS(msgText);
  const bodyWithColor = state.userColor ? `<span style="color:${state.userColor}">${safeBody}</span>` : safeBody;
  const html = `[${ts}] &lt;${sanitizeAndFormatDIS(disp)}&gt; ${bodyWithColor}`;
  broadcastChatFrom(html, state.username || '');
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
  const rows = selectTopicsList.all(limit); // returns topics newest-bumped first

  // Build a 1-based mapping for selection later
  state.boardIndexMap = rows.map(r => r.id); // [realId0, realId1, ...]

  api.batch(b=>{
    b.clear();
    b.print('== Bulletin Board ==', 'magenta'); b.hr();

    if (rows.length === 0){
      b.print('No topics yet. Start one with /newtopic <title>.', 'dim');
    } else {
      b.print('Topics (most recently active first):', 'yellow');
      rows.forEach((r, i)=>{
        const num = i + 1; // 1-based display number
        const safeTitle = sanitizeAndFormatDIS(r.title);
        const replyWord = (r.comments === 1 ? 'reply' : 'replies');
        b.printHTML(`${num}. ${safeTitle}  <span class="dim">(${r.comments} ${replyWord})</span>`);
      });
    }

    b.hr();
    b.print('Open: /topic <#>    New: /newtopic <title>    Remove (admin): /removetopic <#>', 'cyan');
    b.setInputType('text', 'Use /topic <#> to view; type to reply inside a topic');
  });

  state.currentScreen = 'board:list';
  state.currentTopicId = null;
}
function openTopic(api, state, indexNumber){
  if (!requireAuth(api, state)) return;
  const map = state.boardIndexMap || [];
  const idx = (indexNumber|0) - 1;
  const realId = (idx >= 0 && idx < map.length) ? map[idx] : null;
  if (!realId){ api.print('No such topic number.', 'red'); return; }

  const topic = selectTopic.get(realId);
  if (!topic){ api.print('Topic not found (maybe expired).', 'red'); return; }

  const comments = selectCommentsForTopic.all(realId);
  api.batch(b=>{
    b.clear();
    b.printHTML(`Topic: ${sanitizeAndFormatDIS(topic.title)}`, 'magenta'); b.hr();
    if (!comments.length){
      b.print('No replies yet. Type to reply.', 'dim');
    } else {
      comments.forEach(c=>{
        const whoRaw = (c.display_name && c.display_name.trim()) ? c.display_name : (c.username || 'anon');
        const who = sanitizeAndFormatDIS(whoRaw);
        const when = new Date(c.created_at*1000).toLocaleString();
        const body = sanitizeAndFormatDIS(c.body);
        const coloredBody = c.preferred_color ? `<span style="color:${c.preferred_color}">${body}</span>` : body;
        b.printHTML(`&lt;${who}&gt; ${coloredBody}  <span class="dim">(${when})</span>`);
      });
    }
    b.hr();
    b.print('Type to reply.  Commands: /board (back)  /removetopic <#> (admin)', 'cyan');
    b.setInputType('text', 'Type your reply…');
  });

  state.currentScreen = 'board:topic';
  state.currentTopicId = realId;
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
  const raw = String(text || '').trim();
  if (!raw) return true;
  if (raw.charAt(0) === '/') {
    api.print('Use /board to go back, or just type to reply.', 'dim');
    return true;
  }
  return topicPostRaw(raw, api, state), true;
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

  // Accept a list number by default; fall back to raw ID if that fails
  const raw = (args && args[0]) ? args[0] : '';
  let realId = null;

  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n > 0 && state.boardIndexMap && state.boardIndexMap.length){
    const idx = n - 1;
    if (idx >= 0 && idx < state.boardIndexMap.length){
      realId = state.boardIndexMap[idx];
    }
  }
  if (!realId){
    // try as direct DB id
    const asId = parseInt(raw, 10);
    if (Number.isFinite(asId) && asId > 0) realId = asId;
  }

  if (!realId){ api.print('Usage: /removetopic <# from list or raw id>', 'yellow'); return; }
  deleteTopicById.run(realId);
  api.print(`Removed topic.`, 'green');

  // If they were viewing this topic, go back to list
  if (state.currentScreen === 'board:topic' && state.currentTopicId === realId){
    renderBoard(api, state);
  } else {
    // refresh list if they’re on it
    if (state.currentScreen === 'board:list') renderBoard(api, state);
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
  const rows = selectNewsList.all(limit); // newest-active first

  // Build 1-based index -> real id mapping
  state.newsIndexMap = rows.map(r => r.id);

  api.batch(b=>{
    b.clear();
    b.print('== DIS News ==', 'magenta'); b.hr();

    if (!rows.length){
      b.print('No news yet. Add one with /addnews <headline> <url> <tag>.', 'dim');
    } else {
      b.print('Recent links (most recently active first):', 'yellow');
      rows.forEach((r, i)=>{
        const num = i + 1;
        const posterRaw = (r.display_name && r.display_name.trim()) ? r.display_name : (r.username || 'anon');
        const poster = sanitizeAndFormatDIS(posterRaw);
        const safeTitle = sanitizeAndFormatDIS(r.title);
        const urlShown = truncateUrl(r.url, 80);
        b.printHTML(`${num}. ${safeTitle}`);
        b.printHTML(`   <span class="dim">${escapeHTML(urlShown)}</span>  <span class="cyan">[${escapeHTML(r.tag)}]</span>  by &lt;${poster}&gt;  <span class="dim">(${r.comments} comments)</span>`);
      });
    }

    b.hr();
    b.print('Open: /news <#>    Add: /addnews <headline> <url> <tag>    Remove (admin): /removenews <#>', 'cyan');
    b.setInputType('text', 'Use /news <#> or /addnews <headline> <url> <tag>');
  });

  state.currentScreen = 'news:list';
  state.currentNewsId = null;
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
  const raw = String(text || '').trim();
  if (!raw) return true;
  if (raw.charAt(0) === '/'){ api.print('Use /news to go back, or just type to comment.', 'dim'); return true; }
  if (!state.currentNewsId){ api.print('No news item open.', 'red'); return true; }

  const maxLen = +(getSetting.get('news_reply_max_len')?.value || 600);
  const visible = visibleLengthDIS(raw);
  if (visible > maxLen){ api.print(`Comment too long (max ${maxLen} visible chars).`, 'red'); return true; }

  const ts = nowEpoch();
  insertNewsComment.run(state.currentNewsId, state.userId || null, raw, ts);
  const days = +(getSetting.get('news_inactive_days')?.value || 30);
  bumpNewsPost.run(ts, ts + days*86400, state.currentNewsId);
  openNewsItem(api, state, state.currentNewsId);
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

  const raw = (args && args[0]) ? args[0] : '';
  let realId = null;

  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n > 0 && state.newsIndexMap && state.newsIndexMap.length){
    const idx = n - 1;
    if (idx >= 0 && idx < state.newsIndexMap.length){
      realId = state.newsIndexMap[idx];
    }
  }
  if (!realId){
    const asId = parseInt(raw, 10);
    if (Number.isFinite(asId) && asId > 0) realId = asId;
  }

  if (!realId){ api.print('Usage: /removenews <# from list or raw id>', 'yellow'); return; }
  deleteNewsById.run(realId);
  api.print(`Removed news item.`, 'green');

  if (state.currentScreen === 'news:item' && state.currentNewsId === realId){
    renderNewsList(api, state);
  } else {
    if (state.currentScreen === 'news:list') renderNewsList(api, state);
  }
}

function openNewsItem(api, state, indexNumber){
  const map = state.newsIndexMap || [];
  const idx = (indexNumber|0) - 1;
  const realId = (idx >= 0 && idx < map.length) ? map[idx] : null;
  if (!realId){ api.print('No such news number.', 'red'); return; }

  const p = selectNewsPost.get(realId);
  if (!p){ api.print('No such news item (maybe expired).', 'red'); return; }

  state.currentScreen = 'news:item';
  state.currentNewsId = realId;

  const comments = selectNewsComments.all(realId);
  const posterRaw = (p.display_name && p.display_name.trim()) ? p.display_name : (p.username || 'anon');
  const poster = sanitizeAndFormatDIS(posterRaw);

  api.batch(b=>{
    b.clear();
    b.printHTML(sanitizeAndFormatDIS(p.title), 'magenta'); b.hr();
    b.printHTML(`<span class="dim">${escapeHTML(p.url)}</span>  <span class="cyan">[${escapeHTML(p.tag)}]</span>  by &lt;${poster}&gt;`);
    b.hr();
    if (!comments.length){
      b.print('No comments yet. Type to comment.', 'dim');
    } else {
      comments.forEach(c=>{
        const whoRaw = (c.display_name && c.display_name.trim()) ? c.display_name : (c.username || 'anon');
        const who = sanitizeAndFormatDIS(whoRaw);
        const when = new Date(c.created_at*1000).toLocaleString();
        const body = sanitizeAndFormatDIS(c.body);
        const coloredBody = c.preferred_color ? `<span style="color:${c.preferred_color}">${body}</span>` : body;
        b.printHTML(`&lt;${who}&gt; ${coloredBody}  <span class="dim">(${when})</span>`);
      });
    }
    b.hr();
    b.print('Type to comment.  Commands: /news (back)  /removenews <#> (admin)', 'cyan');
    b.setInputType('text', 'Type your comment…');
  });
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
  if (!raw){ api.print('Usage: /setdisplay <name>', 'yellow'); return; }
  const max = 40;
  if (visibleLengthDIS(raw) > max){ api.print(`Display name too long (max ${max} visible chars).`, 'red'); return; }
  setUserDisplay.run(raw, state.userId);
  state.displayName = raw;
  api.print('Display name updated.', 'green');
  api.printHTML(`Preview: ${sanitizeAndFormatDIS(raw)}`);
}
function cmdShowDisplay(api, state){
  if (!requireAuth(api, state)) return;
  const raw = state.displayName || state.username || '';
  api.printHTML(`Display: ${sanitizeAndFormatDIS(raw)}`);
}
function cmdDisplayReset(api, state){
  if (!requireAuth(api, state)) return;
  clearUserDisplay.run(state.userId);
  state.displayName = state.username;
  api.print('Display name reset to username.', 'green');
}

/* ======================= DMs, Suggestions, Invites (brevity) ======================= */
function cmdDM(api, state, args){
  if (!requireAuth(api, state)) return;
  const to = (args||[])[0]; if (!to){ api.print('Usage: /dm <user> <message>', 'yellow'); return; }
  const recipient = getUserIdByName.get(to);
  if (!recipient){ api.print('No such user.', 'red'); return; }
  const body = args.slice(1).join(' ').trim();
  if (!body){ api.print('Message empty.', 'yellow'); return; }
  const max = +(getSetting.get('dm_max_len')?.value || 160);
  if (body.length > max){ api.print(`DM too long (max ${max}).`, 'red'); return; }
  const ts = nowEpoch(); const days = +(getSetting.get('dm_retention_days')?.value || 14);
  insertDM.run(state.userId || null, recipient.id, body, ts, ts + days*86400);
  api.print('Sent.', 'green');
  // live notify if online
  const sockets = HUB.socketsByUser.get((getUserByName.get(to)?.username)||'');
  if (sockets) sockets.forEach(ws => sendOps(ws, [{op:'print', text:`(DM) from ${state.username}: ${body}`, cls:'cyan'}]));
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

/* ======================= Doors (Games) ======================= */
function listDoors(){ return DoorManager?.list?.() || []; }
function cmdGames(api, state){
  if (!requireAuth(api, state)) return;
  const doors = listDoors();
  api.batch(b=>{
    b.clear(); b.print('== Door Games ==','magenta'); b.hr();
    if (!doors.length){ b.print('No doors installed.', 'dim'); }
    else doors.forEach(d=> b.print(`${d.id} — ${d.name||d.id}`));
    b.hr(); b.print('Play with /play <door>', 'cyan');
  });
}
function cmdPlay(api, state, args){
  if (!requireAuth(api, state)) return;
  const id = (args[0]||'').trim().toLowerCase();
  if (!id){ api.print('Usage: /play <door>', 'yellow'); return; }
  const door = DoorManager?.get?.(id);
  if (!door){ api.print('No such door.', 'red'); return; }
  state.currentScreen = `door:${id}`;
  (DoorManager.enter)(id, api, state, []); // manager handles rendering + routing
}

/* ======================= Splash: Register & Invites ======================= */
function cmdRegister(api, state, args){
  const atSplash = !state?.authenticated;
  if (!atSplash && !state.isAdmin && !state.username){
    api.print('You must be logged out or admin to register others.', 'red'); return;
  }
  const [user, pass, inviteCode] = args || [];
  if (!user || !pass || !inviteCode){ api.print('Usage: /register <user> <pass> <invite>', 'yellow'); return; }

  const inv = getInvite.get(inviteCode);
  if (!inv){ api.print('Invalid invite code.', 'red'); return; }
  if (inv.used_at){ api.print('Invite already used.', 'red'); return; }
  if (inv.expires_at && inv.expires_at <= nowEpoch()){ api.print('Invite expired.', 'red'); return; }

  if (getUserIdByName.get(user)){ api.print('Username already exists.', 'red'); return; }

  const hash = bcrypt.hashSync(pass, 10);
  const now = nowEpoch();
  createUserStmt.run(user, hash, 0, now);
  const newUser = getUserByName.get(user);
  useInvite.run(newUser.id, now, inviteCode);

  api.print('Registration complete. You can now login with your credentials.', 'green');
}
function cmdInvite(api, state, args){
  if (!requireAuth(api, state)) return;
  if (!state.isAdmin){ api.print('Admin only.', 'red'); return; }
  const note = (args||[]).join(' ').trim() || null;
  const code = generateInviteCode();
  const now = nowEpoch();
  const expires = now + 30*86400; // 30 days
  insertInvite.run(code, state.userId, now, expires, note);
  api.print(`Invite code: ${code} (expires in 30 days)`, 'green');
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
  switch(cmd){
    /* Navigation */
    case 'main':
    case 'menu':         routeGo(api, state, 'menu'); return true;
    case 'chat':         routeGo(api, state, 'chat'); return true;
    case 'about':        routeGo(api, state, 'about'); return true;
    case 'rules':        routeGo(api, state, 'rules'); return true;
    case 'board':        renderBoard(api, state); return true;
    case 'topic':        if (args.length) openTopic(api, state, parseInt(args[0],10)||0); else api.print('Usage: /topic <id>','yellow'); return true;
     case 'newtopic':         return cmdNewTopic(api, state, args), true;
   // Admin-only removal by list index or id (your cmdRemoveTopic already enforces admin):
    case 'removetopic':      return cmdRemoveTopic(api, state, args), true;

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

    /* Colors + Display name */
    case 'setcolor':     cmdSetColor(api, state, args); return true;
    case 'color':        cmdShowColor(api, state); return true;
    case 'colorreset':   cmdColorReset(api, state); return true;
    case 'setdisplay':   cmdSetDisplay(api, state, args); return true;
    case 'display':      cmdShowDisplay(api, state); return true;
    case 'displayreset': cmdDisplayReset(api, state); return true;

    /* Invites + Register */
    case 'invite':       cmdInvite(api, state, args); return true;
    case 'register':     cmdRegister(api, state, args); return true;

    /* Misc */
    case 'whoami':       api.print(`You are ${state.username}${state.isAdmin?' (admin)':''}`); return true;
    case 'who':          return cmdWho(api), true;
    case 'format':       return cmdFormat(api), true;
    case 'here':         return cmdHere(api, state), true;
    case 'logout':       doLogout(api, state); return true;
    case 'colors':       return cmdColors(api), true;
    case 'help':         cmdHelp(api, state); return true;
    case 'passwd':       return cmdPasswd(api, state, args), true;
  }
  return false;
}

/* ======================= WS handling ======================= */
wss.on('connection', (ws)=>{
  HUB.clients.add(ws);
  const api = makeApi(ws);
  const state = makeInitialState();
  ws.__ctx = { state };

  ws.on('message', (data)=>{
    let msg; try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg.type === 'init'){
      routeGo(api, state, 'splash');
      return;
    }
    if (msg.type === 'input'){
      const text = String(msg.raw||'');
      const trimmed = text.trim();
      if (!trimmed) return;

      // Slash commands first
      if (trimmed.startsWith('/')){
        const parts = trimmed.slice(1).split(/\s+/);
        const cmd = (parts[0]||'').toLowerCase();
        const args = parts.slice(1);
        if (handleGlobalCommand(cmd, api, state, args)) return;

        // Delegate to screen-local command handlers
        let handled =
           (state.currentScreen === 'splash'    && splashHandleCommand(cmd, api))
        || (state.currentScreen === 'chat'      && chatHandleCommand(cmd, api, state, args))
        || (state.currentScreen === 'about'     && aboutHandleCommand(cmd, api, state, args))
        || (state.currentScreen === 'rules'     && rulesHandleCommand(cmd, api, state, args))
        || (state.currentScreen === 'board'     && boardHandleCommand(cmd, api, state, args))
        || (state.currentScreen === 'topic'     && topicHandleCommand(cmd, api, state, args))
        || (state.currentScreen === 'news:list' && newsListHandleCommand(cmd, api, state, args))
        || (state.currentScreen?.startsWith('door:') && DoorManager?.dispatch?.(state.currentScreen.split(':')[1], 'command', cmd, api, state, args))
        || false;

        if (!handled) api.print(`Unknown command: /${cmd}`, 'red');
        return;
      }

      // Raw text (screen-specific)
      if (state.currentScreen === 'splash'){ splashHandleRaw(trimmed, api, state); return; }
      if (state.currentScreen === 'chat'){   chatHandleRaw(trimmed, api, state); return; }
      if (state.currentScreen === 'board'){  api.print('Use /topic <id> or /newtopic <title>.', 'dim'); return; }
      if (state.currentScreen === 'topic'){  topicHandleRaw(trimmed, api, state); return; }
      if (state.currentScreen === 'news:item'){ newsItemHandleRaw(trimmed, api, state); return; }

      // Doors: pass raw to door
      if (state.currentScreen?.startsWith('door:')){
        DoorManager?.dispatch?.(state.currentScreen.split(':')[1], 'raw', trimmed, api, state);
        return;
      }

      // Fallback
      api.print('Use /help for commands.', 'dim');
    }
  });

  ws.on('close', ()=>{
    HUB.clients.delete(ws);
    const u = ws.__ctx?.state?.username;
    if (u){
      const set = HUB.socketsByUser.get(u);
      if (set){ set.delete(ws); if (set.size===0){ HUB.socketsByUser.delete(u); HUB.online.delete(u); } }
      broadcastSystem(`${u} left`);
    }
  });
});

/* ======================= Sweepers ======================= */
function runBoardSweep(){ try { sweepExpiredTopics.run(); } catch {} }
function runNewsSweep(){ try { sweepExpiredNews.run(); } catch {} }
function runChatSweep(){ try { sweepExpiredMessages.run(); } catch {} }
function runDMSweep(){ try { sweepExpiredDMs.run(); } catch {} }
function runInviteSweep(){ try { sweepExpiredInvites.run(); } catch {} }
function runSuggestionSweep(){ try { sweepExpiredSuggestions.run(); } catch {} }

setInterval(()=>{
  runChatSweep(); runDMSweep(); runInviteSweep(); runSuggestionSweep(); runBoardSweep(); runNewsSweep();
}, 10 * 60 * 1000);

/* ======================= Doors boot (optional) ======================= */
if (DoorManager){
  DoorManager.register && guessDoor && DoorManager.register(guessDoor);
  if (lordDoor){
    try { lordDoor.migrate && lordDoor.migrate(db); } catch(e){ console.error('LORD migrate:', e.message); }
    DoorManager.register && DoorManager.register(lordDoor);
  }
}

/* ======================= Helpers ======================= */
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

/* ======================= Start ======================= */
server.listen(PORT, ()=> {
  console.log(`DIS BBS listening on http://localhost:${PORT}`);
});
