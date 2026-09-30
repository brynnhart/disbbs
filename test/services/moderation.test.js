const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { createDatabase, ensureModerationSchema } = require('../../src/database');
const { createModerationService, matchesUsername, likeContains } = require('../../src/services/moderation');
const { createChromeService } = require('../../src/services/chrome');

let clock = 1_700_000_000;
const nowEpoch = () => ++clock;

function setup({ chromeOverride } = {}) {
  const { db, statements, helpers } = createDatabase({ dbPath: ':memory:' });
  const addUser = (username, isAdmin = 0, extra = {}) => {
    db.prepare(`
      INSERT INTO users (username, password_hash, is_admin, created_at, registration_ip, last_login_ip, fingerprint_hash)
      VALUES (?, 'x', ?, 1, ?, ?, ?)
    `).run(username, isAdmin, extra.regIp || null, extra.loginIp || null, extra.fp || null);
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  };
  const chrome = createChromeService({ db, nowEpoch, dayKeyET: () => 'day' });
  const mod = createModerationService({
    db, nowEpoch, chrome: chromeOverride ? chromeOverride(chrome) : chrome,
    resolveUserHandle: helpers.resolveUserHandle,
  });
  return { db, addUser, mod, chrome, statements, helpers };
}

const modLog = (db) => db.prepare('SELECT actor, action, target, ref_id, detail FROM mod_log ORDER BY id').all();

test('ensureModerationSchema is safe to run repeatedly', () => {
  const file = path.join(os.tmpdir(), `dis-mod-${process.pid}-${Date.now()}.sqlite3`);
  try {
    const first = createDatabase({ dbPath: file });
    ensureModerationSchema(first.db);
    ensureModerationSchema(first.db);
    first.db.close();
    const second = createDatabase({ dbPath: file });
    const cols = second.db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
    assert.strictEqual(cols.filter(c => c === 'banned_at').length, 1);
    assert.strictEqual(cols.filter(c => c === 'banned_by').length, 1);
    const banCols = second.db.prepare('PRAGMA table_info(ban_list)').all().map(c => c.name);
    assert.ok(banCols.includes('ban_log_id'));
    const triggers = second.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all().map(r => r.name);
    assert.deepStrictEqual(triggers, ['trg_ban_list_no_admin', 'trg_users_no_ban_admin', 'trg_users_no_delete_admin']);
    assert.strictEqual(second.db.pragma('recursive_triggers', { simple: true }), 1);
    second.db.close();
  } finally {
    for (const f of [file, `${file}-wal`, `${file}-shm`]) { try { fs.unlinkSync(f); } catch {} }
  }
});

test('trigger blocks deleting an admin row but not a regular one', () => {
  const { db, addUser } = setup();
  addUser('regular');
  assert.throws(() => db.prepare("DELETE FROM users WHERE username = 'Punkyroo'").run(), /admin accounts cannot be deleted/);
  assert.ok(db.prepare("SELECT id FROM users WHERE username = 'Punkyroo'").get());
  assert.strictEqual(db.prepare("DELETE FROM users WHERE username = 'regular'").run().changes, 1);
});

test('trigger blocks a bulk delete that would include an admin, and nothing is removed', () => {
  const { db, addUser } = setup();
  addUser('regular');
  const before = db.prepare('SELECT COUNT(1) AS n FROM users').get().n;
  assert.throws(() => db.prepare('DELETE FROM users').run(), /admin accounts cannot be deleted/);
  assert.strictEqual(db.prepare('SELECT COUNT(1) AS n FROM users').get().n, before);
});

test('recursive_triggers stops INSERT OR REPLACE from removing an admin row', () => {
  const { db } = setup();
  const before = db.prepare("SELECT id FROM users WHERE username = 'Punkyroo'").get();
  assert.throws(() => db.prepare(`
    INSERT OR REPLACE INTO users (username, password_hash, is_admin, created_at) VALUES ('punkyroo', 'x', 0, 1)
  `).run(), /admin accounts cannot be deleted/);
  assert.deepStrictEqual(db.prepare("SELECT id FROM users WHERE username = 'Punkyroo'").get(), before);
});

test('inactive-user style delete of is_admin = 0 rows is unaffected by the trigger', () => {
  const { db, addUser } = setup();
  addUser('idle1'); addUser('idle2');
  const info = db.prepare('DELETE FROM users WHERE is_admin = 0').run();
  assert.strictEqual(info.changes, 2);
  assert.ok(db.prepare("SELECT id FROM users WHERE username = 'Punkyroo'").get());
});

test('trigger blocks setting banned_at on an admin row', () => {
  const { db } = setup();
  assert.throws(() => db.prepare("UPDATE users SET banned_at = 1 WHERE username = 'Punkyroo'").run(), /admin accounts cannot be banned/);
  assert.strictEqual(db.prepare("SELECT banned_at FROM users WHERE username = 'Punkyroo'").get().banned_at, null);
});

test('trigger blocks promoting a banned account to admin', () => {
  const { db, addUser } = setup();
  addUser('bad');
  db.prepare("UPDATE users SET banned_at = 1 WHERE username = 'bad'").run();
  assert.throws(() => db.prepare("UPDATE users SET is_admin = 1 WHERE username = 'bad'").run(), /admin accounts cannot be banned/);
});

test('trigger blocks ban_list rows naming an admin, in any case', () => {
  const { db } = setup();
  for (const name of ['Punkyroo', 'punkyroo', 'PUNKYROO']) {
    assert.throws(() => db.prepare("INSERT INTO ban_list (created_at, banned_by, username) VALUES (1, 'x', ?)").run(name), /admin accounts cannot be banned/);
  }
  // IP/fingerprint rows without a username are allowed; admins are exempted at login instead.
  db.prepare("INSERT INTO ban_list (created_at, banned_by, ip) VALUES (1, 'x', '1.2.3.4')").run();
});

test('isProtected and isAdminRow fail in the safe direction', () => {
  const { mod } = setup();
  assert.strictEqual(mod.isProtected(null), true);
  assert.strictEqual(mod.isProtected(undefined), true);
  assert.strictEqual(mod.isProtected({ is_admin: null }), true);
  assert.strictEqual(mod.isProtected({ is_admin: 1 }), true);
  assert.strictEqual(mod.isProtected({ is_admin: 2 }), true);
  assert.strictEqual(mod.isProtected({ is_admin: '0' }), true);
  assert.strictEqual(mod.isProtected({ is_admin: 0 }), false);
  // Exemptions need a real admin row: unknown rows are not exempt.
  assert.strictEqual(mod.isAdminRow(null), false);
  assert.strictEqual(mod.isAdminRow({ is_admin: null }), false);
  assert.strictEqual(mod.isAdminRow({ is_admin: 0 }), false);
  assert.strictEqual(mod.isAdminRow({ is_admin: 2 }), false);
  assert.strictEqual(mod.isAdminRow({ is_admin: '1' }), false);
  assert.strictEqual(mod.isAdminRow({ is_admin: 1 }), true);
});

