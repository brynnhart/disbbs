'use strict';

const crypto = require('crypto');

function delayRandom(minMs, maxMs) {
  const span = Math.max(0, maxMs - minMs);
  const wait = minMs + Math.random() * span;
  return new Promise(resolve => setTimeout(resolve, wait));
}

function createRockoService({
  statements,
  helpers,
  formatting,
  timeUtils,
  notifications,
  hub,
  openAI = {},
  logger = console,
} = {}) {
  if (!statements || !helpers || !formatting || !timeUtils || !notifications || !hub) {
    throw new Error('createRockoService requires database, formatting, notification, and hub dependencies.');
  }

  const {
    getUserByName,
    setUserDisplay,
    setUserColor,
    insertMessage,
    recentMessages,
    insertDM,
    getSetting,
  } = statements;

  const { createUser } = helpers;
  const { sanitizeAndFormatDIS, stripDISFormatting } = formatting;
  const { nowEpoch } = timeUtils;
  const { notifyMentions, extractMentionsFromText } = notifications;
  const { broadcastChatFrom, sendOps, hub: hubState } = hub;

  const username = 'Rocko';
  const usernameLower = username.toLowerCase();
  const desiredDisplayName = '[blue]Rocko[/blue]';
  const desiredColor = '#2fd44f'; // normalized hex for the "green" chat color

  let userRow = getUserByName?.get ? getUserByName.get(username) : null;

  if (!userRow && typeof createUser === 'function') {
    try {
      const password = crypto.randomBytes(24).toString('hex');
      const res = createUser(username, password, { isAdmin: false });
      if (res?.ok) {
        logger?.info?.('[rocko] created service account');
      } else {
        logger?.warn?.(`[rocko] failed to create service account: ${res?.reason || 'unknown reason'}`);
      }
    } catch (err) {
      logger?.error?.('[rocko] error creating user account', err);
    }
    userRow = getUserByName?.get ? getUserByName.get(username) : null;
  }

  if (userRow && (setUserDisplay || setUserColor)) {
    const updates = [];
    const currentDisplay = (userRow.display_name || '').trim();
    if (setUserDisplay && currentDisplay !== desiredDisplayName) {
      try {
        setUserDisplay.run(userRow.id, desiredDisplayName);
        updates.push('display name');
      } catch (err) {
        logger?.warn?.('[rocko] failed to set display name', err);
      }
    }

    const currentColor = (userRow.preferred_color || '').trim().toLowerCase();
    if (setUserColor && currentColor !== desiredColor) {
      try {
        setUserColor.run(desiredColor, userRow.id);
        updates.push('color');
      } catch (err) {
        logger?.warn?.('[rocko] failed to set color', err);
      }
    }

    if (updates.length) {
      try {
        userRow = getUserByName.get(username);
      } catch (err) {
        logger?.warn?.('[rocko] failed to refresh user after updates', err);
      }
    }
  }

  const rockoUserId = userRow?.id || null;
  const rockoDisplayName = (userRow?.display_name && userRow.display_name.trim()) || desiredDisplayName || username;

  const fetchFn = typeof fetch === 'function' ? fetch.bind(globalThis) : null;
  const apiKey = openAI.apiKey || process.env.OPENAI_API_KEY || null;
  const model = openAI.model || 'gpt-5-nano';
  const idleIntervalMs = openAI.idleIntervalMs || 90_000;
  const idleChance = openAI.idleChance ?? 0.25;

  if (!fetchFn) {
    logger?.warn?.('[rocko] global fetch() not available; disabling AI replies.');
  }
  if (!apiKey) {
    logger?.warn?.('[rocko] OPENAI_API_KEY missing; disabling AI replies.');
  }
  if (!rockoUserId) {
    logger?.warn?.('[rocko] user record missing; disabling AI replies.');
  }

  const enabled = !!(fetchFn && apiKey && rockoUserId);

  const state = {
    lastResponseAt: 0,
    lastHumanMessage: null,
  };

  let queue = Promise.resolve();
  let idleTimer = null;

  function enqueue(task) {
    if (!enabled) return Promise.resolve();
    queue = queue.then(() => task()).catch((err) => {
      logger?.warn?.('[rocko] task failed', err);
    });
    return queue;
  }

  function chatRetentionSeconds() {
    const days = +(getSetting?.get?.('chat_retention_days')?.value || 7);
    return days > 0 ? days * 86400 : 0;
  }

  function dmRetentionSeconds() {
    const days = +(getSetting?.get?.('dm_retention_days')?.value || 14);
    return days > 0 ? days * 86400 : 0;
  }

  function chatMaxLength() {
    return +(getSetting?.get?.('chat_max_len')?.value || 400);
  }

  function dmMaxLength() {
    return +(getSetting?.get?.('dm_max_len')?.value || 160);
  }

  function trimToLimit(text, limit) {
    if (!text) return '';
    const str = String(text).trim();
    if (str.length <= limit) return str;
    return str.slice(0, Math.max(0, limit - 1)) + '…';
  }

  function buildChatContext(limit = 12) {
    if (!recentMessages?.all) return '';
    try {
      const rows = recentMessages.all();
      if (!Array.isArray(rows) || rows.length === 0) return '';
      const trimmed = rows.slice(0, limit).reverse();
      return trimmed.map((row) => {
        const name = (row.display_name && row.display_name.trim()) || row.username || 'anon';
        const body = stripDISFormatting(row.body || '');
        return `${name}: ${body}`;
      }).join('\n');
    } catch (err) {
      logger?.warn?.('[rocko] failed to build chat context', err);
      return '';
    }
  }

  async function callOpenAI(prompt, { temperature = 0.7, maxTokens = 200 } = {}) {
    if (!enabled) return null;
    try {
      const res = await fetchFn('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content: 'You are Rocko, a witty but kind regular on the Dead Internet Society BBS. Keep replies concise (under roughly 80 words), friendly, and formatted as plain text suitable for a retro BBS. Stay in first person and avoid roleplaying actions.',
            },
            { role: 'user', content: prompt },
          ],
          temperature,
          max_tokens: maxTokens,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        logger?.warn?.(`[rocko] OpenAI request failed: ${res.status} ${errText}`);
        return null;
      }

      const data = await res.json();
      const choice = data?.choices?.[0];
      const content = choice?.message?.content;
      if (!content) return null;
      return String(content).trim();
    } catch (err) {
      logger?.warn?.('[rocko] OpenAI call failed', err);
      return null;
    }
  }

  function notifyOnlineRecipient(username, fromName) {
    if (!hubState?.socketsByUser || !sendOps) return;
    const sockets = hubState.socketsByUser.get(username);
    if (!sockets || !sockets.size) return;
    const notice = `📬 DM from ${sanitizeAndFormatDIS(fromName)}.`;
    sockets.forEach((ws) => {
      const now = Date.now();
      if (!ws.__ctx) ws.__ctx = {};
      if (!ws.__ctx._lastMentionSound || now - ws.__ctx._lastMentionSound > 400) {
        ws.__ctx._lastMentionSound = now;
        sendOps(ws, [
          { op: 'audio', src: '/static/sounds/mention.wav', volume: 0.8 },
          { op: 'print', text: notice, cls: 'cyan' },
        ]);
      } else {
        sendOps(ws, [{ op: 'print', text: notice, cls: 'cyan' }]);
      }
    });
  }

  function sendChatMessage(text) {
    if (!enabled || !insertMessage?.run) return;
    const trimmed = trimToLimit(text, chatMaxLength());
    if (!trimmed) return;
    const created = nowEpoch();
    const ttl = chatRetentionSeconds();
    const expires = ttl > 0 ? created + ttl : null;

    try {
      insertMessage.run(rockoUserId, trimmed, created, expires);
    } catch (err) {
      logger?.warn?.('[rocko] failed to insert chat message', err);
      return;
    }

    const timeLabel = new Date(created * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const safeBody = sanitizeAndFormatDIS(trimmed);
    const html = `[${timeLabel}] &lt;${sanitizeAndFormatDIS(rockoDisplayName)}&gt; ${safeBody}`;
    broadcastChatFrom?.(html, username, created);
    try {
      notifyMentions?.(trimmed, { id: rockoUserId, username }, 'chat');
    } catch (err) {
      logger?.warn?.('[rocko] notify mentions failed', err);
    }
    state.lastResponseAt = Date.now();
  }

  function sendDM(toUser, body) {
    if (!enabled || !insertDM?.run || !toUser) return;
    const trimmed = trimToLimit(body, dmMaxLength());
    if (!trimmed) return;
    const ts = nowEpoch();
    const ttl = dmRetentionSeconds();
    const expires = ttl > 0 ? ts + ttl : null;

    try {
      insertDM.run(rockoUserId, toUser.id, trimmed, ts, expires);
    } catch (err) {
      logger?.warn?.('[rocko] failed to insert dm', err);
      return;
    }

    notifyOnlineRecipient(toUser.username, rockoDisplayName);
    state.lastResponseAt = Date.now();
  }

  function stripRockoMention(text) {
    if (!text) return '';
    return text.replace(/@rocko/gi, '').trim();
  }

  async function respondToMention(payload) {
    if (!enabled) return;
    if (!payload.fromUsername) return;
    const humanText = stripDISFormatting(payload.text || '');
    await delayRandom(1200, 3200);
    const context = buildChatContext(14);
    const cleaned = stripRockoMention(humanText || payload.text || '');
    const promptParts = [];
    if (context) promptParts.push(`Recent chat (oldest to newest):\n${context}`);
    promptParts.push(`@${payload.fromUsername} said: "${cleaned || humanText || payload.text}"`);
    promptParts.push(`Reply as Rocko. Keep it under 80 words.`);
    const reply = await callOpenAI(promptParts.join('\n\n'));
    if (!reply) return;
    const final = `@${payload.fromUsername} ${reply}`.trim();
    sendChatMessage(final);
  }

  async function respondToDM(payload) {
    if (!enabled) return;
    if (!payload.fromUsername || !payload.userRow) return;
    const clean = stripDISFormatting(payload.text || '');
    await delayRandom(1000, 2400);
    const prompt = `You received this private message from ${payload.fromUsername}: "${clean || payload.text}". Reply briefly as Rocko.`;
    const reply = await callOpenAI(prompt, { temperature: 0.6, maxTokens: 180 });
    if (!reply) return;
    sendDM(payload.userRow, reply);
  }

  async function maybeInterject() {
    if (!enabled) return;
    const now = Date.now();
    if (now - state.lastResponseAt < 60_000) return;
    if (!state.lastHumanMessage) return;
    if (now - state.lastHumanMessage.at > 5 * 60_000) return;
    if (Math.random() > idleChance) return;
    await delayRandom(1500, 4000);
    const context = buildChatContext(14);
    if (!context) return;
    const prompt = `Recent chat on the BBS (oldest to newest):\n${context}\n\nAdd a short message to the conversation as Rocko if you have something relevant to say. If not, answer with exactly "PASS".`;
    const reply = await callOpenAI(prompt, { temperature: 0.8, maxTokens: 200 });
    if (!reply) return;
    if (reply.trim().toUpperCase().startsWith('PASS')) return;
    sendChatMessage(reply);
  }

  function handleChatMessage(payload = {}) {
    const { fromUsername, text } = payload;
    const now = Date.now();
    if (fromUsername && fromUsername.toLowerCase() !== usernameLower) {
      state.lastHumanMessage = { at: now, username: fromUsername, text };
    }
    if (!enabled) return;
    if (!fromUsername || !text) return;
    if (fromUsername.toLowerCase() === usernameLower) return;
    const mentions = extractMentionsFromText?.(text) || [];
    if (mentions.includes(usernameLower)) {
      enqueue(() => respondToMention(payload));
    }
  }

  function handleDM(payload = {}) {
    if (!enabled) return;
    const target = payload.userRow;
    if (!target || !target.username || !target.id || target.username.toLowerCase() === usernameLower) return;
    enqueue(() => respondToDM(payload));
  }

  function start() {
    if (!enabled || idleTimer) return;
    idleTimer = setInterval(() => {
      enqueue(() => maybeInterject());
    }, idleIntervalMs);
  }

  return {
    username,
    usernameLower,
    userId: rockoUserId,
    isEnabled: enabled,
    handleChatMessage,
    handleDM,
    start,
  };
}

module.exports = {
  createRockoService,
};
