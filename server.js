// server.js (Flat Functions Edition)
// Dead Internet Society — Node/Express + WebSocket BBS (Single-Room)

const path = require('path');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto'); // for secure invite codes

const { DoorManager } = require('./doors/manager');
const guessDoor = require('./doors/guess');
DoorManager.register(guessDoor);

const lordDoor = require('./doors/lord');   // <— LORD
DoorManager.register(lordDoor);             // <- NEW

const DB_PATH = process.env.DB_PATH || './dis.sqlite3';
const db = new Database(DB_PATH);

module.exports.__db = db;

// Pragmas for durability & perf
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

// ======================= Migrations (idempotent) =======================
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
  last_login_at INTEGER
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
  expires_at INTEGER,
  used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  used_at INTEGER,
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_invites_code       ON invites(code);
CREATE INDEX IF NOT EXISTS idx_invites_expires_at ON invites(expires_at);
CREATE INDEX IF NOT EXISTS idx_invites_used_at    ON invites(used_at);

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

CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_suggestions_expires ON suggestions(expires_at);
CREATE INDEX IF NOT EXISTS idx_suggestions_created ON suggestions(created_at DESC);

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


CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_expires_at ON messages(expires_at);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
`);

// Run LORD’s schema migration exactly once at boot:
if (lordDoor && typeof lordDoor.migrate === 'function') {
  lordDoor.migrate(db);
}

// Now register LORD so /games lists it and /play lord works:
DoorManager.register(lordDoor);


// --- existing migration: add preferred_color to users (safe if already exists)
try { db.prepare('ALTER TABLE users ADD COLUMN preferred_color TEXT').run(); } catch(_) {}
// --- NEW migration: add display_name to users (safe if already exists)
try { db.prepare('ALTER TABLE users ADD COLUMN display_name TEXT').run(); } catch(_) {}

// ======================= Prepared statements / settings =======================
const getSetting = db.prepare(`SELECT value FROM settings WHERE key=?`);
const setSetting = db.prepare(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);

const insertDM = db.prepare(`
  INSERT INTO dm_messages (sender_id, recipient_id, body, created_at, expires_at)
  VALUES (?, ?, ?, ?, ?)
`);
const listDMsForUser = db.prepare(`
  SELECT m.id, m.body, m.created_at, m.read_at, u.username AS sender
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
const sweepExpiredDMs = db.prepare(`DELETE FROM dm_messages WHERE expires_at IS NOT NULL AND expires_at <= strftime('%s','now')`);

const insertSuggestion = db.prepare(`
  INSERT INTO suggestions (user_id, body, created_at, expires_at)
  VALUES (?, ?, ?, ?)
`);
const listSuggestions = db.prepare(`
  SELECT s.id, s.body, s.created_at, u.username
  FROM suggestions s
  LEFT JOIN users u ON u.id = s.user_id
  WHERE (s.expires_at IS NULL OR s.expires_at > strftime('%s','now'))
  ORDER BY s.created_at DESC
  LIMIT 200
`);
const deleteSuggestionById = db.prepare(`DELETE FROM suggestions WHERE id = ?`);
const sweepExpiredSuggestions = db.prepare(`DELETE FROM suggestions WHERE expires_at IS NOT NULL AND expires_at <= strftime('%s','now')`);

// -------- Board statements
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
  SELECT t.id, t.title, u.username AS creator
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
  UPDATE board_topics
     SET last_commented_at = ?, expires_at = ?
   WHERE id = ?
`);

const sweepExpiredTopics = db.prepare(`
  DELETE FROM board_topics
  WHERE expires_at IS NOT NULL
    AND expires_at <= strftime('%s','now')