test('connectionBanHit: admins (is_admin exactly 1) are exempt; everyone else is matched', () => {
  const { db, addUser, mod } = setup();
  const get = (n) => db.prepare('SELECT * FROM users WHERE username = ?').get(n);
  addUser('regular');
  addUser('odd', 2);
  db.prepare("INSERT INTO ban_list (created_at, banned_by, ip) VALUES (1, 'x', '10.1.1.1')").run();
  db.prepare("INSERT INTO ban_list (created_at, banned_by, fingerprint_hash) VALUES (1, 'x', 'fp-banned')").run();

  const admin = get('Punkyroo');
  assert.strictEqual(mod.connectionBanHit(admin, '10.1.1.1', null), null);
  assert.strictEqual(mod.connectionBanHit(admin, null, 'fp-banned'), null);
  assert.strictEqual(mod.connectionBanHit(admin, '10.1.1.1', 'fp-banned'), null);

  assert.strictEqual(mod.connectionBanHit(get('regular'), '10.1.1.1', null), 'ip');
  assert.strictEqual(mod.connectionBanHit(get('regular'), '10.9.9.9', 'fp-banned'), 'fingerprint');
  assert.strictEqual(mod.connectionBanHit(get('regular'), '10.9.9.9', 'fp-clean'), null);
  assert.strictEqual(mod.connectionBanHit(get('regular'), null, null), null);

  // No exemption without a real row, or for is_admin values other than 1.
  assert.strictEqual(mod.connectionBanHit(null, '10.1.1.1', null), 'ip');
  assert.strictEqual(mod.connectionBanHit(undefined, null, 'fp-banned'), 'fingerprint');
  assert.strictEqual(mod.connectionBanHit({ is_admin: '1' }, '10.1.1.1', null), 'ip');
  assert.strictEqual(mod.connectionBanHit(get('odd'), '10.1.1.1', null), 'ip');
});

test('isAccountBanned gives no admin exemption to is_admin values other than 1', () => {
  const { db, addUser, mod } = setup();
  addUser('odd', 2);
  // A legacy name row can't be inserted for a protected account (trigger), so
  // add it first and then change is_admin, as an old database might have.
  db.prepare("UPDATE users SET is_admin = 0 WHERE username = 'odd'").run();
  db.prepare("INSERT INTO ban_list (created_at, banned_by, username) VALUES (1, 'old', 'odd')").run();
  db.prepare("UPDATE users SET is_admin = 2 WHERE username = 'odd'").run();
  assert.strictEqual(mod.isAccountBanned(db.prepare("SELECT * FROM users WHERE username = 'odd'").get()), true);
});

test('banUser refuses an admin target and logs the attempt', () => {
  const { db, addUser, mod } = setup();
  addUser('admin2', 1);
  const res = mod.banUser({ actor: 'Punkyroo', username: 'admin2' });
  assert.deepStrictEqual(res, { ok: false, reason: 'protected' });
  assert.strictEqual(db.prepare('SELECT COUNT(1) AS n FROM ban_list').get().n, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(1) AS n FROM ban_log').get().n, 0);
  assert.strictEqual(db.prepare("SELECT banned_at FROM users WHERE username = 'admin2'").get().banned_at, null);
  assert.deepStrictEqual(modLog(db).map(r => [r.action, r.target, r.detail]), [['ban_refused', 'admin2', 'protected account']]);
});

test('banUser refuses a target with a non-zero is_admin value', () => {
  const { db, addUser, mod } = setup();
  addUser('odd', 2);
  assert.strictEqual(mod.banUser({ actor: 'Punkyroo', username: 'odd' }).reason, 'protected');
  assert.strictEqual(db.prepare("SELECT banned_at FROM users WHERE username = 'odd'").get().banned_at, null);
});

test('banUser refuses self, unknown users, and an empty actor', () => {
  const { db, addUser, mod } = setup();
  addUser('mod1');
  assert.strictEqual(mod.banUser({ actor: 'Punkyroo', username: 'punkyroo' }).reason, 'self');
  assert.strictEqual(mod.banUser({ actor: 'Punkyroo', username: 'nobody' }).reason, 'not_found');
  assert.strictEqual(mod.banUser({ actor: 'Punkyroo', username: '' }).reason, 'not_found');
  assert.strictEqual(mod.banUser({ actor: '', username: 'mod1' }).reason, 'no_actor');
  assert.strictEqual(db.prepare('SELECT COUNT(1) AS n FROM ban_list').get().n, 0);
});

test('banUser marks the account, keeps the row, and ties ban_list rows to one ban_log id', () => {
  const { db, addUser, mod } = setup();
  const before = addUser('victim', 0, { regIp: '10.0.0.1', loginIp: '10.0.0.2', fp: 'fp-victim' });
  const res = mod.banUser({ actor: 'Punkyroo', username: 'VICTIM' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.username, 'victim');
  assert.strictEqual(res.banRows, 2);
  assert.deepStrictEqual(res.ips, ['10.0.0.1', '10.0.0.2']);

  const row = db.prepare("SELECT * FROM users WHERE username = 'victim'").get();
  assert.strictEqual(row.id, before.id);
  assert.ok(row.banned_at > 0);
  assert.strictEqual(row.banned_by, 'Punkyroo');

  const rows = db.prepare("SELECT username, ip, fingerprint_hash, ban_log_id FROM ban_list ORDER BY id").all();
  assert.deepStrictEqual(rows, [
    { username: 'victim', ip: '10.0.0.1', fingerprint_hash: 'fp-victim', ban_log_id: res.banLogId },
    { username: 'victim', ip: '10.0.0.2', fingerprint_hash: null,        ban_log_id: res.banLogId },
  ]);
  const banLog = db.prepare('SELECT banned_by, username FROM ban_log WHERE id = ?').get(res.banLogId);
  assert.deepStrictEqual(banLog, { banned_by: 'Punkyroo', username: 'victim' });
  const log = modLog(db);
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0].action, 'ban');
  assert.strictEqual(log[0].ref_id, res.banLogId);

  assert.strictEqual(mod.banUser({ actor: 'Punkyroo', username: 'victim' }).reason, 'already_banned');
});

test('banUser reports when the banned IP or fingerprint also matches an admin', () => {
  const { db, addUser, mod } = setup();
  db.prepare("UPDATE users SET last_login_ip = '10.9.9.9', fingerprint_hash = 'shared-fp' WHERE username = 'Punkyroo'").run();
  addUser('housemate', 0, { regIp: '10.9.9.9', fp: 'shared-fp' });
  const res = mod.banUser({ actor: 'Punkyroo', username: 'housemate' });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.adminMatches, ['Punkyroo']);
});

test('banUser rolls back everything if the work inside the ban throws', () => {
  const { db, addUser, mod } = setup();
  addUser('victim', 0, { regIp: '10.0.0.1' });
  assert.throws(() => mod.banUser({ actor: 'Punkyroo', username: 'victim', withinBan: () => { throw new Error('boom'); } }), /boom/);
  assert.strictEqual(db.prepare("SELECT banned_at FROM users WHERE username = 'victim'").get().banned_at, null);
  assert.strictEqual(db.prepare('SELECT COUNT(1) AS n FROM ban_list').get().n, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(1) AS n FROM ban_log').get().n, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(1) AS n FROM mod_log').get().n, 0);
});

test('isAccountBanned: marker, legacy ban_list username rows, and admin exemption', () => {
  const { db, addUser, mod } = setup();
  const get = (n) => db.prepare('SELECT * FROM users WHERE username = ?').get(n);
  addUser('clean'); addUser('marked'); addUser('legacy'); addUser('promoted');
  mod.banUser({ actor: 'Punkyroo', username: 'marked' });
  db.prepare("INSERT INTO ban_list (created_at, banned_by, username) VALUES (1, 'old', 'Legacy')").run();
  // A legacy name row from before this user was made an admin.
  db.prepare("INSERT INTO ban_list (created_at, banned_by, username) VALUES (1, 'old', 'promoted')").run();
  db.prepare("UPDATE users SET is_admin = 1 WHERE username = 'promoted'").run();

  assert.strictEqual(mod.isAccountBanned(get('clean')), false);
  assert.strictEqual(mod.isAccountBanned(get('marked')), true);
  assert.strictEqual(mod.isAccountBanned(get('legacy')), true);
  assert.strictEqual(mod.isAccountBanned(get('promoted')), false);
  assert.strictEqual(mod.isAccountBanned(get('Punkyroo')), false);
  assert.strictEqual(mod.isAccountBanned(null), false);
});

