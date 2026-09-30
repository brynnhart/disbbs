const test = require('node:test');
const assert = require('node:assert');

const { createDatabase } = require('../../src/database');
const { createChromeService } = require('../../src/services/chrome');
const { createModerationService } = require('../../src/services/moderation');
const { createDonationService, chromeForAmount } = require('../../src/services/donations');

let clock = 1_800_000_000;
const nowEpoch = () => ++clock;

function setup({ chromeOverride, moderationOverride, statementsOverride } = {}) {
  const { db, statements, helpers } = createDatabase({ dbPath: ':memory:' });
  for (const u of ['alice', 'bob', 'al', 'snake_case', 'dash-name', 'Mixed', 'spammer', 'troll']) helpers.createUser(u, 'x-password');
  const chrome = createChromeService({ db, nowEpoch, dayKeyET: () => 'd' });
  const moderation = createModerationService({ db, nowEpoch, chrome, resolveUserHandle: helpers.resolveUserHandle });
  const donations = createDonationService({
    db, nowEpoch,
    chrome: chromeOverride ? chromeOverride(chrome) : chrome,
    moderation: moderationOverride ? moderationOverride(moderation) : moderation,
    statements: statementsOverride ? statementsOverride(statements) : statements,
  });
  return { db, statements, chrome, moderation, donations };
}

// The webhook's attribution code before this change, verbatim, as the
// reference for "normal donations are attributed exactly as before".
function oldResolve(statements, message, kofiName) {
  const { getUserByName, getDonationLinkByKofi } = statements;
  let disUsername = null;
  if (message) {
    const words = message.split(/\s+/);
    for (const word of words) {
      const cleaned = word.replace(/[^a-zA-Z0-9_-]/g, '');
      if (!cleaned) continue;
      const user = getUserByName.get(cleaned);
      if (user) { disUsername = user.username; break; }
    }
  }
  if (!disUsername) {
    const link = getDonationLinkByKofi.get(kofiName);
    if (link) disUsername = link.dis_username;
  }
  return disUsername;
}

const count = (db, sql, ...p) => db.prepare(sql).get(...p).n;
const ledger = (db, u) => db.prepare('SELECT amount, reason FROM chrome_transactions WHERE username = ? ORDER BY id').all(u);
const modLog = (db) => db.prepare('SELECT actor, action, target, ref_id, detail FROM mod_log ORDER BY id').all();
const donationRow = (db, tx) => db.prepare('SELECT * FROM donations WHERE kofi_transaction_id = ?').get(tx);

// Messages with no banned names: attribution must match the old code exactly.
const PARITY_CASES = [
  ['', 'Stranger'],
  ['', 'KofiBob'],
  ['keep up the good work', 'Stranger'],
  ['keep up the good work', 'KofiBob'],
  ['from alice', 'Stranger'],
  ['from alice', 'KofiBob'],
  ['alice and bob', 'Stranger'],
  ['bob and alice', 'Stranger'],
  ['thanks @alice!', 'Stranger'],
  ['ALICE rocks', 'Stranger'],
  ['for al, not alice', 'Stranger'],
  ['(snake_case) sends love', 'Stranger'],
  ['dash-name.', 'Stranger'],
  ['mixed case: MIXED', 'Stranger'],
  ['nobody-here at all', 'KofiBob'],
  ['   alice   ', 'Stranger'],
];

test('attribution for donations with no banned names is identical to the old webhook code', () => {
  const { statements, donations } = setup();
  statements.insertDonationLink.run('KofiBob', 'bob', 1);
  for (const [message, kofi] of PARITY_CASES) {
    const before = oldResolve(statements, message, kofi);
    const after = donations.resolveDonationTarget(message, kofi);
    assert.strictEqual(after.username, before, `message=${JSON.stringify(message)} kofi=${kofi}`);
    assert.strictEqual(after.heldFor, null);
  }
});