`);


if (!getSetting.get('chat_retention_days'))        setSetting.run('chat_retention_days', String(7));
if (!getSetting.get('dm_retention_days'))          setSetting.run('dm_retention_days', String(14));
if (!getSetting.get('dm_max_len'))                 setSetting.run('dm_max_len', String(160));
if (!getSetting.get('suggestion_retention_days'))  setSetting.run('suggestion_retention_days', String(60));
if (!getSetting.get('suggestion_max_len'))         setSetting.run('suggestion_max_len', String(400));
if (!getSetting.get('board_inactive_days'))    setSetting.run('board_inactive_days', String(30));
if (!getSetting.get('board_title_max_len'))    setSetting.run('board_title_max_len', String(120));   // visible chars after formatting
if (!getSetting.get('board_reply_max_len'))    setSetting.run('board_reply_max_len', String(600));   // visible chars after formatting
if (!getSetting.get('board_list_limit'))       setSetting.run('board_list_limit', String(100));


// Seed demo admin if missing
const getUser = db.prepare(`SELECT id FROM users WHERE username = ?`);
if (!getUser.get('Punkyroo')) {
  const hash = bcrypt.hashSync('password', 10);
  db.prepare(`
    INSERT INTO users(username, password_hash, is_admin, created_at)
    VALUES (?, ?, 1, strftime('%s','now'))
  `).run('Punkyroo', hash);
}

const PORT = process.env.PORT || 3000;

// ======================= Express + Static =======================
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

// ======================= Shared Chat HUB =======================
const HUB = {
  chatLog: [],
  clients: new Set(),
  online: new Set(),
  socketsByUser: new Map()   // username -> Set<WebSocket>
};

// ======================= Utilities (ops) =======================
function sendOps(ws, ops) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ops', ops }));
  }
}
function makeApi(ws) {
  function _send(ops){ sendOps(ws, ops); }
  return {
    ws,
    clear(){ _send([{op:'clear'}]); },
    print(t,cls){ _send([{op:'print', text:String(t||''), cls:cls||''}]); },
    printHTML(h, cls){
      const op = { op:'printHTML', html:String(h||'') };
      if (cls) op.cls = cls;
      _send([op]);
    },
    hr(){ _send([{op:'hr'}]); },
    setInputType(type, placeholder){ _send([{op:'setInput', inputType:type, placeholder:placeholder}]); },
    batch(fn){
      const ops=[];
      const b={
        clear(){ ops.push({op:'clear'}); },
        print(t,cls){ ops.push({op:'print', text:String(t||''), cls:cls||''}); },
        printHTML(h, cls){
          const op = { op:'printHTML', html:String(h||'') };
          if (cls) op.cls = cls;
          ops.push(op);
        },
        hr(){ ops.push({op:'hr'}); },
        setInputType(type, placeholder){ ops.push({op:'setInput', inputType:type, placeholder:placeholder}); }
      };
      fn(b); _send(ops);
    }
  };
}
function broadcastChatFrom(htmlLine, fromUsername){
  const from = (fromUsername || '').toLowerCase();
  HUB.clients.forEach((client) => {
    const ctx = client.__ctx; if (!ctx) return;
    const st = ctx.state;
    if (!(st && st.currentScreen === 'chat')) return;
    const u = (st.username || '').toLowerCase();
    const isMine = from && u === from;
    sendOps(client, [{ op:'printHTML', html: htmlLine, cls: isMine ? 'me' : undefined }]);
  });
}

// ======================= Sanitizer + DIS Markdown =======================
const ALLOWED_COLORS = ['red','green','yellow','blue','magenta','cyan','white'];
function escapeHTML(s){
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
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

// --- Visible-length helpers for DIS display names ---
const COLOR_TAGS = ['dim', ...ALLOWED_COLORS];

// Remove DIS-markup while keeping the inner text, to measure what will show.
function stripDISFormatting(s){
  if (!s) return '';
  // Remove opening/closing color/dim tags but keep content
  COLOR_TAGS.forEach(tag => {
    const open  = new RegExp(`\\[${tag}\\]`, 'gi');
    const close = new RegExp(`\\[\\/${tag}\\]`, 'gi');
    s = s.replace(open, '').replace(close, '');
  });
  // **bold** -> bold
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  // __underline__ -> underline
  s = s.replace(/__([^_]+)__/g, '$1');
  // _italics_ -> italics  (matches your renderer)
  s = s.replace(/(^|[^_])_([^_\n][^_]*?)_(?!_)/g, '$1$2');
  // Drop any stray [tag] or [/tag] remnants
  s = s.replace(/\[(?:\/)?[a-z]+\]/gi, '');
  return s;
}

// Compute visible length (approx) by stripping DIS tags / simple markdown
function stripDIS(s){
  // strip [color]...[/color] and [dim]...[/dim]
  s = s.replace(/\[(red|green|yellow|blue|magenta|cyan|white|dim)\]([\s\S]*?)\[\/\1\]/gi, '$2');
  // strip basic markdown markers
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');     // bold
  s = s.replace(/__([^_]+)__/g, '$1');         // underline
  s = s.replace(/(^|[^_])_([^_\n][^_]*?)_(?!_)/g, '$1$2'); // italics
  return s;
}
function visibleLengthDIS(s){ return stripDIS(String(s||'')).length; }

// ======================= SVG Splash =======================
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

// ======================= State / Router =======================
function makeInitialState(){
  return {
    authenticated:false,
    username:null,
    currentScreen:'splash',
    login:{ step:'username', tempUser:'' },
    userId:null,
    isAdmin:false,
    userColor:null,
    displayName:null
  };
}
function routeGo(api, state, name){
  state.currentScreen = name;
  if (api && api.ws) { api.ws.__ctx = { state }; }
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

// ======================= Screen: Splash (login/register) =======================
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
  if (cmd==='help'){ api.hr(); api.print('Splash commands:', 'yellow'); api.print('  /help   Show help','cyan'); api.print('  /clear  Clear the screen','cyan'); api.print('  /register <user> <pass> <invite>   Create a new account', 'cyan'); return true; }
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

      // identifiers first
      state.userId   = user.id;
      state.username = user.username; // canonical case
      state.isAdmin  = !!user.is_admin;

      // load preferred color & display name for session
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

// ======================= Screen: Menu =======================
function renderMenu(api, state){
  if (!requireAuth(api, state)) return;
  api.batch(b=>{
    b.clear();
    b.printHTML('<div class="banner"><div class="line"><span class="cyan">▄▄▄</span><span class="magenta"> Dead Internet Society </span><span class="cyan">▄▄▄</span></div><div class="line dim">Command Hub — use slash commands to navigate.</div></div>');
    b.print('Global commands:', 'yellow');
    b.print('  /chat      Enter the Commons Chat', 'cyan');
    b.print('  /board      Enter the Commons Chat', 'cyan');
    b.print('  /games     See list of available door games', 'cyan');
    b.print('  /messages  View your direct messages', 'cyan');
    b.print('  /about     About Dead Internet Society', 'cyan');
    b.print('  /rules     Community rules', 'cyan');
    b.print('  /format    Show DIS-Markdown examples', 'cyan');
    b.print('  /colors    Show color swatches', 'cyan');
    b.print('  /setcolor  Set your chat color', 'cyan');
    b.print('  /color     Show your chat color', 'cyan');
    b.print('  /colorreset Reset your chat color', 'cyan');
    b.print('  /setdisplay <name>  Set your display name (markdown allowed)', 'cyan');
    b.print('  /display            Show your display name', 'cyan');
    b.print('  /displayreset       Reset display name to your username', 'cyan');
    b.print('  /whoami    Show current user', 'cyan');
    b.print('  /help      Show all commands', 'cyan');
    b.print('  /logout    Sign out', 'cyan');
    b.hr();
    b.print('Tip: You can type these anywhere. /main brings you back here.', 'dim');
    b.print('Direct messages: /dm <user> <message>, /messages', 'dim');
  });
}
function menuHandleRaw(text, api, state){
  if (!requireAuth(api, state)) return true;
  api.print('Use slash commands here. Try /chat, /about, /rules, /help, or /main.', 'dim');
  return true;
}

// ======================= Screen: Chat =======================
function renderChat(api, state){
  if (!requireAuth(api, state)) return;
  api.batch(b=>{
    b.clear();
    b.print('== The Commons Chat ==', 'magenta');
    b.print('Topic: One big room to hang out — be kind, be weird.', 'dim'); b.hr();

    const here = usersCurrentlyInChat();
    b.print(here.length ? `Here now (${here.length}): ${here.join(', ')}` : 'Nobody is here yet — say hi!', 'cyan');
    b.hr();

    const rows = recentMessages.all(100).reverse(); // oldest→newest
    if (rows.length === 0) {
      b.print('No messages yet. Type to chat. /leave to return to menu.', 'dim');
    } else {
      rows.forEach(r => {
        const ts = new Date(r.created_at*1000).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
        const disp = r.display_name || r.username || 'anon';
        const safeBody = sanitizeAndFormatDIS(r.body);
        const bodyWithColor = r.color ? `<span style="color:${r.color}">${safeBody}</span>` : safeBody;
        const html = `[${ts}] &lt;${sanitizeAndFormatDIS(disp)}&gt; ${bodyWithColor}`;
        const mine = state.username && r.username &&
                     state.username.toLowerCase() === r.username.toLowerCase();
        b.printHTML(html, mine ? 'me' : undefined);
      });
    }

    b.hr();
    b.print('Tips: typing sends a message. /leave exits. /main for Command Hub. Try **bold**, _italics_, __underline__, or [cyan]color[/cyan].', 'dim');
    b.print('/here shows current people in chat.', 'dim');
    b.print('DM someone: /dm <user> <message>. View inbox: /messages.', 'dim');
  });
}
function chatHandleCommand(cmd, api, state){
  if (!requireAuth(api, state)) return true;
  if (cmd==='leave' || cmd==='menu' || cmd==='main'){ routeGo(api, state, 'menu'); return true; }
  return false;
}
function chatHandleRaw(text, api, state){
  if (!requireAuth(api, state)) return true;
  const msgText = (text||'').trim(); if (!msgText) return true;

  const uid = state.userId || null;
  const created = nowEpoch();
  const ttl = retentionSeconds(); // 0 => never expire
  const expires = ttl > 0 ? (created + ttl) : null;

  // Persist plain body
  insertMessage.run(uid, msgText, created, expires);

  // Render line using session color (body only) and DISPLAY NAME for the tag
  const ts = new Date(created*1000).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
  const safeBody = sanitizeAndFormatDIS(msgText);
  const bodyWithColor = state.userColor ? `<span style="color:${state.userColor}">${safeBody}</span>` : safeBody;
  const disp = state.displayName || state.username || 'anon';
  const html = `[${ts}] &lt;${sanitizeAndFormatDIS(disp)}&gt; ${bodyWithColor}`;

  // Broadcast; use login name for '.me' determination
  broadcastChatFrom(html, state.username);
  return true;
}

// ======================= Screen: About =======================
function renderAbout(api, state){
  if (!requireAuth(api, state)) return;
  api.batch(b=>{
    b.clear();
    b.print('== About Dead Internet Society ==', 'magenta'); b.hr();
    b.print('Dead Internet Society is a punk-style middle finger to the modern feed.', 'white');
    b.print('No engagement farming. No surveillance. No dopamine casinos. No algorithm gods.', 'white');
    b.print('It is small, hand-rolled, and human-scale.  A cozy return to simplicity,', 'white');
    b.print('honesty, and connection. Think ANSI glow, door games, and weird little rooms.', 'white');
    b.hr();
    b.print('Design principles:', 'yellow');
    b.print('• Human first: rooms over feeds, presence over metrics.', 'cyan');
    b.print('• Anti-algorithm: no ranking engines shaping your mind.', 'cyan');
    b.print('• Local vibes: low-bandwidth friendly, readable forever.', 'cyan');
    b.print('• Consent & care: moderation with empathy; clear lines on harm.', 'cyan');
    b.print('• Make weird art: creative anarchy over polished sameness.', 'cyan');
    b.print('• Data minimalism: collect the least, store the least.', 'cyan');
    b.print('• Minimal Use: no infinite scroll; this BBS avoids dominating your attention.', 'cyan'); b.hr();
    b.print('Navigation: /main for Command Hub.', 'dim');
  });
}
function aboutHandleCommand(cmd, api, state){ if (cmd==='menu'||cmd==='main'){ routeGo(api, state, 'menu'); return true; } return false; }
function aboutHandleRaw(text, api){ api.print('Use /main to return to the Command Hub.', 'dim'); return true; }

// ======================= Screen: Rules =======================
function renderRules(api, state){
  if (!requireAuth(api, state)) return;
  api.batch(b=>{
    b.clear();
    b.print('== Rules of the Dead Internet Society ==', 'magenta'); b.hr();
    b.print('Our primary goal is to keep a small, positive community.  We strive to be the EXACT opposite of toxic social media.  Bigotry, Homophobia, Transphobia, Mysogyny, Anti-intellectualism and any other outright hateful, toxic, negative, corrosive actions are commentary will NOT be tolerated.', 'white');
    b.print('Breaking any rule will result in an immediate and perminant ban. No appeals.', 'red');
    b.print('1) No harassment or bigotry. Zero tolerance for targeted abuse.', 'white');
    b.print('2) No doxxing. Keep personal info personal. Ask before sharing.', 'white');
    b.print('3) No spam or growth-hacking. This is not a funnel.', 'white');
    b.print('4) No algorithm games. No clout-chasing. We are not the feed.', 'white');
    b.print('5) Mark sensitive content. Consent and context matter.', 'white');
    b.print('6) Keep it human-scale. Quality over volume. Touch grass as needed.', 'white');
    b.print('7) Build don’t extract. Share tools, credit work, cite sources.', 'white');
    b.print('9) Don’t post anything you wouldn’t paint on a wall.', 'white');
    b.print('10) Have fun. Make weird. Help each other.', 'white'); b.hr();
    b.print('Navigation: /main for Command Hub.', 'dim');
  });
}
function rulesHandleCommand(cmd, api, state){ if (cmd==='menu'||cmd==='main'){ routeGo(api, state, 'menu'); return true; } return false; }
function rulesHandleRaw(text, api){ api.print('Use /main to return to the Command Hub.', 'dim'); return true; }

/* ======================= Screen: Board ========================== */
function renderBoard(api, state){
  if (!requireAuth(api, state)) return;
  const limit = +(getSetting.get('board_list_limit')?.value || 100);
  const rows = selectTopicsList.all(limit);

  api.batch(b=>{
    b.clear();
    b.print('== Message Board ==', 'magenta');
    b.hr();
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
    b.print('Open a topic: /topic <id>', 'cyan');
    b.print('Start new: /newtopic <title>', 'cyan');
    b.print('Leave: /main', 'dim');
    b.setInputType('text', 'Use /topic <id> or /newtopic <title>');
  });
  state.currentScreen = 'board';
}

function boardHandleCommand(cmd, api, state, args){
  if (!requireAuth(api, state)) return true;
  if (cmd === 'main' || cmd === 'menu'){ routeGo(api, state, 'menu'); return true; }
  if (cmd === 'topic'){
    const id = parseInt(args[0], 10);
    if (!id){ api.print('Usage: /topic <id>', 'yellow'); return true; }
    return openTopic(api, state, id), true;
  }
  return false;
}
function boardHandleRaw(text, api, state){
  if (!requireAuth(api, state)) return true;
  api.print('Use /topic <id> to open, or /newtopic <title>.', 'dim');
  return true;
}


/* ======================= Screen: Topic ========================== */
function openTopic(api, state, topicId){
  const t = selectTopic.get(topicId);
  if (!t){ api.print('No such topic (maybe expired).', 'red'); return; }
  state.currentScreen = 'topic';
  state.currentTopicId = topicId;

  const comments = selectCommentsForTopic.all(topicId);

  api.batch(b=>{
    b.clear();
    b.printHTML(`== Topic #${t.id}: ${sanitizeAndFormatDIS(t.title)} ==`, 'magenta');
    b.hr();
    if (comments.length === 0){
      b.print('No replies yet. Be first with /reply <text>.', 'dim');
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
    b.print('Type to reply. Commands: /board (back), /main (menu).', 'dim');
    b.setInputType('text', 'Type to reply… /board to go back');
  });
}


