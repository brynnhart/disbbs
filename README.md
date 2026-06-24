# Dead Internet Society (DIS BBS)

I built this because the internet I loved is gone.

Not gone like deleted. Gone like a neighborhood that slowly becomes unrecognizable. The weirdos moved out. The storefronts became chains. Everything got optimized until there was nothing left to stumble into.

DIS is my attempt to build something back. It's a BBS — a bulletin board system, the kind of thing that existed before the web swallowed everything. You log in, you type commands, you talk to people. A commons chat, a message board, a link share, polls, status posts, direct messages, a few door games. When you're done, you close the tab. It doesn't follow you.

No algorithm decides what you see. No metrics tell you how well you performed today. No infinite scroll. Just people, text, and whatever we make together.

It won't be for everyone. It's probably for you if you already miss something you can't quite name.

DIS lives at [disbbs.org](https://disbbs.org). It runs on a single Node process, stores everything in SQLite, and talks to the browser over WebSocket. The whole thing fits in your head. That's the point.

*— Punky, sysop*

---

## What this is (and what it isn't)

A BBS is not a social network. There's no follower count, no like button, no feed tuned to keep you engaged. The board shows topics in order of last activity. The chat shows messages in the order they were sent. That's the whole algorithm.

I care about a few things in particular:

- **Presence over metrics.** You see who's here right now, not who's been surfaced because they post a lot. The chat shows you who's in the room.
- **No infinite scroll.** There's a bottom. You can reach it. Then you're done.
- **Data minimalism.** Chat and DMs auto-delete on a schedule. We store the least we need to make the place work.
- **Moderation for safety, not virality.** We don't amplify drama. We don't need it to grow.
- **Proudly anti-fascist.** This should go without saying, but here we are.

---

## Tech stack

| Layer | What |
|---|---|
| Runtime | Node.js 20 |
| Server | Express 5 + `ws` (WebSocket) |
| Database | SQLite via `better-sqlite3` |
| Auth (passwords) | `bcryptjs` |
| Frontend | Vanilla JS + CSS in a single `public/index.html` — no framework, no build step |
| AI bot (optional) | OpenAI API (Rocko) |
| News feed | The Guardian API |
| Deployment | Fly.io (Docker, persistent volume) |

The protocol between server and browser is dead simple: the browser sends `{ type: "input", raw: "..." }` over WebSocket, and the server sends back arrays of ops (`print`, `printHTML`, `clear`, `hr`, `setInput`, etc.) that the client renders into the terminal. There's no REST API for the BBS itself — it's all WebSocket.

---

## Running locally

You need Node 20+ and that's pretty much it.

```bash
git clone https://github.com/brynnhart/disbbs.git
cd disbbs
npm install
node server.js
```

Then open `http://localhost:3000`. The database (`dis.sqlite3`) is created automatically on first run. A default admin account `Punkyroo` / `password` is seeded — change that password immediately with `/passwd password <newpassword>`.

### Environment variables

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `DB_PATH` | `./dis.sqlite3` | Path to the SQLite database file |
| `SSO_SECRET` | *(unset)* | Required for cross-subdomain auth cookies. Any long random string works. |
| `OPENAI_API_KEY` | *(unset)* | Enables Rocko, the AI chat bot. Optional. |
| `ROCKO_MODEL` | `gpt-5-nano` | Which OpenAI model Rocko uses |
| `NODE_ENV` | *(unset)* | Set to `production` in prod |

If `SSO_SECRET` is not set, the `/api/auth/complete` endpoint (used for cross-domain auth) will return 500s, but the BBS itself still works fine for a single domain.

---

## Deploying to Fly.io

I run this on Fly.io with a persistent volume for the SQLite file. Here's how to get your own instance up.

**Prerequisites:** install the [Fly CLI](https://fly.io/docs/hands-on/install-flyctl/) and run `fly auth login`.

### First deploy

```bash
# Create the app (pick your own app name)
fly launch --no-deploy

# Create a persistent volume for the database (1GB is plenty)
fly volumes create dis_data --size 1 --region yyz

# Set the SSO secret (generate something long and random)
fly secrets set SSO_SECRET=$(openssl rand -hex 32)

# If you want Rocko, set your OpenAI key
fly secrets set OPENAI_API_KEY=sk-...

# Deploy
fly deploy
```

### Subsequent deploys

```bash
fly deploy
```

That's it. The Dockerfile does `npm ci --omit=dev` and runs `node server.js`. The volume is mounted at `/data` and `DB_PATH` is set to `/data/dis.sqlite3` so the database survives deploys.

### fly.toml notes

The included `fly.toml` is configured for:
- Region: `yyz` (Toronto) — change this to wherever you are
- 1GB RAM, 1 shared CPU — this handles way more users than you'd expect for a BBS
- `auto_stop_machines = "off"` — keeps the machine running so WebSocket connections stay alive
- `min_machines_running = 1` — same reason
- Health check on `/healthz` every 15 seconds

### Scaling

SQLite is surprisingly capable for this use case. A single machine handles hundreds of concurrent WebSocket connections without breaking a sweat. If you ever outgrow it, the architecture would need rethinking, but honestly: if your BBS has enough users to need horizontal scaling, you've already won.

---

## Slash commands

Everything in DIS is a slash command. Type `/help` in the terminal for a quick list. Here's the full reference.

### Getting around

| Command | What it does |
|---|---|
| `/main` or `/menu` | Return to the Command Hub |
| `/chat` | Enter the Commons Chat |
| `/board` | Message board |
| `/links` | Community link share |
| `/polls` | Poll booth |
| `/games` | Door games list |
| `/news` | Latest headlines from The Guardian |
| `/about` | About DIS |
| `/rules` | Community rules |
| `/leave` | Exit a room and return to the menu |

### Account

| Command | What it does |
|---|---|
| `/register <user> <pass>` | Create a new account (you'll be asked one question) |
| `/logout` | Sign out |
| `/passwd <old> <new>` | Change your password |
| `/whoami` | Show your current username |

### Chat

Just type to chat once you're in `/chat`. A few commands work inside the room:

| Command | What it does |
|---|---|
| `/here` | Show who's currently in the chat room |
| `/who` | Show everyone currently online on DIS |
| `/leave` | Exit back to the menu |

### Board

| Command | What it does |
|---|---|
| `/newtopic <title>` | Start a new topic |
| `/topic <id>` | Open a topic by ID |
| `/removetopic <id>` | Remove a topic (admin only) |

Once you're inside a topic, just type to reply.

### Links

| Command | What it does |
|---|---|
| `/addlink <headline> <url>` | Share a link |
| `/links <id>` | Open a link's comment thread |
| `/removelink <id>` | Remove a link (admin only) |

### Status feed

| Command | What it does |
|---|---|
| `/post <text>` | Share a short status update |
| `/feed` | View recent updates from everyone |
| `/feed <user>` | View updates from a specific user |

### Polls

| Command | What it does |
|---|---|
| `/newpoll <question> \| <opt1> \| <opt2> ...` | Create a poll (2–5 options, separated by `\|`) |
| `/vote <poll id> <option #>` | Vote in a poll |
| `/endpoll <id>` | End a poll (creator or admin) |
| `/removepoll <id>` | Remove a poll entirely (creator or admin) |
| `/polls` | View the poll booth |

### Direct messages

| Command | What it does |
|---|---|
| `/dm <user> <message>` | Send a direct message |
| `/messages` | View your inbox (marks all as read) |

You can address users by username or display name. DMs auto-delete after 14 days.

### Profile

| Command | What it does |
|---|---|
| `/profile` | View your own profile |
| `/profile <user>` | View someone else's profile |
| `/aboutme <text>` | Set your profile about text (DIS-Markdown allowed) |
| `/aboutme clear` | Clear your about text |

### Display & colors

| Command | What it does |
|---|---|
| `/setcolor <#RRGGBB \| name>` | Set your chat color. Named colors: `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white` |
| `/color` | Show your current color |
| `/colorreset` | Reset to no color |
| `/setdisplay <name>` | Set a display name (DIS-Markdown allowed) |
| `/display` | Show your current display name |
| `/displayreset` | Reset display name back to your username |

### Community

| Command | What it does |
|---|---|
| `/users [page]` | Browse the member list |
| `/suggest <text>` | Submit a suggestion |
| `/suggestions` | View all current suggestions |
| `/announcements` | View site announcements |
| `/notifications` | View your @mention notifications |
| `/notifications 200` | View more (up to 200) |

### Utilities

| Command | What it does |
|---|---|
| `/help` | Show the command list |
| `/format` | Show DIS-Markdown formatting examples |
| `/colors` | Show color swatches |
| `/here` | Who's in the current room |

### Games

| Command | What it does |
|---|---|
| `/games` | List available door games |
| `/play <game>` | Open a door game in a new tab |

Current games: PacMan, ASCIIcraft, LORD (Legend of the Red Dragon port).

### Rocko (the AI bot)

Rocko is an optional AI chat participant powered by OpenAI. He only shows up if you set `OPENAI_API_KEY`.

| Command | What it does |
|---|---|
| `/dm Rocko <message>` | Have a private conversation with Rocko |
| `@Rocko` in chat | Summon Rocko to respond in the commons |

Rocko reads recent chat history for context and tries not to be annoying. He won't respond to every message — just ones directed at him, or occasionally when the room goes quiet.

### Admin commands

These only appear in `/help` if you're an admin.

| Command | What it does |
|---|---|
| `/adminchat` | Enter the private admin room |
| `/announce <text>` | Post a site-wide announcement |
| `/removeannounce <id>` | Remove an announcement |
| `/removesuggestion <id>` | Remove a suggestion |
| `/retention` | View current retention settings |
| `/retention <area> <days>` | Set auto-delete for `chat`, `dms`. Use `0` to disable. |

Note: auto-deletion is currently disabled for board topics, links, status posts, announcements, suggestions, and user accounts. Only chat messages and DMs are pruned on a schedule.

### DIS-Markdown

A light formatting language that works in chat, board posts, display names, and about text:

| Syntax | Result |
|---|---|
| `**bold**` | **bold** |
| `_italics_` | *italics* |
| `__underline__` | underline |
| `[cyan]text[/cyan]` | colored text |
| `[dim]text[/dim]` | dimmed text |
| `@username` | mention (triggers a notification) |

Available color tags: `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`.

---

## Project structure

```
disbbs/
├── server.js                   # Everything: WebSocket handler, all commands, all routes
├── package.json
├── Dockerfile
├── fly.toml                    # Fly.io deployment config
│
├── src/
│   ├── database/
│   │   └── index.js            # createDatabase() — schema, prepared statements, helpers
│   ├── hub/
│   │   └── index.js            # WebSocket broadcast helpers, presence tracking
│   ├── services/
│   │   ├── notifications.js    # @mention detection and delivery
│   │   └── rocko.js            # Rocko AI bot (optional, needs OPENAI_API_KEY)
│   └── utils/
│       ├── formatting.js       # DIS-Markdown parser/sanitizer, HTML escaping
│       └── time.js             # Epoch helpers, date heading formatters
│
└── public/
    ├── index.html              # The entire frontend (HTML + CSS + JS, no build step)
    ├── favicon.ico
    ├── emoji/                  # SVG emoji used in the terminal
    │   ├── happy.svg
    │   ├── sad.svg
    │   ├── angry.svg
    │   ├── shrug.svg
    │   └── wow.svg
    └── sounds/
        └── mention.wav         # Played when you get a mention or DM
```

### How the server works

`server.js` is intentionally monolithic. Every slash command handler lives there. The flow for any user action is:

1. Browser sends `{ type: "input", raw: "/whatever args" }` over WebSocket
2. Server parses the command, runs the handler
3. Handler calls `api.print(...)`, `api.printHTML(...)`, etc.
4. Those methods batch up ops and send them as `{ type: "ops", ops: [...] }` back to the browser
5. Browser's JS executes each op against the terminal DOM

There's no client-side routing, no state management library, no virtual DOM. The server owns all the state. The browser is a dumb terminal.

The database layer (`src/database/index.js`) exposes two things: `statements` (prepared SQLite queries) and `helpers` (functions like `createUser`, `verifyLogin`, `resolveUserHandle`). Server.js destructures what it needs from both.

### The database schema

All tables use `CREATE TABLE IF NOT EXISTS`, and columns added after the initial launch are handled by `ensure*Column()` migration functions that run on startup. The main tables:

- `users` — accounts, passwords (bcrypt), display names, colors, about text, signup reason
- `messages` — commons chat (auto-deleted after 7 days by default)
- `dm_messages` — direct messages (auto-deleted after 14 days by default)
- `board_topics` + `board_comments` — the message board
- `news_posts` + `news_comments` — the link share
- `polls` + `poll_options` + `poll_votes` — polls
- `status_posts` — the status feed
- `suggestions` — user suggestions
- `announcements` — site-wide announcements
- `admin_messages` — admin chat
- `notifications` — @mention notifications
- `settings` — key/value config store (retention days, limits, etc.)

---

## Contributing

This is a personal project and I'm opinionated about what it is and isn't. That said, if you find a bug or have a fix, open an issue or a PR and we'll talk.

The one thing I ask: don't pitch me on making it more like a modern social platform. That's the whole thing I'm trying not to build.

---

## Contact

Issues: sysop@disbbs.org  
The BBS itself: [disbbs.org](https://disbbs.org)
