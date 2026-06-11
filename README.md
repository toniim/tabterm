<h1 align="center">TabTerm</h1>

<p align="center">
  <em>A tabbed terminal workspace for your LAN — real shells that survive restarts, grouped sessions, conflict-safe synced notes, every device in sync.</em>
</p>

<p align="center">
  <a href="#quick-start"><img alt="Bun ≥ 1.1" src="https://img.shields.io/badge/Bun-%E2%89%A5%201.1-black?logo=bun"></a>
  <img alt="React 18" src="https://img.shields.io/badge/React-18-61dafb?logo=react&logoColor=white">
  <img alt="xterm.js" src="https://img.shields.io/badge/xterm.js-v5-22c55e">
  <img alt="SQLite WAL" src="https://img.shields.io/badge/SQLite-WAL-003B57?logo=sqlite&logoColor=white">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue">
</p>

<p align="center">
  <img src="docs/assets/screenshot.png" alt="TabTerm — tabbed terminal workspace with grouped sessions and notes" width="100%">
</p>

---

Open any device on your network in a browser and you get a **real, interactive
shell** — one PTY per session, organized into colored groups across multiple
workspaces, with a markdown notes pane sitting next to each terminal. Everything
persists to SQLite and syncs live across every connected client.

No login. No cloud. No external services. Just `bun start`.

