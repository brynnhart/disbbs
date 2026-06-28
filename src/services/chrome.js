'use strict';

function createChromeService({ db, nowEpoch, ymdFromEpoch }) {
  const stmtGetRow     = db.prepare('SELECT balance, last_daily_at, last_stipend_at FROM chrome_balances WHERE username = ?');
  const stmtEnsureRow  = db.prepare('INSERT INTO chrome_balances (username, balance, created_at) VALUES (?, 0, ?) ON CONFLICT(username) DO NOTHING');
  const stmtAddBalance = db.prepare('UPDATE chrome_balances SET balance = balance + ? WHERE username = ?');
  const stmtSubBalance = db.prepare('UPDATE chrome_balances SET balance = balance - ? WHERE username = ?');
  const stmtInsertTx   = db.prepare('INSERT INTO chrome_transactions (username, amount, reason, created_at) VALUES (?, ?, ?, ?)');
  const stmtSetLastDaily   = db.prepare('UPDATE chrome_balances SET last_daily_at   = ? WHERE username = ?');
  const stmtSetLastStipend = db.prepare('UPDATE chrome_balances SET last_stipend_at = ? WHERE username = ?');
  const stmtLeaderboard    = db.prepare('SELECT username, balance FROM chrome_balances WHERE balance > 0 ORDER BY balance DESC LIMIT ?');
  const stmtGetJackpot     = db.prepare('SELECT amount FROM slots_jackpot WHERE id = 1');
  const stmtSetJackpot     = db.prepare('UPDATE slots_jackpot SET amount = ? WHERE id = 1');

  function ensureRow(username) {
    stmtEnsureRow.run(username, nowEpoch());
  }

  function getBalance(username) {
    const row = stmtGetRow.get(username);
    return row ? row.balance : 0;
  }

  function award(username, amount, reason) {
    ensureRow(username);
    stmtAddBalance.run(amount, username);
    stmtInsertTx.run(username, amount, reason, nowEpoch());
    return getBalance(username);
  }

  function spend(username, amount, reason) {
    ensureRow(username);
    const bal = getBalance(username);
    if (bal < amount) return { success: false, newBalance: bal };
    stmtSubBalance.run(amount, username);
    stmtInsertTx.run(username, -amount, reason, nowEpoch());
    return { success: true, newBalance: bal - amount };
  }

  function getDailyBonus(username) {
    const today = ymdFromEpoch(nowEpoch());
    ensureRow(username);
    const row = stmtGetRow.get(username);
    if (row.last_daily_at === today) return { awarded: false, amount: 0, newBalance: row.balance };
    const newBalance = award(username, 10, 'daily bonus');
    stmtSetLastDaily.run(today, username);
    return { awarded: true, amount: 10, newBalance };
  }

  function checkStipend(username) {
    const today = ymdFromEpoch(nowEpoch());
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