test('listLog returns newest first and filters by target', () => {
  const { mod } = setup();
  mod.log('Punkyroo', 'ban_note', 'alice', 3, 'first');
  mod.log('Punkyroo', 'purge_activity', 'bob', null, { rows: 2 });
  mod.log('Punkyroo', 'ban_note', 'ALICE', 3, 'second');
  assert.deepStrictEqual(mod.listLog({ limit: 10 }).map(r => r.detail), ['second', '{"rows":2}', 'first']);
  assert.deepStrictEqual(mod.listLog({ target: 'alice' }).map(r => r.detail), ['second', 'first']);
});

/* ---------------- Stage 3: purge, forfeiture, feed matching ---------------- */

const count = (db, sql, ...p) => db.prepare(sql).get(...p).n;

// Target "al" and bystander "alice": every feed row mentioning "alice" must
// survive a purge of "al".
function seedWorld(db, chrome, addUser) {
  const al = addUser('al', 0, { regIp: '10.0.0.1', fp: 'fp-al' });
  const alice = addUser('alice');
  const ins = (sql, ...p) => Number(db.prepare(sql).run(...p).lastInsertRowid);

  ins('INSERT INTO messages (user_id, body, created_at) VALUES (?, ?, 1)', al.id, 'hi');
  ins('INSERT INTO messages (user_id, body, created_at) VALUES (?, ?, 1)', al.id, 'spam');
  ins('INSERT INTO messages (user_id, body, created_at) VALUES (?, ?, 1)', alice.id, 'hello');

  const t1 = ins('INSERT INTO board_topics (title, creator_id, created_at, last_commented_at) VALUES (?, ?, 1, 1)', 'al topic', al.id);
  const t2 = ins('INSERT INTO board_topics (title, creator_id, created_at, last_commented_at) VALUES (?, ?, 1, 1)', 'alice topic', alice.id);
  ins('INSERT INTO board_comments (topic_id, user_id, body, created_at) VALUES (?, ?, ?, 1)', t1, al.id, 'own');
  ins('INSERT INTO board_comments (topic_id, user_id, body, created_at) VALUES (?, ?, ?, 1)', t1, alice.id, 'reply 1');
  ins('INSERT INTO board_comments (topic_id, user_id, body, created_at) VALUES (?, ?, ?, 1)', t1, alice.id, 'reply 2');
  ins('INSERT INTO board_comments (topic_id, user_id, body, created_at) VALUES (?, ?, ?, 1)', t2, al.id, 'al on alice topic');
  ins('INSERT INTO board_comments (topic_id, user_id, body, created_at) VALUES (?, ?, ?, 1)', t2, alice.id, 'alice on own topic');

  const p1 = ins("INSERT INTO news_posts (title, url, tag, user_id, created_at, last_commented_at) VALUES ('l', 'u', 't', ?, 1, 1)", al.id);
  ins('INSERT INTO news_comments (post_id, user_id, body, created_at) VALUES (?, ?, ?, 1)', p1, al.id, 'own');
  ins('INSERT INTO news_comments (post_id, user_id, body, created_at) VALUES (?, ?, ?, 1)', p1, alice.id, 'reply');

  const poll1 = ins('INSERT INTO polls (question, creator_id, created_at) VALUES (?, ?, 1)', 'al poll', al.id);
  const opt1 = ins("INSERT INTO poll_options (poll_id, option_index, option_text) VALUES (?, 1, 'a')", poll1);
  const poll2 = ins('INSERT INTO polls (question, creator_id, created_at) VALUES (?, ?, 1)', 'alice poll', alice.id);
  const opt2 = ins("INSERT INTO poll_options (poll_id, option_index, option_text) VALUES (?, 1, 'a')", poll2);
  ins('INSERT INTO poll_votes (poll_id, option_id, user_id, created_at) VALUES (?, ?, ?, 1)', poll1, opt1, alice.id);
  ins('INSERT INTO poll_votes (poll_id, option_id, user_id, created_at) VALUES (?, ?, ?, 1)', poll2, opt2, al.id);

  ins('INSERT INTO status_posts (user_id, body, created_at) VALUES (?, ?, 1)', al.id, 'status');
  ins('INSERT INTO status_posts (user_id, body, created_at) VALUES (?, ?, 1)', alice.id, 'status');
  ins('INSERT INTO dm_messages (sender_id, recipient_id, body, created_at) VALUES (?, ?, ?, 1)', al.id, alice.id, 'sent by al');
  ins('INSERT INTO dm_messages (sender_id, recipient_id, body, created_at) VALUES (?, ?, ?, 1)', alice.id, al.id, 'sent to al');
  ins("INSERT INTO pixel_art (name, creator_username, pixel_data, created_at) VALUES ('a1', 'al', '[]', 1)");
  ins("INSERT INTO pixel_art (name, creator_username, pixel_data, created_at) VALUES ('a2', 'alice', '[]', 1)");
  ins("INSERT INTO notifications (to_user_id, from_user_id, kind, context, body, created_at) VALUES (?, ?, 'mention', 'chat', 'x', 1)", al.id, alice.id);
  ins("INSERT INTO notifications (to_user_id, from_user_id, kind, context, body, created_at) VALUES (?, ?, 'mention', 'chat', 'x', 1)", alice.id, al.id);
  ins("INSERT INTO notifications (to_user_id, from_user_id, kind, context, body, created_at) VALUES (?, ?, 'mention', 'chat', 'x', 1)", alice.id, alice.id);

  for (const m of ['📋 al started a new topic: hi', '💥 alice robbed al.', '📋 alice started a new topic: al_x', '🏆 alice just took the #1 spot', '🎛 alice designed x.al']) {
    ins("INSERT INTO activity_feed (category, event_type, message, created_at) VALUES ('c', 'e', ?, 1)", m);
  }
  ins("INSERT INTO game_feed (username, event_type, message, created_at) VALUES ('al', 'e', 'won a hand', 1)");
  ins("INSERT INTO game_feed (username, event_type, message, created_at) VALUES ('alice', 'e', 'alice beat al at blackjack', 1)");
  ins("INSERT INTO game_feed (username, event_type, message, created_at) VALUES ('alice', 'e', 'alice solved wordle', 1)");

  ins("INSERT INTO graffiti_wall (cell_index, color, painted_by, painted_at) VALUES (1, '#f00', 'al', 1)");
  ins("INSERT INTO graffiti_wall (cell_index, color, painted_by, painted_at) VALUES (2, '#0f0', 'alice', 1)");
  ins("INSERT INTO graffiti_activity (username, last_logged) VALUES ('al', 1)");
  ins("INSERT INTO graffiti_activity (username, last_logged) VALUES ('alice', 1)");

  const game = ins('INSERT INTO dots_game (started_at, ends_at) VALUES (1, 2)');
  ins("INSERT INTO dots_lines (game_id, line_idx, drawn_by, drawn_at) VALUES (?, 1, 'al', 1)", game);
  ins("INSERT INTO dots_turns (game_id, username, last_drew_at) VALUES (?, 'al', 1)", game);
  ins("INSERT INTO resource_balances (username, resource, amount) VALUES ('al', 'iron', 5)");

  chrome.award('al', 100, 'welcome bonus');
  chrome.award('alice', 50, 'welcome bonus');
  return { al, alice };
}

const purgeHook = (mod, actor) => (row, banLogId) => mod.purgeWithinBan(actor, row, banLogId);

test('matchesUsername is whole-word and case-insensitive', () => {
  assert.strictEqual(matchesUsername('📋 al started a topic', 'al'), true);
  assert.strictEqual(matchesUsername('robbed AL.', 'al'), true);
  assert.strictEqual(matchesUsername('(al)', 'al'), true);
  assert.strictEqual(matchesUsername("al's topic", 'al'), true);
  assert.strictEqual(matchesUsername('alice started a topic', 'al'), false);
  assert.strictEqual(matchesUsername('hal did a thing', 'al'), false);
  assert.strictEqual(matchesUsername('al_x did a thing', 'al'), false);
  assert.strictEqual(matchesUsername('al-x did a thing', 'al'), false);
  assert.strictEqual(matchesUsername('x.al did a thing', 'al'), false);
  assert.strictEqual(matchesUsername('al.x did a thing', 'al'), false);
  assert.strictEqual(matchesUsername('a.b won', 'a.b'), true);
  assert.strictEqual(matchesUsername('axb won', 'a.b'), false);
  assert.strictEqual(likeContains('a_b%c\\d'), '%a\\_b\\%c\\\\d%');
});