test('the only attribution changes involve banned names (before → after)', () => {
  const { statements, moderation, donations } = setup();
  statements.insertDonationLink.run('KofiBob', 'bob', 1);
  statements.insertDonationLink.run('KofiTroll', 'troll', 1);
  moderation.banUser({ actor: 'Punkyroo', username: 'spammer' });
  moderation.banUser({ actor: 'Punkyroo', username: 'troll' });
  const cases = [
    // [message, kofi, old target, new target, new heldFor]
    ['thanks spammer and alice', 'Stranger', 'spammer', 'alice', null],
    ['spammer', 'KofiBob', 'spammer', 'bob', null],
    ['spammer', 'Stranger', 'spammer', null, 'spammer'],
    ['love', 'KofiTroll', 'troll', null, 'troll'],
    ['from alice', 'KofiTroll', 'alice', 'alice', null],
  ];
  for (const [message, kofi, oldTarget, newTarget, held] of cases) {
    assert.strictEqual(oldResolve(statements, message, kofi), oldTarget);
    const r = donations.resolveDonationTarget(message, kofi);
    assert.deepStrictEqual([r.username, r.heldFor], [newTarget, held], `${message} / ${kofi}`);
  }
});

test('webhook: normal donation is awarded once, in the ledger and on the row', () => {
  const { db, donations, chrome } = setup();
  const r = donations.recordKofiDonation({ txId: 'tx-1', kofiName: 'Stranger', amount: 5, message: 'from alice' });
  assert.deepStrictEqual([r.status, r.username, r.chromeAmount, r.matchedBy], ['awarded', 'alice', 500, 'message']);
  assert.deepStrictEqual(ledger(db, 'alice'), [{ amount: 500, reason: 'donation bonus' }]);
  assert.strictEqual(chrome.getBalance('alice'), 500);
  const row = donationRow(db, 'tx-1');
  assert.deepStrictEqual([row.dis_username, row.chrome_awarded], ['alice', 500]);
  assert.deepStrictEqual(modLog(db), []);
});

test('webhook: banned name skipped, scan continues to the next valid name', () => {
  const { db, moderation, donations } = setup();
  moderation.banUser({ actor: 'Punkyroo', username: 'spammer' });
  const r = donations.recordKofiDonation({ txId: 'tx-2', kofiName: 'Stranger', amount: 3, message: 'spammer told me about alice' });
  assert.deepStrictEqual([r.status, r.username], ['awarded', 'alice']);
  assert.deepStrictEqual(ledger(db, 'spammer'), []);
});

test('webhook: only a banned name → stored unlinked with 0 chrome, held and logged', () => {
  const { db, moderation, donations } = setup();
  moderation.banUser({ actor: 'Punkyroo', username: 'spammer' });
  const before = modLog(db).length;
  const r = donations.recordKofiDonation({ txId: 'tx-3', kofiName: 'SpamKofi', amount: 2.5, message: 'this is spammer' });
  assert.deepStrictEqual([r.status, r.heldFor, r.chromeAmount, r.matchedBy], ['held_banned', 'spammer', 250, 'message']);
  const row = donationRow(db, 'tx-3');
  assert.deepStrictEqual([row.dis_username, row.chrome_awarded, row.amount], [null, 0, 2.5]);
  assert.deepStrictEqual(ledger(db, 'spammer'), []);
  const log = modLog(db).slice(before);
  assert.strictEqual(log.length, 1);
  assert.deepStrictEqual([log[0].actor, log[0].action, log[0].target, log[0].ref_id], ['kofi-webhook', 'donation_skipped_banned', 'spammer', row.id]);
  assert.deepStrictEqual(JSON.parse(log[0].detail), {
    source: 'kofi_webhook', tx_id: 'tx-3', kofi_name: 'SpamKofi', amount_usd: 2.5, chrome: 250,
    matched_by: 'message', skipped_banned: ['spammer'],
  });
});

