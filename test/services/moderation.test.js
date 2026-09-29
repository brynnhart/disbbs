const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { createDatabase, ensureModerationSchema } = require('../../src/database');
const { createModerationService } = require('../../src/services/moderation');

let clock = 1_700_000_000;
const nowEpoch = () => ++clock;

function setup() {
  const { db } = createDatabase({ dbPath: ':memory:' });
  const addUser = (username, isAdmin = 0, extra = {}) => {
    db.prepare(`
      INSERT INTO users (username, password_hash, is_admin, created_at, registration_ip, last_login_ip, fingerprint_hash)
      VALUES (?, 'x', ?, 1, ?, ?, ?)
    `).run(username, isAdmin, extra.regIp || null, extra.loginIp || null, extra.fp || null);
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  };
  const mod = createModerationService({ db, nowEpoch });
  return { db, addUser, mod };
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