test('deleteFeedRowsFor: "al" does not touch alice rows, and "_" is not a wildcard', () => {
  const { db, mod } = setup();
  const add = (m) => db.prepare("INSERT INTO activity_feed (category, event_type, message, created_at) VALUES ('c', 'e', ?, 1)").run(m);
  add('alice joined'); add('al joined'); add('axb joined'); add('a_b joined');
  assert.deepStrictEqual(mod.deleteFeedRowsFor('al'), { activity: 1, game: 0 });
  assert.deepStrictEqual(mod.deleteFeedRowsFor('a_b'), { activity: 1, game: 0 });
  assert.deepStrictEqual(db.prepare('SELECT message FROM activity_feed ORDER BY id').all().map(r => r.message), ['alice joined', 'axb joined']);
});

test('ban with purge: exact scope, cascade counts, chrome forfeited, account row kept', () => {
  const { db, addUser, mod, chrome } = setup();
  const { al } = seedWorld(db, chrome, addUser);

  const res = mod.banUser({ actor: 'Punkyroo', username: 'al', withinBan: purgeHook(mod, 'Punkyroo') });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.extra.counts, {
    chat_msgs: 2, board_comments: 2, board_topics: 1, link_comments: 1, link_posts: 1,
    poll_votes: 1, polls_created: 1, status_posts: 1, dm_sent: 1, pixel_art: 1,
    notifications: 2, activity_feed: 2, game_feed: 2, graffiti_cells: 1, graffiti_log: 1,
  });
  assert.deepStrictEqual(res.extra.cascade, { board_replies: 2, link_comments: 1, poll_votes: 1 });
  assert.strictEqual(res.extra.chromeForfeited, 100);

  // Account row kept and marked.
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(al.id);
  assert.ok(row && row.banned_at > 0);

  // Alice's own content survives; only the cascade took her replies/vote.
  assert.strictEqual(count(db, 'SELECT COUNT(1) n FROM messages'), 1);
  assert.deepStrictEqual(db.prepare('SELECT title FROM board_topics').all(), [{ title: 'alice topic' }]);
  assert.deepStrictEqual(db.prepare('SELECT body FROM board_comments').all(), [{ body: 'alice on own topic' }]);
  assert.strictEqual(count(db, 'SELECT COUNT(1) n FROM news_posts'), 0);
  assert.deepStrictEqual(db.prepare('SELECT question FROM polls').all(), [{ question: 'alice poll' }]);
  assert.strictEqual(count(db, 'SELECT COUNT(1) n FROM poll_votes'), 0);
  assert.strictEqual(count(db, 'SELECT COUNT(1) n FROM status_posts'), 1);
  assert.deepStrictEqual(db.prepare('SELECT body FROM dm_messages').all(), [{ body: 'sent to al' }]);
  assert.deepStrictEqual(db.prepare('SELECT creator_username c FROM pixel_art').all(), [{ c: 'alice' }]);
  assert.strictEqual(count(db, 'SELECT COUNT(1) n FROM notifications'), 1);
  assert.deepStrictEqual(db.prepare('SELECT message FROM activity_feed ORDER BY id').all().map(r => r.message),
    ['📋 alice started a new topic: al_x', '🏆 alice just took the #1 spot', '🎛 alice designed x.al']);
  assert.deepStrictEqual(db.prepare('SELECT message FROM game_feed').all(), [{ message: 'alice solved wordle' }]);
  assert.deepStrictEqual(db.prepare('SELECT painted_by FROM graffiti_wall').all(), [{ painted_by: 'alice' }]);
  assert.deepStrictEqual(db.prepare('SELECT username FROM graffiti_activity').all(), [{ username: 'alice' }]);

  // Deliberately untouched: dots and minerals.
  assert.strictEqual(count(db, "SELECT COUNT(1) n FROM dots_lines WHERE drawn_by = 'al'"), 1);
  assert.strictEqual(count(db, "SELECT COUNT(1) n FROM dots_turns WHERE username = 'al'"), 1);
  assert.strictEqual(count(db, "SELECT COUNT(1) n FROM resource_balances WHERE username = 'al'"), 1);

  // Chrome: balance 0, and the ledger keeps both rows.
  assert.strictEqual(chrome.getBalance('al'), 0);
  assert.deepStrictEqual(db.prepare("SELECT amount, reason FROM chrome_transactions WHERE username = 'al' ORDER BY id").all(),
    [{ amount: 100, reason: 'welcome bonus' }, { amount: -100, reason: 'ban forfeiture' }]);
  assert.strictEqual(chrome.getBalance('alice'), 50);

  // ban_log carries the counts; mod_log has the ban then the purge.
  const bl = db.prepare('SELECT * FROM ban_log WHERE id = ?').get(res.banLogId);
  assert.strictEqual(bl.chat_msgs, 2);
  assert.strictEqual(bl.board_topics, 1);
  assert.strictEqual(bl.pixel_art, 1);
  assert.deepStrictEqual(db.prepare('SELECT action, ref_id FROM mod_log ORDER BY id').all(),
    [{ action: 'ban', ref_id: res.banLogId }, { action: 'purge_content', ref_id: res.banLogId }]);
});

test('ban with keep: account banned, all content and chrome left in place', () => {
  const { db, addUser, mod, chrome } = setup();
  const { al } = seedWorld(db, chrome, addUser);
  const res = mod.banUser({ actor: 'Punkyroo', username: 'al' });
  assert.strictEqual(res.ok, true);
  assert.ok(db.prepare('SELECT banned_at FROM users WHERE id = ?').get(al.id).banned_at > 0);
  assert.strictEqual(count(db, 'SELECT COUNT(1) n FROM messages WHERE user_id = ?', al.id), 2);
  assert.strictEqual(count(db, 'SELECT COUNT(1) n FROM board_topics WHERE creator_id = ?', al.id), 1);
  assert.strictEqual(count(db, 'SELECT COUNT(1) n FROM activity_feed'), 5);
  assert.strictEqual(chrome.getBalance('al'), 100);
  assert.strictEqual(count(db, "SELECT COUNT(1) n FROM chrome_transactions WHERE username = 'al'"), 1);
  const bl = db.prepare('SELECT chat_msgs, board_topics FROM ban_log WHERE id = ?').get(res.banLogId);
  assert.deepStrictEqual(bl, { chat_msgs: 0, board_topics: 0 });
  assert.deepStrictEqual(db.prepare('SELECT action FROM mod_log').all().map(r => r.action), ['ban']);
});

test('purgeUserContent on its own: content gone, account kept and not banned, admin forfeiture reason', () => {
  const { db, addUser, mod, chrome } = setup();
  const { al } = seedWorld(db, chrome, addUser);
  const res = mod.purgeUserContent('Punkyroo', al);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.counts.chat_msgs, 2);
  assert.strictEqual(res.chromeForfeited, 100);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(al.id);
  assert.ok(row);
  assert.strictEqual(row.banned_at, null);
  assert.deepStrictEqual(db.prepare("SELECT reason FROM chrome_transactions WHERE username = 'al' ORDER BY id").all().map(r => r.reason),
    ['welcome bonus', 'admin forfeiture']);
  assert.deepStrictEqual(db.prepare('SELECT action, target FROM mod_log').all(), [{ action: 'purge_content', target: 'al' }]);
});

