'use strict';

// Moderation: bans, unbans, purges, and the mod_log audit trail.
//
// Rules this service enforces (see ensureModerationSchema for the matching
// database triggers, which back these up if a code path ever skips them):
// - Accounts are never deleted. A ban sets users.banned_at/banned_by.
// - Admin accounts can never be banned. The check fails closed: a missing
//   row or any is_admin value other than exactly 0 counts as protected.
// - Every moderation action, including refused attempts, lands in mod_log.
function createModerationService({ db, nowEpoch }) {
  const stmtGetUserByName   = db.prepare('SELECT * FROM users WHERE username = ?');
  const stmtGetUserById     = db.prepare('SELECT * FROM users WHERE id = ?');
  const stmtListAdmins      = db.prepare('SELECT username, registration_ip, last_login_ip, fingerprint_hash FROM users WHERE is_admin IS NOT 0');
  const stmtMarkBanned      = db.prepare('UPDATE users SET banned_at = ?, banned_by = ? WHERE id = ? AND is_admin = 0 AND banned_at IS NULL');
  const stmtInsertBanLog    = db.prepare('INSERT INTO ban_log (created_at, banned_by, username) VALUES (?, ?, ?)');
  const stmtInsertBanRow    = db.prepare(`
    INSERT INTO ban_list (created_at, banned_by, username, ip, fingerprint_hash, notes, ban_log_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const stmtBanByUsername   = db.prepare('SELECT id FROM ban_list WHERE LOWER(username) = LOWER(?) LIMIT 1');
  const stmtInsertModLog    = db.prepare(`
    INSERT INTO mod_log (created_at, actor, action, target, ref_id, detail)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const stmtListModLog      = db.prepare('SELECT * FROM mod_log ORDER BY id DESC LIMIT ?');
  const stmtListModLogFor   = db.prepare('SELECT * FROM mod_log WHERE target = ? COLLATE NOCASE ORDER BY id DESC LIMIT ?');

  // True when the row may exist and is an admin. Used for exemptions, so an
  // unknown row is NOT exempt.
  function isAdminRow(row) {
    return !!row && row.is_admin != null && row.is_admin !== 0;
  }

  // True when the row must not be banned. Fails closed: no row, or any
  // is_admin value other than exactly 0, is protected.
  function isProtected(row) {
    return !row || row.is_admin !== 0;
  }

  // Account-level ban state for login paths. Admins are never banned. A
  // ban_list row naming the user still counts, which covers bans made before
  // users.banned_at existed.
  function isAccountBanned(row) {
    if (!row) return false;
    if (isAdminRow(row)) return false;
    if (row.banned_at != null) return true;
    return !!stmtBanByUsername.get(row.username);
  }

  function log(actor, action, target, refId, detail) {
    const text = detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail));
    stmtInsertModLog.run(nowEpoch(), String(actor || '?'), action, target || null, refId == null ? null : refId, text);
  }

  function listLog({ limit = 20, target = null } = {}) {
    const n = Math.max(1, Math.min(200, parseInt(limit, 10) || 20));
    return target ? stmtListModLogFor.all(target, n) : stmtListModLog.all(n);
  }

  function refusal(reason) {
    const err = new Error(`ban refused: ${reason}`);
    err.refusal = reason;
    return err;
  }

  function adminMatchesFor(ips, fingerprint) {
    return stmtListAdmins.all()
      .filter(a => (a.registration_ip && ips.includes(a.registration_ip))
                || (a.last_login_ip && ips.includes(a.last_login_ip))
                || (fingerprint && a.fingerprint_hash === fingerprint))
      .map(a => a.username);
  }

  // Bans one account by exact username (case-insensitive, no display-name
  // resolution). Writes the ban marker, ban_list rows tied together by
  // ban_log_id, a ban_log row, and a mod_log row, all in one transaction.
  // Returns { ok:false, reason } for refusals; throws only on real errors.
  // opts.withinBan(row, banLogId) runs inside the same transaction.
  function banUser({ actor, username, withinBan = null }) {
    const actorName = String(actor || '').trim();
    const name = String(username || '').trim();
    if (!actorName) return { ok: false, reason: 'no_actor' };
    if (!name) return { ok: false, reason: 'not_found' };

    const target = stmtGetUserByName.get(name);
    if (!target) return { ok: false, reason: 'not_found' };
    if (target.username.toLowerCase() === actorName.toLowerCase()) {
      log(actorName, 'ban_refused', target.username, null, 'self');
      return { ok: false, reason: 'self' };
    }
    if (isProtected(target)) {
      log(actorName, 'ban_refused', target.username, null, 'protected account');
      return { ok: false, reason: 'protected' };
    }
    if (target.banned_at != null) return { ok: false, reason: 'already_banned' };

    const now = nowEpoch();
    try {
      return db.transaction(() => {
        // Re-read inside the transaction so the protection check sees the
        // row as it is being written.
        const row = stmtGetUserById.get(target.id);
        if (isProtected(row)) throw refusal('protected');
        if (row.banned_at != null) throw refusal('already_banned');

        const banLogId = Number(stmtInsertBanLog.run(now, actorName, row.username).lastInsertRowid);

        const regIp = row.registration_ip || null;
        const fp    = row.fingerprint_hash || null;
        const ips   = regIp ? [regIp] : [];
        stmtInsertBanRow.run(now, actorName, row.username, regIp, fp, null, banLogId);
        let banRows = 1;
        if (row.last_login_ip && row.last_login_ip !== regIp) {
          stmtInsertBanRow.run(now, actorName, row.username, row.last_login_ip, null, null, banLogId);
          ips.push(row.last_login_ip);
          banRows++;
        }

        const info = stmtMarkBanned.run(now, actorName, row.id);
        if (info.changes !== 1) throw refusal('protected');

        const extra = withinBan ? withinBan(row, banLogId) : null;

        log(actorName, 'ban', row.username, banLogId, { banRows, ips, fingerprint: !!fp });

        return {
          ok: true,
          banLogId,
          username: row.username,
          userId: row.id,
          banRows,
          ips,
          fingerprint: fp,
          adminMatches: adminMatchesFor(ips, fp),
          extra,
        };
      })();
    } catch (e) {
      const protectedByTrigger = e && /admin accounts cannot be banned/.test(e.message || '');
      if (e && (e.refusal || protectedByTrigger)) {
        const reason = protectedByTrigger ? 'protected' : e.refusal;
        if (reason === 'protected') log(actorName, 'ban_refused', target.username, null, 'protected account');
        return { ok: false, reason };
      }
      throw e;
    }
  }

  return { isAdminRow, isProtected, isAccountBanned, banUser, log, listLog };
}

module.exports = { createModerationService };