//  TODO:   I removed the /reply command from the list of commands... I leave this functionality for the moment... if people don't is the /reply command this function can be released
function topicHandleCommand(cmd, api, state, args){
  if (!requireAuth(api, state)) return true;
  if (cmd === 'board'){ renderBoard(api, state); return true; }
  if (cmd === 'main' || cmd === 'menu'){ routeGo(api, state, 'menu'); return true; }
  if (cmd === 'reply'){
    const raw = (args||[]).join(' ').trim();
    if (!state.currentTopicId){ api.print('No topic open.', 'red'); return true; }
    if (!raw){ api.print('Usage: /reply <text>', 'yellow'); return true; }

    // length check on visible chars (strip DIS tags crudely)
    const maxLen = +(getSetting.get('board_reply_max_len')?.value || 600);
    const visible = visibleLengthDIS(raw);
    if (visible > maxLen){
      api.print(`Reply too long (max ${maxLen} visible chars).`, 'red');
      return true;
    }

    const t = selectTopic.get(state.currentTopicId);
    if (!t){ api.print('Topic expired or missing.', 'red'); return true; }

    const ts = nowEpoch();
    insertComment.run(state.currentTopicId, state.userId || null, raw, ts);

    // bump topic & extend expiry window
    const days = +(getSetting.get('board_inactive_days')?.value || 30);
    const expires = ts + days*86400;
    updateTopicBump.run(ts, expires, state.currentTopicId);

    openTopic(api, state, state.currentTopicId);
    return true;
  }
  return false;
}
function topicHandleRaw(text, api, state){
  if (!requireAuth(api, state)) return true;
  const raw = String(text || '').trim();
  if (!raw) return true;

  // If user typed a slash-command, let the global/command router handle it.
  if (raw.charAt(0) === '/') {
    api.print('Use /board to go back, or just type to reply.', 'dim');
    return true;
  }

  if (!state.currentTopicId){
    api.print('No topic open.', 'red');
    return true;
  }

  // Enforce visible-length limit (DIS markup doesn't count)
  const maxLen = +(getSetting.get('board_reply_max_len')?.value || 600);
  const visible = visibleLengthDIS(raw); // you already have this helper
  if (visible > maxLen){
    api.print(`Reply too long (max ${maxLen} visible chars).`, 'red');
    return true;
  }

  // Persist the reply, bump topic, re-render
  const ts = nowEpoch();
  insertComment.run(state.currentTopicId, state.userId || null, raw, ts);

  const days = +(getSetting.get('board_inactive_days')?.value || 30);
  const expires = ts + days*86400;
  updateTopicBump.run(ts, expires, state.currentTopicId);

  // Repaint topic so the new comment shows
  openTopic(api, state, state.currentTopicId);
  return true;
}