test('admin targets are refused by /ban-with-purge, purgeUserContent and forfeitChrome; nothing changes', () => {
  const { db, addUser, mod, chrome } = setup();
  const admin2 = addUser('admin2', 1);
  db.prepare('INSERT INTO messages (user_id, body, created_at) VALUES (?, ?, 1)').run(admin2.id, 'admin msg');
  db.prepare("INSERT INTO activity_feed (category, event_type, message, created_at) VALUES ('c', 'e', 'admin2 posted', 1)").run();
  chrome.award('admin2', 70, 'welcome bonus');

  assert.strictEqual(mod.banUser({ actor: 'Punkyroo', username: 'admin2', withinBan: purgeHook(mod, 'Punkyroo') }).reason, 'protected');
  assert.strictEqual(mod.purgeUserContent('Punkyroo', admin2).reason, 'protected');
  assert.strictEqual(mod.forfeitChrome('Punkyroo', admin2).reason, 'protected');
  // A stale row claiming is_admin 0 is re-read inside the transaction and still refused.
  assert.strictEqual(mod.purgeUserContent('Punkyroo', Object.assign({}, admin2, { is_admin: 0 })).reason, 'protected');
  assert.strictEqual(mod.forfeitChrome('Punkyroo', Object.assign({}, admin2, { is_admin: 0 })).reason, 'protected');
  // Directly calling the ban hook on an admin row refuses too.
  assert.throws(() => mod.purgeWithinBan('Punkyroo', admin2, 1), /refused: protected/);
  assert.strictEqual(mod.purgeUserContent('Punkyroo', null).reason, 'not_found');

  assert.strictEqual(count(db, 'SELECT COUNT(1) n FROM messages WHERE user_id = ?', admin2.id), 1);
  assert.strictEqual(count(db, 'SELECT COUNT(1) n FROM activity_feed'), 1);
  assert.strictEqual(chrome.getBalance('admin2'), 70);
  assert.strictEqual(db.prepare("SELECT banned_at FROM users WHERE username = 'admin2'").get().banned_at, null);
  assert.deepStrictEqual(db.prepare('SELECT action FROM mod_log ORDER BY id').all().map(r => r.action),
    ['ban_refused', 'purge_refused', 'purge_chrome_refused', 'purge_refused', 'purge_chrome_refused']);
});

test('refusals for already-banned, unknown and self are logged with a reason', () => {
  const { db, addUser, mod } = setup();
  addUser('victim');
  assert.strictEqual(mod.banUser({ actor: 'Punkyroo', username: 'victim' }).ok, true);
  assert.strictEqual(mod.banUser({ actor: 'Punkyroo', username: 'victim' }).reason, 'already_banned');
  assert.strictEqual(mod.banUser({ actor: 'Punkyroo', username: 'ghost' }).reason, 'not_found');
  assert.strictEqual(mod.banUser({ actor: 'Punkyroo', username: 'Punkyroo' }).reason, 'self');
  assert.deepStrictEqual(db.prepare("SELECT action, target, detail FROM mod_log WHERE action = 'ban_refused' ORDER BY id").all(), [
    { action: 'ban_refused', target: 'victim', detail: 'already banned' },
    { action: 'ban_refused', target: 'ghost', detail: 'not found' },
    { action: 'ban_refused', target: 'Punkyroo', detail: 'self' },
  ]);
});

function assertUntouched(db, chrome, al) {
  assert.strictEqual(db.prepare('SELECT banned_at FROM users WHERE id = ?').get(al.id).banned_at, null);
  assert.strictEqual(count(db, 'SELECT COUNT(1) n FROM ban_list'), 0);
  assert.strictEqual(count(db, 'SELECT COUNT(1) n FROM ban_log'), 0);
  assert.strictEqual(count(db, 'SELECT COUNT(1) n FROM mod_log'), 0);
  assert.strictEqual(count(db, 'SELECT COUNT(1) n FROM messages WHERE user_id = ?', al.id), 2);
  assert.strictEqual(count(db, 'SELECT COUNT(1) n FROM board_topics WHERE creator_id = ?', al.id), 1);
  assert.strictEqual(count(db, "SELECT COUNT(1) n FROM board_comments WHERE body LIKE 'reply%'"), 2);
  assert.strictEqual(count(db, 'SELECT COUNT(1) n FROM activity_feed'), 5);
  assert.strictEqual(chrome.getBalance('al'), 100);
  assert.deepStrictEqual(db.prepare("SELECT amount FROM chrome_transactions WHERE username = 'al'").all(), [{ amount: 100 }]);
}

test('a purge failing partway (a table delete throws) rolls back the whole ban', () => {
  const { db, addUser, mod, chrome } = setup();
  const { al } = seedWorld(db, chrome, addUser);
  // graffiti_activity is purged late, after most content deletes have run.
  db.exec('DROP TABLE graffiti_activity');
  assert.throws(() => mod.banUser({ actor: 'Punkyroo', username: 'al', withinBan: purgeHook(mod, 'Punkyroo') }), /graffiti_activity/);
  assertUntouched(db, chrome, al);
});

test('a failure after the chrome spend rolls the chrome back too (same transaction)', () => {
  const { db, addUser, mod, chrome } = setup({
    chromeOverride: (real) => ({
      getBalance: real.getBalance,
      spend: (...a) => { real.spend(...a); throw new Error('failed after spend'); },
    }),
  });
  const { al } = seedWorld(db, chrome, addUser);
  assert.throws(() => mod.banUser({ actor: 'Punkyroo', username: 'al', withinBan: purgeHook(mod, 'Punkyroo') }), /failed after spend/);
  assertUntouched(db, chrome, al);
});

test('forfeitChrome: spends through the service, zero balance is a no-op', () => {
  const { db, addUser, mod, chrome } = setup();
  const rich = addUser('rich');
  const poor = addUser('poor');
  chrome.award('rich', 40, 'welcome bonus');
  const r1 = mod.forfeitChrome('Punkyroo', rich);
  assert.deepStrictEqual([r1.ok, r1.amount, r1.reason], [true, 40, 'admin forfeiture']);
  assert.strictEqual(chrome.getBalance('rich'), 0);
  assert.deepStrictEqual(db.prepare("SELECT amount, reason FROM chrome_transactions WHERE username = 'rich' ORDER BY id").all(),
    [{ amount: 40, reason: 'welcome bonus' }, { amount: -40, reason: 'admin forfeiture' }]);
  const r2 = mod.forfeitChrome('Punkyroo', poor);
  assert.deepStrictEqual([r2.ok, r2.amount], [true, 0]);
  assert.strictEqual(count(db, "SELECT COUNT(1) n FROM chrome_transactions WHERE username = 'poor'"), 0);
  // A banned account's forfeiture is labelled as such.
  mod.banUser({ actor: 'Punkyroo', username: 'poor' });
  chrome.award('poor', 5, 'test');
  assert.strictEqual(mod.forfeitChrome('Punkyroo', db.prepare("SELECT * FROM users WHERE username = 'poor'").get()).reason, 'ban forfeiture');
});

/* ---------------- Stage 4: unban, notes, purgeactivity, visibility ---------------- */

const userRow = (db, name) => db.prepare('SELECT * FROM users WHERE username = ?').get(name);
const banRows = (db, name) => db.prepare('SELECT id, ip, ban_log_id FROM ban_list WHERE username = ? COLLATE NOCASE ORDER BY id').all(name);
const lastLog = (db) => db.prepare('SELECT actor, action, target, ref_id, detail FROM mod_log ORDER BY id DESC LIMIT 1').get();
const insertLegacyRow = (db, username, createdAt, bannedBy, ip) =>
  Number(db.prepare('INSERT INTO ban_list (created_at, banned_by, username, ip) VALUES (?, ?, ?, ?)').run(createdAt, bannedBy, username, ip).lastInsertRowid);

