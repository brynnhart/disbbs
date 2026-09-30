'use strict';

// Ko-fi donations: attribution, chrome awards, and holds for banned accounts.
//
// Rules:
// - A transaction id is recorded once. Redeliveries change nothing.
// - Every award goes through the chrome service, in the same transaction as
//   the donation row, so a donation is never marked awarded without its
//   chrome or the reverse.
// - Banned accounts are never awarded. Their donations are stored unlinked
//   with 0 chrome (so /linkdonor can award them after an /unban), and every
//   such skip writes a mod_log row. No donation is dropped silently.
// - A donation is awarded at most once: /linkdonor only claims rows that are
//   still unlinked, and the claim and the award commit together.

// Chrome for a donation amount in dollars.
function chromeForAmount(amount) {
  return Math.floor((Number(amount) || 0) * 100);
}

// Candidate usernames in a donation message, in order.
function messageWords(message) {
  if (!message) return [];
  return String(message).split(/\s+/)
    .map(word => word.replace(/[^a-zA-Z0-9_-]/g, ''))
    .filter(Boolean);
}

function createDonationService({ db, nowEpoch, chrome, moderation, statements }) {
  const { getUserByName, getDonationByTxId, insertDonation, getDonationLinkByKofi, insertDonationLink } = statements;
  const stmtHeldForKofi = db.prepare(`
    SELECT id, kofi_transaction_id, amount FROM donations
     WHERE LOWER(kofi_name) = LOWER(?) AND dis_username IS NULL
     ORDER BY id
  `);
  // Claim guard: only an unlinked row can be claimed, so a second run finds
  // nothing to award.
  const stmtClaimDonation = db.prepare(`
    UPDATE donations SET dis_username = ?, chrome_awarded = ? WHERE id = ? AND dis_username IS NULL
  `);

  // Fails safe: if the ban check itself fails, treat the account as banned
  // so nothing is awarded.
  function isBanned(username) {
    try { return moderation.isBannedUsername(username); } catch (e) { return true; }
  }

  // Who a webhook donation is for. The message is scanned word by word as
  // before; banned names are skipped (and remembered) and the scan
  // continues. Then the Ko-fi name link. heldFor is set when the donation
  // would have gone to a banned account.
  function resolveDonationTarget(message, kofiName) {
    const skippedBanned = [];
    for (const word of messageWords(message)) {
      const user = getUserByName.get(word);
      if (!user) continue;
      if (isBanned(user.username)) { skippedBanned.push(user.username); continue; }
      return { username: user.username, matchedBy: 'message', heldFor: null, skippedBanned };
    }
    const link = kofiName ? getDonationLinkByKofi.get(kofiName) : null;
    if (link) {
      if (isBanned(link.dis_username)) {
        return { username: null, matchedBy: 'link', heldFor: link.dis_username, skippedBanned };
      }
      return { username: link.dis_username, matchedBy: 'link', heldFor: null, skippedBanned };
    }
    if (skippedBanned.length) {
      return { username: null, matchedBy: 'message', heldFor: skippedBanned[0], skippedBanned };
    }
    return { username: null, matchedBy: null, heldFor: null, skippedBanned };
  }

  function isUniqueViolation(e) {
    return !!e && /UNIQUE constraint failed: donations\.kofi_transaction_id/.test(e.message || '');
  }

  // Records one Ko-fi delivery. Returns { status, ... } where status is
  // 'duplicate', 'awarded', 'unlinked', 'held_banned' or 'award_failed'.
  // Throws only if even the fallback record fails, so the caller can return
  // a non-200 and let Ko-fi retry (nothing was written in that case).
  function recordKofiDonation({ txId, kofiName, amount, message }) {
    const tx = String(txId || '').trim();
    const name = String(kofiName || '').trim();
    const amt = Number(amount) || 0;
    const msg = String(message || '').trim();
    if (getDonationByTxId.get(tx)) return { status: 'duplicate' };

    const target = resolveDonationTarget(msg, name);
    const chromeAmount = chromeForAmount(amt);
    const now = nowEpoch();

    try {
      return db.transaction(() => {
        if (target.username) {
          const info = insertDonation.run(tx, name, target.username, amt, msg, chromeAmount, now);
          if (chromeAmount > 0) chrome.award(target.username, chromeAmount, 'donation bonus');
          return { status: 'awarded', donationId: Number(info.lastInsertRowid), username: target.username, chromeAmount, matchedBy: target.matchedBy };
        }
        const info = insertDonation.run(tx, name, null, amt, msg, 0, now);
        const donationId = Number(info.lastInsertRowid);
        if (target.heldFor) {
          moderation.log('kofi-webhook', 'donation_skipped_banned', target.heldFor, donationId, {
            source: 'kofi_webhook', tx_id: tx, kofi_name: name, amount_usd: amt, chrome: chromeAmount,
            matched_by: target.matchedBy, skipped_banned: target.skippedBanned,
          });
          return { status: 'held_banned', donationId, heldFor: target.heldFor, chromeAmount, matchedBy: target.matchedBy };
        }
        return { status: 'unlinked', donationId, chromeAmount };
      })();
    } catch (e) {
      if (isUniqueViolation(e)) return { status: 'duplicate' };
      // The award (or the row) failed and everything rolled back. Record the
      // donation unlinked with 0 chrome and log it, so /linkdonor can award
      // it later and nothing is lost.
      return db.transaction(() => {
        const info = insertDonation.run(tx, name, null, amt, msg, 0, now);
        const donationId = Number(info.lastInsertRowid);
        moderation.log('kofi-webhook', 'donation_award_failed', target.username || target.heldFor || null, donationId, {
          source: 'kofi_webhook', tx_id: tx, kofi_name: name, amount_usd: amt, chrome: chromeAmount,
          intended: target.username, error: String((e && e.message) || e),
        });
        return { status: 'award_failed', donationId, intended: target.username, chromeAmount };
      })();
    }
  }

  // /linkdonor <kofi> <username>. Always creates/updates the link. Awards
  // every still-unlinked donation for that Ko-fi name exactly once, unless
  // the account is banned: then nothing is awarded, the donations stay
  // unlinked, and one mod_log row lists them.
  function linkDonor({ actor, kofiName, username }) {
    const actorName = String(actor || '').trim();
    const kofi = String(kofiName || '').trim();
    const user = getUserByName.get(String(username || '').trim());
    if (!actorName || !kofi) return { ok: false, reason: 'usage' };
    if (!user) return { ok: false, reason: 'not_found' };

    insertDonationLink.run(kofi, user.username, nowEpoch());

    const held = stmtHeldForKofi.all(kofi);
    if (isBanned(user.username)) {
      const chromeTotal = held.reduce((s, d) => s + chromeForAmount(d.amount), 0);
      const amountTotal = held.reduce((s, d) => s + (Number(d.amount) || 0), 0);
      if (held.length) {
        moderation.log(actorName, 'donation_skipped_banned', user.username, null, {
          source: 'linkdonor', kofi_name: kofi, count: held.length, amount_usd: amountTotal, chrome: chromeTotal,
          donations: held.map(d => ({ tx_id: d.kofi_transaction_id, amount_usd: d.amount, chrome: chromeForAmount(d.amount) })),
        });
      }
      return { ok: true, username: user.username, banned: true, held: { count: held.length, amount: amountTotal, chrome: chromeTotal }, awarded: { count: 0, chrome: 0 } };
    }

    let count = 0;
    let chromeTotal = 0;
    const failures = [];
    for (const d of held) {
      const cr = chromeForAmount(d.amount);
      try {
        db.transaction(() => {
          // Claim first: if another run already claimed it, award nothing.
          if (stmtClaimDonation.run(user.username, cr, d.id).changes !== 1) return;
          if (cr > 0) chrome.award(user.username, cr, 'donation bonus');
          count++;
          chromeTotal += cr;
        })();
      } catch (e) {
        failures.push({ tx_id: d.kofi_transaction_id, error: String((e && e.message) || e) });
      }
    }
    if (failures.length) {
      moderation.log(actorName, 'donation_award_failed', user.username, null, { source: 'linkdonor', kofi_name: kofi, failures });
    }
    return { ok: true, username: user.username, banned: false, awarded: { count, chrome: chromeTotal }, failed: failures.length };
  }

  return { resolveDonationTarget, recordKofiDonation, linkDonor };
}

module.exports = { createDonationService, chromeForAmount, messageWords };