// ======================= Color Preferences (unchanged) =======================
const NAMED_COLORS = {
  red:'#FF4545', green:'#2FD44F', yellow:'#E3C600', blue:'#3AA0FF',
  magenta:'#CC66FF', cyan:'#19C3C3', white:'#FFFFFF', gray:'#B0B0B0',
  orange:'#FFA500', purple:'#A64CE6', pink:'#FF77AA', lime:'#B6FF00'
};
function normalizeHex(s){
  if (!s) return null;
  s = s.trim().toLowerCase();
  if (s in NAMED_COLORS) return NAMED_COLORS[s];
  const m3 = s.match(/^#?([0-9a-f]{3})$/i);
  if (m3) { const r = m3[1]; return ('#' + r[0]+r[0] + r[1]+r[1] + r[2]+r[2]).toUpperCase(); }
  const m6 = s.match(/^#?([0-9a-f]{6})$/i);
  if (m6) return ('#' + m6[1]).toUpperCase();
  return null;
}
function relLuminance(hex){
  const r = parseInt(hex.slice(1,3),16)/255;
  const g = parseInt(hex.slice(3,5),16)/255;
  const b = parseInt(hex.slice(5,7),16)/255;
  const f = v => (v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4));
  const R = f(r), G = f(g), B = f(b);
  return 0.2126*R + 0.7152*G + 0.0722*B;
}
function isReadableOnBlack(hex){ return relLuminance(hex) >= 0.175; } // ~4.5:1 vs black
function parseUserColor(input){
  const hex = normalizeHex(input);
  if (!hex) return { ok:false, reason:'invalid' };
  if (!isReadableOnBlack(hex)) return { ok:false, reason:'dark' };
  return { ok:true, hex };
}
const setUserColor = db.prepare(`UPDATE users SET preferred_color = ? WHERE id = ?`);
const getUserColor = db.prepare(`SELECT preferred_color FROM users WHERE id = ?`);

function cmdSetColor(api, state, args){
  if (!requireAuth(api, state)) return;
  const raw = (args||[]).join(' ').trim();
  if (!raw){
    api.print('Usage: /setcolor <hex|name>', 'yellow');
    api.print('Examples: /setcolor #19c3c3  or  /setcolor cyan', 'dim');
    return;
  }
  const res = parseUserColor(raw);
  if (!res.ok){
    if (res.reason === 'dark') api.print('That color is too dark for a black background. Pick something brighter.', 'red');
    else api.print('Invalid color. Use a hex like #A1B2C3 or a name like cyan, red, magenta…', 'red');
    return;
  }
  setUserColor.run(res.hex, state.userId);
  state.userColor = res.hex;
  api.print(`Color set to ${res.hex}.`, 'green');
  api.printHTML(`Preview: <span style="color:${res.hex}">this is your chat color</span>`);
}
function cmdColor(api, state){
  if (!requireAuth(api, state)) return;
  const row = getUserColor.get(state.userId);
  const hex = row && row.preferred_color;
  if (!hex) { api.print('You have no color set. Use /setcolor <hex|name>.', 'yellow'); return; }
  api.printHTML(`Your color: <strong>${hex}</strong> — <span style="color:${hex}">preview text</span>`);
}
function cmdColorReset(api, state){
  if (!requireAuth(api, state)) return;
  setUserColor.run(null, state.userId);
  state.userColor = null;
  api.print('Color reset. You now use the default theme color.', 'green');
}

// ======================= Display Name (NEW) =======================
const setUserDisplay = db.prepare(`UPDATE users SET display_name = ? WHERE id = ?`);
const getUserDisplay = db.prepare(`SELECT display_name FROM users WHERE id = ?`);

function cmdSetDisplay(api, state, args){
  if (!requireAuth(api, state)) return;
  const raw = (args||[]).join(' ').trim();
  if (!raw){
    api.print('Usage: /setdisplay <name>', 'yellow');
    return;
  }

  const maxVisible = 40;
  const visibleLen = visibleLengthDIS(raw);

  if (visibleLen > maxVisible){
    api.print(`Display name too long when rendered (max ${maxVisible} visible characters).`, 'red');
    api.print(`Yours is ${visibleLen}. Formatting markers don’t count toward the limit.`, 'dim');
    return;
  }

  setUserDisplay.run(raw, state.userId);
  state.displayName = raw;
  api.print('Display name updated.', 'green');
  api.printHTML(`Preview: ${sanitizeAndFormatDIS(raw)} <span class="dim">(${visibleLen}/${maxVisible})</span>`);
}

function cmdDisplay(api, state){
  if (!requireAuth(api, state)) return;
  const dn = state.displayName || state.username;
  api.printHTML(`Your display name: ${sanitizeAndFormatDIS(dn)}`);
}
function cmdDisplayReset(api, state){
  if (!requireAuth(api, state)) return;
  setUserDisplay.run(null, state.userId);
  state.displayName = state.username;
  api.print('Display name reset to your username.', 'green');
}

// ======================= Global Commands =======================
function cmdHelp(api, state){
  api.hr();
  api.print('Global slash commands:', 'yellow');
  api.print('  /register  Create an account: /register <user> <pass> <invite>', 'cyan');
  api.print('  /chat      Enter the Commons Chat', 'cyan');
  api.print('  /board     Enter the Bulletin Board', 'cyan');
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
function cmdClear(api){ api.clear(); }
function cmdWhoami(api, state){ api.print(state.authenticated ? (state.username||'guest') : 'Not logged in', 'cyan'); }
function cmdChat(api, state){ if (requireAuth(api, state)) routeGo(api, state, 'chat'); }
function cmdAbout(api, state){ if (requireAuth(api, state)) routeGo(api, state, 'about'); }
function cmdRules(api, state){ if (requireAuth(api, state)) routeGo(api, state, 'rules'); }
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
function cmdLogout(api, state){
  const u = state.username;
  state.authenticated = false;
  state.username = null;
  state.login.step = 'username';
  state.login.tempUser = '';
  state.userId = null;
  state.userColor = null;
  state.displayName = null;
  if (u){
    HUB.online.delete(u);
    const set = HUB.socketsByUser.get(u);
    if (set) {
      set.delete(api.ws);
      if (set.size === 0) {
        HUB.socketsByUser.delete(u);
        broadcastSystem(`${u} left`);
      }
    }
  }
  api.setInputType('text', 'Username'); routeGo(api, state, 'splash');
}
function cmdMain(api, state){ if (requireAuth(api, state)) routeGo(api, state, 'menu'); }
function cmdColors(api){
  api.print('█ RED','red'); api.print('█ GREEN','green'); api.print('█ YELLOW','yellow');
  api.print('█ BLUE','blue'); api.print('█ MAGENTA','magenta'); api.print('█ CYAN','cyan'); api.print('█ WHITE','white');
}
function cmdRegister(api, state, args){
  const [username, password, inviteCode] = args || [];
  if (!username || !password || !inviteCode) {
    api.print('Usage: /register <username> <password> <invite>', 'yellow');
    return;
  }
  if (password.length < 6) { api.print('Password must be at least 6 characters.', 'yellow'); return; }
  const vi = validateInvite(inviteCode);
  if (!vi.ok) {
    const why = vi.reason === 'no_such' ? 'Invite not found.'
              : vi.reason === 'used'    ? 'Invite already used.'
              : vi.reason === 'expired' ? 'Invite expired.'
              : 'Invalid invite.';
    api.print(why, 'red'); return;
  }
  const res = createUser(username, password);
  if (!res.ok) { api.print('That username is taken.', 'red'); return; }
  try {
    const newUser = findUserByName.get(username);
    const changed = redeemInvite.run(newUser.id, inviteCode).changes;
    if (!changed) { api.print('Invite could not be redeemed (race condition). Try another.', 'red'); return; }
  } catch(e) { api.print('Invite redemption failed. Try another code.', 'red'); return; }

  if (state && state.authenticated) api.print(`Account created: ${username}. You remain logged in as ${state.username}.`, 'green');
  else api.print('Account created. Please log in with your new credentials.', 'green');
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
  if (!state.isAdmin){ api.print('Unknown command.', 'red'); return; }
  const mode = (args[0]||'unused').toLowerCase();
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
function cmdGames(api, state){
  if (!requireAuth(api, state)) return;
  api.hr();
  api.print('Available games', 'yellow');
  // Each item is: id, title, description, how to start
  const games = [
    { id: 'lord',  title: 'Legend of the Redux Dragon', desc: 'Daily forest runs, duels, and tavern mischief.', start: '/play lord' },
    { id: 'guess', title: 'Guess The Number',           desc: 'Simple demo door for testing.',                  start: '/play guess' }
  ];
  games.forEach(g => {
    api.print(`• ${g.title}  [id: ${g.id}]`, 'cyan');
    api.print(`  ${g.desc}`, 'dim');
    api.print(`  Start: ${g.start}`, 'green');
  });
  api.hr();
  api.print('Use /play <id> to launch a game (e.g., /play lord). /leave exits a game.', 'dim');
}

function cmdPlay(api, state, args){
  if (!requireAuth(api, state)) return;
  const id = (args[0] || '').toLowerCase();
  if (!id){ api.print('Usage: /play <door-id>', 'yellow'); return; }
  DoorManager.enter(api, state, id);
}
function cmdLeave(api, state){
  if (state.currentScreen && state.currentScreen.startsWith('door:')) {
    DoorManager.leave(api, state);
    renderMenu(api, state);
  } else {
    cmdMain(api, state);
  }
}
function cmdDM(api, state, args){
  if (!requireAuth(api, state)) return;
  const toUser = (args[0] || '').trim();
  const text = args.slice(1).join(' ').trim();
  if (!toUser || !text) { api.print('Usage: /dm <user> <message>', 'yellow'); return; }
  const max = dmMaxLen();
  if (text.length > max) { api.print(`Message too long (max ${max} chars).`, 'red'); return; }
  const rec = findUserByName.get(toUser);
  if (!rec) { api.print('No such user.', 'red'); return; }
  if (rec.username.toLowerCase() === (state.username||'').toLowerCase()) { api.print('You cannot DM yourself.', 'yellow'); return; }
  const created = nowEpoch();
  const ttl = dmRetentionSeconds();
  const expires = ttl > 0 ? (created + ttl) : null;
  insertDM.run(state.userId || null, rec.id, text, created, expires);
  const ts = new Date(created*1000).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
  const from = state.displayName || state.username || 'anon';
  const htmlToSender = `[${ts}] <span class="dim">[dm→</span>${escapeHTML(rec.username)}<span class="dim">]</span> ${sanitizeAndFormatDIS(text)}`;
  const htmlToRcpt   = `[${ts}] <span class="dim">[dm←</span>${sanitizeAndFormatDIS(from)}<span class="dim">]</span> ${sanitizeAndFormatDIS(text)}`;
  api.printHTML(htmlToSender);
  deliverDMToUser(rec.username, htmlToRcpt);
}
function cmdMessages(api, state, args){
  if (!requireAuth(api, state)) return;
  const rows = listDMsForUser.all(state.userId, 50);
  const mDays = getSetting.get('dm_retention_days').value;
  api.hr();
  api.print('Your Direct Messages (newest first):', 'yellow');
  api.print('messages kept for only '+mDays+' days', 'red');
  if (!rows.length){ api.print('No messages.', 'dim'); return; }
  rows.forEach(r => {
    const ts = new Date(r.created_at*1000).toLocaleString();
    const from = r.sender || 'anon';
    const body = sanitizeAndFormatDIS(r.body);
    const badge = r.read_at ? '' : '<span class="yellow">[unread]</span> ';
    api.printHTML(`${badge}<span class="dim">${ts}</span> <strong>${escapeHTML(from)}</strong>: ${body}`);
  });
  try { markAllDMsRead.run(state.userId); } catch(e) {}
}
function cmdHere(api, state){
  if (!requireAuth(api, state)) return;
  const here = usersCurrentlyInChat();
  api.print(here.length ? `Here now (${here.length}): ${here.join(', ')}` : 'Nobody is in chat right now.', 'cyan');
}
function cmdSuggest(api, state, args){
  if (!requireAuth(api, state)) return;
  const text = (args || []).join(' ').trim();
  if (!text){ api.print('Usage: /suggest <your suggestion>', 'yellow'); return; }
  const max = suggestionMaxLen();
  if (text.length > max){ api.print(`Suggestion too long (max ${max} chars).`, 'red'); return; }
  const created = nowEpoch();
  const ttl = suggestionRetentionSeconds();
  const expires = ttl > 0 ? (created + ttl) : null;
  insertSuggestion.run(state.userId || null, text, created, expires);
  broadcastSystem(`${state.username || 'anon'} added a suggestion.`);
  api.print('Thanks — suggestion submitted.', 'green');
}
function cmdSuggestions(api, state){
  if (!requireAuth(api, state)) return;
  const rows = listSuggestions.all();
  setSuggestionListForState(state, rows);
  api.hr();
  api.print('Suggestion Box (newest first):', 'yellow');
  if (!rows.length){
    api.print('No suggestions yet. Add one with /suggest <text>.', 'dim');
    return;
  }
  rows.forEach((r, i) => {
    const n = i + 1;
    const ts = new Date(r.created_at*1000).toLocaleString();
    const who = r.username || 'anon';
    const body = sanitizeAndFormatDIS(r.body);
    api.printHTML(`${n}. <strong>${escapeHTML(who)}</strong> <span class="dim">(${ts})</span>: ${body}`);
  });
  if (state.isAdmin) api.print('Admin: remove with /removesuggestion <#>', 'dim');
}
function cmdRemoveSuggestion(api, state, args){
  if (!requireAuth(api, state)) return;
  if (!state.isAdmin){ api.print('Unknown command.', 'red'); return; }
  const numStr = (args && args[0]) || '';
  const n = parseInt(numStr, 10);
  if (Number.isNaN(n) || n < 1){ api.print('Usage: /removesuggestion <number>', 'yellow'); return; }
  const id = getSuggestionIdByIndex(state, n);
  if (!id){ api.print('Invalid number. Run /suggestions to refresh the list.', 'red'); return; }
  const changes = deleteSuggestionById.run(id).changes;
  if (!changes){ api.print('Could not remove (already gone?).', 'yellow'); return; }
  api.print(`Suggestion #${n} removed.`, 'green');
  cmdSuggestions(api, state);
}

function cmdNewTopic(api, state, args){
  if (!requireAuth(api, state)) return;
  const raw = (args||[]).join(' ').trim();
  if (!raw){ api.print('Usage: /newtopic <title>', 'yellow'); return; }

  const maxLen = +(getSetting.get('board_title_max_len')?.value || 120);
  const visible = visibleLengthDIS(raw);
  if (visible > maxLen){
    api.print(`Title too long (max ${maxLen} visible chars).`, 'red'); return;
  }

  const ts = nowEpoch();
  const days = +(getSetting.get('board_inactive_days')?.value || 30);
  const expires = ts + days*86400;

  insertTopic.run(raw, state.userId || null, ts, ts, expires);
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
  } else {
    // if they’re elsewhere, no-op; /board will reflect
  }
}


// ======================= Command Router =======================
function handleGlobalCommand(cmd, api, state, args){
  switch(cmd){
    case 'help':         return cmdHelp(api, state), true;
    case 'clear':        return cmdClear(api), true;
    case 'whoami':       return cmdWhoami(api, state), true;
    case 'who':          return cmdWho(api), true;
    case 'games':
    case 'doors':        return cmdGames(api, state), true;
    case 'board':      return renderBoard(api, state), true;
case 'topic':      return (args.length ? (openTopic(api, state, parseInt(args[0],10)||0), true) : (api.print('Usage: /topic <id>', 'yellow'), true));
case 'newtopic':   return cmdNewTopic(api, state, args), true;
case 'removetopic':return cmdRemoveTopic(api, state, args), true;

    case 'dm':           return cmdDM(api, state, args), true;
    case 'messages':     return cmdMessages(api, state, args), true;
    case 'here':         return cmdHere(api, state), true;
    case 'play':         return cmdPlay(api, state, args), true;
    case 'leave':        return cmdLeave(api, state), true;
    case 'passwd':       return cmdPasswd(api, state, args), true;
    case 'register':     return cmdRegister(api, state, args), true;
    case 'makeinvite':   return cmdMakeInvite(api, state, args), true;
    case 'listinvites':  return cmdListInvites(api, state, args), true;
    case 'revokeinvite': return cmdRevokeInvite(api, state, args), true;
    case 'chat':         return cmdChat(api, state), true;
    case 'about':        return cmdAbout(api, state), true;
    case 'rules':        return cmdRules(api, state), true;
    case 'format':       return cmdFormat(api), true;
    case 'logout':       return cmdLogout(api, state), true;
    case 'main':         return cmdMain(api, state), true;
    case 'colors':       return cmdColors(api), true;
    case 'setcolor':     return cmdSetColor(api, state, args), true;
    case 'color':        return cmdColor(api, state), true;
    case 'colorreset':   return cmdColorReset(api, state), true;
    case 'setdisplay':   return cmdSetDisplay(api, state, args), true;
    case 'display':      return cmdDisplay(api, state), true;
    case 'displayreset': return cmdDisplayReset(api, state), true;
    case 'suggest':      return cmdSuggest(api, state, args), true;
    case 'suggestions':  return cmdSuggestions(api, state), true;
    case 'removesuggestion': return cmdRemoveSuggestion(api, state, args), true;
    default:             return false;
  }
}

// ======================= WS Lifecycle =======================
wss.on('connection', (ws) => {
  HUB.clients.add(ws);
  const state = makeInitialState();
  const api = makeApi(ws);
  ws.__ctx = { state };

  routeGo(api, state, 'splash');

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'init') return;

    if (msg.type === 'input') {
      const text = String(msg.raw || '').trim(); if (!text) return;

      if (state.currentScreen.startsWith('door:')) {
        const doorId = state.currentScreen.split(':')[1];
        const door = DoorManager.get(doorId);
        if (door) {
          if (text.charAt(0) === '/') {
            const parts = text.slice(1).split(/\s+/);
            const cmd = (parts[0] || '').toLowerCase();
            const args = parts.slice(1);
            if (!handleGlobalCommand(cmd, api, state, args)) {
              if (!door.handleCommand || !door.handleCommand(cmd, api, state, args)) {
                api.print(`Unknown command: /${cmd}`, 'red');
              }
            }
          } else {
            if (door.handleRaw) door.handleRaw(text, api, state);
          }
        }
        return;
      }

      if (state.currentScreen === 'topic') {
        return topicHandleRaw(text, api, state);
      }

      if (text.charAt(0) === '/') {
        const parts = text.slice(1).split(/\s+/);
        const cmd = (parts[0] || '').toLowerCase();
        const args = parts.slice(1);
        if (!handleGlobalCommand(cmd, api, state, args)) {
          const handled =
     (state.currentScreen === 'splash' && splashHandleCommand(cmd, api))
  || (state.currentScreen === 'chat'   && chatHandleCommand(cmd, api, state))
  || (state.currentScreen === 'about'  && aboutHandleCommand(cmd, api, state))
  || (state.currentScreen === 'rules'  && rulesHandleCommand(cmd, api, state))
  || (state.currentScreen === 'board'  && boardHandleCommand(cmd, api, state, args))
  || (state.currentScreen === 'topic'  && topicHandleCommand(cmd, api, state, args)) 
  || (state.currentScreen === 'menu'   && (cmd==='help'? (cmdHelp(api), true): false));

          if (!handled){
            api.print(`Unknown command: /${cmd}`, 'red'); api.print('Try /help.', 'dim');
          }
        }
      } else {
        switch(state.currentScreen){
          case 'splash': splashHandleRaw(text, api, state); break;
          case 'menu':   menuHandleRaw(text, api, state); break;
          case 'chat':   chatHandleRaw(text, api, state); break;
          case 'about':  aboutHandleRaw(text, api); break;
          case 'rules':  rulesHandleRaw(text, api); break;
          default: api.print('Not sure what to do. Try /help.', 'dim');
        }
      }
    }
  });

  ws.on('close', ()=> {
    HUB.clients.delete(ws);
    const u = state && state.username;
    if (u){
      const set = HUB.socketsByUser.get(u);
      if (set) { set.delete(ws); if (set.size === 0) { HUB.socketsByUser.delete(u); HUB.online.delete(u); broadcastSystem(`${u} left`); } }
    }
  });

  ws.on('error', (err)=> { try { api.print('WS Error: '+(err && err.message ? err.message : err), 'red'); } catch(e){} });
});