test('unban <username>: removes every row of the ban together, clears banned_at, reports forfeited chrome', () => {
  const { db, addUser, mod, chrome } = setup();
  addUser('victim', 0, { regIp: '10.0.0.1', loginIp: '10.0.0.2', fp: 'fp-v' });
  chrome.award('victim', 30, 'welcome bonus');
  const ban = mod.banUser({ actor: 'Punkyroo', username: 'victim', withinBan: purgeHook(mod, 'Punkyroo') });
  assert.strictEqual(banRows(db, 'victim').length, 2);

  const res = mod.unban({ actor: 'Punkyroo', ref: 'VICTIM' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.username, 'victim');
  assert.strictEqual(res.rowsRemoved, 2);
  assert.strictEqual(res.account, true);
  assert.strictEqual(res.cleared, true);
  assert.strictEqual(res.stillBlocked, false);
  assert.deepStrictEqual(res.banLogIds, [ban.banLogId]);
  assert.strictEqual(res.chromeForfeited, 30);

  assert.strictEqual(banRows(db, 'victim').length, 0);
  const row = userRow(db, 'victim');
  assert.strictEqual(row.banned_at, null);
  assert.strictEqual(row.banned_by, null);
  assert.strictEqual(mod.isAccountBanned(row), false);
  // Chrome is reported, not restored.
  assert.strictEqual(chrome.getBalance('victim'), 0);

  const log = lastLog(db);
  assert.strictEqual(log.action, 'unban');
  assert.strictEqual(log.target, 'victim');
  assert.strictEqual(log.ref_id, ban.banLogId);
  assert.deepStrictEqual(JSON.parse(log.detail), {
    ref: 'VICTIM', rows_removed: 2, account: true, cleared: true, still_blocked: false,
    ban_log_ids: [ban.banLogId], chrome_forfeited: 30,
  });
});

test('unban after a keep ban reports 0 chrome forfeited', () => {
  const { addUser, mod } = setup();
  addUser('kept');
  mod.banUser({ actor: 'Punkyroo', username: 'kept' });
  assert.strictEqual(mod.unban({ actor: 'Punkyroo', ref: 'kept' }).chromeForfeited, 0);
});

test('unban #<id>: any row of a linked ban removes the whole group', () => {
  const { db, addUser, mod } = setup();
  addUser('victim', 0, { regIp: '10.0.0.1', loginIp: '10.0.0.2' });
  mod.banUser({ actor: 'Punkyroo', username: 'victim' });
  const rows = banRows(db, 'victim');
  const res = mod.unban({ actor: 'Punkyroo', ref: `#${rows[1].id}` });
  assert.strictEqual(res.rowsRemoved, 2);
  assert.strictEqual(res.cleared, true);
  assert.strictEqual(banRows(db, 'victim').length, 0);
  assert.strictEqual(userRow(db, 'victim').banned_at, null);
});

test('legacy ban with no account row: grouped by username + created_at + banned_by', () => {
  const { db, mod } = setup();
  const a = insertLegacyRow(db, 'ghost', 500, 'oldadmin', '1.1.1.1');
  insertLegacyRow(db, 'ghost', 500, 'oldadmin', '2.2.2.2');
  const older = insertLegacyRow(db, 'ghost', 400, 'oldadmin', '3.3.3.3');
  insertLegacyRow(db, 'someoneelse', 500, 'oldadmin', '4.4.4.4');

  const res = mod.unban({ actor: 'Punkyroo', ref: `#${a}` });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.rowsRemoved, 2);
  assert.strictEqual(res.account, false);
  assert.strictEqual(res.chromeForfeited, null);
  assert.deepStrictEqual(banRows(db, 'ghost').map(r => r.id), [older]);
  assert.strictEqual(banRows(db, 'someoneelse').length, 1);

  const rest = mod.unban({ actor: 'Punkyroo', ref: 'Ghost' });
  assert.strictEqual(rest.rowsRemoved, 1);
  assert.strictEqual(rest.username, 'ghost');
  assert.strictEqual(banRows(db, 'ghost').length, 0);
});

test('legacy ban on an existing account (no banned_at) is lifted by timestamp group', () => {
  const { db, addUser, mod } = setup();
  addUser('oldtimer');
  const a = insertLegacyRow(db, 'oldtimer', 700, 'oldadmin', '5.5.5.5');
  insertLegacyRow(db, 'oldtimer', 700, 'oldadmin', '6.6.6.6');
  assert.strictEqual(mod.isAccountBanned(userRow(db, 'oldtimer')), true);
  const res = mod.unban({ actor: 'Punkyroo', ref: `#${a}` });
  assert.strictEqual(res.rowsRemoved, 2);
  assert.strictEqual(res.account, true);
  assert.strictEqual(res.stillBlocked, false);
  assert.strictEqual(mod.isAccountBanned(userRow(db, 'oldtimer')), false);
});

test('unban #<id> of one ban leaves the account marked while another ban entry for the name remains', () => {
  const { db, addUser, mod } = setup();
  addUser('twice', 0, { regIp: '10.0.0.9' });
  insertLegacyRow(db, 'twice', 100, 'oldadmin', '7.7.7.7');
  mod.banUser({ actor: 'Punkyroo', username: 'twice' });
  const linked = banRows(db, 'twice').find(r => r.ban_log_id != null);
  const res = mod.unban({ actor: 'Punkyroo', ref: `#${linked.id}` });
  assert.strictEqual(res.rowsRemoved, 1);
  assert.strictEqual(res.cleared, false);
  assert.strictEqual(res.stillBlocked, true);
  assert.ok(userRow(db, 'twice').banned_at > 0);
  const all = mod.unban({ actor: 'Punkyroo', ref: 'twice' });
  assert.strictEqual(all.cleared, true);
  assert.strictEqual(all.stillBlocked, false);
});

test('unban refusals are logged; admin rows are never touched', () => {
  const { db, addUser, mod } = setup();
  addUser('clean');
  const admin2 = addUser('admin2');
  // Legacy name row from before admin2 was promoted.
  insertLegacyRow(db, 'admin2', 900, 'oldadmin', '8.8.8.8');
  db.prepare("UPDATE users SET is_admin = 1 WHERE username = 'admin2'").run();
  const adminBefore = userRow(db, 'admin2');

  assert.strictEqual(mod.unban({ actor: 'Punkyroo', ref: 'nobody' }).reason, 'not_found');
  assert.strictEqual(mod.unban({ actor: 'Punkyroo', ref: '#999' }).reason, 'not_found');
  assert.strictEqual(mod.unban({ actor: 'Punkyroo', ref: 'clean' }).reason, 'not_banned');
  assert.strictEqual(mod.unban({ actor: 'Punkyroo', ref: 'Punkyroo' }).reason, 'not_banned');
  assert.deepStrictEqual(db.prepare("SELECT target, detail FROM mod_log WHERE action = 'unban_refused' ORDER BY id").all(), [
    { target: 'nobody', detail: 'not found' },
    { target: '#999', detail: 'not found' },
    { target: 'clean', detail: 'not banned' },
    { target: 'Punkyroo', detail: 'not banned' },
  ]);

  // Cleaning up the stale entry removes the ban_list row but leaves the admin row as it was.
  const res = mod.unban({ actor: 'Punkyroo', ref: 'admin2' });
  assert.strictEqual(res.rowsRemoved, 1);
  assert.strictEqual(res.cleared, false);
  assert.deepStrictEqual(userRow(db, 'admin2'), adminBefore);
  assert.strictEqual(admin2.id, adminBefore.id);
});

test('unban rolls back completely if the audit write fails', () => {
  const { db, addUser, mod } = setup();
  addUser('victim', 0, { regIp: '10.0.0.1', loginIp: '10.0.0.2' });
  mod.banUser({ actor: 'Punkyroo', username: 'victim' });
  db.exec('DROP TABLE mod_log');
  assert.throws(() => mod.unban({ actor: 'Punkyroo', ref: 'victim' }), /mod_log/);
  assert.strictEqual(banRows(db, 'victim').length, 2);
  assert.ok(userRow(db, 'victim').banned_at > 0);
});

