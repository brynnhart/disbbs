'use strict';

const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
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

/* Status Posts */
CREATE TABLE IF NOT EXISTS status_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_status_posts_expires_at ON status_posts(expires_at);
CREATE INDEX IF NOT EXISTS idx_status_posts_created_at ON status_posts(created_at);
CREATE INDEX IF NOT EXISTS idx_status_posts_user_created ON status_posts(user_id, created_at DESC);

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

/* Links (posts & comments) */
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

/* Announcements */
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_announcements_expires_at ON announcements(expires_at);
CREATE INDEX IF NOT EXISTS idx_announcements_created_at ON announcements(created_at);

/* Polls */
CREATE TABLE IF NOT EXISTS polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  creator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  ended_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_polls_created_at ON polls(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_polls_ended_at ON polls(ended_at DESC);

CREATE TABLE IF NOT EXISTS poll_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  option_index INTEGER NOT NULL,
  option_text TEXT NOT NULL,
  UNIQUE(poll_id, option_index)
);
CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options(poll_id);

CREATE TABLE IF NOT EXISTS poll_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE(poll_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON poll_votes(poll_id);

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

CREATE TABLE IF NOT EXISTS activity_feed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_feed_created ON activity_feed(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_feed_category ON activity_feed(category, created_at DESC);
`);

  ensureNotificationsSchema(db);
  ensureAboutColumn(db);
  ensureNormalizationColumns(db);
  ensureSignupReasonColumn(db);
  ensurePixelArtSchema(db);
  ensureEmailColumn(db);
  ensurePasswordResetTokensSchema(db);
  ensureFingerprintColumns(db);
  ensureBanSchema(db);
  ensureLastSeenColumn(db);
  ensureRegistrationRejectionsSchema(db);
  ensureWordleSchema(db);
  seedWordleWords(db);
  ensureChromeSchema(db);
  ensureDonationsSchema(db);

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

  const setUserSignupReason = db.prepare('UPDATE users SET signup_reason = ? WHERE id = ?');

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
  const countUnreadDMs = db.prepare(`
    SELECT COUNT(*) AS count
      FROM dm_messages m
     WHERE m.recipient_id = ?
       AND m.read_at IS NULL
       AND (m.expires_at IS NULL OR m.expires_at > strftime('%s','now'))
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

  const insertStatusPost = db.prepare(`
    INSERT INTO status_posts (user_id, body, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `);
  const listStatusPosts = db.prepare(`
    SELECT p.id, p.body, p.created_at,
           u.username, u.display_name, u.preferred_color AS color
      FROM status_posts p
      LEFT JOIN users u ON u.id = p.user_id
     WHERE (p.expires_at IS NULL OR p.expires_at > strftime('%s','now'))
     ORDER BY p.created_at DESC
     LIMIT ?
  `);
  const listStatusPostsByUser = db.prepare(`
    SELECT p.id, p.body, p.created_at,
           u.username, u.display_name, u.preferred_color AS color
      FROM status_posts p
      LEFT JOIN users u ON u.id = p.user_id
     WHERE p.user_id = ?
       AND (p.expires_at IS NULL OR p.expires_at > strftime('%s','now'))
     ORDER BY p.created_at DESC
     LIMIT ?
  `);
  const sweepExpiredStatusPosts = db.prepare(`
    DELETE FROM status_posts WHERE expires_at IS NOT NULL AND expires_at <= strftime('%s','now')
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

  const insertAnnouncement = db.prepare(`
    INSERT INTO announcements (user_id, body, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `);
  const listAnnouncements = db.prepare(`
    SELECT a.id, a.body, a.created_at,
           u.username, u.display_name
      FROM announcements a
      LEFT JOIN users u ON u.id = a.user_id
     WHERE (a.expires_at IS NULL OR a.expires_at > strftime('%s','now'))
     ORDER BY a.created_at DESC
     LIMIT ?
  `);
  const deleteAnnouncementById = db.prepare('DELETE FROM announcements WHERE id = ?');
  const sweepExpiredAnnouncements = db.prepare(`
    DELETE FROM announcements
     WHERE expires_at IS NOT NULL AND expires_at <= strftime('%s','now')
  `);

  const insertPoll = db.prepare(`
    INSERT INTO polls (question, creator_id, created_at)
    VALUES (?, ?, ?)
  `);
  const listActivePolls = db.prepare(`
    SELECT p.id, p.question, p.creator_id, p.created_at,
           u.username, u.display_name
      FROM polls p
      LEFT JOIN users u ON u.id = p.creator_id
     WHERE p.ended_at IS NULL
     ORDER BY p.created_at DESC
  `);
  const listEndedPolls = db.prepare(`
    SELECT p.id, p.question, p.creator_id, p.created_at, p.ended_at,
           u.username, u.display_name
      FROM polls p
      LEFT JOIN users u ON u.id = p.creator_id
     WHERE p.ended_at IS NOT NULL
     ORDER BY p.ended_at DESC
     LIMIT ?
  `);
  const getPollById = db.prepare(`
    SELECT p.id, p.question, p.creator_id, p.created_at, p.ended_at, p.ended_by,
           u.username, u.display_name
      FROM polls p
      LEFT JOIN users u ON u.id = p.creator_id
     WHERE p.id = ?
  `);
  const insertPollOption = db.prepare(`
    INSERT INTO poll_options (poll_id, option_index, option_text)
    VALUES (?, ?, ?)
  `);
  const listPollOptionsWithVotes = db.prepare(`
    SELECT o.id, o.option_index, o.option_text,
           COUNT(v.id) AS votes
      FROM poll_options o
      LEFT JOIN poll_votes v ON v.option_id = o.id
     WHERE o.poll_id = ?
     GROUP BY o.id
     ORDER BY o.option_index ASC
  `);
  const getPollOptionByIndex = db.prepare(`
    SELECT o.id, o.option_index, o.option_text
      FROM poll_options o
     WHERE o.poll_id = ? AND o.option_index = ?
  `);
  const countPollVotes = db.prepare(`
    SELECT COUNT(1) AS total
      FROM poll_votes
     WHERE poll_id = ?
  `);
  const getPollVoteForUser = db.prepare(`
    SELECT id, option_id
      FROM poll_votes
     WHERE poll_id = ? AND user_id = ?
  `);
  const insertPollVote = db.prepare(`
    INSERT INTO poll_votes (poll_id, option_id, user_id, created_at)
    VALUES (?, ?, ?, ?)
  `);
  const endPollById = db.prepare(`
    UPDATE polls
       SET ended_at = ?, ended_by = ?
     WHERE id = ? AND ended_at IS NULL
  `);
  const removePollById = db.prepare(`
    DELETE FROM polls WHERE id = ?
  `);

  const sweepInactiveUsers = db.prepare(`
    DELETE FROM users
     WHERE is_admin = 0
       AND COALESCE(last_login_at, created_at) <= strftime('%s','now') - ?
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

  const insertPasswordResetToken = db.prepare(`
    INSERT INTO password_reset_tokens (username, token, created_at)
    VALUES (?, ?, ?)
  `);
  const getPasswordResetToken = db.prepare(`
    SELECT id, username, token, created_at, used_at
      FROM password_reset_tokens
     WHERE token = ?
  `);
  const markPasswordResetTokenUsed = db.prepare(`
    UPDATE password_reset_tokens
       SET used_at = ?
     WHERE token = ? AND used_at IS NULL
  `);

  const updateUserFingerprint = db.prepare(`
    UPDATE users
       SET registration_ip  = COALESCE(registration_ip, ?),
           last_login_ip    = ?,
           user_agent       = ?,
           accept_language  = ?,
           fingerprint_hash = ?
     WHERE id = ?
  `);
  const updateUserFingerprintOnRegister = db.prepare(`
    UPDATE users
       SET registration_ip  = ?,
           last_login_ip    = ?,
           user_agent       = ?,
           accept_language  = ?,
           fingerprint_hash = ?
     WHERE id = ?
  `);

  const insertBan = db.prepare(`
    INSERT INTO ban_list (created_at, banned_by, username, ip, fingerprint_hash, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const listBans = db.prepare(`
    SELECT id, created_at, banned_by, username, ip, fingerprint_hash, notes
      FROM ban_list
     ORDER BY created_at DESC
  `);
  const getBanById = db.prepare(`SELECT * FROM ban_list WHERE id = ?`);
  const deleteBanById = db.prepare(`DELETE FROM ban_list WHERE id = ?`);
  const updateBanNote = db.prepare(`UPDATE ban_list SET notes = ? WHERE id = ?`);

  const checkBanByUsername = db.prepare(`
    SELECT id FROM ban_list WHERE LOWER(username) = LOWER(?) LIMIT 1
  `);
  const checkBanByIp = db.prepare(`
    SELECT id FROM ban_list WHERE ip IS NOT NULL AND ip = ? LIMIT 1
  `);
  const checkBanByFingerprint = db.prepare(`
    SELECT id FROM ban_list WHERE fingerprint_hash IS NOT NULL AND fingerprint_hash = ? LIMIT 1
  `);

  const getLastSeenAt = db.prepare(`SELECT last_seen_at FROM users WHERE id = ?`);
  const setLastSeenAt = db.prepare(`UPDATE users SET last_seen_at = ? WHERE id = ?`);

  const countNewBoardTopics = db.prepare(`
    SELECT COUNT(1) AS n FROM board_topics
     WHERE created_at > ? AND creator_id != ?
       AND (expires_at IS NULL OR expires_at > strftime('%s','now'))
  `);
  const countNewBoardComments = db.prepare(`
    SELECT COUNT(1) AS n FROM board_comments bc
      JOIN board_topics bt ON bt.id = bc.topic_id
     WHERE bc.created_at > ? AND bc.user_id != ?
       AND (bt.expires_at IS NULL OR bt.expires_at > strftime('%s','now'))
  `);
  const countNewLinkPosts = db.prepare(`
    SELECT COUNT(1) AS n FROM news_posts
     WHERE created_at > ? AND user_id != ?
       AND (expires_at IS NULL OR expires_at > strftime('%s','now'))
  `);
  const countNewPolls = db.prepare(`
    SELECT COUNT(1) AS n FROM polls
     WHERE created_at > ? AND creator_id != ?
  `);
  const countNewVotesOnUserPolls = db.prepare(`
    SELECT COUNT(1) AS n FROM poll_votes pv
      JOIN polls p ON p.id = pv.poll_id
     WHERE pv.created_at > ? AND p.creator_id = ? AND pv.user_id != ?
  `);
  const countNewStatusPosts = db.prepare(`
    SELECT COUNT(1) AS n FROM status_posts
     WHERE created_at > ? AND user_id != ?
       AND (expires_at IS NULL OR expires_at > strftime('%s','now'))
  `);
  const countNewPixelArt = db.prepare(`
    SELECT COUNT(1) AS n FROM pixel_art
     WHERE created_at > ? AND creator_username != ?
  `);

  const listRecentUsers = db.prepare(`
    SELECT id, username, created_at, registration_ip, user_agent, email, fingerprint_hash, last_login_ip
      FROM users
     ORDER BY created_at DESC
     LIMIT ?
  `);

  const insertRegistrationRejection = db.prepare(`
    INSERT INTO registration_rejections (created_at, ip, user_agent, username) VALUES (?, ?, ?, ?)
  `);
  const listRegistrationRejections = db.prepare(`
    SELECT id, created_at, ip, user_agent, username
      FROM registration_rejections
     ORDER BY created_at DESC
     LIMIT ?
  `);

  /* Wordle */
  const wordleGetDaily        = db.prepare('SELECT word FROM wordle_daily WHERE date = ?');
  const wordleSetDaily        = db.prepare('INSERT OR IGNORE INTO wordle_daily (date, word) VALUES (?, ?)');
  const wordleGetRandomWord   = db.prepare(`
    SELECT word FROM wordle_words
     WHERE word NOT IN (SELECT word FROM wordle_daily WHERE date >= date('now', '-30 days'))
     ORDER BY RANDOM() LIMIT 1
  `);
  const wordleCheckWord       = db.prepare('SELECT 1 AS found FROM wordle_words WHERE word = ?');
  const wordleGetGuesses      = db.prepare(`
    SELECT guess, result_json, guess_num FROM wordle_guesses
     WHERE username = ? AND date = ? ORDER BY guess_num ASC
  `);
  const wordleCountGuesses    = db.prepare('SELECT COUNT(1) AS n FROM wordle_guesses WHERE username = ? AND date = ?');
  const wordleInsertGuess     = db.prepare(`
    INSERT OR IGNORE INTO wordle_guesses (username, date, guess_num, guess, result_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const wordleGetResult       = db.prepare('SELECT solved, guesses FROM wordle_results WHERE username = ? AND date = ?');
  const wordleUpsertResult    = db.prepare(`
    INSERT INTO wordle_results (username, date, solved, guesses, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(username, date) DO UPDATE SET solved = excluded.solved, guesses = excluded.guesses
  `);
  const wordleGetStreak       = db.prepare('SELECT current_streak, best_streak, last_played_date FROM wordle_streaks WHERE username = ?');
  const wordleUpsertStreak    = db.prepare(`
    INSERT INTO wordle_streaks (username, current_streak, best_streak, last_played_date) VALUES (?, ?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET
      current_streak   = excluded.current_streak,
      best_streak      = excluded.best_streak,
      last_played_date = excluded.last_played_date
  `);
  const wordleLeaderCurrent   = db.prepare(`
    SELECT username, current_streak FROM wordle_streaks
     WHERE current_streak > 0 ORDER BY current_streak DESC, username ASC LIMIT 10
  `);
  const wordleLeaderBest      = db.prepare(`
    SELECT username, best_streak FROM wordle_streaks
     WHERE best_streak > 0 ORDER BY best_streak DESC, username ASC LIMIT 10
  `);
  const wordleGetTodaySolvers = db.prepare(`
    SELECT username, guesses FROM wordle_results
     WHERE date = ? AND solved = 1 ORDER BY guesses ASC, created_at ASC LIMIT 20
  `);
  const gameFeedInsert        = db.prepare('INSERT INTO game_feed (username, event_type, message, created_at) VALUES (?, ?, ?, ?)');
  const gameFeedList          = db.prepare(`
    SELECT username, event_type, message, created_at FROM game_feed
     ORDER BY created_at DESC LIMIT ?
  `);

  /* Donations */
  const insertDonation             = db.prepare(`
    INSERT INTO donations (kofi_transaction_id, kofi_name, dis_username, amount, message, chrome_awarded, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const getDonationByTxId          = db.prepare('SELECT id FROM donations WHERE kofi_transaction_id = ?');
  const listRecentDonations        = db.prepare(`
    SELECT id, kofi_transaction_id, kofi_name, dis_username, amount, message, chrome_awarded, created_at
      FROM donations ORDER BY created_at DESC LIMIT ?
  `);
  const updateDonationAwarded      = db.prepare(`
    UPDATE donations SET dis_username = ?, chrome_awarded = ? WHERE id = ?
  `);
  const getUnlinkedDonationsByKofi = db.prepare(`
    SELECT id, amount FROM donations WHERE LOWER(kofi_name) = LOWER(?) AND dis_username IS NULL
  `);
  const insertDonationLink         = db.prepare(`
    INSERT INTO donation_links (kofi_name, dis_username, created_at) VALUES (?, ?, ?)
    ON CONFLICT(kofi_name) DO UPDATE SET dis_username = excluded.dis_username, created_at = excluded.created_at
  `);
  const getDonationLinkByKofi      = db.prepare('SELECT dis_username FROM donation_links WHERE LOWER(kofi_name) = LOWER(?)');
  const deleteDonationLink         = db.prepare('DELETE FROM donation_links WHERE LOWER(kofi_name) = LOWER(?)');
  const getMonthDonations          = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total_amount,
           COUNT(DISTINCT kofi_transaction_id) AS total_count
      FROM donations
     WHERE strftime('%Y-%m', datetime(created_at, 'unixepoch')) = strftime('%Y-%m', 'now')
  `);
  const getMonthTopDonors          = db.prepare(`
    SELECT dis_username, SUM(amount) AS total
      FROM donations
     WHERE dis_username IS NOT NULL
       AND strftime('%Y-%m', datetime(created_at, 'unixepoch')) = strftime('%Y-%m', 'now')
     GROUP BY dis_username
     ORDER BY total DESC
     LIMIT 5
  `);
  const checkUserIsDonor           = db.prepare('SELECT 1 AS found FROM donations WHERE LOWER(dis_username) = LOWER(?) LIMIT 1');

  const insertPixelArt    = db.prepare(`INSERT INTO pixel_art (name, creator_username, pixel_data, created_at) VALUES (?, ?, ?, ?)`);
  const listPixelArt      = db.prepare(`SELECT id, name, creator_username, created_at, pixel_data FROM pixel_art ORDER BY created_at DESC LIMIT 200`);
  const getPixelArtByName = db.prepare('SELECT * FROM pixel_art WHERE name = ?');
  const getPixelArtById   = db.prepare('SELECT * FROM pixel_art WHERE id = ?');
  const getPixelArtEmoji  = db.prepare('SELECT id, name, pixel_data FROM pixel_art WHERE name = LOWER(?)');
  const updatePixelArt    = db.prepare('UPDATE pixel_art SET name = ?, pixel_data = ? WHERE id = ?');
  const deletePixelArt    = db.prepare('DELETE FROM pixel_art WHERE id = ?');

  function defSetting(key, val){
    if (!getSetting.get(key)) setSetting.run(key, String(val));
  }

  // defaults
  defSetting('chat_retention_days', 7);
  defSetting('dm_retention_days', 14);
  defSetting('dm_max_len', 160);
  defSetting('suggestion_retention_days', 0);
  defSetting('suggestion_max_len', 400);
  defSetting('board_inactive_days', 0);
  defSetting('board_title_max_len', 120);
  defSetting('board_reply_max_len', 600);
  defSetting('board_list_limit', 100);
  defSetting('news_inactive_days', 0);
  defSetting('news_title_max_len', 120);
  defSetting('news_reply_max_len', 600);
  defSetting('news_list_limit', 150);
  defSetting('admin_chat_retention_days', 7);
  defSetting('announcement_retention_days', 0);
  defSetting('about_max_len', 600);
  defSetting('users_page_size', 20);
  defSetting('status_retention_days', 0);
  defSetting('status_max_len', 280);
  defSetting('status_feed_limit', 50);
  defSetting('user_inactive_days', 0);

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
    insertNotification,
    listNotificationsForUser,
    markAllNotificationsSeen,
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
    wordleCheckWord,
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
    getMonthDonations,
    getMonthTopDonors,
    checkUserIsDonor,
    insertPixelArt,
    listPixelArt,
    getPixelArtByName,
    getPixelArtById,
    getPixelArtEmoji,
    updatePixelArt,
    deletePixelArt,
    setSetting,
  };

  const helpers = {
    defSetting,
    normalizeHandle,
    refreshUserNormsByRow,
    resolveUserHandle,
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

function ensureSignupReasonColumn(db){
  try {
    const has = db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'signup_reason');
    if (!has) {
      db.exec('ALTER TABLE users ADD COLUMN signup_reason TEXT');
    }
  } catch (e) {
    console.error('Failed to add users.signup_reason column:', e && e.message ? e.message : e);
  }
}

function ensurePixelArtSchema(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS pixel_art (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT NOT NULL UNIQUE,
      creator_username TEXT NOT NULL,
      pixel_data       TEXT NOT NULL,
      created_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pixel_art_name       ON pixel_art(name);
    CREATE INDEX IF NOT EXISTS idx_pixel_art_created_at ON pixel_art(created_at DESC);
  `);
}

function ensureEmailColumn(db){
  try {
    const has = db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'email');
    if (!has) {
      db.exec('ALTER TABLE users ADD COLUMN email TEXT');
    }
  } catch (e) {
    console.error('Failed to add users.email column:', e && e.message ? e.message : e);
  }
}

function ensurePasswordResetTokensSchema(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT    NOT NULL,
      token      TEXT    NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      used_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_prt_token      ON password_reset_tokens(token);
    CREATE INDEX IF NOT EXISTS idx_prt_username   ON password_reset_tokens(username);
  `);
}

function ensureLastSeenColumn(db){
  try {
    const has = db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'last_seen_at');
    if (!has) db.exec('ALTER TABLE users ADD COLUMN last_seen_at INTEGER');
  } catch (e) {
    console.error('ensureLastSeenColumn failed:', e && e.message ? e.message : e);
  }
}

function ensureFingerprintColumns(db){
  try {
    const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
    const needed = ['registration_ip','last_login_ip','user_agent','accept_language','screen_resolution','timezone','fingerprint_hash'];
    for (const col of needed){
      if (!cols.includes(col)){
        db.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT`);
      }
    }
  } catch (e) {
    console.error('ensureFingerprintColumns failed:', e && e.message ? e.message : e);
  }
}

function ensureBanSchema(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS ban_list (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at       INTEGER NOT NULL,
      banned_by        TEXT    NOT NULL,
      username         TEXT,
      ip               TEXT,
      fingerprint_hash TEXT,
      notes            TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ban_username ON ban_list(username);
    CREATE INDEX IF NOT EXISTS idx_ban_ip       ON ban_list(ip);
    CREATE INDEX IF NOT EXISTS idx_ban_fp       ON ban_list(fingerprint_hash);

    CREATE TABLE IF NOT EXISTS ban_log (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at       INTEGER NOT NULL,
      banned_by        TEXT    NOT NULL,
      username         TEXT    NOT NULL,
      chat_msgs        INTEGER NOT NULL DEFAULT 0,
      board_topics     INTEGER NOT NULL DEFAULT 0,
      board_comments   INTEGER NOT NULL DEFAULT 0,
      link_posts       INTEGER NOT NULL DEFAULT 0,
      link_comments    INTEGER NOT NULL DEFAULT 0,
      poll_votes       INTEGER NOT NULL DEFAULT 0,
      polls_created    INTEGER NOT NULL DEFAULT 0,
      status_posts     INTEGER NOT NULL DEFAULT 0,
      dm_sent          INTEGER NOT NULL DEFAULT 0,
      pixel_art        INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function ensureRegistrationRejectionsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS registration_rejections (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      ip         TEXT,
      user_agent TEXT,
      username   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reg_rejections_created ON registration_rejections(created_at DESC);
  `);
}

function ensureWordleSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wordle_words (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      word TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS wordle_daily (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      word TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wordle_guesses (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      username    TEXT    NOT NULL,
      date        TEXT    NOT NULL,
      guess_num   INTEGER NOT NULL,
      guess       TEXT    NOT NULL,
      result_json TEXT    NOT NULL,
      created_at  INTEGER NOT NULL,
      UNIQUE(username, date, guess_num)
    );
    CREATE INDEX IF NOT EXISTS idx_wordle_guesses_udate ON wordle_guesses(username, date);

    CREATE TABLE IF NOT EXISTS wordle_results (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT    NOT NULL,
      date       TEXT    NOT NULL,
      solved     INTEGER NOT NULL DEFAULT 0,
      guesses    INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE(username, date)
    );
    CREATE INDEX IF NOT EXISTS idx_wordle_results_date ON wordle_results(date);

    CREATE TABLE IF NOT EXISTS wordle_streaks (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      username         TEXT    NOT NULL UNIQUE,
      current_streak   INTEGER NOT NULL DEFAULT 0,
      best_streak      INTEGER NOT NULL DEFAULT 0,
      last_played_date TEXT
    );

    CREATE TABLE IF NOT EXISTS game_feed (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT    NOT NULL,
      event_type TEXT    NOT NULL,
      message    TEXT    NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_game_feed_created ON game_feed(created_at DESC);
  `);
}

const WORDLE_WORD_LIST = [
  'about','abuse','acute','admit','adopt','adult','after','again','agent','agree',
  'ahead','alarm','album','alert','alike','alien','align','alive','alley','allow',
  'alone','along','altar','alter','angel','anger','angle','ankle','apart','apple',
  'apply','arena','argue','arise','armor','aroma','arose','array','aside','asset',
  'atlas','attic','audio','audit','awful',
  'baker','basic','basis','batch','beach','beard','beast','bench','bible','birth',
  'black','blade','blame','blank','blaze','bleed','blend','bless','blind','block',
  'blood','bloom','blown','bluff','board','bonus','boost','booth','botch','bound',
  'brain','brave','bread','break','breed','brick','bride','brief','bring','broad',
  'broke','brook','brown','brush','brute','buddy','build','built','bulge','bunch',
  'burnt','buyer',
  'cabin','cable','camel','candy','carry','carve','catch','cause','chalk','champ',
  'chain','chair','chaos','charm','chase','cheap','check','cheek','chess','chest',
  'child','china','choir','chose','civic','civil','claim','clamp','clasp','clash',
  'class','clean','clear','cleat','cliff','climb','cling','clock','clone','close',
  'cloth','cloud','clump','coach','coast','cobra','comet','comic','coral','count',
  'court','cover','crack','craft','cramp','crawl','crazy','cream','creek','crime',
  'crimp','crisp','cross','crowd','crown','crush','crypt','curve','cycle',
  'daily','dance','daisy','death','decay','delay','delta','depot','depth','dirty',
  'dizzy','dodge','donor','dough','doubt','draft','drain','drama','drank','drawn',
  'dream','dress','drink','drive','drove','drown','drums','dryer','dwarf','dwelt',
  'eager','eagle','early','earth','eerie','eight','elect','elite','ember','empty',
  'enjoy','enter','entry','equal','epoch','error','essay','event','evoke','exact',
  'expel','extra',
  'fable','faint','fairy','faith','false','fancy','fault','favor','feast','fence',
  'ferry','fever','fiber','field','fifth','fifty','fight','final','fired','first',
  'fixed','fjord','flare','flash','flame','fleet','flesh','flock','flood','floor',
  'fluid','flute','focus','force','forge','found','freak','fraud','fresh','front',
  'frost','frown','fruit','funny',
  'ghost','giant','given','glare','glide','gloom','glory','gloss','glove','grace',
  'grade','grain','grand','grasp','grass','grave','great','green','grief','grind',
  'groan','group','grove','grown','gruff','guard','guess','guild','guile','guise',
  'happy','harsh','haste','haunt','haven','heart','heavy','hedge','hence','herbs',
  'hinge','hippo','hoist','holly','honey','honor','horse','hotel','house','human',
  'humor','hunch','hurry',
  'ideal','image','imply','inner','irate','ivory',
  'jaunt','jewel','joker','joust','judge','juice','juicy',
  'karma','knack','knave','kneel','knife','knock','known',
  'label','lance','lapse','latch','laugh','layer','leapt','learn','leave','legal',
  'lemon','level','light','limit','linen','liner','lingo','liver','local','lodge',
  'logic','loose','loyal','lucky','lunar','lurch','lusty',
  'magic','major','manor','march','match','mayor','maxim','merit','mercy','metal',
  'might','mirth','model','money','month','moral','mount','mouse','muddy','mulch',
  'music',
  'naive','naval','nerve','night','noble','noise','north','notch','nudge','nurse',
  'nymph',
  'often','olive','onset','optic','orbit','order','other','outer','overt','owner',
  'ozone',
  'paint','panel','paper','parch','patch','pause','peace','pearl','penny','perch',
  'petty','phase','phone','photo','piano','piece','pilot','pixel','pizza','pivot',
  'place','plain','plane','plank','plant','plate','plaza','pluck','plumb','plume',
  'point','poker','polar','pouch','power','prank','prawn','press','price','pride',
  'prime','print','prism','prize','probe','proof','prove','pulse','pupil',
  'qualm','quake','queen','quell','quest','quick','quiet','quirk','quote',
  'radar','radio','raise','ranch','range','rapid','raven','reach','realm','rebel',
  'reign','relay','relic','renew','repay','resin','reset','rhyme','rider','ridge',
  'right','rigid','ripen','risky','rivet','river','roast','robot','rocky','rogue',
  'rouge','rough','rouse','round','route','rover','royal','ruddy','ruler','rusty',
  'salve','salvo','sandy','satin','sauce','savvy','scalp','scale','scare','scarf',
  'scary','scene','scope','score','scoot','scorn','scout','scrub','sense','serum',
  'serve','seven','shack','shady','shaft','shake','shame','shard','shape','share',
  'sheep','sheen','sheer','shelf','shift','shirt','short','shout','shove','shoal',
  'shrug','shunt','siege','sight','silky','siren','sixth','sixty','skill','slave',
  'sleek','sleet','sleep','slice','slide','slosh','slope','slump','small','smart',
  'smash','smear','smell','smelt','smile','smirk','smoke','smoky','snack','snail',
  'sneer','sniff','snore','snort','snout','sober','solid','solar','solve','south',
  'space','spare','spank','spark','spawn','speak','speck','speed','spend','spice',
  'spicy','spine','spill','spire','split','spoke','spoon','sport','spray','squad',
  'stage','stain','stalk','stall','stand','stark','stash','start','state','stead',
  'steam','steak','steel','steed','steep','steer','stern','stick','stiff','still',
  'stomp','stone','stool','stoop','store','storm','stout','story','stove','straw',
  'stray','strip','strum','strut','stunt','stuff','style','suave','sugar','sunny',
  'super','surge','sweet','swamp','swear','sweep','swell','swirl','swoop','sword',
  'table','tacky','taint','talon','tango','tangy','tardy','tempo','terse','theft',
  'theme','thick','thief','thing','think','third','thorn','those','threw','thump',
  'tidal','tired','title','tithe','toast','token','touch','tough','toxin','track',
  'trade','trail','train','trash','treat','trend','trial','tribe','trout','trove',
  'truck','truce','trunk','trust','truth','tulip','tuner','tunic','turbo','tutor',
  'tweak','tweed','twice','twirl','twist',
  'under','unify','union','unite','unity','until','upper','upset','urban','utter',
  'valet','valve','vapor','vaunt','vault','venom','verge','verse','video','vigor',
  'viral','virus','visor','vital','vivid','vixen','vocal','vodka','vogue','voter',
  'vouch',
  'wacky','waltz','watch','water','weary','weird','weave','wedge','wheel','where',
  'whiff','while','whirl','whisk','white','whole','wield','windy','witch','woman',
  'wonky','world','worst','worth','wound','wrath','wreak','wreck','wring','wrist',
  'write','wrong','wrote',
  'yacht','yearn','yeast','yield','young','youth',
  'zebra','zesty',
];

function ensureChromeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chrome_balances (
      username        TEXT    PRIMARY KEY,
      balance         INTEGER NOT NULL DEFAULT 0,
      last_daily_at   TEXT,
      last_stipend_at TEXT,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chrome_balances_balance ON chrome_balances(balance DESC);

    CREATE TABLE IF NOT EXISTS chrome_transactions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT    NOT NULL,
      amount     INTEGER NOT NULL,
      reason     TEXT    NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chrome_tx_username ON chrome_transactions(username, created_at DESC);

    CREATE TABLE IF NOT EXISTS slots_jackpot (
      id     INTEGER PRIMARY KEY,
      amount INTEGER NOT NULL
    );
  `);
  const jpRow = db.prepare('SELECT id FROM slots_jackpot WHERE id = 1').get();
  if (!jpRow) {
    db.prepare('INSERT INTO slots_jackpot (id, amount) VALUES (1, 500)').run();
  }
}

function ensureDonationsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS donations (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      kofi_transaction_id TEXT    NOT NULL UNIQUE,
      kofi_name           TEXT    NOT NULL,
      dis_username        TEXT,
      amount              REAL    NOT NULL,
      message             TEXT    NOT NULL DEFAULT '',
      chrome_awarded      INTEGER NOT NULL DEFAULT 0,
      created_at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_donations_kofi_name    ON donations(kofi_name);
    CREATE INDEX IF NOT EXISTS idx_donations_dis_username ON donations(dis_username);
    CREATE INDEX IF NOT EXISTS idx_donations_created_at   ON donations(created_at DESC);

    CREATE TABLE IF NOT EXISTS donation_links (
      kofi_name    TEXT    PRIMARY KEY,
      dis_username TEXT    NOT NULL,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_donation_links_dis ON donation_links(dis_username);
  `);
}

function seedWordleWords(db) {
  const count = db.prepare('SELECT COUNT(1) AS n FROM wordle_words').get().n;
  if (count > 0) return;
  const insert = db.prepare('INSERT OR IGNORE INTO wordle_words (word) VALUES (?)');
  const tx = db.transaction((words) => { for (const w of words) insert.run(w); });
  tx(WORDLE_WORD_LIST);
}

module.exports = {
  createDatabase,
};
