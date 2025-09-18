'use strict';

function createNotificationService({ statements, helpers, hub, timeUtils }){
  const { insertNotification, listNotificationsForUser, markAllNotificationsSeen } = statements;
  const { resolveUserHandle } = helpers;
  const { sendOps, hub: hubState } = hub;
  const { nowEpoch } = timeUtils;

  function humanizeContext(ctx){
    if (!ctx) return 'somewhere';
    if (ctx === 'chat') return 'Chat';
    if (ctx === 'adminchat') return 'Admin Chat';
    const mTopic = /^topic:(\d+)$/.exec(ctx);
    if (mTopic) return `Topic #${mTopic[1]}`;
    const mNews = /^news:(\d+)$/.exec(ctx);
    if (mNews) return `News #${mNews[1]}`;
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
          const notice = `🔔 ${fromName} mentioned you in ${place}.`;
          sockets.forEach(ws => {
            sendOps(ws, [{ op:'beep' }, { op:'print', text: notice, cls:'cyan' }]);
          });
        }
      });
    } catch (e) {
      // best effort
    }
  }

  function listMentionsForUser(userId, limit){
    return listNotificationsForUser.all(userId, limit);
  }

  function markMentionsSeen(userId){
    markAllNotificationsSeen.run(userId);
  }

  return {
    notifyMentions,
    extractMentionsFromText,
    humanizeContext,
    listMentionsForUser,
    markMentionsSeen,
  };
}

module.exports = {
  createNotificationService,
};