test('setBanNote updates the entry and logs the note text; unknown ids are refused and logged', () => {
  const { db, addUser, mod } = setup();
  addUser('victim', 0, { regIp: '10.0.0.1' });
  const ban = mod.banUser({ actor: 'Punkyroo', username: 'victim' });
  const id = banRows(db, 'victim')[0].id;
  assert.strictEqual(mod.setBanNote('Punkyroo', id, 'spam wave, see adminchat').ok, true);
  assert.strictEqual(db.prepare('SELECT notes FROM ban_list WHERE id = ?').get(id).notes, 'spam wave, see adminchat');
  const log = lastLog(db);
  assert.deepStrictEqual([log.action, log.target, log.ref_id], ['ban_note', 'victim', ban.banLogId]);
  assert.deepStrictEqual(JSON.parse(log.detail), { ban_list_id: id, note: 'spam wave, see adminchat' });
  assert.strictEqual(mod.setBanNote('Punkyroo', 999, 'x').reason, 'not_found');
  assert.deepStrictEqual([lastLog(db).action, lastLog(db).target], ['ban_note_refused', '#999']);
});

test('purgeActivityFor: whole-word, refuses admins and unknown names, allows old banned names', () => {
  const { db, addUser, mod } = setup();
  addUser('al'); addUser('alice'); addUser('admin2', 1);
  const add = (m) => db.prepare("INSERT INTO activity_feed (category, event_type, message, created_at) VALUES ('c', 'e', ?, 1)").run(m);
  add('📋 al started a topic'); add('📋 alice started a topic'); add('🏆 admin2 took #1'); add('👤 ghost just joined DIS!');
  db.prepare("INSERT INTO game_feed (username, event_type, message, created_at) VALUES ('al', 'e', 'won', 1)").run();

  const res = mod.purgeActivityFor('Punkyroo', 'al');
  assert.deepStrictEqual([res.ok, res.activity, res.game], [true, 1, 1]);
  assert.strictEqual(mod.purgeActivityFor('Punkyroo', 'admin2').reason, 'protected');
  assert.strictEqual(mod.purgeActivityFor('Punkyroo', 'nobody').reason, 'not_found');
  insertLegacyRow(db, 'ghost', 1, 'oldadmin', null);
  const ghost = mod.purgeActivityFor('Punkyroo', 'ghost');
  assert.deepStrictEqual([ghost.ok, ghost.account, ghost.activity], [true, false, 1]);

  assert.deepStrictEqual(db.prepare('SELECT message FROM activity_feed ORDER BY id').all().map(r => r.message),
    ['📋 alice started a topic', '🏆 admin2 took #1']);
  assert.deepStrictEqual(db.prepare("SELECT action, target, detail FROM mod_log ORDER BY id").all(), [
    { action: 'purge_activity', target: 'al', detail: '{"activity":1,"game":1}' },
    { action: 'purge_activity_refused', target: 'admin2', detail: 'protected account' },
    { action: 'purge_activity_refused', target: 'nobody', detail: 'not found' },
    { action: 'purge_activity', target: 'ghost', detail: '{"activity":1,"game":0}' },
  ]);
});

test('mod_log records every action: ban, note, purge, chrome, activity, unban', () => {
  const { db, addUser, mod, chrome } = setup();
  const t = addUser('target', 0, { regIp: '10.0.0.1' });
  chrome.award('target', 5, 'welcome bonus');
  const ban = mod.banUser({ actor: 'Punkyroo', username: 'target' });
  mod.setBanNote('Punkyroo', banRows(db, 'target')[0].id, 'note');
  mod.purgeUserContent('Punkyroo', userRow(db, 'target'));
  mod.forfeitChrome('Punkyroo', userRow(db, 'target'));
  mod.purgeActivityFor('Punkyroo', 'target');
  mod.unban({ actor: 'Punkyroo', ref: 'target' });
  assert.deepStrictEqual(mod.listLog({ target: 'target' }).map(r => r.action).reverse(),
    ['ban', 'ban_note', 'purge_content', 'purge_chrome', 'purge_activity', 'unban']);
  assert.ok(mod.listLog({ target: 'target' }).every(r => r.actor === 'Punkyroo'));
  assert.strictEqual(ban.ok && t.id > 0, true);
});

test('listBanOverview shows banned accounts with their ban id alongside ban_list rows', () => {
  const { db, addUser, mod } = setup();
  addUser('victim', 0, { regIp: '10.0.0.1' });
  const ban = mod.banUser({ actor: 'Punkyroo', username: 'victim' });
  insertLegacyRow(db, 'ghost', 1, 'oldadmin', '9.9.9.9');
  const o = mod.listBanOverview();
  assert.deepStrictEqual(o.accounts.map(a => [a.username, a.ban_log_id, a.banned_by]), [['victim', ban.banLogId, 'Punkyroo']]);
  assert.deepStrictEqual(o.rows.map(r => r.username).sort(), ['ghost', 'victim']);
});

test('inactive-user sweep never deletes banned (or admin) accounts', () => {
  const { db, addUser, mod, statements } = setup();
  addUser('idle'); addUser('bannedidle');
  mod.banUser({ actor: 'Punkyroo', username: 'bannedidle' });
  statements.sweepInactiveUsers.run(0);
  assert.strictEqual(userRow(db, 'idle'), undefined);
  assert.ok(userRow(db, 'bannedidle'));
  assert.ok(userRow(db, 'Punkyroo'));
});

test('read-side visibility: banned accounts are hidden from leaderboards, member list and count', () => {
  const { db, addUser, mod, chrome, statements } = setup();
  addUser('good'); addUser('bad');
  chrome.award('good', 10, 'x');
  chrome.award('bad', 500, 'x');
  db.prepare("INSERT INTO wordle_streaks (username, current_streak, best_streak, last_played_date) VALUES ('good', 2, 3, 'd'), ('bad', 9, 9, 'd')").run();
  db.prepare("INSERT INTO wordle_results (username, date, solved, guesses, created_at) VALUES ('good', 'd', 1, 4, 1), ('bad', 'd', 1, 2, 1)").run();
  const before = statements.countUsers.get().n;
  mod.banUser({ actor: 'Punkyroo', username: 'bad' });   // keep: the balance stays

  assert.deepStrictEqual(chrome.getLeaderboard(10).map(r => r.username), ['good']);
  assert.deepStrictEqual(statements.wordleLeaderCurrent.all().map(r => r.username), ['good']);
  assert.deepStrictEqual(statements.wordleLeaderBest.all().map(r => r.username), ['good']);
  assert.deepStrictEqual(statements.wordleGetTodaySolvers.all('d').map(r => r.username), ['good']);
  assert.strictEqual(statements.countUsers.get().n, before - 1);
  assert.ok(!statements.listUsersPage.all(100, 0).some(r => r.username === 'bad'));

  mod.unban({ actor: 'Punkyroo', ref: 'bad' });
  assert.deepStrictEqual(chrome.getLeaderboard(10).map(r => r.username), ['bad', 'good']);
  assert.strictEqual(statements.countUsers.get().n, before);
});

/* ---------------- Visibility helpers (follow-up Stage A) ---------------- */

const { createNotificationService } = require('../../src/services/notifications');
const formatting = require('../../src/utils/formatting');

const ADMIN_VIEWER = { username: 'Punkyroo', isAdmin: true };
const USER_VIEWER  = { username: 'viewer', isAdmin: false };