// ======================= Helper Functions =======================
function nowEpoch() { return Math.floor(Date.now()/1000); }
function retentionSeconds() {
  const row = getSetting.get('chat_retention_days');
  const days = row ? parseInt(row.value, 10) : 7;
  return Math.max(0, days) * 86400;
}
function makeInviteCode() {
  const hex = crypto.randomBytes(20).toString('hex').toUpperCase();
  return hex.match(/.{1,4}/g).join('-');
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
function validateInvite(code) {
  const row = getInvite.get(code);
  if (!row) return { ok:false, reason:'no_such' };
  if (row.used_at) return { ok:false, reason:'used' };
  if (row.expires_at && row.expires_at <= nowEpoch()) return { ok:false, reason:'expired' };
  return { ok:true, invite: row };
}
function deliverDMToUser(username, htmlLine){
  const set = HUB.socketsByUser.get(username);
  if (!set || set.size === 0) return false;
  set.forEach(ws => sendOps(ws, [{ op: 'printHTML', html: htmlLine }]));
  return true;
}

// Users
const findUserByName = db.prepare(`SELECT * FROM users WHERE username = ?`);
function verifyLogin(username, password) {
  const u = findUserByName.get(username);
  if (!u) return null;
  if (!bcrypt.compareSync(password, u.password_hash)) return null;
  db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).run(nowEpoch(), u.id);
  return u;
}
function createUser(username, password, opts = {}) {
  const existing = findUserByName.get(username);
  if (existing) return { ok: false, reason: 'exists' };
  const isAdmin = opts.isAdmin ? 1 : 0;
  const hash = bcrypt.hashSync(password, 10);
  try {
    db.prepare(`
      INSERT INTO users (username, password_hash, is_admin, created_at)
      VALUES (?, ?, ?, strftime('%s','now'))
    `).run(username, hash, isAdmin);
    const row = db.prepare(`SELECT id FROM users WHERE username = ?`).get(username);
    return { ok: true, id: row.id };
  } catch (e) {
    if ((e && e.message || '').toLowerCase().includes('unique')) {
      return { ok:false, reason:'exists' };
    }
    throw e;
  }
}

