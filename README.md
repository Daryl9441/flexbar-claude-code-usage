# Claude Code Usage for Flexbar

Display your [Claude Code](https://claude.com/claude-code) usage limits live on your [Flexbar](https://eniacelec.com/products/flexbar) — like a [clawdmeter](https://github.com/HermannBjorgvin/Clawdmeter), but on the macro bar you already own.

Each key shows one usage limit as a meter: the current percentage, a progress bar that shifts from green through orange (75%) to red (100%) as usage increases, the time until the limit resets, and optionally Clawd, the Claude Code crab.

![Session meter](docs/media/render-v4-session.png)
![Weekly meter](docs/media/render-v4-weekly-clawd.png)
![Per-model meter](docs/media/render-v4-model-full.png)

## Features

- **Session meter** — your 5-hour rolling usage window
- **Weekly meter** — your 7-day usage window (all models)
- **Per-model weekly meter** — the model-scoped weekly limit (e.g. Opus)
- Tap a key to refresh immediately
- No API key needed — reads your existing Claude Code login
- Respects a custom key background color set in FlexDesigner
- Optional Clawd mascot, using the official pixel-art artwork

## Session Status key

A second key shows what your latest Claude Code session is doing, so you can see at a glance whether Claude is still working, has finished, or is waiting for you:

| Status | Meaning |
| --- | --- |
| **Working** (blue) | Claude is generating or running a tool (also while background agents run) |
| **Question** (amber) | Claude asked you something (`AskUserQuestion`) — the question is shown |
| **Plan ready** (amber) | A plan is waiting for your approval |
| **Approval** (amber) | A tool call is waiting for your permission. **Approval?** means it is inferred (a tool call has made no progress for 10 s) |
| **Asked you** (amber) | The turn ended with a question in Claude's reply |
| **Done** (green) | The turn finished |
| **Stopped** / **Error** (red) | You interrupted the turn, or it ended with an API error |
| **Idle** (grey) | Nothing happened for a while |

Below the status it shows the question, the current todo item or the session title, and a progress bar when Claude keeps a todo list (e.g. 3/5). The top right shows how long the current state has lasted, plus `+N` when other sessions are also working or waiting.

**Press the key to list all running sessions.** Each row is just a colored dot and the session title, so you can check every session at a glance:

| Dot | Meaning |
| --- | --- |
| Amber | Waiting for you: a question, a plan to approve, or a permission prompt |
| Blue | Working |
| Red | Stopped or ended with an error |
| Green | Completed: the turn finished and the session waits at the prompt |

Sessions waiting for you come first, then working, stopped and completed ones, the most recent first in each group. A session counts as running while its Claude Code process is open, or for the key's idle time (15 minutes by default) after its last activity. The list follows the key's project filter, uses three rows per column and more columns on wider keys, and updates live while it is shown. When it does not fit, a page indicator (e.g. `1/3`) appears bottom right and each further press shows the next page; a press on the last page, or 15 seconds without a press, returns to the normal view.

The key reads the session transcripts Claude Code writes to `~/.claude/projects` (or `CLAUDE_CONFIG_DIR`), plus the live status Claude Code keeps in `~/.claude/sessions`. Everything stays on your computer; nothing is sent anywhere. Sessions from the Claude desktop app's Code tab are included. When several sessions are active, one that is waiting for you is shown first.

**Per key:**

| Setting | Default | Description |
| --- | --- | --- |
| Project filter | empty | Part of the project path; empty shows the latest session of any project |
| Idle after | 15 min | When a finished session counts as idle and leaves the running list |
| Key text language | FlexDesigner language | English or Simplified Chinese |
| Show project name | on | Show the project folder name next to the status |
| Show Clawd | off | Show Clawd on wide keys |

If your Claude Code data is not in `~/.claude`, set the folder in the plugin settings.

## New Session key

A third key opens a new Claude Code session in the Claude desktop app with one tap — the same page as the app's own "New Claude Code Session" Dock menu item. It uses the app's `claude://code/new` link, so the [Claude desktop app](https://claude.com/download) must be installed.

| Setting | Default | Description |
| --- | --- | --- |
| Project folder | empty | Folder to start the session in: an absolute path or `~/…` (relative paths start from your home folder). Empty lets the app choose |
| Key text language | FlexDesigner language | English or Simplified Chinese |

The key shows "Opening…" briefly after a tap, or "Claude app not found" if no app handles the link; taps within a second of each other count once. Keys 100 px wide or narrower show just the icon. The link is handed to the system opener (`open` on macOS, the URL protocol handler on Windows, `xdg-open` on Linux) directly, without a shell.

## How it works

The plugin reads the OAuth token that Claude Code stores on your machine (`~/.claude/.credentials.json`, or the Keychain on macOS) and polls the same usage endpoint that Claude Code's own `/usage` command uses. Usage polling costs no tokens and nothing is sent anywhere except to `api.anthropic.com`.

One usage request serves all keys, at most one request every 30 seconds. If the endpoint rate-limits the plugin (HTTP 429), it honors the server's `Retry-After`: keys show a countdown until usage data returns, and no requests are made until then.

When the stored token expires, the plugin refreshes it the same way Claude Code does (via the stored refresh token) and writes the new token pair back to the credential store — so the meters keep working even if you only use the Claude desktop app and never run the CLI. If the refresh token itself has been revoked, keys ask you to log in with Claude Code again.

Requirements:

- [Claude Code](https://claude.com/claude-code) installed and logged in on the same computer
- A Claude subscription (Pro / Max) — API-key-only accounts have no usage limits to display

## Privacy

- The plugin reads your Claude Code credentials locally (`~/.claude/.credentials.json`, `CLAUDE_CODE_OAUTH_TOKEN`, or the macOS Keychain) and sends them only to Anthropic's own endpoints: the usage endpoint on `api.anthropic.com`, and the OAuth token endpoint (`platform.claude.com`, falling back to `console.anthropic.com`) when it refreshes an expired token.
- Tokens are never logged or shown on a key; error messages are redacted before they reach the FlexDesigner log or the settings page. A refreshed token pair is written back only to the credential store it came from.
- The Session Status key reads transcripts and session status locally and sends nothing anywhere.
- No credentials or personal data are stored in this repository. Contributors: run `npm run setup:hooks` once and `npm run check:privacy` before pushing; the rules are in [CLAUDE.md](CLAUDE.md#privacy-rules-mandatory).

## Installation

Install from [Flexgate](https://flexgate.enilinx.com/), or download the `.flexplugin` file from the [latest release](https://github.com/Sese-Schneider/flexbar-claude-code-usage/releases) and install it via FlexDesigner.

## Configuration

**Global settings** (plugin config page):

| Setting | Default | Description |
| --- | --- | --- |
| Credentials file | auto-detect | Override path to `.credentials.json` (useful with `CLAUDE_CONFIG_DIR`) |
| Refresh interval | 180 s | How often usage is polled (minimum 60 s) |
| Claude Code folder | auto-detect | Override `~/.claude` for Session Status keys |

**Per key:**

| Setting | Default | Description |
| --- | --- | --- |
| Usage limit | Session | Session (5 h), Weekly (all models), or Weekly (per model) |
| Show time until reset | on | Show the countdown until the limit resets |
| Show Clawd | off | Show Clawd, the Claude Code crab, next to the meter |

The countdown sits next to the percentage; on narrow keys with Clawd enabled it moves below the progress bar. A custom background color set in the key's style editor is used as the meter background.

## Development

```bash
npm install
npm run build          # bundle src/ -> <plugin>/backend/plugin.cjs
npm run dev            # link into FlexDesigner + watch + debug
npm run plugin:pack    # produce dev.sese.flexbar_claude_code_usage.flexplugin
```

FlexDesigner must be running for `npm run dev`.

## License

[MIT](LICENSE)