test('isBannedUsername: banned true; clean, unknown and admin false; case-insensitive', () => {
  const { db, addUser, mod } = setup();
  addUser('clean'); addUser('bad');
  mod.banUser({ actor: 'Punkyroo', username: 'bad' });
  assert.strictEqual(mod.isBannedUsername('bad'), true);
  assert.strictEqual(mod.isBannedUsername('BAD'), true);
  assert.strictEqual(mod.isBannedUsername('clean'), false);
  assert.strictEqual(mod.isBannedUsername('nobody'), false);
  assert.strictEqual(mod.isBannedUsername(''), false);
  assert.strictEqual(mod.isBannedUsername(null), false);
  assert.strictEqual(mod.isBannedUsername('Punkyroo'), false);
});

test('isBannedUsername never reports an admin, even with an old ban_list row naming them', () => {
  const { db, addUser, mod } = setup();
  addUser('admin2');
  insertLegacyRow(db, 'admin2', 1, 'oldadmin', '1.2.3.4');
  db.prepare("UPDATE users SET is_admin = 1 WHERE username = 'admin2'").run();
  assert.strictEqual(mod.isBannedUsername('admin2'), false);
  assert.ok(!mod.bannedUsernameSet().has('admin2'));
  assert.strictEqual(mod.canViewerSee(USER_VIEWER, 'admin2'), true);
});

test('isBannedUsername fails safe: a failing lookup counts as banned; bannedUsernameSet returns null', () => {
  const { db, addUser, mod } = setup();
  addUser('clean');
  db.exec('ALTER TABLE users RENAME TO users_moved');
  assert.strictEqual(mod.isBannedUsername('clean'), true);
  assert.strictEqual(mod.bannedUsernameSet(), null);
  // With no set, a non-admin listing shows only the viewer's own items.
  const canSee = mod.makeVisibilityFilter(USER_VIEWER);
  assert.strictEqual(canSee('viewer'), true);
  assert.strictEqual(canSee('clean'), false);
  // Admins still see everything.
  assert.strictEqual(mod.makeVisibilityFilter(ADMIN_VIEWER)('clean'), true);
});

test('bannedUsernameSet matches banned accounts exactly', () => {
  const { addUser, mod } = setup();
  addUser('Bad1'); addUser('bad2'); addUser('fine');
  mod.banUser({ actor: 'Punkyroo', username: 'Bad1' });
  mod.banUser({ actor: 'Punkyroo', username: 'bad2' });
  assert.deepStrictEqual([...mod.bannedUsernameSet()].sort(), ['bad1', 'bad2']);
});

test('viewer admin status comes only from isAdmin === true on the session state', () => {
  const { addUser, mod } = setup();
  addUser('bad');
  mod.banUser({ actor: 'Punkyroo', username: 'bad' });
  assert.strictEqual(mod.canViewerSee({ username: 'x', isAdmin: true }, 'bad'), true);
  for (const v of [null, undefined, {}, { isAdmin: 1 }, { isAdmin: 'true' }, { is_admin: 1 }, { isAdmin: false }]) {
    assert.strictEqual(mod.canViewerSee(v, 'bad'), false, JSON.stringify(v));
  }
});

test('resolveVisibleUser: banned is not found for users, visible to admins, never with adminBypass false', () => {
  const { db, addUser, mod } = setup();
  addUser('bad'); addUser('good');
  mod.banUser({ actor: 'Punkyroo', username: 'bad' });
  assert.strictEqual(mod.resolveVisibleUser('bad', USER_VIEWER), null);
  assert.strictEqual(mod.resolveVisibleUser('good', USER_VIEWER).row.username, 'good');
  assert.strictEqual(mod.resolveVisibleUser('bad', ADMIN_VIEWER).row.username, 'bad');
  assert.strictEqual(mod.resolveVisibleUser('bad', ADMIN_VIEWER, { adminBypass: false }), null);
  assert.strictEqual(mod.resolveVisibleUser('nobody', ADMIN_VIEWER), null);
  assert.ok(db);
});

test('resolveVisibleUser drops banned candidates from ambiguous display-name matches', () => {
  const { db, addUser, mod, helpers } = setup();
  addUser('bad'); addUser('good'); addUser('other');
  for (const [u, d] of [['bad', 'Twin'], ['good', 'Twin']]) {
    db.prepare('UPDATE users SET display_name = ? WHERE username = ?').run(d, u);
    helpers.refreshUserNormsByRow(db.prepare('SELECT id, username, display_name FROM users WHERE username = ?').get(u));
  }
  assert.ok(helpers.resolveUserHandle('twin').ambiguous, 'fixture should be ambiguous before the ban');
  mod.banUser({ actor: 'Punkyroo', username: 'bad' });
  // Only one visible candidate left: resolves straight to it.
  assert.strictEqual(mod.resolveVisibleUser('twin', USER_VIEWER).row.username, 'good');
  // Admins still get the full ambiguous list.
  assert.deepStrictEqual(mod.resolveVisibleUser('twin', ADMIN_VIEWER).ambiguous.map(r => r.username).sort(), ['bad', 'good']);
});

test('canViewerSee / makeVisibilityFilter: admin sees banned creators, users do not, owners see their own', () => {
  const { addUser, mod } = setup();
  addUser('bad'); addUser('good');
  mod.banUser({ actor: 'Punkyroo', username: 'bad' });
  const userFilter = mod.makeVisibilityFilter(USER_VIEWER);
  const adminFilter = mod.makeVisibilityFilter(ADMIN_VIEWER);
  assert.deepStrictEqual(['bad', 'good', 'viewer'].map(userFilter), [false, true, true]);
  assert.deepStrictEqual(['bad', 'good', 'viewer'].map(adminFilter), [true, true, true]);
  assert.strictEqual(mod.canViewerSee(USER_VIEWER, 'BAD'), false);
  assert.strictEqual(mod.canViewerSee(ADMIN_VIEWER, 'bad'), true);
});

test('unbanning restores visibility everywhere the helpers are used', () => {
  const { addUser, mod } = setup();
  addUser('bad');
  mod.banUser({ actor: 'Punkyroo', username: 'bad' });
  assert.strictEqual(mod.canViewerSee(USER_VIEWER, 'bad'), false);
  mod.unban({ actor: 'Punkyroo', ref: 'bad' });
  assert.strictEqual(mod.isBannedUsername('bad'), false);
  assert.ok(!mod.bannedUsernameSet().has('bad'));
  assert.strictEqual(mod.canViewerSee(USER_VIEWER, 'bad'), true);
  assert.strictEqual(mod.makeVisibilityFilter(USER_VIEWER)('bad'), true);
  assert.strictEqual(mod.resolveVisibleUser('bad', USER_VIEWER).row.username, 'bad');
});

test('mentions of a banned account create nothing; unban restores them (real notification service)', () => {
  const { db, addUser, mod, statements, helpers } = setup();
  const sent = [];
  const socketsByUser = new Map([['bad', new Set([{ id: 'ws' }])]]);
  const notifications = createNotificationService({
    statements, helpers,
    hub: { sendOps: (ws, ops) => sent.push(ops), hub: { socketsByUser, away: new Map() } },
    timeUtils: { nowEpoch: () => 5 }, formatting,
    isHiddenUser: (n) => mod.isBannedUsername(n),
  });
  const sender = addUser('sender');
  const bad = addUser('bad');
  mod.banUser({ actor: 'Punkyroo', username: 'bad' });
  notifications.notifyMentions('hey @bad', sender, 'chat');
  assert.strictEqual(count(db, 'SELECT COUNT(1) n FROM notifications WHERE to_user_id = ?', bad.id), 0);
  assert.strictEqual(sent.length, 0);
  mod.unban({ actor: 'Punkyroo', ref: 'bad' });
  notifications.notifyMentions('hey @bad', sender, 'chat');
  assert.strictEqual(count(db, 'SELECT COUNT(1) n FROM notifications WHERE to_user_id = ?', bad.id), 1);
  assert.strictEqual(sent.length, 1);
});