> Terminals are real PTYs (`vim`, `htop`, `ssh`, `git` — whatever) backed by
> [GoTTY](https://github.com/sorenisanerd/gotty) subprocesses that TabTerm
> spawns and proxies. The browser never talks to GoTTY directly. With `tmux`
> installed, those shells run inside tmux so they (and whatever they're running)
> **outlive a server restart or crash** — reconnect and you're right where you left off.

## Features

- 🖥️ **Real shells in the browser** — one GoTTY-backed PTY per session, rendered with xterm.js (auto-fit, auto-reconnect).
- 🗂️ **Nested workspaces** — primary tabs at the top, colored collapsible groups in the sidebar, drag-and-drop reordering.
- 🐚 **Your shell** — sessions launch your `$SHELL` (zsh or bash) with prompt/status + AI-startup hooks layered on top, without touching your dotfiles.
- 📝 **Per-session markdown notes** — multiple notes per session (Tiptap editor), live-synced across devices with **conflict-safe versioning** (optimistic concurrency: a stale edit is rejected with a *keep mine / take theirs* prompt instead of silently clobbering) and an **offline edit queue** that flushes on reconnect.
- 🎨 **Customizable, synced terminal** — pick the terminal **font family, size, line-height, and theme** from the status-bar gear; choices persist and **sync to every connected device** (SQLite + WebSocket).
- ⌘ **Command palette** — `⌘K` to jump to any session or workspace; sessions waiting on Claude get a ping.
- 🔔 **Attention badges & desktop pings** — when a long-running agent finishes or needs you, the session lights up and the OS pops a notification.
- 🔁 **Live multi-device sync** — every mutation broadcasts over WebSocket; open the same layout on your desktop and laptop and stay in sync.
- 💾 **Persistent** — layout, groups, sessions, and notes live in SQLite (WAL); GoTTY processes are re-spawned automatically on restart.
- ♻️ **Durable sessions (tmux)** — when `tmux` is installed, each session runs inside a tmux session, so your shells and running programs (`vim`, a build, `claude`) **survive a server restart or crash** — reconnect and they're still going. Falls back to plain shells when tmux is absent.
- 🌗 **Light & dark** — themed terminal palettes that match the chrome.

## Quick start

```bash
bun install        # installs deps + downloads the GoTTY binary
bun run dev        # server + Vite client with hot reload
```

Then open the printed URL (default <http://localhost:3000>).

### Production

```bash
bun run build      # build the React SPA into dist/
bun start          # NODE_ENV=production: Bun serves the SPA + API on one port
```

## Requirements

- [Bun](https://bun.sh) ≥ 1.1
- GoTTY — fetched automatically via the `postinstall` script (`bun install`).
- [tmux](https://github.com/tmux/tmux) ≥ 3.1 — **optional**. Enables durable sessions (programs survive a server restart). Without it, sessions work exactly as before but don't persist across restarts. Install via your package manager (`apt install tmux`, `brew install tmux`, …); not auto-installed.

## Configuration

All configuration lives in a single JSON file. Every field is optional and falls
back to a sensible default.

- **Dev**: `config.sample.json` in the repo root (so local runs never touch your prod database).
- **Prod** (compiled binary or `NODE_ENV=production`): `~/.config/tabterm.json`.

| Key             | Default                  | Description                                                                                |
| --------------- | ------------------------ | ------------------------------------------------------------------------------------------ |
| `dbPath`        | `~/.config/tabterm.db`   | Path to the SQLite database.                                                               |
| `port`          | `3000`                   | HTTP + WebSocket server port.                                                              |
| `gottyBasePort` | `4001`                   | First port for dynamically-allocated GoTTY processes (one per session).                    |
| `gottyBin`      | bundled binary           | Path to the GoTTY binary.                                                                  |
| `sessionInit`   | _(none)_                 | Default honors your `$SHELL` (zsh or bash) with status/AI-startup hooks layered on. Set a path to use a custom bash rcfile, or `"off"` to launch a bare `$SHELL` with no injection. |
| `claudeCommand` | `claude`                 | Command launched for "Claude session". Use an absolute path if it's outside `$PATH`.       |
| `tmux`          | _(auto)_                 | Durable sessions run inside tmux when it's installed. Set to `"off"` to disable and use plain child-process shells (no cross-restart persistence). |
| `sessionCommands` | `[]`                   | Extra launch-profile buttons in the sidebar. Each entry runs a command as a session. None by default (only a plain shell). |

Example `sessionCommands` entry — adds a button that launches an AI CLI as a session:

```json
{
  "sessionCommands": [
    { "type": "opus", "label": "Opus session", "icon": "✨", "command": "~/bin/opus", "color": "var(--orange)" }
  ]
}
```

Paths support `~` expansion. Example `~/.config/tabterm.json`:

```json
{
  "dbPath": "~/.config/tabterm.db",
  "port": 8080,
  "gottyBasePort": 4001
}
```

> Terminal **font** (family/size/line-height) and **theme** aren't in this file —
> they're per-workspace settings you change live from the status-bar **gear**, and
> they sync to every device.

## Shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘K` / `Ctrl+K` | Command palette — search & jump to any session, workspace, or action (`↑`/`↓` to select, `⏎` to go, `Esc` to close) |
| `⌘B` / `Ctrl+B` | Toggle the navigation sidebar |
| `⌘⇧K` | Clear the terminal viewport + scrollback (client-side; a running TUI repaints on its next refresh) |
| `⏎` Enter | Submit — sends CR (what TUIs like Claude Code treat as "send") |
| `Shift`/`⌘`/`⌥` + `⏎` | Insert a newline instead of submitting — sends LF |
| `⌥`+drag (macOS) · `Shift`+drag (Linux/Win) | Select terminal text for a native browser selection → then copy |
| `⌘C` / `Ctrl+C` · `⌘V` / `Ctrl+V` | Copy the selection · Paste (bracketed-paste aware) |
| Mouse wheel · one-finger swipe (touch) | Scroll the terminal (tmux scrollback) |
| Double-click a session name | Rename the session (header title or sidebar) |
| Drag a file onto the terminal | Insert its path (uploaded if the OS hides the real path) |

## Terminal settings

- **Fonts & theme** — status-bar gear ⚙️ → font family, size, line-height, theme. Applied live, synced to all clients.
- **On-screen key bar** — status-bar ⌨️ toggle adds Esc/Ctrl/Alt/arrows for touch keyboards (default on for touch, off on desktop).

> Why copy needs a modifier: with `tmux` the multiplexer owns the screen (so the wheel can scroll), which means a bare drag goes to tmux. Holding `⌥`/`Shift` tells xterm.js to make a local browser selection instead, which `⌘C`/`Ctrl+C` then copies.

## Architecture

```
┌──────────────────────────────────────────────────┐
│  Browser — React + Zustand + xterm.js            │
│  - App WS:  session/group/note/settings sync     │
│  - PTY WS:  /gotty/ws/:sessionId (per terminal)  │
└───────────────────┬──────────────────────────────┘
                    │ HTTP + WS (one port)
┌───────────────────▼──────────────────────────────┐
│  Bun server (src/server/)                        │
│  - Serves the SPA + REST /api/*                  │
│  - App WS: broadcasts mutations to all clients   │
│  - PTY WS proxy: /gotty/ws/:id → GoTTY process   │
│  - Process mgr: spawn GoTTY per session; the      │
│    shell lives in a durable tmux session          │
└──────┬────────────────────┬──────────────────────┘
       │ bun:sqlite         │ spawn (one GoTTY per session)
┌──────▼──────┐   ┌──────────▼──────────┐
│  state.db   │   │ GoTTY → tmux → shell │  ...
│  (WAL)      │   │ (real PTY, durable)  │
└─────────────┘   └─────────────────────┘
```

The browser never connects to GoTTY directly — every PTY stream is proxied
through the Bun server. App state (layout, groups, notes, terminal settings)
lives in SQLite. With `tmux`, the shell + its scrollback live in the tmux server
(a daemon independent of Bun), so a server restart **reattaches** the same
running session rather than starting fresh; GoTTY becomes a disposable attach
client. Without tmux, sessions are plain child shells and don't persist across
restarts.

## Tech stack

| Layer            | Technology                                          |
| ---------------- | --------------------------------------------------- |
| Runtime          | Bun (HTTP, WS, SQLite, process management)          |
| Frontend         | React 18 + TypeScript, Vite                         |
| Terminal         | xterm.js v5 + `@xterm/addon-fit`                    |
| PTY backend      | GoTTY (one subprocess per session)                  |
| Session durability | tmux (optional; durable session per terminal)     |
| Notes editor     | Tiptap (markdown round-trip, version-checked sync)  |
| State (client)   | Zustand                                             |
| State (server)   | `bun:sqlite` (WAL)                                  |
| Styling          | Tailwind CSS v4                                     |

## Project layout

```
src/
├── server/        # Bun.serve entry, SQLite, routes, app WS, GoTTY manager, config
└── client/        # React SPA: store, WS client, components (Sidebar, Terminal, NotesPanel)
scripts/           # install-gotty, embed-asset generation, screenshot mockup
config.sample.json # dev config
```

## Scripts

| Command             | Description                              |
| ------------------- | ---------------------------------------- |
| `bun run dev`       | Server + client with hot reload          |
| `bun run build`     | Build the SPA into `dist/`               |
| `bun start`         | Run the production server                |
| `bun run typecheck` | `tsc --noEmit`                           |

## Scope & trust model

TabTerm assumes a **LAN-trust model**: there is no authentication or user
accounts — anyone who can reach the port gets a shell. Run it only on trusted
networks. It is a local/LAN tool, not a cloud service.

## License

MIT — see [LICENSE](LICENSE).