// Messages
const insertMessage = db.prepare(`
  INSERT INTO messages(user_id, body, created_at, expires_at) VALUES (?, ?, ?, ?)
`);
const recentMessages = db.prepare(`
  SELECT m.id, m.body, m.created_at, u.username, u.display_name, u.preferred_color AS color
  FROM messages m
  LEFT JOIN users u ON u.id = m.user_id
  WHERE (m.expires_at IS NULL OR m.expires_at > strftime('%s','now'))
  ORDER BY m.created_at DESC
  LIMIT ?
`);
const sweepExpired = db.prepare(`DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at <= strftime('%s','now')`);

// Invites
const insertInvite = db.prepare(`
  INSERT INTO invites (code, created_by, created_at, expires_at, note)
  VALUES (?, ?, strftime('%s','now'), ?, ?)
`);
const getInvite = db.prepare(`SELECT * FROM invites WHERE code = ?`);
const redeemInvite = db.prepare(`
  UPDATE invites
     SET used_by = ?, used_at = strftime('%s','now')
   WHERE code = ? AND used_at IS NULL
`);

function dmRetentionSeconds() {
  const row = getSetting.get('dm_retention_days');
  const days = row ? parseInt(row.value, 10) : 14;
  return Math.max(0, days) * 86400;
}
function dmMaxLen() {
  const row = getSetting.get('dm_max_len');
  return row ? Math.max(1, parseInt(row.value, 10)) : 160;
}
function usersCurrentlyInChat() {
  const uniq = new Set();
  HUB.clients.forEach(ws => {
    const st = ws && ws.__ctx && ws.__ctx.state;
    if (st && st.currentScreen === 'chat' && st.username) {
      uniq.add(st.username);
    }
  });
  return Array.from(uniq).sort((a,b)=>a.localeCompare(b, 'en', {sensitivity:'base'}));
}
function systemLine(t){ return `<span class="dim">* ${escapeHTML(t)}</span>`; }
function broadcastSystem(t){ broadcastChatFrom(systemLine(t), null); }
function suggestionRetentionSeconds(){
  const row = getSetting.get('suggestion_retention_days');
  const days = row ? parseInt(row.value, 10) : 30;
  return Math.max(0, days) * 86400;
}
function suggestionMaxLen(){
  const row = getSetting.get('suggestion_max_len');
  return row ? Math.max(1, parseInt(row.value, 10)) : 300;
}
function setSuggestionListForState(state, rows){ state._suggestIndexMap = rows.map(r => r.id); }
function getSuggestionIdByIndex(state, idx){
  if (!state._suggestIndexMap) return null;
  const i = idx - 1;
  return (i >= 0 && i < state._suggestIndexMap.length) ? state._suggestIndexMap[i] : null;
}

// ======================= Clean Sweeper =======================
function runBoardSweep(){
  // If last_commented_at is older than N days, we delete (comments cascade).
  const days = +(getSetting.get('board_inactive_days')?.value || 30);
  const cutoff = nowEpoch() - days*86400;
  // we set expires_at when bumping/commenting; this sweep removes it once past now
  sweepExpiredTopics.run();
}

function runSweep(){
  try { sweepExpired.run(); } catch(e){}
  try { sweepExpiredDMs && sweepExpiredDMs.run(); } catch(e){}
  try { sweepExpiredSuggestions.run(); } catch(e){}
}
runSweep();
setInterval(()=>{
  try { sweepExpiredDMs.run(); } catch{}
  try { sweepExpiredSuggestions.run(); } catch{}
  try { runBoardSweep(); } catch{}
}, 10 * 60 * 1000);

// ======================= Graceful shutdown =======================
process.on('SIGINT', () => { try { db.close(); } finally { process.exit(0); } });
process.on('SIGTERM', () => { try { db.close(); } finally { process.exit(0); } });

// ======================= Start =======================
server.listen(PORT, () => {
  console.log('DIS BBS listening on http://localhost:'+PORT);
});
