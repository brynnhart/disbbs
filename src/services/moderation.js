'use strict';

// Moderation: bans, unbans, purges, and the mod_log audit trail.
//
// Rules this service enforces (see ensureModerationSchema for the matching
// database triggers, which back these up if a code path ever skips them):
// - Accounts are never deleted. A ban sets users.banned_at/banned_by.
// - Admin accounts can never be banned or purged. The check fails closed: a
//   missing row or any is_admin value other than exactly 0 counts as protected.
// - Chrome is only ever moved through the chrome service, so the ledger in
//   chrome_transactions stays complete.
// - Every moderation action, including refused attempts, lands in mod_log.

// Characters allowed in usernames (USERNAME_RE in server.js). A name only
// matches feed text when it isn't glued to more of these on either side.
const NAME_CHARS = 'A-Za-z0-9_\\-';

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// LIKE pattern for "contains s", with LIKE's own wildcards escaped (use with
// ESCAPE '\'). Usernames can contain '_', which LIKE treats as a wildcard.
function likeContains(s) {
  return '%' + String(s).replace(/[\\%_]/g, '\\$&') + '%';
}

// Whole-word, case-insensitive username match. '.' is a username character,
// so "al.x" is a different name, but a sentence-ending "al." still matches.
function makeUsernameMatcher(username) {
  const name = escapeRegExp(username);
  return new RegExp(
    `(?<![${NAME_CHARS}.])${name}(?![${NAME_CHARS}])(?!\\.[${NAME_CHARS}])`,
    'i'
  );
}

function matchesUsername(text, username) {
  if (!text || !username) return false;
  return makeUsernameMatcher(username).test(String(text));
}

const REFUSAL_DETAIL = {
  protected: 'protected account',
  self: 'self',
  not_found: 'not found',
  already_banned: 'already banned',
  not_banned: 'not banned',
};

