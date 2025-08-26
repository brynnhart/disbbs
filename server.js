// server.js (Flat Functions Edition)
// Dead Internet Society — Node/Express + WebSocket BBS (Single-Room)

const path = require('path');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto'); // NEW: for secure invite codes

const { DoorManager } = require('./doors/manager');
const guessDoor = require('./doors/guess');
DoorManager.register(guessDoor);


const DB_PATH = process.env.DB_PATH || './dis.sqlite3';
const db = new Database(DB_PATH);


// Pragmas for durability & perf
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

// Migrations (idempotent)
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
  expires_at INTEGER,              -- NULL = no expiry
  used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  used_at INTEGER,                 -- NULL = unused
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
  expires_at INTEGER,   -- NULL = never expire
  read_at INTEGER       -- NULL = unread
);
CREATE INDEX IF NOT EXISTS idx_dm_recipient_created ON dm_messages(recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dm_expires_at ON dm_messages(expires_at);
CREATE INDEX IF NOT EXISTS idx_dm_read_at ON dm_messages(read_at);



CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER -- NULL means never expire
);
CREATE INDEX IF NOT EXISTS idx_messages_expires_at ON messages(expires_at);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
`);

// Seed default retention (in days) if missing (e.g., 7 days)
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
const sweepExpiredDMs = db.prepare(`
  DELETE FROM dm_messages WHERE expires_at IS NOT NULL AND expires_at <= strftime('%s','now')
