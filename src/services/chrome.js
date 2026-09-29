'use strict';

function createChromeService({ db, nowEpoch, dayKeyET, hub, sendOps }) {
  const stmtGetRow     = db.prepare('SELECT balance, last_daily_at, last_stipend_at FROM chrome_balances WHERE username = ?');
  const stmtEnsureRow  = db.prepare('INSERT INTO chrome_balances (username, balance, created_at) VALUES (?, 0, ?) ON CONFLICT(username) DO NOTHING');
  const stmtAddBalance = db.prepare('UPDATE chrome_balances SET balance = balance + ? WHERE username = ?');
  const stmtSubBalance = db.prepare('UPDATE chrome_balances SET balance = balance - ? WHERE username = ?');
  const stmtInsertTx   = db.prepare('INSERT INTO chrome_transactions (username, amount, reason, created_at) VALUES (?, ?, ?, ?)');
  const stmtSetLastDaily   = db.prepare('UPDATE chrome_balances SET last_daily_at   = ? WHERE username = ?');
  const stmtSetLastStipend = db.prepare('UPDATE chrome_balances SET last_stipend_at = ? WHERE username = ?');
  // Banned accounts keep their row (and, after "/ban <user> keep", their
  // balance) but never show on the leaderboard.
  const stmtLeaderboard    = db.prepare(`
    SELECT username, balance FROM chrome_balances
     WHERE balance > 0
       AND NOT EXISTS (SELECT 1 FROM users u WHERE u.username = chrome_balances.username AND u.banned_at IS NOT NULL)
     ORDER BY balance DESC LIMIT ?
  `);
  const stmtGetJackpot     = db.prepare('SELECT amount FROM slots_jackpot WHERE id = 1');
  const stmtSetJackpot     = db.prepare('UPDATE slots_jackpot SET amount = ? WHERE id = 1');

  function ensureRow(username) {
    stmtEnsureRow.run(username, nowEpoch());
  }

  function getBalance(username) {
    const row = stmtGetRow.get(username);
    return row ? row.balance : 0;
  }

  // Status-strip op (Phase 3 of the phosphor redesign): broadcast the new
  // balance to every active socket for this user. Hooked in here, at the
  // service's own mutation points, rather than at each of the many call
  // sites across server.js that call award/spend.
  function broadcastChromeStatus(username, balance) {
    if (!hub || !sendOps) return;
    const sockets = hub.socketsByUser.get(username);
    if (!sockets) return;
    sockets.forEach(ws => sendOps(ws, [{ op: 'status', chrome: balance }]));
  }

  function award(username, amount, reason) {
    ensureRow(username);
    stmtAddBalance.run(amount, username);
    stmtInsertTx.run(username, amount, reason, nowEpoch());
    const newBalance = getBalance(username);
    broadcastChromeStatus(username, newBalance);
    return newBalance;
  }

  function spend(username, amount, reason) {
    ensureRow(username);
    const bal = getBalance(username);
    if (bal < amount) return { success: false, newBalance: bal };
    stmtSubBalance.run(amount, username);
    stmtInsertTx.run(username, -amount, reason, nowEpoch());
    const newBalance = bal - amount;
    broadcastChromeStatus(username, newBalance);
    return { success: true, newBalance };
  }

  function getDailyBonus(username) {
    const today = dayKeyET(); // board time (America/New_York) — see src/utils/time.js
    ensureRow(username);
    const row = stmtGetRow.get(username);
    if (row.last_daily_at === today) return { awarded: false, amount: 0, newBalance: row.balance };
    const newBalance = award(username, 10, 'daily bonus');
    stmtSetLastDaily.run(today, username);
    return { awarded: true, amount: 10, newBalance };
  }

  function checkStipend(username) {
    const today = dayKeyET(); // board time (America/New_York) — see src/utils/time.js
    ensureRow(username);
    const row = stmtGetRow.get(username);
    if (row.last_stipend_at === today || row.balance > 0) {
      return { awarded: false, amount: 0, newBalance: row.balance };
    }
    const newBalance = award(username, 20, 'safety net stipend');
    stmtSetLastStipend.run(today, username);
    return { awarded: true, amount: 20, newBalance };
  }

  function getLeaderboard(limit = 10) {
    return stmtLeaderboard.all(limit);
  }

  function getJackpot() {
    const row = stmtGetJackpot.get();
    return row ? row.amount : 500;
  }

  function addToJackpot(amount) {
    const next = getJackpot() + amount;
    stmtSetJackpot.run(next);
    return next;
  }

  function claimJackpot(username) {
    const amount = getJackpot();
    stmtSetJackpot.run(500);
    const newBalance = award(username, amount, 'slots jackpot');
    return { amount, newBalance };
  }

  return { getBalance, award, spend, getDailyBonus, checkStipend, getLeaderboard, getJackpot, addToJackpot, claimJackpot };
}

module.exports = { createChromeService };