test('webhook: Ko-fi name linked to a banned account → held and logged (matched_by link)', () => {
  const { db, statements, moderation, donations } = setup();
  statements.insertDonationLink.run('KofiTroll', 'troll', 1);
  moderation.banUser({ actor: 'Punkyroo', username: 'troll' });
  const r = donations.recordKofiDonation({ txId: 'tx-4', kofiName: 'KofiTroll', amount: 1, message: '' });
  assert.deepStrictEqual([r.status, r.heldFor, r.matchedBy], ['held_banned', 'troll', 'link']);
  assert.strictEqual(donationRow(db, 'tx-4').dis_username, null);
  assert.deepStrictEqual(ledger(db, 'troll'), []);
  assert.strictEqual(modLog(db).filter(l => l.action === 'donation_skipped_banned').length, 1);
});

test('webhook: banned name in message + Ko-fi name linked to a visible user → awarded to the link', () => {
  const { db, statements, moderation, donations } = setup();
  statements.insertDonationLink.run('KofiBob', 'bob', 1);
  moderation.banUser({ actor: 'Punkyroo', username: 'spammer' });
  const r = donations.recordKofiDonation({ txId: 'tx-5', kofiName: 'KofiBob', amount: 1, message: 'spammer' });
  assert.deepStrictEqual([r.status, r.username, r.matchedBy], ['awarded', 'bob', 'link']);
  assert.deepStrictEqual(ledger(db, 'bob'), [{ amount: 100, reason: 'donation bonus' }]);
});

test('webhook: no match at all → unlinked, no award, no mod_log (unchanged behavior)', () => {
  const { db, donations } = setup();
  const r = donations.recordKofiDonation({ txId: 'tx-6', kofiName: 'Stranger', amount: 4, message: 'hi' });
  assert.strictEqual(r.status, 'unlinked');
  assert.deepStrictEqual([donationRow(db, 'tx-6').dis_username, donationRow(db, 'tx-6').chrome_awarded], [null, 0]);
  assert.deepStrictEqual(modLog(db), []);
});

test('duplicate delivery of an awarded donation: no second row, award or log', () => {
  const { db, donations } = setup();
  const payload = { txId: 'tx-dup', kofiName: 'Stranger', amount: 5, message: 'from alice' };
  assert.strictEqual(donations.recordKofiDonation(payload).status, 'awarded');
  assert.strictEqual(donations.recordKofiDonation(payload).status, 'duplicate');
  assert.strictEqual(donations.recordKofiDonation(payload).status, 'duplicate');
  assert.strictEqual(count(db, "SELECT COUNT(1) n FROM donations WHERE kofi_transaction_id = 'tx-dup'"), 1);
  assert.deepStrictEqual(ledger(db, 'alice'), [{ amount: 500, reason: 'donation bonus' }]);
  assert.deepStrictEqual(modLog(db), []);
});

test('duplicate delivery of a held donation: exactly one mod_log row', () => {
  const { db, moderation, donations } = setup();
  moderation.banUser({ actor: 'Punkyroo', username: 'spammer' });
  const payload = { txId: 'tx-dup2', kofiName: 'X', amount: 1, message: 'spammer' };
  donations.recordKofiDonation(payload);
  assert.strictEqual(donations.recordKofiDonation(payload).status, 'duplicate');
  assert.strictEqual(modLog(db).filter(l => l.action === 'donation_skipped_banned').length, 1);
  assert.strictEqual(count(db, "SELECT COUNT(1) n FROM donations WHERE kofi_transaction_id = 'tx-dup2'"), 1);
});

test('duplicate that slips past the pre-check is stopped by the UNIQUE constraint with no award', () => {
  const { db, donations } = setup({
    statementsOverride: (s) => Object.assign({}, s, { getDonationByTxId: { get: () => undefined } }),
  });
  const payload = { txId: 'tx-race', kofiName: 'Stranger', amount: 2, message: 'from alice' };
  assert.strictEqual(donations.recordKofiDonation(payload).status, 'awarded');
  assert.strictEqual(donations.recordKofiDonation(payload).status, 'duplicate');
  assert.deepStrictEqual(ledger(db, 'alice'), [{ amount: 200, reason: 'donation bonus' }]);
  assert.strictEqual(count(db, "SELECT COUNT(1) n FROM donations WHERE kofi_transaction_id = 'tx-race'"), 1);
});

