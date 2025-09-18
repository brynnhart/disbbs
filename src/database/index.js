'use strict';

const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const { stripDISFormatting } = require('../utils/formatting');
const { nowEpoch } = require('../utils/time');

function createDatabase({ dbPath }) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

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

  ensureNotificationsSchema(db);
  ensureAboutColumn(db);
  ensureNormalizationColumns(db);

  const getSetting = db.prepare('SELECT value FROM settings WHERE key=?');
  const setSetting = db.prepare(`
    INSERT INTO settings(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `);

  const getUserByName = db.prepare('SELECT * FROM users WHERE username = ?');
  const getUserIdByName = db.prepare('SELECT id FROM users WHERE username = ?');
  const setLastLogin = db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?');
  const getUserColor = db.prepare('SELECT preferred_color FROM users WHERE id = ?');
  const setUserColor = db.prepare('UPDATE users SET preferred_color = ? WHERE id = ?');
  const clearUserColor = db.prepare('UPDATE users SET preferred_color = NULL WHERE id = ?');
  const getUserDisplay = db.prepare('SELECT display_name FROM users WHERE id = ?');
  const setUserDisplay = db.prepare('UPDATE users SET display_name = ? WHERE id = ?');
  const clearUserDisplay = db.prepare('UPDATE users SET display_name = NULL WHERE id = ?');
  const getUserAboutById = db.prepare('SELECT about FROM users WHERE id = ?');
  const getUserAboutByName = db.prepare('SELECT about FROM users WHERE username = ?');
  const setUserAboutById = db.prepare('UPDATE users SET about = ? WHERE id = ?');

  const insertInvite = db.prepare(`
    INSERT INTO invites (code, created_by, created_at, expires_at, note)
    VALUES (?, ?, strftime('%s','now'), ?, ?)
  `);
  const getInvite = db.prepare('SELECT * FROM invites WHERE code = ?');
  const redeemInvite = db.prepare(`
    UPDATE invites
       SET used_by = ?, used_at = strftime('%s','now')
     WHERE code = ? AND used_at IS NULL
  `);
  const sweepExpiredInvites = db.prepare(`
    DELETE FROM invites
     WHERE expires_at IS NOT NULL AND expires_at <= strftime('%s','now')
  `);

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
  const deleteSuggestionById = db.prepare('DELETE FROM suggestions WHERE id = ?');
  const sweepExpiredSuggestions = db.prepare(`
    DELETE FROM suggestions WHERE expires_at IS NOT NULL AND expires_at <= strftime('%s','now')
  `);

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

  const insertTopic = db.prepare(`
    INSERT INTO board_topics (title, creator_id, created_at, last_commented_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const deleteTopicById = db.prepare('DELETE FROM board_topics WHERE id = ?');
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

  const insertNewsPost = db.prepare(`
    INSERT INTO news_posts (title, url, tag, user_id, created_at, last_commented_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteNewsById = db.prepare('DELETE FROM news_posts WHERE id = ?');
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

  const updateUserNorms = db.prepare(`
    UPDATE users
       SET username_norm     = ?,
           display_name_norm = ?
     WHERE id = ?
  `);
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
  const countUsers = db.prepare('SELECT COUNT(1) AS n FROM users');
  const listUsersPage = db.prepare(`
    SELECT username, display_name, last_login_at
      FROM users
  ORDER BY username COLLATE NOCASE ASC
     LIMIT ? OFFSET ?
  `);

  const insertNotification = db.prepare(`
    INSERT INTO notifications (to_user_id, from_user_id, kind, context, body, created_at, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `);
  const listNotificationsForUser = db.prepare(`
    SELECT n.id, n.kind, n.context, n.body, n.created_at, n.seen_at,
           u.username AS from_username, u.display_name AS from_display
      FROM notifications n
      LEFT JOIN users u ON u.id = n.from_user_id
     WHERE n.to_user_id = ?
       AND n.kind = 'mention'
     ORDER BY (n.seen_at IS NULL) DESC, n.created_at DESC
     LIMIT ?
  `);
  const markAllNotificationsSeen = db.prepare(`
    UPDATE notifications
       SET seen_at = strftime('%s','now')
     WHERE to_user_id = ? AND seen_at IS NULL
  `);

  function defSetting(key, val){
    if (!getSetting.get(key)) setSetting.run(key, String(val));
  }

  // defaults
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

  function normalizeHandle(s){
    if (!s) return '';
    const plain = stripDISFormatting(String(s));
    return plain.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function refreshUserNormsByRow(row){
    const u = row.username || '';
    const d = row.display_name || null;
    updateUserNorms.run(normalizeHandle(u), d ? normalizeHandle(d) : null, row.id);
  }

  function resolveUserHandle(anyName){
    if (!anyName) return null;
    const fast = getUserByName.get(String(anyName).trim());
    if (fast) return { row: fast };

    const needle = normalizeHandle(anyName);
    if (!needle) return null;

    const rows = getUsersByNorm.all(needle, needle);
    if (rows.length === 1) return { row: rows[0] };
    if (rows.length > 1)   return { ambiguous: rows.map(r => ({ id:r.id, username:r.username })) };
    return null;
  }

  function makeInviteCode(){
    const hex = crypto.randomBytes(20).toString('hex').toUpperCase();
    return hex.match(/.{1,4}/g).join('-');
  }

  function createInvite({ creatorId, days, note }){
    const expires_at = (typeof days === 'number' && days > 0) ? (nowEpoch() + days*86400) : null;
    const code = makeInviteCode();
    try {
      insertInvite.run(code, creatorId || null, expires_at, note || null);
      return { ok:true, code, expires_at };
    } catch (e) {
      return { ok:false, err: e && e.message ? e.message : String(e) };
    }
  }

  function validateInvite(code){
    const row = getInvite.get(code);
    if (!row) return { ok:false, reason:'no_such' };
    if (row.used_at) return { ok:false, reason:'used' };
    if (row.expires_at && row.expires_at <= nowEpoch()) return { ok:false, reason:'expired' };
    return { ok:true, invite: row };
  }

  function createUser(username, password, opts = {}){
    const existing = getUserByName.get(username);
    if (existing) return { ok:false, reason:'exists' };

    const isAdmin = opts.isAdmin ? 1 : 0;
    const hash = bcrypt.hashSync(password, 10);

    try {
      db.prepare(`
        INSERT INTO users (username, password_hash, is_admin, created_at)
        VALUES (?, ?, ?, strftime('%s','now'))
      `).run(username, hash, isAdmin);

      const row = getUserByName.get(username);
      return { ok:true, id: row.id };
    } catch (e) {
      const msg = (e && e.message) || '';
      if (msg.toLowerCase().includes('unique')) {
        return { ok:false, reason:'exists' };
      }
      throw e;
    }
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

  try {
    const rows = db.prepare('SELECT id, username, display_name FROM users').all();
    for (const r of rows) refreshUserNormsByRow(r);
  } catch (e) {
    console.error('Norm backfill issue:', e && e.message ? e.message : e);
  }

  if (!getUserIdByName.get('Punkyroo')) {
    const hash = bcrypt.hashSync('password', 10);
    db.prepare(`
      INSERT INTO users(username, password_hash, is_admin, created_at)
      VALUES (?, ?, ?, ?)
    `).run('Punkyroo', hash, 1, nowEpoch());
  }

  const statements = {
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
    insertInvite,
    getInvite,
    redeemInvite,
    sweepExpiredInvites,
    insertDM,
    listDMsForUser,
    markAllDMsRead,
    sweepExpiredDMs,
    insertSuggestion,
    listSuggestions,
    deleteSuggestionById,
    sweepExpiredSuggestions,
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
    updateUserNorms,
    getUsersByNorm,
    listUsersBasic,
    countUsers,
    listUsersPage,
    insertNotification,
    listNotificationsForUser,
    markAllNotificationsSeen,
  };

  const helpers = {
    defSetting,
    normalizeHandle,
    refreshUserNormsByRow,
    resolveUserHandle,
    createInvite,
    validateInvite,
    makeInviteCode,
    createUser,
    verifyLogin,
  };

  return { db, statements, helpers };
}

function ensureNotificationsSchema(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      to_user_id   INTEGER NOT NULL,
      from_user_id INTEGER,
      kind         TEXT    NOT NULL,
      context      TEXT    NOT NULL,
      body         TEXT    NOT NULL,
      created_at   INTEGER NOT NULL,
      seen_at      INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_notify_to_created ON notifications (to_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notify_to_unseen  ON notifications (to_user_id, seen_at);
  `);
}

function ensureAboutColumn(db){
  try {
    const hasAbout = db.prepare("PRAGMA table_info(users)").all().some(c => c.name === 'about');
    if (!hasAbout) {
      db.exec('ALTER TABLE users ADD COLUMN about TEXT');
    }
  } catch (e) {
    console.error('Failed to add users.about column (ok if already exists):', e && e.message ? e.message : e);
  }
}

function ensureNormalizationColumns(db){
  try {
    const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
    if (!cols.includes('username_norm')) {
      db.exec('ALTER TABLE users ADD COLUMN username_norm TEXT');
    }
    if (!cols.includes('display_name_norm')) {
      db.exec('ALTER TABLE users ADD COLUMN display_name_norm TEXT');
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
}

module.exports = {
  createDatabase,
};
