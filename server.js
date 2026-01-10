const path = require('path');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bcrypt = require('bcryptjs');

const { createDatabase } = require('./src/database');
const { createHub } = require('./src/hub');
const { createNotificationService } = require('./src/services/notifications');
const { createRockoService } = require('./src/services/rocko');
const formatting = require('./src/utils/formatting');
const timeUtils = require('./src/utils/time');


let DoorManager, lordDoor, casinoDoor;
try {
  const DM = require('./doors/manager');
  DoorManager = DM?.DoorManager || DM;
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

app.use('/static', express.static(path.join(__dirname, 'public')));

const database = createDatabase({ dbPath: DB_PATH });
const { db, statements, helpers } = database;
module.exports.__db = db;

const hubApi = createHub({ timeUtils, formatting });
const notifications = createNotificationService({
  statements,
  helpers,
  hub: hubApi,
  timeUtils,
});

const rocko = createRockoService({
  statements,
  helpers,
  formatting,
  timeUtils,
  notifications,
  hub: hubApi,
  openAI: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.ROCKO_MODEL || 'gpt-5-nano',
  },
  logger: console,
});

if (rocko && typeof rocko.start === 'function') {
  rocko.start();
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
  sanitizeAndFormatDIS,
  escapeHTML,
  visibleLengthDIS,
  stripDISFormatting,
  ALLOWED_COLORS,
} = formatting;

const {
  nowEpoch,
  ymdFromEpoch,
  dayHeadingFromEpoch,
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
  getInvite,
  redeemInvite,
  sweepExpiredInvites,
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
  sweepExpiredAnnouncements,
  sweepInactiveUsers,
  updateUserNorms,
  getUsersByNorm,
  listUsersBasic,
  countUsers,
  listUsersPage,
} = statements;

const {
  refreshUserNormsByRow,
  resolveUserHandle,
  normalizeHandle,
  createInvite,
  validateInvite,
  createUser,
  verifyLogin,
} = helpers;

function printDayDivider(batchApi, epochSec){
  const label = dayHeadingFromEpoch(epochSec);
  batchApi.printHTML(`<span class="dim">── ${escapeHTML(label)} ──</span>`);
}

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

    '<g font-family="ui-monospace, Menlo, Consolas, monospace" text-anchor="middle">',
    '<text x="600" y="402" font-size="26" font-weight="bold" fill="#c32419ff" opacity="0.9">proudly ANTI-FAscist</text>',
    '<text x="600" y="422" font-size="13" font-weight="bold" fill="#c32419ff" opacity="0.5">(which should... ya know... be the default)</text>',
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

function resetState(state){
  if (!state) return;
  const fresh = makeInitialState();
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, fresh);
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
     b.print('Accounts removed after 60 days of inactivity. Issues? sysop@disbbs.org', 'red');
    b.setInputType('text', 'Username or /register');
    b.setInputLimit(null);
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
    api.print('Enter password:', 'cyan'); api.setInputType('password', 'Password'); api.setInputLimit(null); state.login.step='password'; return true;
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
      api.setInputLimit(null);
      api.print('Login successful.', 'green');

      routeGo(api, state, 'menu');
      cmdAnnouncements(api, state);
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
  api.print('  /register  Create an account: /register <user> <pass> <invite>', 'cyan');
  api.print('  /chat      Enter the Commons Chat', 'cyan');
  api.print('  /here      Show who is currently in the chat', 'cyan');
  api.print('  /post <text>  Share a short status update (swept after ~30 days)', 'cyan');
  api.print('  /feed [user]  View recent updates (optionally for a user)', 'cyan');
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
  api.print('  /announcements     View site announcements', 'cyan');
  api.print('  /main      Return to Command Hub', 'cyan');
  api.print('  /logout    Sign out', 'cyan');

  if (state && state.isAdmin){
    api.hr(); api.print('Admin:', 'yellow');
    api.print('  /makeinvite [days] [note]   Create a single-use invite', 'cyan');
    api.print('  /listinvites [unused|used|all]  Show recent invites', 'cyan');
    api.print('  /revokeinvite <code>        Expire an unused invite', 'cyan');
    api.print('  /removesuggestion <#>  Remove a suggestion (from the current list)', 'cyan');
    api.print('  /retention <area> <days>   Set auto-delete retention (board/news/messages/posts/users)', 'cyan');
    api.print('  /adminchat   Admin live room (private)', 'cyan');
    api.print('  /announce <text>             Post a new announcement', 'cyan');
    api.print('  /removeannounce <id>         Remove an announcement', 'cyan');

  }
  api.hr();
  api.print('DIS-Markdown: **bold**, _italics_, __underline__, [dim]…[/dim], and color tags like [cyan]…[/cyan].', 'dim');
}

