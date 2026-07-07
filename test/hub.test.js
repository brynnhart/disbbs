const test = require('node:test');
const assert = require('node:assert');

const { createHub } = require('../src/hub');

test('broadcastChatFrom delivers messages to chat clients with day separators', () => {
  const hubApi = createHub({
    timeUtils: {
      dayHeadingET: (ms) => `Day ${Math.floor(ms / 86400000)}`,
      dayKeyET: (ms) => `day-${Math.floor(ms / 86400000)}`,
    },
    formatting: { escapeHTML: (val) => String(val) },
  });

  const sent = new Map();
  function makeClient(username, screen = 'chat') {
    const records = [];
    const ws = {
      readyState: 1,
      OPEN: 1,
      send(payload) {
        records.push(JSON.parse(payload));
      },
      __ctx: { state: { username, currentScreen: screen } },
    };
    sent.set(ws, records);
    hubApi.hub.clients.add(ws);
    return ws;
  }

  const alice = makeClient('Alice');
  const bob = makeClient('Bob');
  const spectator = makeClient('Spectator', 'menu');

  hubApi.broadcastChatFrom('<b>hi</b>', 'Alice', 100);
  hubApi.broadcastChatFrom('<b>hello</b>', 'Bob', 120);
  hubApi.broadcastChatFrom('<b>new day</b>', 'Bob', 172800);

  const aliceFirst = sent.get(alice)[0];
  assert.deepStrictEqual(aliceFirst, {
    type: 'ops',
    ops: [
      { op: 'printHTML', html: '<span class="dim">── Day 0 ──</span>', cls: 'chat-day' },
      { op: 'printHTML', html: '<b>hi</b>', cls: 'chat-msg me' },
    ],
  });

  const bobFirst = sent.get(bob)[0];
  assert.deepStrictEqual(bobFirst, {
    type: 'ops',
    ops: [
      { op: 'printHTML', html: '<span class="dim">── Day 0 ──</span>', cls: 'chat-day' },
      { op: 'printHTML', html: '<b>hi</b>', cls: 'chat-msg' },
    ],
  });

  const aliceSecondOps = sent.get(alice)[1].ops;
  assert.strictEqual(aliceSecondOps.length, 1);
  assert.deepStrictEqual(aliceSecondOps[0], { op: 'printHTML', html: '<b>hello</b>', cls: 'chat-msg' });

  const aliceThird = sent.get(alice)[2];
  assert.deepStrictEqual(aliceThird.ops[0], { op: 'printHTML', html: '<span class="dim">── Day 2 ──</span>', cls: 'chat-day' });
  assert.deepStrictEqual(aliceThird.ops[1], { op: 'printHTML', html: '<b>new day</b>', cls: 'chat-msg' });

  const spectatorRecords = sent.get(spectator);
  assert.strictEqual(spectatorRecords.length, 0, 'non-chat client should not receive messages');
});

test('usersCurrentlyInChat lists sorted usernames', () => {
  const hubApi = createHub({
    timeUtils: {
      dayHeadingET: () => 'Day',
      dayKeyET: () => 'day',
    },
    formatting: { escapeHTML: (val) => String(val) },
  });

  function makeClient(username, screen) {
    const ws = {
      readyState: 1,
      send() {},
      __ctx: { state: { username, currentScreen: screen } },
    };
    hubApi.hub.clients.add(ws);
  }

  makeClient('Charlie', 'chat');
  makeClient('alice', 'chat');
  makeClient('Bob', 'menu');

  assert.deepStrictEqual(hubApi.usersCurrentlyInChat(), ['alice', 'Charlie']);
});
