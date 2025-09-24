const test = require('node:test');
const assert = require('node:assert');

const { createNotificationService } = require('../../src/services/notifications');

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
    { op: 'print', text: '🔔 Alice mentioned you in Chat.', cls: 'cyan' },
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
  });

  assert.deepStrictEqual(service.listMentionsForUser(5, 10), [5, 10, listed]);
  service.markMentionsSeen(7);
  assert.strictEqual(marked, 7);
});
