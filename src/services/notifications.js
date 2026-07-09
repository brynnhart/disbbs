'use strict';

function createNotificationService({ statements, helpers, hub, timeUtils, formatting }){
  const { insertNotification, listNotificationsForUser, markAllNotificationsSeen, countUnreadDMs } = statements;
  const { resolveUserHandle } = helpers;
  const { sendOps, hub: hubState } = hub;
  const { nowEpoch } = timeUtils;
  const { sanitizeAndFormatDIS } = formatting;

  function humanizeContext(ctx){
    if (!ctx) return 'somewhere';
    if (ctx === 'chat') return 'Chat';
    if (ctx === 'adminchat') return 'Admin Chat';
    if (ctx === 'status') return 'Status Feed';
    const mTopic = /^topic:(\d+)$/.exec(ctx);
    if (mTopic) return `Topic #${mTopic[1]}`;
    const mNews = /^news:(\d+)$/.exec(ctx);
    if (mNews) return `Link #${mNews[1]}`;
    return ctx;
  }

  function extractMentionsFromText(raw){
    if (!raw) return [];
    const found = new Set();
    const rx = /(^|[\s.,;:!?()[\]{}"'])@([A-Za-z0-9_\-./[\]]{2,32})/g;
    let m;
    while ((m = rx.exec(raw)) !== null) {
      const handle = m[2];
      if (handle) found.add(handle.toLowerCase());
    }
    return Array.from(found);
  }

  function notifyMentions(rawText, fromUserRow, context){
    try {
      const handles = extractMentionsFromText(rawText);
      if (!handles.length) return;

      const created = nowEpoch();
      const fromId = fromUserRow ? fromUserRow.id : null;
      const fromName = fromUserRow ? (fromUserRow.username || 'someone') : 'someone';

      handles.forEach(h => {
        const resolved = resolveUserHandle(h);
        if (!resolved || resolved.ambiguous) return;

        const target = resolved.row;
        if (!target || (fromId && target.id === fromId)) return;

        insertNotification.run(target.id, fromId, 'mention', context, rawText, created);

        const sockets = hubState.socketsByUser.get(target.username);
        if (sockets && sockets.size){
          const place = humanizeContext(context);
          // fromName may be a display name carrying DIS-Markdown (color/
          // bold/italic/underline) tags — render them, don't print literally.
          const noticeHTML = `* ${sanitizeAndFormatDIS(fromName)} mentioned you in ${place} — /notifications to read`;
          sockets.forEach(ws => {
            sendOps(ws, [{ op:'beep' }, { op:'printHTML', html: noticeHTML, cls:'dim' }]);
          });
        }

        // away auto-reply (specs/PLACES.md /away), once per sender per away-session
        const awayEntry = hubState.away && hubState.away.get(target.username.toLowerCase());
        if (awayEntry && fromUserRow && fromUserRow.username) {
          const senderKey = fromUserRow.username.toLowerCase();
          if (!awayEntry.notified.has(senderKey)) {
            awayEntry.notified.add(senderKey);
            const senderSockets = hubState.socketsByUser.get(fromUserRow.username);
            if (senderSockets && senderSockets.size) {
              const line = `* ${target.username} is away: ${awayEntry.message}`;
              senderSockets.forEach(ws => sendOps(ws, [{ op: 'print', text: line, cls: 'dim' }]));
            }
          }
        }
      });
    } catch (e) {
      // best effort
    }
  }

  // Shared DM arrival signal (specs/PLACES.md Signals): one dim line plus
  // the footer's unread state, delivered to every open socket of the
  // recipient. Used by both the /dm command and Rocko's DMs so the footer
  // MSG count stays correct regardless of who sent it.
  function notifyDM(recipientRow, fromName){
    if (!recipientRow || !recipientRow.username) return;
    const sockets = hubState.socketsByUser.get(recipientRow.username);
    if (!sockets || !sockets.size) return;

    const unread = countUnreadDMs.get(recipientRow.id)?.count || 0;
    // fromName may be a display name carrying DIS-Markdown (color/bold/
    // italic/underline) tags — render them, don't print literally.
    const noticeHTML = `* incoming from ${sanitizeAndFormatDIS(fromName || 'someone')} — /messages to read`;

    sockets.forEach(ws => {
      if (!ws.__ctx) ws.__ctx = {};
      const now = Date.now();
      const ops = [];
      if (!ws.__ctx._lastMentionSound || now - ws.__ctx._lastMentionSound > 400) {
        ws.__ctx._lastMentionSound = now;
        ops.push({ op: 'audio', src: '/static/sounds/mention.wav', volume: 0.8 });
      }
      ops.push({ op: 'printHTML', html: noticeHTML, cls: 'dim' });
      ops.push({ op: 'status', unread });
      sendOps(ws, ops);
    });
  }

  function listMentionsForUser(userId, limit){
    return listNotificationsForUser.all(userId, limit);
  }

  function markMentionsSeen(userId){
    markAllNotificationsSeen.run(userId);
  }

  return {
    notifyMentions,
    notifyDM,
    extractMentionsFromText,
    humanizeContext,
    listMentionsForUser,
    markMentionsSeen,
  };
}

module.exports = {
  createNotificationService,
};