test('award failure: row and chrome roll back together; donation kept unlinked and logged', () => {
  const { db, donations } = setup({
    chromeOverride: (real) => Object.assign({}, real, { award: (...a) => { real.award(...a); throw new Error('award blew up'); } }),
  });
  const r = donations.recordKofiDonation({ txId: 'tx-fail', kofiName: 'Stranger', amount: 3, message: 'from alice' });
  assert.deepStrictEqual([r.status, r.intended], ['award_failed', 'alice']);
  assert.deepStrictEqual([donationRow(db, 'tx-fail').dis_username, donationRow(db, 'tx-fail').chrome_awarded], [null, 0]);
  assert.deepStrictEqual(ledger(db, 'alice'), []);
  const log = modLog(db);
  assert.deepStrictEqual([log.length, log[0].action, log[0].target], [1, 'donation_award_failed', 'alice']);
  assert.strictEqual(JSON.parse(log[0].detail).tx_id, 'tx-fail');
});

test('fail safe: if the ban check throws, nothing is awarded and the donation is held and logged', () => {
  const { db, donations } = setup({
    moderationOverride: (m) => Object.assign({}, m, { isBannedUsername: () => { throw new Error('db down'); } }),
  });
  const r = donations.recordKofiDonation({ txId: 'tx-safe', kofiName: 'Stranger', amount: 1, message: 'from alice' });
  assert.deepStrictEqual([r.status, r.heldFor], ['held_banned', 'alice']);
  assert.deepStrictEqual(ledger(db, 'alice'), []);
  assert.strictEqual(modLog(db)[0].action, 'donation_skipped_banned');
});

test('/linkdonor to a banned account: link created, nothing awarded, held donations logged once per run', () => {
  const { db, statements, moderation, donations } = setup();
  moderation.banUser({ actor: 'Punkyroo', username: 'spammer' });
  donations.recordKofiDonation({ txId: 'h1', kofiName: 'SpamKofi', amount: 1, message: 'hi' });
  donations.recordKofiDonation({ txId: 'h2', kofiName: 'SpamKofi', amount: 2.5, message: '' });
  const res = donations.linkDonor({ actor: 'Punkyroo', kofiName: 'SpamKofi', username: 'spammer' });
  assert.deepStrictEqual([res.ok, res.banned, res.held.count, res.held.chrome, res.awarded.count], [true, true, 2, 350, 0]);
  assert.strictEqual(statements.getDonationLinkByKofi.get('SpamKofi').dis_username, 'spammer');
  assert.strictEqual(count(db, "SELECT COUNT(1) n FROM donations WHERE kofi_name = 'SpamKofi' AND dis_username IS NULL"), 2);
  assert.deepStrictEqual(ledger(db, 'spammer'), []);
  const log = modLog(db).filter(l => l.action === 'donation_skipped_banned');
  assert.strictEqual(log.length, 1);
  const detail = JSON.parse(log[0].detail);
  assert.deepStrictEqual([detail.source, detail.count, detail.chrome], ['linkdonor', 2, 350]);
  assert.deepStrictEqual(detail.donations.map(d => d.tx_id), ['h1', 'h2']);
});