`);

if (!getSetting.get('chat_retention_days')) setSetting.run('chat_retention_days', String(7));
if (!getSetting.get('dm_retention_days')) setSetting.run('dm_retention_days', String(14));  // default 14 days
if (!getSetting.get('dm_max_len')) setSetting.run('dm_max_len', String(160));              // default 160 chars


// Seed demo user if not present
const getUser = db.prepare(`SELECT id FROM users WHERE username = ?`);
if (!getUser.get('Punkyroo')) {
  const hash = bcrypt.hashSync('password', 10);
  db.prepare(`
    INSERT INTO users(username, password_hash, is_admin, created_at)
    VALUES (?, ?, 1, strftime('%s','now'))
  `).run('Punkyroo', hash);
}


const PORT = process.env.PORT || 3000;

/* ======================= Express + Static ======================= */
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

/* ======================= Shared Chat HUB ======================== */
const HUB = {
  chatLog: [],
  clients: new Set(),
  online: new Set(),
  socketsByUser: new Map()   // username -> Set<WebSocket>
};


/* ======================= Utilities (ops) ======================== */
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
    printHTML(h){ _send([{op:'printHTML', html:String(h||'')}]); },
    hr(){ _send([{op:'hr'}]); },
    setInputType(type, placeholder){ _send([{op:'setInput', inputType:type, placeholder:placeholder}]); },
    batch(fn){
      const ops=[]; 
      const b={
        clear(){ ops.push({op:'clear'}); },
        print(t,cls){ ops.push({op:'print', text:String(t||''), cls:cls||''}); },
        printHTML(h){ ops.push({op:'printHTML', html:String(h||'')}); },
        hr(){ ops.push({op:'hr'}); },
        setInputType(type, placeholder){ ops.push({op:'setInput', inputType:type, placeholder:placeholder}); }
      };
      fn(b); _send(ops);
    }
  };
}
function broadcastToChat(htmlLine){
  HUB.clients.forEach((client)=>{
    const ctx = client.__ctx;
    if (!ctx) return;
    const st = ctx.state;
    if (st && st.currentScreen === 'chat') {
      sendOps(client, [{op:'printHTML', html: htmlLine}]);
    }
  });
}

/* ======================= Sanitizer + DIS Markdown ============== */
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
  let out = s;
  for (const c of ALLOWED_COLORS) {
    const re = new RegExp('\\['+c+'\\]([\\s\\s]*?)\\[\\/'+c+'\\]','gi');
    out = out.replace(re, '<span class="'+c+'">$1</span>');
  }
  return out;
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

/* ======================= SVG Splash ============================ */
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

/* ======================= State / Router ======================== */
function makeInitialState(){
  return {
    authenticated:false,
    username:null,
    currentScreen:'splash',
    login:{ step:'username', tempUser:'' }
  };
}
function routeGo(api, state, name){
  state.currentScreen = name;
  if (api && api.ws) { api.ws.__ctx = { state }; } // broadcast sees current screen
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

/* ======================= Screen: Splash ======================== */
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
  if (cmd==='help'){ api.hr(); api.print('Splash commands:', 'yellow'); api.print('  /help   Show help','cyan'); api.print('  /clear  Clear the screen','cyan'); api.print('  /register <user> <pass> <invite>   Create a new account', 'cyan');
return true; }
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
    state.username = user.username; // keep canonical case
    HUB.online.add(state.username);
if (!HUB.socketsByUser.has(state.username)) HUB.socketsByUser.set(state.username, new Set());
HUB.socketsByUser.get(state.username).add(api.ws);
broadcastSystem(`${state.username} joined`);


    state.userId = user.id;
    state.isAdmin = !!user.is_admin;  
    api.setInputType('text', 'Type here… try /help'); api.print('Login successful.', 'green');
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

/* ======================= Screen: Menu ========================== */
function renderMenu(api, state){
  if (!requireAuth(api, state)) return;
  api.batch(b=>{
    b.clear();
    b.printHTML('<div class="banner"><div class="line"><span class="cyan">▄▄▄</span><span class="magenta"> Dead Internet Society </span><span class="cyan">▄▄▄</span></div><div class="line dim">Command Hub — use slash commands to navigate.</div></div>');
    b.print('Global commands:', 'yellow');
    b.print('  /chat      Enter the Commons Chat', 'cyan');
    b.print('  /games     See list of available door games', 'cyan');
    b.print('  /messages  View your direct messages', 'cyan');
    b.print('  /about     About Dead Internet Society', 'cyan');
    b.print('  /rules     Community rules', 'cyan');
    b.print('  /format    Show DIS‑Markdown examples', 'cyan');
    b.print('  /colors    Show color swatches', 'cyan');
    b.print('  /whoami    Show current user', 'cyan');
    b.print('  /help      Show all commands', 'cyan');
    b.print('  /logout    Sign out', 'cyan');
    b.hr();
    b.print('Tip: You can type these anywhere. /main brings you back here.', 'dim');
    b.print('Direct messages: /dm <user> <message>, /messages', 'dim');
  });
}

// Numbers are no longer used here—nudge the user toward slash commands.
function menuHandleRaw(text, api, state){
  if (!requireAuth(api, state)) return true;
  api.print('Use slash commands here. Try /chat, /about, /rules, /help, or /main.', 'dim');
  return true;
}

/* ======================= Screen: Chat ========================== */
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
        const user = r.username || 'anon';
        const html = `[${ts}] &lt;${escapeHTML(user)}&gt; ${sanitizeAndFormatDIS(r.body)}`;
        b.printHTML(html);
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

  const user = state.username || 'anon';
  const uid = state.userId || null;
  const created = nowEpoch();
  const ttl = retentionSeconds(); // 0 => never expire
  const expires = ttl > 0 ? (created + ttl) : null;

  // Persist
  insertMessage.run(uid, msgText, created, expires);

  // Render line (single broadcast path)
  const ts = new Date(created*1000).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
  const html = `[${ts}] &lt;${escapeHTML(user)}&gt; ${sanitizeAndFormatDIS(msgText)}`;
  broadcastToChat(html);

  return true;
}


/* ======================= Screen: About ========================= */
function renderAbout(api, state){
  if (!requireAuth(api, state)) return;
  api.batch(b=>{
    b.clear();
    b.print('== About Dead Internet Society ==', 'magenta'); b.hr();
    b.print('Dead Internet Society is a punk‑style middle finger to the modern feed.', 'white');
    b.print('No engagement farming. No surveillance. No dopamine casinos. No algorithm gods.', 'white');
    b.print('It is small, hand‑rolled, and human‑scale — a cozy return to simplicity,', 'white');
    b.print('honesty, and connection. Think ANSI glow, door games, and weird little rooms.', 'white'); b.hr();
    b.print('Design principles:', 'yellow');
    b.print('• Human first: rooms over feeds, presence over metrics.', 'cyan');
    b.print('• Anti‑algorithm: no ranking engines shaping your mind.', 'cyan');
    b.print('• Local vibes: low‑bandwidth friendly, readable forever.', 'cyan');
    b.print('• Consent & care: moderation with empathy; clear lines on harm.', 'cyan');
    b.print('• Make weird art: creative anarchy over polished sameness.', 'cyan');
    b.print('• Data minimalism: collect the least, store the least.', 'cyan');
    b.print('• Minimal Use: no infinite scroll; this BBS avoids dominating your attention.', 'cyan'); b.hr();
    b.print('Navigation: /main for Command Hub.', 'dim');
  });
}
function aboutHandleCommand(cmd, api, state){ if (cmd==='menu'||cmd==='main'){ routeGo(api, state, 'menu'); return true; } return false; }
function aboutHandleRaw(text, api){ api.print('Use /main to return to the Command Hub.', 'dim'); return true; }

/* ======================= Screen: Rules ========================= */
function renderRules(api, state){
  if (!requireAuth(api, state)) return;
  api.batch(b=>{
    b.clear();
    b.print('== Rules of the Dead Internet Society ==', 'magenta'); b.hr();
    b.print('1) No harassment or bigotry. Zero tolerance for targeted abuse.', 'white');
    b.print('2) No doxxing. Keep personal info personal. Ask before sharing.', 'white');
    b.print('3) No spam or growth‑hacking. This is not a funnel.', 'white');
    b.print('4) No algorithm games. No clout‑chasing. We are not the feed.', 'white');
    b.print('5) Mark sensitive content. Consent and context matter.', 'white');
    b.print('6) Keep it human‑scale. Quality over volume. Touch grass as needed.', 'white');
    b.print('7) Build don’t extract. Share tools, credit work, cite sources.', 'white');
    b.print('8) Mods are gardeners. Expect empathy, clarity, and firm lines on harm.', 'white');
    b.print('9) Data minimalism. Don’t post anything you wouldn’t paint on a wall.', 'white');
    b.print('10) Have fun. Make weird. Help each other.', 'white'); b.hr();
    b.print('Navigation: /main for Command Hub.', 'dim');

  });
}
function rulesHandleCommand(cmd, api, state){ if (cmd==='menu'||cmd==='main'){ routeGo(api, state, 'menu'); return true; } return false; }
function rulesHandleRaw(text, api){ api.print('Use /main to return to the Command Hub.', 'dim'); return true; }

/* ======================= Global Commands ======================= */
function cmdHelp(api, state){
  api.hr();
  api.print('Global slash commands:', 'yellow');
  api.print('  /register  Create an account: /register <user> <pass> <invite>', 'cyan');
  api.print('  /chat      Enter the Commons Chat', 'cyan');
  api.print('  /here      Show who is currently in the chat', 'cyan');
  api.print('  /doors     List available doors', 'cyan');
api.print('  /games     List available games', 'cyan');
api.print('  /dm        Send a direct message: /dm <user> <message>', 'cyan');
api.print('  /messages  Show your recent direct messages', 'cyan');
api.print('  /leave     Leave the current game', 'cyan');
  api.print('  /about     About Dead Internet Society', 'cyan');
  api.print('  /rules     Community rules', 'cyan');
  api.print('  /passwd    Change your password: /passwd <old> <new>', 'cyan');
  api.print('  /format    Show DIS‑Markdown examples', 'cyan');
  api.print('  /colors    Show color swatches', 'cyan');
  api.print('  /whoami    Show current user', 'cyan');
  api.print('  /who       List users currently online', 'cyan');
  api.print('  /main      Return to Command Hub', 'cyan');
  api.print('  /logout    Sign out', 'cyan');

  if (state && state.isAdmin){
  api.hr(); api.print('Admin:', 'yellow');
  api.print('  /makeinvite [days] [note]   Create a single‑use invite', 'cyan');
  api.print('  /listinvites [unused|used|all]  Show recent invites', 'cyan');
  api.print('  /revokeinvite <code>        Expire an unused invite', 'cyan');
}

  api.hr();
  api.print('DIS‑Markdown: **bold**, _italics_, __underline__, [dim]…[/dim], and color tags like [cyan]…[/cyan].', 'dim');
}

function cmdClear(api){ api.clear(); }
function cmdWhoami(api, state){ api.print(state.authenticated ? (state.username||'guest') : 'Not logged in', 'cyan'); }
function cmdChat(api, state){ if (requireAuth(api, state)) routeGo(api, state, 'chat'); }
function cmdAbout(api, state){ if (requireAuth(api, state)) routeGo(api, state, 'about'); }
function cmdRules(api, state){ if (requireAuth(api, state)) routeGo(api, state, 'rules'); }
function cmdFormat(api){
  api.hr();
  api.print('DIS‑Markdown examples (sanitized & rendered):', 'yellow');
  ['**Bold** and _italics_ and __underline__.',
   'Mixing: **bold and _italic_** plus [cyan]color[/cyan] and [dim]dim[/dim].',
   'Colors: [red]red[/red] [green]green[/green] [yellow]yellow[/yellow] [blue]blue[/blue] [magenta]magenta[/magenta] [cyan]cyan[/cyan] [white]white[/white]',
   'Safety: <script>alert(1)</script> will be escaped.'
  ].forEach(ex => api.printHTML(sanitizeAndFormatDIS(ex)));
  api.hr(); api.print('Use these in Chat; everything is sanitized first.', 'dim');
}
function cmdLogout(api, state){
  state.authenticated=false; state.username=null; state.login.step='username'; state.login.tempUser='';
  if (state.username){
  HUB.online.delete(state.username);
  const set = HUB.socketsByUser.get(state.username);
  if (set) { set.delete(api.ws); if (set.size === 0) HUB.socketsByUser.delete(state.username); }
  broadcastSystem(`${state.username} left`);
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

function cmdMakeInvite(api, state, args){
  if (!requireAuth(api, state)) return;
  if (!state.isAdmin) { api.print('Unknown command.', 'red'); return; } // hide existence

  // Parse: /makeinvite [days] [note...]
  let days = 7, note = '';
  if (args && args.length) {
    const maybe = parseInt(args[0], 10);
    if (!Number.isNaN(maybe) && maybe >= 0) {
      days = maybe;
      note = args.slice(1).join(' ').trim();
    } else {
      note = args.join(' ').trim();
    }
  }

  const out = createInvite({ creatorId: state.userId, days, note });
  if (!out.ok) {
    api.print('Failed to create invite.', 'red');
    return;
  }

  const expiresLine = out.expires_at
    ? new Date(out.expires_at*1000).toLocaleString()
    : 'never';
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
  const list = DoorManager.all();
  if (!list.length){ api.print('No games installed yet.', 'dim'); return; }
  api.hr();
  api.print('Available games:', 'yellow');
  list.forEach(d => api.print(`  - ${d.id}  (${d.name})`, 'cyan'));
  api.print('Use /play <id> to enter a game. Example: /play guess', 'dim');
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
    renderMenu(api, state); // return to hub
  } else {
    // not in a door → behave like "back to hub"
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
  if (rec.username.toLowerCase() === (state.username||'').toLowerCase()) {
    api.print('You cannot DM yourself.', 'yellow'); return;
  }

  const created = nowEpoch();
  const ttl = dmRetentionSeconds();
  const expires = ttl > 0 ? (created + ttl) : null;

  insertDM.run(state.userId || null, rec.id, text, created, expires);

  const ts = new Date(created*1000).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
  const from = state.username || 'anon';
  const htmlToSender = `[${ts}] <span class="dim">[dm→</span>${escapeHTML(rec.username)}<span class="dim">]</span> ${sanitizeAndFormatDIS(text)}`;
  const htmlToRcpt   = `[${ts}] <span class="dim">[dm←</span>${escapeHTML(from)}<span class="dim">]</span> ${sanitizeAndFormatDIS(text)}`;

  // Feedback to sender
  api.printHTML(htmlToSender);

  // Instant deliver if online (non-blocking)
  deliverDMToUser(rec.username, htmlToRcpt);
}


function cmdMessages(api, state, args){
  if (!requireAuth(api, state)) return;

  const rows = listDMsForUser.all(state.userId, 50); // last 50
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

  // Mark all as read now
  try { markAllDMsRead.run(state.userId); } catch(e) {}
}

function cmdHere(api, state){
  if (!requireAuth(api, state)) return;
  const here = usersCurrentlyInChat();
  api.print(here.length ? `Here now (${here.length}): ${here.join(', ')}` : 'Nobody is in chat right now.', 'cyan');
}









function handleGlobalCommand(cmd, api, state, args){
  switch(cmd){
    case 'help':       return cmdHelp(api, state), true;          // pass state now
    case 'clear':      return cmdClear(api), true;
    case 'whoami':     return cmdWhoami(api, state), true;
    case 'who':        return cmdWho(api), true;
    case 'games':     return cmdGames(api, state), true;
case 'doors':     return cmdGames(api, state), true; // hidden alias
case 'dm':        return cmdDM(api, state, args), true;
case 'messages':  return cmdMessages(api, state, args), true;
case 'here':      return cmdHere(api, state), true;
    case 'play':      return cmdPlay(api, state, args), true;
    case 'leave':     return cmdLeave(api, state), true;
    case 'passwd':     return cmdPasswd(api, state, args), true;
    case 'register':   return cmdRegister(api, state, args), true; // UPDATED
    case 'makeinvite': return cmdMakeInvite(api, state, args), true; // NEW (admin only)
    case 'listinvites': return cmdListInvites(api, state, args), true;
    case 'revokeinvite': return cmdRevokeInvite(api, state, args), true;
    case 'chat':       return cmdChat(api, state), true;
    case 'about':      return cmdAbout(api, state), true;
    case 'rules':      return cmdRules(api, state), true;
    case 'format':     return cmdFormat(api), true;
    case 'logout':     return cmdLogout(api, state), true;
    case 'main':       return cmdMain(api, state), true;
    case 'colors':     return cmdColors(api), true;
    default:           return false;
  }
}


/* ======================= WS Lifecycle ========================== */
wss.on('connection', (ws) => {
  HUB.clients.add(ws);
  const state = makeInitialState();
  const api = makeApi(ws);

  // store ctx for broadcast routing
  ws.__ctx = { state };

  // Boot splash
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
    if (msg.type === 'input') {
      const text = String(msg.raw || '').trim();
      if (!text) return;
      if (text.charAt(0) === '/') {
        const parts = text.slice(1).split(/\s+/);
        const cmd = (parts[0] || '').toLowerCase();
        const args = parts.slice(1);
        // global first
        if (!handleGlobalCommand(cmd, api, state, args)) {
          // door-local
          if (!door.handleCommand || !door.handleCommand(cmd, api, state, args)) {
            api.print(`Unknown command: /${cmd}`, 'red');
          }
        }
      } else {
        if (door.handleRaw) door.handleRaw(text, api, state);
      }
    }
  }
  return; // prevent falling through to normal screen routing
}


      if (text.charAt(0) === '/') {
        const parts = text.slice(1).split(/\s+/);
        const cmd = (parts[0] || '').toLowerCase();
        const args = parts.slice(1); // currently unused
        if (!handleGlobalCommand(cmd, api, state, args)) {
          // delegate to screen-specific command handlers
          const handled = (state.currentScreen === 'splash' && splashHandleCommand(cmd, api))
                       || (state.currentScreen === 'chat'   && chatHandleCommand(cmd, api, state))
                       || (state.currentScreen === 'about'  && aboutHandleCommand(cmd, api, state))
                       || (state.currentScreen === 'rules'  && rulesHandleCommand(cmd, api, state))
                       || (state.currentScreen === 'menu'   && (cmd==='help'? (cmdHelp(api, state), true): false));
          if (!handled){
            api.print(`Unknown command: /${cmd}`, 'red'); api.print('Try /help.', 'dim');
          }
        }
      } else {
        // raw input to current screen
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


/* ======================= Helper Functions ======================== */
function nowEpoch() { return Math.floor(Date.now()/1000); }
function retentionSeconds() {
  const row = getSetting.get('chat_retention_days');
  const days = row ? parseInt(row.value, 10) : 7;
  return Math.max(0, days) * 24 * 60 * 60;
}

function makeInviteCode() {
  // 20 bytes (160 bits) → 40 hex chars → group for readability
  const hex = crypto.randomBytes(20).toString('hex').toUpperCase(); // e.g. 'A1B2...'
  return hex.match(/.{1,4}/g).join('-'); // 'A1B2-...-...'
}

// returns { ok, code, expires_at, err }
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

// returns { ok, reason? } and (on ok) the user is already created elsewhere
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


// Messages
const insertMessage = db.prepare(`
  INSERT INTO messages(user_id, body, created_at, expires_at) VALUES (?, ?, ?, ?)
