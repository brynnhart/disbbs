const test = require('node:test');
const assert = require('node:assert');

const { createNotificationService } = require('../../src/services/notifications');
const formatting = require('../../src/utils/formatting');

test('extractMentionsFromText finds unique handles with punctuation', () => {
  const service = createNotificationService({
    statements: {
      insertNotification: { run() {} },
      listNotificationsForUser: { all: () => [] },
      markAllNotificationsSeen: { run() {} },
    },
    helpers: { resolveUserHandle: () => null },
    hub: { sendOps() {}, hub: { socketsByUser: new Map() } },
    timeUtils: { nowEpoch: () => 0 },
    formatting,
  });

  const raw = "Hey @Alice! Talk to @bob, and maybe @alice again.";
  assert.deepStrictEqual(service.extractMentionsFromText(raw), ['alice', 'bob']);
});

test('humanizeContext names known locations', () => {
  const service = createNotificationService({
    statements: {
      insertNotification: { run() {} },
      listNotificationsForUser: { all: () => [] },
      markAllNotificationsSeen: { run() {} },
    },
    helpers: { resolveUserHandle: () => null },
    hub: { sendOps() {}, hub: { socketsByUser: new Map() } },
    timeUtils: { nowEpoch: () => 0 },
    formatting,
  });

  assert.strictEqual(service.humanizeContext('chat'), 'Chat');
  assert.strictEqual(service.humanizeContext('adminchat'), 'Admin Chat');
  assert.strictEqual(service.humanizeContext('status'), 'Status Feed');
  assert.strictEqual(service.humanizeContext('topic:42'), 'Topic #42');
  assert.strictEqual(service.humanizeContext('news:7'), 'News #7');
  assert.strictEqual(service.humanizeContext('somewhere'), 'somewhere');
});

test('notifyMentions creates notifications and alerts connected users', () => {
  const inserted = [];
  const sentOps = [];
  const socketsByUser = new Map();
  const fakeSocket = { id: 'socket-1' };
  socketsByUser.set('Target', new Set([fakeSocket]));

  const service = createNotificationService({
    statements: {
      insertNotification: { run: (...args) => inserted.push(args) },
      listNotificationsForUser: { all: () => [] },
      markAllNotificationsSeen: { run() {} },
    },
    helpers: {
      resolveUserHandle: (handle) => {
        if (handle === 'target') {
          return { row: { id: 2, username: 'Target' } };
        }
        return null;
      },
    },
    hub: {
      sendOps: (ws, ops) => sentOps.push({ ws, ops }),
      hub: { socketsByUser },
    },
    timeUtils: { nowEpoch: () => 1234 },
    formatting,
  });

  service.notifyMentions('Hello @Target and @target again', { id: 1, username: 'Alice' }, 'chat');

  assert.strictEqual(inserted.length, 1);
  const [args] = inserted;
  assert.deepStrictEqual(args, [2, 1, 'mention', 'chat', 'Hello @Target and @target again', 1234]);

  assert.strictEqual(sentOps.length, 1);
  const notice = sentOps[0];
  assert.strictEqual(notice.ws, fakeSocket);
  assert.deepStrictEqual(notice.ops, [
    { op: 'beep' },
    { op: 'printHTML', html: '* Alice mentioned you in Chat — /notifications to read', cls: 'dim' },
  ]);
});

test('notifyDM renders DIS-Markdown tags in the sender name and pushes unread status', () => {
  const sentOps = [];
  const socketsByUser = new Map();
  const fakeSocket = { id: 'socket-1' };
  socketsByUser.set('punkyroo', new Set([fakeSocket]));

  const service = createNotificationService({
    statements: {
      insertNotification: { run() {} },
      listNotificationsForUser: { all: () => [] },
      markAllNotificationsSeen: { run() {} },
      countUnreadDMs: { get: () => ({ count: 3 }) },
    },
    helpers: { resolveUserHandle: () => null },
    hub: { sendOps: (ws, ops) => sentOps.push({ ws, ops }), hub: { socketsByUser } },
    timeUtils: { nowEpoch: () => 0 },
    formatting,
  });

  service.notifyDM({ id: 9, username: 'punkyroo' }, '[magenta]punkyroo[/magenta]');

  assert.strictEqual(sentOps.length, 1);
  const { ws, ops } = sentOps[0];
  assert.strictEqual(ws, fakeSocket);
  assert.deepStrictEqual(ops[1], {
    op: 'printHTML',
    html: '* incoming from <span class="uc-magenta">punkyroo</span> — /messages to read',
    cls: 'dim',
  });
  assert.deepStrictEqual(ops[2], { op: 'status', unread: 3 });
});

test('notifyMentions sends an away auto-reply to the sender once per away-session', () => {
  const sentOps = [];
  const socketsByUser = new Map();
  const targetSocket = { id: 'target-socket' };
  const senderSocket = { id: 'sender-socket' };
  socketsByUser.set('Target', new Set([targetSocket]));
  socketsByUser.set('Alice', new Set([senderSocket]));
  const away = new Map();
  away.set('target', { message: 'gardening', notified: new Set() });

  const service = createNotificationService({
    statements: {
      insertNotification: { run() {} },
      listNotificationsForUser: { all: () => [] },
      markAllNotificationsSeen: { run() {} },
    },
    helpers: {
      resolveUserHandle: (handle) => (handle === 'target' ? { row: { id: 2, username: 'Target' } } : null),
    },
    hub: {
      sendOps: (ws, ops) => sentOps.push({ ws, ops }),
      hub: { socketsByUser, away },
    },
    timeUtils: { nowEpoch: () => 1234 },
    formatting,
  });

  service.notifyMentions('Hello @Target', { id: 1, username: 'Alice' }, 'chat');
  service.notifyMentions('Hello again @Target', { id: 1, username: 'Alice' }, 'chat');

  const senderNotices = sentOps.filter(({ ws }) => ws === senderSocket);
  assert.strictEqual(senderNotices.length, 1, 'auto-reply should fire once per sender per away-session');
  assert.deepStrictEqual(senderNotices[0].ops, [
    { op: 'print', text: '* Target is away: gardening', cls: 'dim' },
  ]);
});

test('listMentionsForUser and markMentionsSeen proxy to statements', () => {
  const listed = ['mention'];
  let marked = 0;
  const service = createNotificationService({
    statements: {
      insertNotification: { run() {} },
      listNotificationsForUser: { all: (userId, limit) => [userId, limit, listed] },
      markAllNotificationsSeen: { run: (userId) => { marked = userId; } },
    },
    helpers: { resolveUserHandle: () => null },
    hub: { sendOps() {}, hub: { socketsByUser: new Map() } },
    timeUtils: { nowEpoch: () => 0 },
    formatting,
  });

  assert.deepStrictEqual(service.listMentionsForUser(5, 10), [5, 10, listed]);
  service.markMentionsSeen(7);
  assert.strictEqual(marked, 7);
});