test('/linkdonor after /unban awards held donations exactly once; a second run awards nothing', () => {
  const { db, moderation, donations, chrome } = setup();
  moderation.banUser({ actor: 'Punkyroo', username: 'spammer' });
  // Held by the webhook (message names only the banned account).
  donations.recordKofiDonation({ txId: 'held-1', kofiName: 'SpamKofi', amount: 2, message: 'spammer' });
  donations.linkDonor({ actor: 'Punkyroo', kofiName: 'SpamKofi', username: 'spammer' });
  // Held by the link while banned.
  donations.recordKofiDonation({ txId: 'held-2', kofiName: 'SpamKofi', amount: 1, message: '' });
  assert.strictEqual(donations.recordKofiDonation({ txId: 'held-2', kofiName: 'SpamKofi', amount: 1, message: '' }).status, 'duplicate');
  assert.deepStrictEqual(ledger(db, 'spammer'), []);

  moderation.unban({ actor: 'Punkyroo', ref: 'spammer' });

  const first = donations.linkDonor({ actor: 'Punkyroo', kofiName: 'SpamKofi', username: 'spammer' });
  assert.deepStrictEqual([first.banned, first.awarded.count, first.awarded.chrome], [false, 2, 300]);
  assert.deepStrictEqual(ledger(db, 'spammer'), [{ amount: 200, reason: 'donation bonus' }, { amount: 100, reason: 'donation bonus' }]);
  assert.deepStrictEqual(db.prepare("SELECT kofi_transaction_id tx, dis_username u, chrome_awarded c FROM donations WHERE kofi_name = 'SpamKofi' ORDER BY id").all(),
    [{ tx: 'held-1', u: 'spammer', c: 200 }, { tx: 'held-2', u: 'spammer', c: 100 }]);

  const second = donations.linkDonor({ actor: 'Punkyroo', kofiName: 'SpamKofi', username: 'spammer' });
  assert.deepStrictEqual([second.awarded.count, second.awarded.chrome], [0, 0]);
  assert.strictEqual(ledger(db, 'spammer').length, 2);
  assert.strictEqual(chrome.getBalance('spammer'), 300);
});

test('/linkdonor never touches donations that were already awarded', () => {
  const { db, donations } = setup();
  donations.recordKofiDonation({ txId: 'a1', kofiName: 'AliceKofi', amount: 1, message: 'from alice' });
  const res = donations.linkDonor({ actor: 'Punkyroo', kofiName: 'AliceKofi', username: 'alice' });
  assert.strictEqual(res.awarded.count, 0);
  assert.deepStrictEqual(ledger(db, 'alice'), [{ amount: 100, reason: 'donation bonus' }]);
});

test('/linkdonor award failure rolls back the claim; donation stays held and is logged', () => {
  let fail = true;
  const { db, donations } = setup({
    chromeOverride: (real) => Object.assign({}, real, { award: (...a) => { real.award(...a); if (fail) throw new Error('boom'); } }),
  });
  donations.recordKofiDonation({ txId: 'u1', kofiName: 'NewKofi', amount: 1, message: '' });
  const res = donations.linkDonor({ actor: 'Punkyroo', kofiName: 'NewKofi', username: 'bob' });
  assert.deepStrictEqual([res.awarded.count, res.failed], [0, 1]);
  assert.strictEqual(donationRow(db, 'u1').dis_username, null);
  assert.deepStrictEqual(ledger(db, 'bob'), []);
  assert.strictEqual(modLog(db).filter(l => l.action === 'donation_award_failed').length, 1);
  fail = false;
  assert.strictEqual(donations.linkDonor({ actor: 'Punkyroo', kofiName: 'NewKofi', username: 'bob' }).awarded.count, 1);
  assert.deepStrictEqual(ledger(db, 'bob'), [{ amount: 100, reason: 'donation bonus' }]);
});

test('/linkdonor refuses unknown accounts; zero-dollar donations are claimed without a ledger row', () => {
  const { db, donations } = setup();
  assert.strictEqual(donations.linkDonor({ actor: 'Punkyroo', kofiName: 'K', username: 'ghost' }).reason, 'not_found');
  donations.recordKofiDonation({ txId: 'z1', kofiName: 'ZeroKofi', amount: 0, message: '' });
  const res = donations.linkDonor({ actor: 'Punkyroo', kofiName: 'ZeroKofi', username: 'bob' });
  assert.deepStrictEqual([res.awarded.count, res.awarded.chrome], [1, 0]);
  assert.deepStrictEqual(ledger(db, 'bob'), []);
  assert.strictEqual(donationRow(db, 'z1').dis_username, 'bob');
  assert.strictEqual(chromeForAmount(2.5), 250);
});