/* ======================= Menu ======================= */
function renderMenu(api, state){
  if (!requireAuth(api, state)) return;
  const unreadCount = countUnreadDMs.get(state.userId)?.count || 0;
  api.batch(b=>{
    b.clear();
    b.setInputLimit(null);
    b.printHTML('<div class="banner"><div class="line"><span class="cyan">▄▄▄</span><span class="magenta"> Dead Internet Society </span><span class="cyan">▄▄▄</span></div><div class="line dim">Command Hub — use slash commands to navigate.</div></div>');
    b.print('Main Menu:', 'yellow');
    if (unreadCount > 0) {
      const label = unreadCount === 1 ? 'message' : 'messages';
      b.printHTML(`<span style="color:#ff6b6b;font-weight:bold;">📬 NEW DIRECT MESSAGES: ${unreadCount} unread ${label}.</span>`);
    }
    b.print('  /chat            Enter the Commons Chat', 'cyan');
    b.print('  /post <text>     Share a short status update', 'cyan');
    b.print('  /feed [user]     View the latest updates', 'cyan');
    b.print('  /board           Bulletin board', 'cyan');
    b.print('  /news            Fark-like news links', 'cyan');
    b.print('  /games           List door games', 'cyan');
    b.print('  /messages        View your direct messages', 'cyan');
    b.print('  /announcements   View site announcements', 'cyan');
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

/* ======================= Announcements ======================= */
function fetchActiveAnnouncements(){
  try { runAnnouncementSweep(); } catch {}
  const limit = Math.max(1, Math.min(200, ANNOUNCEMENT_LIST_LIMIT));
  return listAnnouncements.all(limit);
}

function printAnnouncements(api, rows){
  api.batch(b => {
    b.hr();
    b.print('== Announcements ==', 'magenta');
    b.hr();

    if (!rows.length){
      b.print('No announcements at this time.', 'dim');
    } else {
      rows.forEach(r => {
        const when = r.created_at ? new Date(r.created_at * 1000).toLocaleString() : '';
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

/* ======================= Status Posts / Feed ======================= */
function getStatusFeedLimit(){
  const row = getSetting.get('status_feed_limit');
  const parsed = row && row.value != null ? parseInt(row.value, 10) : NaN;
  const fallback = 50;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(STATUS_FEED_LIMIT_CAP, parsed));
}

const STATUS_NAME_COLOR_CLASS_RE = new RegExp(`class\\s*=\\s*"(?:${ALLOWED_COLORS.join('|')})"`, 'i');
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
    b.hr();
    b.print(`== ${headingText} ==`, 'magenta');
    b.hr();

    if (!rows.length){
      b.print(emptyMessage, 'dim');
    } else {
      let lastYmd = null;
      rows.forEach(r => {
        const thisYmd = ymdFromEpoch(r.created_at);
        if (thisYmd !== lastYmd) {
          printDayDivider(b, r.created_at);
          lastYmd = thisYmd;
        }

        const timeLabel = new Date(r.created_at * 1000).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
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
  runStatusPostSweep();

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

  try { runStatusPostSweep(); } catch {}

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
        const usernameRaw = typeof r.username === 'string' ? r.username : '';
        const isRocko = !!(rocko && usernameRaw && typeof rocko.usernameLower === 'string' && usernameRaw.toLowerCase() === rocko.usernameLower);
        const displaySource = r.display_name && typeof r.display_name === 'string' ? r.display_name.trim() : '';
        const shouldUseRockoDisplay = isRocko && (!displaySource || displaySource.toLowerCase() === usernameRaw.toLowerCase());
        const disp = shouldUseRockoDisplay ? (rocko.displayName || usernameRaw || 'anon') : (displaySource || usernameRaw || 'anon');
        const color = r.color || (isRocko ? rocko.color : '');
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

  const ts = new Date(created*1000).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
  const disp = state.displayName || state.username || 'anon';
  const safeBody = sanitizeAndFormatDIS(msgText);
  const bodyWithColor = state.userColor ? `<span style="color:${state.userColor}">${safeBody}</span>` : safeBody;
  const html = `[${ts}] &lt;${sanitizeAndFormatDIS(disp)}&gt; ${bodyWithColor}`;

  broadcastChatFrom(html, state.username || '', created); // your existing broadcast with day dividers

  // === NEW: mentions → notify
  const fromRow = { id: uid, username: state.username };
  notifyMentions(msgText, fromRow, 'chat');

  if (rocko && typeof rocko.handleChatMessage === 'function') {
    try {
      rocko.handleChatMessage({
        text: msgText,
        fromUsername: state.username,
        displayName: state.displayName,
        userId: state.userId,
      });
    } catch (e) {
      console.warn('[rocko] chat hook failed:', e && e.message ? e.message : e);
    }
  }

  return true;
}


/* ======================= About / Rules ======================= */
function renderAbout(api, state){
  if (!requireAuth(api, state)) return;
  api.batch(b=>{
    b.clear();
    b.setInputLimit(null);
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
    b.setInputLimit(null);
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
    b.setInputLimit(null);
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
    b.setInputLimit(null);
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

  const maxLen = +(getSetting.get('news_comment_max_len')?.value || 600);

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
    b.setInputLimit(maxLen);
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
  let days = 7, note = '';
  if (args && args.length) {
    const maybe = parseInt(args[0], 10);
    if (!Number.isNaN(maybe) && maybe >= 0) { days = maybe; note = args.slice(1).join(' ').trim(); }
    else { note = args.join(' ').trim(); }
  }
  const out = createInvite({ creatorId: state.userId, creatorName: state.username, days, note });
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
  const rows = db.prepare(`SELECT code, created_at, expires_at, used_at, note, created_by_name, used_by_name FROM invites WHERE ${where} ORDER BY created_at DESC LIMIT 50`).all();
  if (!rows.length){ api.print('No invites found.', 'dim'); return; }
  api.hr(); api.print(`Invites (${mode}):`, 'yellow');
  rows.forEach(r=>{
    const exp = r.expires_at ? new Date(r.expires_at*1000).toLocaleString() : 'never';
    const used = r.used_at ? new Date(r.used_at*1000).toLocaleString() : '—';
    const maker = r.created_by_name ? ` by ${r.created_by_name}` : '';
    const usedBy = r.used_by_name ? ` → ${r.used_by_name}` : '';
    const noteBit = r.note ? ` - ${r.note}` : '';
    api.print(`• ${r.code}${maker}${usedBy}  exp:${exp}  used:${used}${noteBit}`, r.used_at?'dim':'cyan');
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

function cmdRetention(api, state, args){
  if (!requireAuth(api, state)) return;
  if (!state.isAdmin){ api.print('Unknown command.', 'red'); return; }

  const keys = {
    board: 'board_inactive_days',
    news: 'news_inactive_days',
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
      news: keys.news,
      messages: keys.messages,
      posts: keys.posts,
      users: keys.users,
    }).forEach(([label, key]) => {
      const value = Number(getSetting.get(key)?.value || 0);
      api.print(`  ${label}: ${value} day${value === 1 ? '' : 's'}`, 'cyan');
    });
    api.print('Set with: /retention <board|news|messages|posts|users> <days>. Use 0 to disable.', 'dim');
    return;
  }

  if (args.length < 2){
    api.print('Usage: /retention <board|news|messages|posts|users> <days>', 'yellow');
    return;
  }

  const area = String(args[0] || '').trim().toLowerCase();
  const key = keys[area];
  if (!key){
    api.print('Unknown retention area. Use: board, news, messages, posts, users.', 'yellow');
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

  if (
    rocko
    && typeof rocko.handleDM === 'function'
    && recipient
    && recipient.username
    && recipient.username.toLowerCase() === rocko.usernameLower
  ) {
    try {
      rocko.handleDM({
        text: body,
        fromUsername: state.username,
        displayName: state.displayName,
        userRow: {
          id: state.userId,
          username: state.username,
          display_name: state.displayName,
        },
      });
    } catch (e) {
      console.warn('[rocko] dm hook failed:', e && e.message ? e.message : e);
    }
  }

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
    b.clear(); b.print('== Direct Messages ==','magenta'); b.hr();
    if (!rows.length){ b.print('No messages.', 'dim'); }
    else rows.forEach(r=>{
      const ts = new Date(r.created_at*1000).toLocaleString();
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
  const rows = listMentionsForUser(state.userId, limit);

  api.batch(b=>{
    b.clear();
    b.print('== Notifications ==','magenta'); b.hr();

    if (!rows.length){
      b.print('No notifications yet. Mention someone with @username in Chat/Boards/News.', 'dim');
    } else {
      rows.forEach(n=>{
        const when = new Date(n.created_at*1000).toLocaleString();
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
    const newUser = getUserByName.get(username);
    const changed = redeemInvite.run(newUser.id, newUser.username, inviteCode).changes;
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
  const u = getUserByName.get(state.username);
  if (!u || !bcrypt.compareSync(oldp, u.password_hash)){ api.print('Old password incorrect.', 'red'); return; }
  const hash = bcrypt.hashSync(newp, 10);
  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hash, u.id);
  api.print('Password updated.', 'green');
}



/* ======================= Logout ======================= */
function doLogout(api, state){
  if (!state || !state.authenticated){
    api.print('You are not logged in.', 'yellow');
    return;
  }

  try { DoorManager?.leave?.(api, state); } catch {}

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
    case 'post':         cmdPost(api, state, args); return true;
    case 'feed':         cmdFeed(api, state, args); return true;
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
    case 'retention':    return (cmdRetention(api, state, args), true);
    case 'register':     cmdRegister(api, state, args); return true;

    /* Notifications */
    case 'notifications': cmdNotifications(api, state, args); return true;
    case 'announcements': cmdAnnouncements(api, state); return true;
    case 'announce':      cmdAnnounce(api, state, args); return true;
    case 'removeannounce': cmdRemoveAnnouncement(api, state, args); return true;

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
const HEARTBEAT_MS = 30_000;
function markAlive() { this.isAlive = true; }

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


wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', markAlive);

  HUB.clients.add(ws);
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

    // Handshake
    if (msg.type === 'init') { routeGo(api, state, 'splash'); return; }

    const inDoor = !!(state.currentScreen && state.currentScreen.startsWith('door:'));
    const doorId = inDoor ? state.currentScreen.slice(5) : null;

    const exitDoor = () => {
      try { DoorManager?.leave?.(api, state); } catch {}
      api.setPrompt && api.setPrompt('DIS>');
      api.setInputType && api.setInputType('text', 'type /help for commands');
      routeGo(api, state, 'menu');
    };

    if (msg.type === 'doorEvent') {
      if (!inDoor || !doorId) return;
      const slug = String(msg.slug || '').trim().toLowerCase();
      if (!slug || slug !== String(doorId || '').toLowerCase()) return;
      const payload = msg.payload;
      if (payload && typeof payload === 'object' && String(payload.type || '').toLowerCase() === 'leave') {
        exitDoor();
        return;
      }
      const handled = DoorManager?.dispatch?.(doorId, 'event', payload, api, state);
      if (handled === 'leave') exitDoor();
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

      if (inDoor) {
        // Only /leave escapes; everything else is door-local
        const handled = DoorManager?.dispatch?.(doorId, 'command', cmd, api, state, args);
        if (handled === 'leave') {
          exitDoor();
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
    removeUserPresence(api, state);
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
  runChatSweep(); runDMSweep(); runInviteSweep(); runSuggestionSweep(); runStatusPostSweep(); runBoardSweep(); runNewsSweep(); runAdminChatSweep(); runAnnouncementSweep(); runInactiveUserSweep();
}, 10 * 60 * 1000);

/* ======================= Doors boot (optional) ======================= */
if (DoorManager && typeof DoorManager.register === 'function') {
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
        DoorManager.register('casino', casinoDoor, { name: 'Casino' });
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




function retentionSecondsAdmin(){
  const days = +(getSetting.get('admin_chat_retention_days')?.value || 7);
  return days > 0 ? days*86400 : 0;
}

function inactiveUserAgeSeconds(){
  const days = +(getSetting.get('user_inactive_days')?.value || 60);
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



app.get('/healthz', (req, res) => {
  // Liveness only — don't touch DB or do any work
  res.type('text').send('ok');
});




/* ======================= Start ======================= */
server.listen(PORT, ()=> {
  console.log(`DIS BBS listening on http://localhost:${PORT}`);
});