`);
const recentMessages = db.prepare(`
  SELECT m.id, m.body, m.created_at, u.username
  FROM messages m
  LEFT JOIN users u ON u.id = m.user_id
  WHERE (m.expires_at IS NULL OR m.expires_at > strftime('%s','now'))
  ORDER BY m.created_at DESC
  LIMIT ?
`);
const sweepExpired = db.prepare(`DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at <= strftime('%s','now')`);

// ----- Invites
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
      uniq.add(st.username); // avoids double-counting multiple tabs
    }
  });
  return Array.from(uniq).sort((a,b)=>a.localeCompare(b, 'en', {sensitivity:'base'}));
}



function systemLine(t){ return `<span class="dim">* ${escapeHTML(t)}</span>`; }
function broadcastSystem(t){ broadcastToChat(systemLine(t)); }



/* ======================= Clean Sweeper ================================ */
function runSweep() {
  try { sweepExpired.run(); } catch(e) {}
  try { sweepExpiredDMs.run(); } catch(e) {}
}

runSweep();
setInterval(runSweep, 60 * 1000); // every 60s


/* ======================= Graceful shutdown ==================== */
process.on('SIGINT', () => {
  try { db.close(); } finally { process.exit(0); }
});
process.on('SIGTERM', () => {
  try { db.close(); } finally { process.exit(0); }
});




/* ======================= Start ================================ */
server.listen(PORT, () => {
  console.log('DIS BBS listening on http://localhost:'+PORT);
});