function createModerationService({ db, nowEpoch, chrome, resolveUserHandle = null }) {
  const stmtGetUserByName   = db.prepare('SELECT * FROM users WHERE username = ?');
  const stmtGetUserById     = db.prepare('SELECT * FROM users WHERE id = ?');
  const stmtListAdmins      = db.prepare('SELECT username, registration_ip, last_login_ip, fingerprint_hash FROM users WHERE is_admin IS NOT 0');
  const stmtMarkBanned      = db.prepare('UPDATE users SET banned_at = ?, banned_by = ? WHERE id = ? AND is_admin = 0 AND banned_at IS NULL');
  const stmtInsertBanLog    = db.prepare('INSERT INTO ban_log (created_at, banned_by, username) VALUES (?, ?, ?)');
  const stmtUpdateBanLogCounts = db.prepare(`
    UPDATE ban_log
       SET chat_msgs = ?, board_topics = ?, board_comments = ?, link_posts = ?, link_comments = ?,
           poll_votes = ?, polls_created = ?, status_posts = ?, dm_sent = ?, pixel_art = ?
     WHERE id = ?
  `);
  const stmtInsertBanRow    = db.prepare(`
    INSERT INTO ban_list (created_at, banned_by, username, ip, fingerprint_hash, notes, ban_log_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const stmtBanByUsername   = db.prepare('SELECT id FROM ban_list WHERE LOWER(username) = LOWER(?) LIMIT 1');
  const stmtBanByIp         = db.prepare('SELECT id FROM ban_list WHERE ip IS NOT NULL AND ip = ? LIMIT 1');
  const stmtBanByFp         = db.prepare('SELECT id FROM ban_list WHERE fingerprint_hash IS NOT NULL AND fingerprint_hash = ? LIMIT 1');
  const stmtInsertModLog    = db.prepare(`
    INSERT INTO mod_log (created_at, actor, action, target, ref_id, detail)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const stmtListModLog      = db.prepare('SELECT * FROM mod_log ORDER BY id DESC LIMIT ?');
  const stmtListModLogFor   = db.prepare('SELECT * FROM mod_log WHERE target = ? COLLATE NOCASE ORDER BY id DESC LIMIT ?');
  const stmtBanPurgeLogs    = db.prepare("SELECT detail FROM mod_log WHERE action = 'purge_content' AND ref_id = ?");

  // Visibility. "Banned" here means a users row with is_admin = 0 and
  // banned_at set — the same definition as the leaderboard filters. Old
  // ban_list rows are ignored, so an admin can never be reported as banned.
  const stmtUserBanState    = db.prepare('SELECT is_admin, banned_at FROM users WHERE username = ?');
  const stmtBannedUsernames = db.prepare('SELECT username FROM users WHERE is_admin = 0 AND banned_at IS NOT NULL');

  // Unban / notes / listing.
  const stmtGetBanRow       = db.prepare('SELECT * FROM ban_list WHERE id = ?');
  const stmtBanRowsByLogId  = db.prepare('SELECT * FROM ban_list WHERE ban_log_id = ?');
  // Rows written before ban_log_id existed: one /ban wrote them all with the
  // same username, created_at and banned_by.
  const stmtLegacyGroup     = db.prepare(`
    SELECT * FROM ban_list
     WHERE ban_log_id IS NULL AND username = ? COLLATE NOCASE AND created_at = ? AND banned_by = ?
  `);
  const stmtBanRowsForName  = db.prepare(`
    SELECT * FROM ban_list
     WHERE username = ? COLLATE NOCASE
        OR ban_log_id IN (SELECT ban_log_id FROM ban_list WHERE username = ? COLLATE NOCASE AND ban_log_id IS NOT NULL)
  `);
  const stmtBanNameRow      = db.prepare('SELECT username FROM ban_list WHERE username = ? COLLATE NOCASE LIMIT 1');
  const stmtDeleteBanRow    = db.prepare('DELETE FROM ban_list WHERE id = ?');
  const stmtClearBanned     = db.prepare('UPDATE users SET banned_at = NULL, banned_by = NULL WHERE id = ? AND is_admin = 0 AND banned_at IS NOT NULL');
  const stmtUpdateBanNote   = db.prepare('UPDATE ban_list SET notes = ? WHERE id = ?');
  const stmtListBanRows     = db.prepare('SELECT * FROM ban_list ORDER BY created_at DESC, id DESC');
  const stmtListBannedAccounts = db.prepare(`
    SELECT u.username, u.banned_at, u.banned_by,
           (SELECT MAX(b.id) FROM ban_log b WHERE b.username = u.username) AS ban_log_id
      FROM users u
     WHERE u.banned_at IS NOT NULL
     ORDER BY u.banned_at DESC
  `);

  // Content purge. Own replies/votes go first so the cascade counts below
  // only see other users' rows.
  const purge = {
    chat:           db.prepare('DELETE FROM messages       WHERE user_id = ?'),
    boardComments:  db.prepare('DELETE FROM board_comments WHERE user_id = ?'),
    cascadeBoard:   db.prepare('SELECT COUNT(1) AS n FROM board_comments WHERE topic_id IN (SELECT id FROM board_topics WHERE creator_id = ?)'),
    boardTopics:    db.prepare('DELETE FROM board_topics   WHERE creator_id = ?'),
    linkComments:   db.prepare('DELETE FROM news_comments  WHERE user_id = ?'),
    cascadeLinks:   db.prepare('SELECT COUNT(1) AS n FROM news_comments WHERE post_id IN (SELECT id FROM news_posts WHERE user_id = ?)'),
    linkPosts:      db.prepare('DELETE FROM news_posts     WHERE user_id = ?'),
    pollVotes:      db.prepare('DELETE FROM poll_votes     WHERE user_id = ?'),
    cascadePolls:   db.prepare('SELECT COUNT(1) AS n FROM poll_votes WHERE poll_id IN (SELECT id FROM polls WHERE creator_id = ?)'),
    polls:          db.prepare('DELETE FROM polls          WHERE creator_id = ?'),
    statusPosts:    db.prepare('DELETE FROM status_posts   WHERE user_id = ?'),
    dmSent:         db.prepare('DELETE FROM dm_messages    WHERE sender_id = ?'),
    pixelArt:       db.prepare('DELETE FROM pixel_art      WHERE creator_username = ? COLLATE NOCASE'),
    notifications:  db.prepare('DELETE FROM notifications  WHERE to_user_id = ? OR from_user_id = ?'),
    graffitiCells:  db.prepare('DELETE FROM graffiti_wall  WHERE painted_by = ? COLLATE NOCASE'),
    graffitiLog:    db.prepare('DELETE FROM graffiti_activity WHERE username = ? COLLATE NOCASE'),
  };
  const stmtActivityCandidates = db.prepare("SELECT id, message FROM activity_feed WHERE message LIKE ? ESCAPE '\\'");
  const stmtDeleteActivity     = db.prepare('DELETE FROM activity_feed WHERE id = ?');
  const stmtGameFeedCandidates = db.prepare("SELECT id, username, message FROM game_feed WHERE username = ? COLLATE NOCASE OR message LIKE ? ESCAPE '\\'");
  const stmtDeleteGameFeed     = db.prepare('DELETE FROM game_feed WHERE id = ?');

  // True only for a real row with is_admin exactly 1. Used for exemptions,
  // so a missing row or any other is_admin value is NOT exempt.
  function isAdminRow(row) {
    return !!row && row.is_admin === 1;
  }

  // True when the row must not be banned or purged. Fails closed: no row, or
  // any is_admin value other than exactly 0, is protected.
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

  // IP/fingerprint ban match for a login. Admins are exempt, so a ban on
  // someone sharing an admin's network or browser can't lock the admin out.
  // Only a positive match on a present value denies.
  function connectionBanHit(row, ip, fingerprintHash) {
    if (isAdminRow(row)) return null;
    if (ip && stmtBanByIp.get(ip)) return 'ip';
    if (fingerprintHash && stmtBanByFp.get(fingerprintHash)) return 'fingerprint';
    return null;
  }

  // Exact username lookup (case-insensitive, no display-name resolution).
  function findUser(username) {
    const name = String(username || '').trim();
    return name ? (stmtGetUserByName.get(name) || null) : null;
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
    const err = new Error(`moderation refused: ${reason}`);
    err.refusal = reason;
    return err;
  }

  function isTriggerProtection(e) {
    return !!e && /admin accounts cannot be (banned|deleted)/.test(e.message || '');
  }

  function adminMatchesFor(ips, fingerprint) {
    return stmtListAdmins.all()
      .filter(a => (a.registration_ip && ips.includes(a.registration_ip))
                || (a.last_login_ip && ips.includes(a.last_login_ip))
                || (fingerprint && a.fingerprint_hash === fingerprint))
      .map(a => a.username);
  }

  // Deletes activity_feed and game_feed rows that name the user as a whole
  // word. The escaped LIKE narrows the candidates; the JS check decides.
  function deleteFeedRowsFor(username) {
    const re = makeUsernameMatcher(username);
    let activity = 0;
    for (const r of stmtActivityCandidates.all(likeContains(username))) {
      if (re.test(r.message)) activity += stmtDeleteActivity.run(r.id).changes;
    }
    let game = 0;
    for (const r of stmtGameFeedCandidates.all(username, likeContains(username))) {
      const own = r.username && r.username.toLowerCase() === username.toLowerCase();
      if (own || re.test(r.message)) game += stmtDeleteGameFeed.run(r.id).changes;
    }
    return { activity, game };
  }

  // Spends the whole balance through the chrome service. Throws if the spend
  // doesn't go through, so a surrounding transaction rolls back.
  function forfeitBalance(username, reason) {
    if (!chrome) throw new Error('moderation: chrome service is required to forfeit a balance');
    const balance = chrome.getBalance(username);
    if (!(balance > 0)) return 0;
    const res = chrome.spend(username, balance, reason);
    if (!res || !res.success) throw new Error(`moderation: chrome forfeiture failed for ${username}`);
    return balance;
  }

  // The purge itself, for a row already re-read inside a transaction. Throws
  // a refusal for protected rows.
  function purgeRow(row, { chromeReason }) {
    if (isProtected(row)) throw refusal('protected');
    const id = row.id;
    const name = row.username;

    const counts = {};
    const cascade = {};
    counts.chat_msgs      = purge.chat.run(id).changes;
    counts.board_comments = purge.boardComments.run(id).changes;
    cascade.board_replies = purge.cascadeBoard.get(id).n;
    counts.board_topics   = purge.boardTopics.run(id).changes;
    counts.link_comments  = purge.linkComments.run(id).changes;
    cascade.link_comments = purge.cascadeLinks.get(id).n;
    counts.link_posts     = purge.linkPosts.run(id).changes;
    counts.poll_votes     = purge.pollVotes.run(id).changes;
    cascade.poll_votes    = purge.cascadePolls.get(id).n;
    counts.polls_created  = purge.polls.run(id).changes;
    counts.status_posts   = purge.statusPosts.run(id).changes;
    counts.dm_sent        = purge.dmSent.run(id).changes;
    counts.pixel_art      = purge.pixelArt.run(name).changes;
    counts.notifications  = purge.notifications.run(id, id).changes;
    const feeds = deleteFeedRowsFor(name);
    counts.activity_feed  = feeds.activity;
    counts.game_feed      = feeds.game;
    counts.graffiti_cells = purge.graffitiCells.run(name).changes;
    counts.graffiti_log   = purge.graffitiLog.run(name).changes;

    // Last, so a failure in any delete above never reaches the ledger.
    const chromeForfeited = forfeitBalance(name, chromeReason);

    return { counts, cascade, chromeForfeited };
  }

  function purgeLogDetail(result, extra) {
    return Object.assign({ counts: result.counts, cascade: result.cascade, chrome_forfeited: result.chromeForfeited }, extra || {});
  }

  // Purge hook for banUser's withinBan: runs inside the ban's transaction,
  // records the counts on the ban_log row, and throws on any refusal so the
  // whole ban rolls back.
  function purgeWithinBan(actor, row, banLogId) {
    const result = purgeRow(row, { chromeReason: 'ban forfeiture' });
    const c = result.counts;
    stmtUpdateBanLogCounts.run(
      c.chat_msgs, c.board_topics, c.board_comments, c.link_posts, c.link_comments,
      c.poll_votes, c.polls_created, c.status_posts, c.dm_sent, c.pixel_art, banLogId
    );
    log(actor, 'purge_content', row.username, banLogId, purgeLogDetail(result, { with_ban: true }));
    return result;
  }

  function refuseAction(actor, action, targetLabel, reason) {
    if (reason !== 'no_actor' && targetLabel) {
      log(actor, action, targetLabel, null, REFUSAL_DETAIL[reason] || reason);
    }
    return { ok: false, reason };
  }

  // Standalone purge (/purgeuser). The account row is never touched.
  function purgeUserContent(actor, targetRow) {
    const actorName = String(actor || '').trim();
    if (!actorName) return { ok: false, reason: 'no_actor' };
    if (!targetRow) return { ok: false, reason: 'not_found' };
    if (isProtected(targetRow)) return refuseAction(actorName, 'purge_refused', targetRow.username, 'protected');
    try {
      return db.transaction(() => {
        const row = stmtGetUserById.get(targetRow.id);
        if (isProtected(row)) throw refusal('protected');
        const reason = row.banned_at != null ? 'ban forfeiture' : 'admin forfeiture';
        const result = purgeRow(row, { chromeReason: reason });
        log(actorName, 'purge_content', row.username, null, purgeLogDetail(result));
        return Object.assign({ ok: true, username: row.username }, result);
      })();
    } catch (e) {
      if (e && (e.refusal || isTriggerProtection(e))) {
        return refuseAction(actorName, 'purge_refused', targetRow.username, e.refusal || 'protected');
      }
      throw e;
    }
  }

  // Standalone chrome forfeiture (/purgechrome). Nothing is deleted: the
  // balance is spent through the chrome service and the ledger keeps both.
  function forfeitChrome(actor, targetRow) {
    const actorName = String(actor || '').trim();
    if (!actorName) return { ok: false, reason: 'no_actor' };
    if (!targetRow) return { ok: false, reason: 'not_found' };
    if (isProtected(targetRow)) return refuseAction(actorName, 'purge_chrome_refused', targetRow.username, 'protected');
    try {
      return db.transaction(() => {
        const row = stmtGetUserById.get(targetRow.id);
        if (isProtected(row)) throw refusal('protected');
        const reason = row.banned_at != null ? 'ban forfeiture' : 'admin forfeiture';
        const amount = forfeitBalance(row.username, reason);
        log(actorName, 'purge_chrome', row.username, null, { chrome_forfeited: amount, reason });
        return { ok: true, username: row.username, amount, reason };
      })();
    } catch (e) {
      if (e && (e.refusal || isTriggerProtection(e))) {
        return refuseAction(actorName, 'purge_chrome_refused', targetRow.username, e.refusal || 'protected');
      }
      throw e;
    }
  }

  // Bans one account by exact username (case-insensitive, no display-name
  // resolution). Writes the ban marker, ban_list rows tied together by
  // ban_log_id, a ban_log row, and a mod_log row, all in one transaction.
  // Returns { ok:false, reason } for refusals (each logged); throws only on
  // real errors, after rolling everything back.
  // withinBan(row, banLogId) runs inside the same transaction.
  function banUser({ actor, username, withinBan = null }) {
    const actorName = String(actor || '').trim();
    const name = String(username || '').trim();
    if (!actorName) return { ok: false, reason: 'no_actor' };
    if (!name) return { ok: false, reason: 'not_found' };

    const target = stmtGetUserByName.get(name);
    if (!target) return refuseAction(actorName, 'ban_refused', name, 'not_found');
    if (target.username.toLowerCase() === actorName.toLowerCase()) {
      return refuseAction(actorName, 'ban_refused', target.username, 'self');
    }
    if (isProtected(target)) return refuseAction(actorName, 'ban_refused', target.username, 'protected');
    if (target.banned_at != null) return refuseAction(actorName, 'ban_refused', target.username, 'already_banned');

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

        log(actorName, 'ban', row.username, banLogId, { banRows, ips, fingerprint: !!fp, purged: !!withinBan });

        const extra = withinBan ? withinBan(row, banLogId) : null;

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
      if (e && (e.refusal || isTriggerProtection(e))) {
        return refuseAction(actorName, 'ban_refused', target.username, e.refusal || 'protected');
      }
      throw e;
    }
  }

  // All ban_list rows written by the same ban as `row`.
  function banGroupFor(row) {
    if (row.ban_log_id != null) return stmtBanRowsByLogId.all(row.ban_log_id);
    if (row.username) return stmtLegacyGroup.all(row.username, row.created_at, row.banned_by);
    return [row];
  }

  // Chrome forfeited by the purge that ran with these bans; null when no
  // ban in the set was recorded (old bans deleted chrome outright).
  function chromeForfeitedFor(banLogIds) {
    if (!banLogIds.length) return null;
    let total = 0;
    for (const id of banLogIds) {
      for (const r of stmtBanPurgeLogs.all(id)) {
        try { total += Number(JSON.parse(r.detail).chrome_forfeited) || 0; } catch {}
      }
    }
    return total;
  }

  // /unban <username> removes every ban_list row for that name plus any row
  // linked to the same bans; /unban #<id> removes the group that row belongs
  // to. One transaction: delete the rows, clear the account marker when no
  // ban entry for the name remains, write the audit row. Admin rows are never
  // updated (the UPDATE is guarded by is_admin = 0).
  function unban({ actor, ref }) {
    const actorName = String(actor || '').trim();
    const raw = String(ref || '').trim();
    if (!actorName) return { ok: false, reason: 'no_actor' };
    if (!raw) return { ok: false, reason: 'not_found' };

    let rows;
    let name;
    if (/^#\d+$/.test(raw)) {
      const row = stmtGetBanRow.get(parseInt(raw.slice(1), 10));
      if (!row) return refuseAction(actorName, 'unban_refused', raw, 'not_found');
      rows = banGroupFor(row);
      name = row.username || null;
    } else {
      const user = stmtGetUserByName.get(raw);
      name = user ? user.username : raw;
      rows = stmtBanRowsForName.all(name, name);
      if (!rows.length && !(user && user.banned_at != null)) {
        return refuseAction(actorName, 'unban_refused', name, user ? 'not_banned' : 'not_found');
      }
      if (!user) name = (rows.find(r => r.username) || {}).username || name;
    }

    const result = db.transaction(() => {
      let removed = 0;
      for (const r of rows) removed += stmtDeleteBanRow.run(r.id).changes;

      const user = name ? stmtGetUserByName.get(name) : null;
      let cleared = false;
      if (user && user.banned_at != null && !stmtBanNameRow.get(user.username)) {
        cleared = stmtClearBanned.run(user.id).changes === 1;
      }
      const after = user ? stmtGetUserById.get(user.id) : null;
      const banLogIds = [...new Set(rows.map(r => r.ban_log_id).filter(v => v != null))];
      const out = {
        ok: true,
        username: name,
        rowsRemoved: removed,
        account: !!user,
        cleared,
        stillBlocked: after ? isAccountBanned(after) : false,
        banLogIds,
        chromeForfeited: chromeForfeitedFor(banLogIds),
      };
      log(actorName, 'unban', name || raw, banLogIds[0] != null ? banLogIds[0] : null, {
        ref: raw, rows_removed: removed, account: out.account, cleared, still_blocked: out.stillBlocked,
        ban_log_ids: banLogIds, chrome_forfeited: out.chromeForfeited,
      });
      return out;
    })();
    return result;
  }

  function setBanNote(actor, banId, note) {
    const actorName = String(actor || '').trim();
    const text = String(note || '').trim();
    if (!actorName) return { ok: false, reason: 'no_actor' };
    const row = stmtGetBanRow.get(banId);
    if (!row) return refuseAction(actorName, 'ban_note_refused', `#${banId}`, 'not_found');
    return db.transaction(() => {
      stmtUpdateBanNote.run(text, row.id);
      log(actorName, 'ban_note', row.username || `#${row.id}`, row.ban_log_id, { ban_list_id: row.id, note: text });
      return { ok: true, id: row.id, username: row.username || null };
    })();
  }

  // /purgeactivity: whole-word feed purge for an existing account or a name
  // that only survives in ban_list (old bans). Admin accounts are refused.
  function purgeActivityFor(actor, username) {
    const actorName = String(actor || '').trim();
    const raw = String(username || '').trim();
    if (!actorName) return { ok: false, reason: 'no_actor' };
    if (!raw) return { ok: false, reason: 'not_found' };
    const user = stmtGetUserByName.get(raw);
    let name;
    if (user) {
      if (isProtected(user)) return refuseAction(actorName, 'purge_activity_refused', user.username, 'protected');
      name = user.username;
    } else {
      const banned = stmtBanNameRow.get(raw);
      if (!banned) return refuseAction(actorName, 'purge_activity_refused', raw, 'not_found');
      name = banned.username;
    }
    return db.transaction(() => {
      const counts = deleteFeedRowsFor(name);
      log(actorName, 'purge_activity', name, null, counts);
      return Object.assign({ ok: true, username: name, account: !!user }, counts);
    })();
  }

  // True when the named account is banned. Unknown names are false (callers
  // keep their own "not found" path). Fails safe: if the lookup throws, the
  // account is treated as banned, i.e. hidden and refused.
  function isBannedUsername(username) {
    const name = String(username || '').trim();
    if (!name) return false;
    try {
      const row = stmtUserBanState.get(name);
      if (!row) return false;
      return row.is_admin === 0 && row.banned_at != null;
    } catch (e) {
      return true;
    }
  }

  // Lowercased names of banned accounts, for filtering listings with one
  // query. Returns null if the lookup fails; callers must then hide every
  // item the viewer doesn't own.
  function bannedUsernameSet() {
    try {
      return new Set(stmtBannedUsernames.all().map(r => r.username.toLowerCase()));
    } catch (e) {
      return null;
    }
  }

  // viewer is the server-side session state; only viewer.isAdmin === true
  // counts as an admin.
  function viewerIsAdmin(viewer) {
    return !!viewer && viewer.isAdmin === true;
  }

  // Whether items by `creator` should be shown to `viewer`: admins see
  // everything, everyone sees their own, banned creators are hidden.
  function canViewerSee(viewer, creator) {
    if (viewerIsAdmin(viewer)) return true;
    if (viewer && viewer.username && creator && viewer.username.toLowerCase() === String(creator).toLowerCase()) return true;
    return !isBannedUsername(creator);
  }

  // Listing filter built from one bannedUsernameSet() query.
  function makeVisibilityFilter(viewer) {
    if (viewerIsAdmin(viewer)) return () => true;
    const own = viewer && viewer.username ? viewer.username.toLowerCase() : null;
    const banned = bannedUsernameSet();
    return (creator) => {
      const c = String(creator || '').toLowerCase();
      if (own && c === own) return true;
      if (!banned) return false;
      return !banned.has(c);
    };
  }

  // resolveUserHandle, with banned accounts treated as not found. Admin
  // viewers see everything unless adminBypass is false. Ambiguous matches
  // drop banned candidates, so a banned name is never listed back.
  function resolveVisibleUser(anyName, viewer, { adminBypass = true } = {}) {
    if (!resolveUserHandle) throw new Error('moderation: resolveUserHandle is required');
    const resolved = resolveUserHandle(anyName);
    if (!resolved) return null;
    if (adminBypass && viewerIsAdmin(viewer)) return resolved;
    if (resolved.row) return isBannedUsername(resolved.row.username) ? null : resolved;
    if (resolved.ambiguous) {
      const visible = resolved.ambiguous.filter(r => !isBannedUsername(r.username));
      if (!visible.length) return null;
      if (visible.length === 1) {
        const row = stmtGetUserByName.get(visible[0].username);
        return row ? { row } : null;
      }
      return { ambiguous: visible };
    }
    return null;
  }

  function listBanOverview() {
    return { rows: stmtListBanRows.all(), accounts: stmtListBannedAccounts.all() };
  }

  return {
    isAdminRow, isProtected, isAccountBanned, connectionBanHit, findUser,
    banUser, purgeWithinBan, purgeUserContent, forfeitChrome, deleteFeedRowsFor,
    unban, setBanNote, purgeActivityFor, listBanOverview,
    isBannedUsername, bannedUsernameSet, canViewerSee, makeVisibilityFilter, resolveVisibleUser,
    log, listLog,
  };
}

module.exports = { createModerationService, matchesUsername, likeContains };
