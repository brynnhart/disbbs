// doors/news.js
const NEWS_TAGS = [
  'Florida','Not News','Hero','Facepalm','Breaking','Obvious','Science!',
  'Oops','Money','Fail','Tech','Politics','World','Crime','Sports'
];

module.exports = {
  id: 'news',
  name: 'DIS News',

  // prepared statements set up once per process
  _stmts: null,
  _prepare(db) {
    if (this._stmts) return this._stmts;
    return this._stmts = {
      insertPost: db.prepare(`
        INSERT INTO news_posts (title, url, tag, user_id, created_at, last_commented_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`),
      deletePost: db.prepare(`DELETE FROM news_posts WHERE id = ?`),
      list: db.prepare(`
        SELECT p.id, p.title, p.url, p.tag, p.created_at, p.last_commented_at,
               u.username, u.display_name, u.preferred_color,
               (SELECT COUNT(1) FROM news_comments nc WHERE nc.post_id = p.id) AS comments
          FROM news_posts p
          LEFT JOIN users u ON u.id = p.user_id
         WHERE (p.expires_at IS NULL OR p.expires_at > strftime('%s','now'))
         ORDER BY p.last_commented_at DESC
         LIMIT ?`),
      get: db.prepare(`
        SELECT p.id, p.title, p.url, p.tag, u.username, u.display_name
          FROM news_posts p
          LEFT JOIN users u ON u.id = p.user_id
         WHERE p.id = ?
           AND (p.expires_at IS NULL OR p.expires_at > strftime('%s','now'))`),
      comments: db.prepare(`
        SELECT c.id, c.body, c.created_at, u.username, u.display_name, u.preferred_color
          FROM news_comments c
          LEFT JOIN users u ON u.id = c.user_id
         WHERE c.post_id = ?
         ORDER BY c.created_at ASC
         LIMIT 500`),
      insertComment: db.prepare(`
        INSERT INTO news_comments (post_id, user_id, body, created_at)
        VALUES (?, ?, ?, ?)`),
      bump: db.prepare(`
        UPDATE news_posts SET last_commented_at = ?, expires_at = ? WHERE id = ?`)
    };
  },

  // lifecycle: manager injects these
  db: null,
  helpers: null,

  newSession(/*state*/) {
    return { currentId: null };
  },

  render(api, state, sess /*, args */) {
    // list view
    const { db, helpers } = this;
    const S = this._prepare(db);
    const limit = +(helpers.getSetting('news_list_limit') || 150);
    const rows = S.list.all(limit);

    api.batch(b=>{
      b.clear();
      b.print('== DIS News ==', 'magenta'); b.hr();
      if (!rows.length){
        b.print('No news yet. Add one with /addnews <headline> <url> <tag>.', 'dim');
      } else {
        b.print('Recent links (most recent first):', 'yellow');
        rows.forEach(r=>{
          const posterRaw = (r.display_name?.trim()) ? r.display_name : (r.username || 'anon');
          const poster = helpers.sanitizeAndFormatDIS(posterRaw);
          const safeTitle = helpers.sanitizeAndFormatDIS(r.title);
          const urlShown = r.url.length <= 80 ? r.url : (r.url.slice(0,79) + '…');
          b.printHTML(`${r.id}. ${safeTitle}`);
          b.printHTML(`   <span class="dim">${helpers.escapeHTML(urlShown)}</span>  <span class="cyan">[${helpers.escapeHTML(r.tag)}]</span>  by &lt;${poster}&gt;  <span class="dim">(${r.comments} comments)</span>`);
        });
      }
      b.hr();
      b.print('Open: /news <id>    Add: /addnews <headline> <url> <tag>    Remove (admin): /removenews <id>', 'cyan');
      b.print('Tags: ' + NEWS_TAGS.join(', '), 'dim');
      b.setInputType('text', 'Use /news <id> or /addnews <headline> <url> <tag>');
    });

    sess.currentId = null;
    state.currentScreen = 'door:news';
  },

  _openItem(api, state, sess, id) {
    const { db, helpers } = this;
    const S = this._prepare(db);
    const p = S.get.get(id);
    if (!p) { api.print('No such news item (maybe expired).', 'red'); return; }

    const comments = S.comments.all(id);
    const posterRaw = (p.display_name?.trim()) ? p.display_name : (p.username || 'anon');
    const poster = helpers.sanitizeAndFormatDIS(posterRaw);

    api.batch(b=>{
      b.clear();
      b.printHTML(`== [${helpers.escapeHTML(p.tag)}] ${helpers.sanitizeAndFormatDIS(p.title)} ==`, 'magenta');
      b.printHTML(`<span class="dim">${helpers.escapeHTML(p.url)}</span>  by &lt;${poster}&gt;`);
      b.hr();
      if (!comments.length){
        b.print('No comments yet. Type to comment.', 'dim');
      } else {
        comments.forEach(c=>{
          const ts = new Date(c.created_at*1000).toLocaleString();
          const authorRaw = (c.display_name?.trim()) ? c.display_name : (c.username || 'anon');
          const author = helpers.sanitizeAndFormatDIS(authorRaw);
          const body = helpers.sanitizeAndFormatDIS(c.body);
          const colored = c.preferred_color ? `<span style="color:${c.preferred_color}">${body}</span>` : body;
          b.printHTML(`[${helpers.escapeHTML(ts)}] &lt;${author}&gt; ${colored}`);
        });
      }
      b.hr();
      b.print('Type to comment. Commands: /news (back), /main', 'dim');
      b.setInputType('text', 'Type to comment… /news to go back');
    });

    sess.currentId = id;
  },

  onRaw(text, api, state, sess) {
    const raw = String(text||'').trim();
    if (!raw) return true;

    // In list view, raw text is ignored; in item view, raw text = comment
    if (!sess.currentId) {
      api.print('Use /news <id> or /addnews <headline> <url> <tag>.', 'dim');
      return true;
    }

    // comment
    const { db, helpers } = this;
    const S = this._prepare(db);

    const maxLen = +(helpers.getSetting('news_reply_max_len') || 600);
    const visible = helpers.sanitizeAndFormatDIS(raw).replace(/<[^>]+>/g,'').length; // conservative
    if (visible > maxLen){ api.print(`Comment too long (max ${maxLen} visible chars).`, 'red'); return true; }

    const ts = helpers.nowEpoch();
    S.insertComment.run(sess.currentId, state.userId || null, raw, ts);
    const days = +(helpers.getSetting('news_inactive_days') || 30);
    S.bump.run(ts, ts + days*86400, sess.currentId);
    this._openItem(api, state, sess, sess.currentId);
    return true;
  },

  onCommand(cmd, api, state, args, sess) {
    if (cmd === 'news') {
      if (args?.length) {
        const id = parseInt(args[0], 10);
        if (!id){ api.print('Usage: /news <id>', 'yellow'); return true; }
        this._openItem(api, state, sess, id);
      } else {
        this.render(api, state, sess);
      }
      return true;
    }

    if (cmd === 'addnews') {
      const { db, helpers } = this;
      const S = this._prepare(db);
      const raw = (args||[]).join(' ').trim();
      if (!raw){ api.print('Usage: /addnews <headline> <url> <tag>', 'yellow'); return true; }
      const parts = raw.split(/\s+/);
      if (parts.length < 3){ api.print('Usage: /addnews <headline> <url> <tag>', 'yellow'); return true; }
      const tag = parts.pop();
      const urlIn = parts.pop();
      const headline = parts.join(' ').trim();

      const maxLen = +(helpers.getSetting('news_title_max_len') || 120);
      const visible = helpers.sanitizeAndFormatDIS(headline).replace(/<[^>]+>/g,'').length;
      if (visible > maxLen){ api.print(`Headline too long (max ${maxLen} visible chars).`, 'red'); return true; }
      if (!NEWS_TAGS.includes(tag)){ api.print(`Unknown tag "${tag}". Allowed: ${NEWS_TAGS.join(', ')}`, 'red'); return true; }

      let url;
      try {
        const u = new URL(urlIn.includes('://') ? urlIn : 'https://' + urlIn);
        url = u.toString();
      } catch { api.print('Invalid URL. Example: example.com or https://example.com/article', 'red'); return true; }

      const ts = helpers.nowEpoch();
      const days = +(helpers.getSetting('news_inactive_days') || 30);
      S.insertPost.run(headline, url, tag, state.userId || null, ts, ts, ts + days*86400);
      api.print('News link added.', 'green');
      this.render(api, state, sess);
      return true;
    }

    if (cmd === 'removenews') {
      if (!state.isAdmin){ api.print('Admin only.', 'red'); return true; }
      const id = parseInt(args?.[0], 10);
      if (!id){ api.print('Usage: /removenews <id>', 'yellow'); return true; }
      this._prepare(this.db).deletePost.run(id);
      api.print(`Removed news #${id}.`, 'green');
      // if you were viewing it, bounce back to list
      if (sess.currentId === id) this.render(api, state, sess);
      return true;
    }

    return false;
  },

  // Expose commands for global discovery (/help or auto-wire)
  commands: {
    news: (api, state, args, sess) => module.exports.onCommand('news', api, state, args, sess),
    addnews: (api, state, args, sess) => module.exports.onCommand('addnews', api, state, args, sess),
    removenews: (api, state, args, sess) => module.exports.onCommand('removenews', api, state, args, sess),
  }
};
