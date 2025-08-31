// doors/board.js
// Message Board as a Door (list + topic + replies)

module.exports = {
  id: 'board',
  name: 'Message Board',

  db: null,
  helpers: null,
  _stmts: null,

  _prepare(db) {
    if (this._stmts) return this._stmts;
    return (this._stmts = {
      insertTopic: db.prepare(`
        INSERT INTO board_topics (title, creator_id, created_at, last_commented_at, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `),
      deleteTopicById: db.prepare(`DELETE FROM board_topics WHERE id = ?`),
      list: db.prepare(`
        SELECT t.id, t.title, t.created_at, t.last_commented_at,
               COUNT(c.id) AS comments
          FROM board_topics t
          LEFT JOIN board_comments c ON c.topic_id = t.id
         WHERE (t.expires_at IS NULL OR t.expires_at > strftime('%s','now'))
         GROUP BY t.id
         ORDER BY t.last_commented_at DESC
         LIMIT ?
      `),
      topic: db.prepare(`
        SELECT t.id, t.title, u.username AS creator, u.display_name
          FROM board_topics t
          LEFT JOIN users u ON u.id = t.creator_id
         WHERE t.id = ?
           AND (t.expires_at IS NULL OR t.expires_at > strftime('%s','now'))
      `),
      comments: db.prepare(`
        SELECT c.id, c.body, c.created_at, u.username, u.display_name, u.preferred_color
          FROM board_comments c
          LEFT JOIN users u ON u.id = c.user_id
         WHERE c.topic_id = ?
         ORDER BY c.created_at ASC
         LIMIT 500
      `),
      insertComment: db.prepare(`
        INSERT INTO board_comments (topic_id, user_id, body, created_at)
        VALUES (?, ?, ?, ?)
      `),
      bumpTopic: db.prepare(`
        UPDATE board_topics SET last_commented_at = ?, expires_at = ? WHERE id = ?
      `)
    });
  },

  /** called by DoorManager when the door is registered */
  // (manager injects db + helpers via Object.assign)
  newSession(/*state*/) {
    return { currentId: null };
  },

  /** Entry point from /board (and from /topic etc. via args) */
  render(api, state, sess, args = []) {
    // Shortcut: support global command shims that pass args to enter()
    // e.g. ['topic', '12'] or ['newtopic', 'hello world ...']
    const head = (args[0] || '').toLowerCase();
    if (head === 'topic') {
      const id = parseInt(args[1], 10);
      if (!id) return api.print('Usage: /topic <id>', 'yellow');
      return this._openTopic(api, state, sess, id);
    }
    if (head === 'newtopic') return this._cmdNewTopic(api, state, args.slice(1));
    if (head === 'removetopic') return this._cmdRemoveTopic(api, state, args.slice(1));

    // Default: list view
    this._renderList(api, state, sess);
  },

  _renderList(api, state, sess) {
    if (!this._requireAuth(api, state)) return;
    const { db, helpers } = this;
    const S = this._prepare(db);
    const limit = +(helpers.getSetting('board_list_limit') || 100);
    const rows = S.list.all(limit);

    api.batch(b => {
      b.clear();
      b.print('== Message Board ==', 'magenta'); b.hr();
      if (!rows.length) {
        b.print('No topics yet. Start one with /newtopic <title>.', 'dim');
      } else {
        b.print('Topics (most recently active first):', 'yellow');
        rows.forEach(r => {
          const when = new Date(r.last_commented_at * 1000).toLocaleString();
          const safeTitle = helpers.sanitizeAndFormatDIS(r.title);
          b.printHTML(`${r.id}. ${safeTitle}  <span class="dim">(${r.comments} repl${r.comments === 1 ? 'y' : 'ies'}, active ${helpers.escapeHTML(when)})</span>`);
        });
      }
      b.hr();
      b.print('Open: /topic <id>   Start: /newtopic <title>   Back: /main', 'cyan');
      b.setInputType('text', 'Use /topic <id> or /newtopic <title>');
    });

    state.currentScreen = 'door:board';
    sess.currentId = null;
  },

  _openTopic(api, state, sess, id) {
    if (!this._requireAuth(api, state)) return;
    const { db, helpers } = this;
    const S = this._prepare(db);
    const t = S.topic.get(id);
    if (!t) return api.print('No such topic (maybe expired).', 'red');

    state.currentScreen = 'door:board';
    sess.currentId = id;

    const comments = S.comments.all(id);
    const posterRaw = (t.display_name && t.display_name.trim()) ? t.display_name : (t.creator || 'anon');
    const poster = helpers.sanitizeAndFormatDIS(posterRaw);

    api.batch(b => {
      b.clear();
      b.printHTML(`== Topic #${t.id}: ${helpers.sanitizeAndFormatDIS(t.title)} ==`, 'magenta');
      b.printHTML(`<span class="dim">by &lt;${poster}&gt;</span>`); b.hr();
      if (!comments.length) {
        b.print('No replies yet. Type to reply.', 'dim');
      } else {
        comments.forEach(c => {
          const ts = new Date(c.created_at * 1000).toLocaleString();
          const authorRaw = (c.display_name && c.display_name.trim()) ? c.display_name : (c.username || 'anon');
          const author = helpers.sanitizeAndFormatDIS(authorRaw);
          const body = helpers.sanitizeAndFormatDIS(c.body);
          const colored = c.preferred_color ? `<span style="color:${c.preferred_color}">${body}</span>` : body;
          b.printHTML(`[${helpers.escapeHTML(ts)}] &lt;${author}&gt; ${colored}`);
        });
      }
      b.hr();
      b.print('Type to reply. Commands: /board (back), /main', 'dim');
      b.setInputType('text', 'Type to reply… /board to go back');
    });
  },

  /** raw text inside the door */
  onRaw(text, api, state, sess) {
    if (!this._requireAuth(api, state)) return true;
    const raw = String(text || '').trim();
    if (!raw) return true;
    if (!sess.currentId) {
      api.print('Use /topic <id> or /newtopic <title>.', 'dim');
      return true;
    }

    const { db, helpers } = this;
    const S = this._prepare(db);
    const maxLen = +(helpers.getSetting('board_reply_max_len') || 600);
    const visible = helpers.visibleLengthDIS ? helpers.visibleLengthDIS(raw) : String(raw).length;
    if (visible > maxLen) { api.print(`Reply too long (max ${maxLen} visible chars).`, 'red'); return true; }

    const ts = helpers.nowEpoch();
    S.insertComment.run(sess.currentId, state.userId || null, raw, ts);
    const days = +(helpers.getSetting('board_inactive_days') || 30);
    S.bumpTopic.run(ts, ts + days * 86400, sess.currentId);
    this._openTopic(api, state, sess, sess.currentId);
    return true;
  },

  /** slash commands while inside the door (or routed here by manager) */
  onCommand(cmd, api, state, args, sess) {
    cmd = (cmd || '').toLowerCase();
    if (cmd === 'board') { this._renderList(api, state, sess); return true; }
    if (cmd === 'topic') {
      const id = parseInt(args?.[0], 10);
      if (!id) { api.print('Usage: /topic <id>', 'yellow'); return true; }
      this._openTopic(api, state, sess, id); return true;
    }
    if (cmd === 'newtopic') return this._cmdNewTopic(api, state, args), true;
    if (cmd === 'removetopic') return this._cmdRemoveTopic(api, state, args), true;
    if (cmd === 'main' || cmd === 'menu') { api.print('Use /main to leave.', 'dim'); return false; }
    return false;
  },

  _cmdNewTopic(api, state, args) {
    if (!this._requireAuth(api, state)) return;
    const { db, helpers } = this;
    const S = this._prepare(db);

    const raw = (args || []).join(' ').trim();
    if (!raw) return api.print('Usage: /newtopic <title>', 'yellow');
    const maxLen = +(helpers.getSetting('board_title_max_len') || 120);
    const visible = helpers.visibleLengthDIS ? helpers.visibleLengthDIS(raw) : String(raw).length;
    if (visible > maxLen) return api.print(`Title too long (max ${maxLen} visible chars).`, 'red');

    const ts = helpers.nowEpoch();
    const days = +(helpers.getSetting('board_inactive_days') || 30);
    S.insertTopic.run(raw, state.userId || null, ts, ts, ts + days * 86400);
    api.print('Topic created.', 'green');
    this._renderList(api, state, { currentId: null });
  },

  _cmdRemoveTopic(api, state, args) {
    if (!this._requireAuth(api, state)) return;
    if (!state.isAdmin) return api.print('Admin only.', 'red');
    const { db } = this;
    const S = this._prepare(db);

    const id = parseInt(args?.[0], 10);
    if (!id) return api.print('Usage: /removetopic <id>', 'yellow');
    S.deleteTopicById.run(id);
    api.print(`Removed topic #${id}.`, 'green');
    this._renderList(api, state, { currentId: null });
  },

  _requireAuth(api, state) {
    if (!state?.authenticated) {
      api.print('You must be logged in. Returning to login…', 'yellow');
      if (typeof state.routeGo === 'function') state.routeGo('splash');
      return false;
    }
    return true;
  },

  // (optional) expose commands for global discovery if your manager uses them
  commands: {
    board: (api, state, args, sess) => module.exports.onCommand('board', api, state, args, sess),
    topic: (api, state, args, sess) => module.exports.onCommand('topic', api, state, args, sess),
    newtopic: (api, state, args, sess) => module.exports.onCommand('newtopic', api, state, args, sess),
    removetopic: (api, state, args, sess) => module.exports.onCommand('removetopic', api, state, args, sess),
  }
};
