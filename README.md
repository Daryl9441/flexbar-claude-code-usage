# AI Coding Usage for Flexbar

Display your [Claude Code](https://claude.com/claude-code) usage limits live on your [Flexbar](https://eniacelec.com/products/flexbar) — like a [clawdmeter](https://github.com/HermannBjorgvin/Clawdmeter), but on the macro bar you already own.

By default a **Claude Usage** key shows how much is **left** of both your 5-hour and weekly limits, in as little as 120 px:

![5 hours + weekly, remaining (120 px)](docs/media/render-dual-120.png)
![5 hours + weekly, remaining, with reset times (240 px)](docs/media/render-dual-240.png)

A key can instead show one usage limit as a meter: the current percentage used, a progress bar that shifts from green through orange (75%) to red (100%) as usage increases, the time until the limit resets, and optionally Clawd, the Claude Code crab.

![Session meter](docs/media/render-v4-session.png)
![Weekly meter](docs/media/render-v4-weekly-clawd.png)
![Per-model meter](docs/media/render-v4-model-full.png)

The same three key types (usage meter, session status, new session) also exist for [Kimi](#kimi-keys) (Kimi Code CLI and the Kimi desktop app's Kimi Work), [Gemini](#gemini-keys) (Gemini CLI), [Antigravity](#antigravity-keys) (Google Antigravity: the desktop app, the IDE and the `agy` CLI), [Grok Bot](#grok-bot-keys) (the Grok Bot desktop app) and [DeepSeek](#deepseek-keys) (the DeepSeek API account balance). They appear in FlexDesigner's key library under "AI Coding Usage", eighteen keys in all.

The plugin used to be called "Claude Code Usage". Its Claude keys are now listed as **Claude Usage**, **Claude Sessions** (formerly Session Status) and **Claude New Session** (formerly New Session); keys already on your Flexbar keep working with their settings.

## Features

- **5 hours + weekly (remaining)**, the default: both limits on one compact key, as the percentage you have left
- **Session meter** — your 5-hour rolling usage window
- **Weekly meter** — your 7-day usage window (all models)
- **Per-model weekly meter** — the model-scoped weekly limit (e.g. Opus)
- Tap a key to refresh immediately
- No API key needed — reads your existing Claude Code login
- Respects a custom key background color set in FlexDesigner
- Optional Clawd mascot, using the official pixel-art artwork

## Claude Sessions key (Session Status)

A second key, **Claude Sessions**, shows what your latest Claude Code session is doing, so you can see at a glance whether Claude is still working, has finished, or is waiting for you:

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

## Claude New Session key

A third key, **Claude New Session**, opens a new Claude Code session in the Claude desktop app with one tap — the same page as the app's own "New Claude Code Session" Dock menu item. It uses the app's `claude://code/new` link, so the [Claude desktop app](https://claude.com/download) must be installed.

| Setting | Default | Description |
| --- | --- | --- |
| Project folder | empty | Folder to start the session in: an absolute path or `~/…` (relative paths start from your home folder). Empty lets the app choose |
| Key text language | FlexDesigner language | English or Simplified Chinese |

The key shows "Opening…" briefly after a tap, or "Claude app not found" if no app handles the link (macOS and Linux; on Windows the system shows its own "get an app" prompt instead); taps within a second of each other count once. Keys 100 px wide or narrower show just the icon. The link is handed to the system opener (`open` on macOS, the URL protocol handler on Windows, `xdg-open` on Linux) directly, without a shell.

## Kimi keys

Three keys show Moonshot AI's Kimi Code CLI and the Kimi desktop app's Kimi Work. They look like the Claude keys and carry the Kimi mark (turn it off with **Show Kimi mark**).

**Kimi Usage** shows the remaining total Kimi membership quota by default. This total covers Kimi and Code together, like the membership page in the Kimi app. A total usage of 59.05% displays as **40.95% remaining**; the meter keeps up to two decimal places and shows the membership reset time when available.

The plugin first uses the total reported by the Kimi Code CLI's quota endpoint (`api.kimi.com/coding/v1/usages`, or `api.kimi.ai` for the global service, picked like the CLI does from its environment, `config.toml` and region marker). It uses the CLI's own login (`~/.kimi-code/credentials/`). If that endpoint omits the total, the plugin reads the current Kimi desktop app's access token for `www.kimi.com` and asks Kimi's official membership service (`GetSubscriptionStats`) for the shared quota and reset time. It does not read browser cookies or refresh the app's login. One fetch serves every Kimi Usage key, at most one every 30 seconds, with the same rate-limit lockout as Claude.

The desktop app and Code CLI can be signed in to different accounts. When the membership total comes from the app, it belongs to the app's account; the optional Code usage meters continue to use the CLI's account. Sign in to the same account in both if you want to compare their numbers.

| Setting | Default | Description |
| --- | --- | --- |
| Usage limit | Total membership remaining | Remaining total membership quota (Kimi + Code). Optional meters show used percentages for Code's 5-hour and 7-day limits, total membership usage, monthly Code share, extra usage (booster), the Kimi Work context, or the Moonshot API balance (remaining, cash, voucher) |
| Key text language | FlexDesigner language | English or Simplified Chinese |
| Show time until reset | on | Show the reset date and time for membership remaining, or the countdown for a used-percentage meter |
| Show Kimi mark | on | Show the Kimi mark next to the meter |

If the service does not report the membership total, the default key shows **Total usage unavailable**. Membership remaining stays selectable and never substitutes a Code limit or a context-window percentage. The total membership used-percentage option also shows unavailable when the total is missing. The plugin cannot infer the shared membership total from Code's 5-hour or 7-day usage.

Not every plan reports every optional Code limit. Extra usage appears while the booster wallet is turned on and has purchased extra usage. An optional Code used-percentage key whose limit is missing shows the first available plan limit with its own label, and its settings page says so. The chosen setting is kept and resumes once the plan reports it.

The **Kimi Work context** option needs no login: it shows how full the context window of the running (or latest) Kimi Work task is, read from the Kimi desktop app's data on this computer. Select it explicitly to display context usage.

**API balance** is separate from membership. Set a Moonshot API key in the plugin settings (or `MOONSHOT_API_KEY`) and choose **API balance remaining**. The key then shows what is left on the Kimi open platform: `available_balance` from `GET https://api.moonshot.cn/v1/users/me/balance` (CNY on the China site; cash plus vouchers). **API cash balance** is `cash_balance` (the topped-up cash, which can be negative) and **API voucher balance** is `voucher_balance`. The international site (`api.moonshot.ai`, USD) is the **Kimi API site** setting; a key from one site does not work on the other. With no key, nothing is requested and the membership and Code meters stay as they were. A balance error does not replace a plan limit that was read successfully. At 0 or below, the face says the API cannot be called.

When the Kimi Code login has expired, the key refreshes it with the CLI's own protocol: it takes the CLI's refresh lock, refreshes once and writes the new token pair back to the CLI's credential file. Turn off **Refresh an expired Kimi Code login** in the plugin settings to keep the key read-only; it then asks you to run `kimi` instead.

**Kimi Sessions** works like the Claude Sessions key (same states, `+N`, press for the running list). It merges Kimi Code CLI sessions (`~/.kimi-code/sessions`) with the desktop app's Kimi Work tasks. Questions and approvals from Kimi Code 1.5 journals are known, not guessed; a sub-agent waiting for you shows on its parent session. Unread Kimi Work results stay "Done" for up to 12 hours; archived tasks are hidden.

Pressing the key rotates one step further: after the running list, a **scheduled-tasks board** page shows Kimi Work's Blueprint automations — a state dot (blue running, red last run failed, green scheduled, grey manual/paused), the title and the next run per row, paged like the list, and the same 15 seconds without a press returns to the session face. Next runs are computed from each task's cron in its own timezone. The page is skipped for CLI-only keys and on computers without the Kimi desktop app.

| Setting | Default | Description |
| --- | --- | --- |
| Sessions from | Kimi Code and Kimi Work | Both, only Kimi Work (the Kimi app), or only Kimi Code (CLI) |
| Include scheduled tasks | off | Also list Kimi Work's scheduled-task conversations as sessions |
| Scheduled tasks page | on | End the press rotation with the scheduled-tasks board |
| Project filter | empty | Part of the Kimi Code project path or the Kimi Work project |
| Idle after | 15 min | When a finished session counts as idle |
| Key text language, Show project name, Show Kimi mark | | As on the Claude key |

**Kimi New Session** opens a new session in **Kimi Code App** on macOS (bundle `com.kimi.code.desktop`). It activates the exact App and invokes **File → New Session** through macOS Accessibility. Success requires verification of the new-session view and a focused, empty message input. The ordinary Kimi app and the `kimi` terminal client are never used by this key.

The key keeps its existing cid and language. Old target, terminal mode and folder settings are ignored. Select the project in Kimi Code App. FlexDesigner needs existing macOS Accessibility access; missing access or an unverifiable view shows an error. If the App restores an unsent draft, the key reports **Draft preserved** and leaves it intact; it never submits or erases it. There is no app-argument or CLI fallback.

Use **Open new session** in either New Session key's settings page to test the same press handler without changing the device layout.

Requirements: Kimi Code App installed in `/Applications` or `~/Applications`; macOS; Accessibility access for FlexDesigner. The native action recognizes **File → New Session** / **文件 → 新建会话** and **Message input** / **消息输入框**. A missing app or unsupported platform shows an error. The usage and session keys retain their existing sources.

## Gemini keys

Three keys show Google's [Gemini CLI](https://github.com/google-gemini/gemini-cli), with the Gemini mark (turn it off with **Show Gemini mark**).

**Gemini Usage** shows Gemini CLI quota as a meter: how much of a model's daily request quota is used. It reads the Gemini CLI login (`~/.gemini/oauth_creds.json`) without ever writing to it: an expired access token is refreshed in memory only, with the OAuth client of the Gemini CLI installed on this computer. It then asks Gemini Code Assist (`cloudcode-pa.googleapis.com`) for the account's tier (at most hourly) and per-model quota (each poll, at most once every 30 seconds).

| Setting | Default | Description |
| --- | --- | --- |
| Usage limit | Default | Default: the model with the least quota left (its name is on the chip). Pro or Flash: the most used model of that family. Auto: Pro and Flash together. Or any single model the account reports |
| Key text language | FlexDesigner language | English or Simplified Chinese |
| Show time until reset | on | Show the countdown until the quota resets |
| Show Gemini mark | on | Show the Gemini mark next to the meter |

Only Gemini CLI's "Login with Google" on a **Gemini Code Assist Standard or Enterprise** subscription reports quota. For personal Google accounts (Code Assist for individuals, Google AI Pro and Ultra) Google answers that the account is not eligible, and API-key logins or Vertex AI have no quota endpoint; the key then says so ("Not supported", "No quota") instead of a meter. If your organization's account needs a Google Cloud project, enter it as **Gemini Cloud project** in the plugin settings (or set `GOOGLE_CLOUD_PROJECT`). A short network or server error keeps the last meter for up to 30 minutes.

**Gemini Sessions** works like the Claude Sessions key. It reads the session files Gemini CLI writes to `~/.gemini/tmp/<project>/chats/` (both the JSON and the newer JSONL format) and names projects by their folder. With **Follow running Gemini CLIs** on (the default), it also reads the process list every 10 seconds (`ps` and `lsof` on macOS, `/proc` on Linux; not on Windows) to tell running sessions from stopped ones, to see tools running, and to show a freshly started CLI as "New session". Gemini CLI does not record pending approvals, so **Approval?** is a guess (a reply with no text and no tool running for 10 seconds). It rarely fires: Gemini CLI writes a reply, and its tool calls, only once the tools have finished, and such replies nearly always have text. So while a tool waits for your approval, or an `ask_user` question waits for your answer, the key usually still shows the previous reply as **Done** until the tool finishes.

| Setting | Default | Description |
| --- | --- | --- |
| Follow running Gemini CLIs | on | Read the process list; off judges from the session files only |
| Project filter, Idle after, Key text language, Show project name, Show Gemini mark | | As on the Claude key |

**Gemini New Session** opens a terminal window running the Gemini CLI in the key's folder: on macOS a temporary `.command` script (it deletes itself; one Terminal never ran is removed a minute later) opened in Terminal, on Windows a `cmd` window, on Linux `x-terminal-emulator`. Every argument is passed as-is, never through a shell string. On Windows a program path with a character `cmd.exe` would act on (`& | < > ^ % ! ( ) "`) is refused rather than run.

| Setting | Default | Description |
| --- | --- | --- |
| Open in | Terminal (Gemini CLI) | Or a new chat in the Gemini app (`googlegemini://newchat`; no folder, not a CLI session; the key shows "Gemini app" instead of a folder name) |
| Approval mode | Ask (default) | Ask, auto-approve edits, approve everything (YOLO), or plan (read-only) |
| Resume latest session | off | Start with `--resume latest` |
| Project folder | empty | Where the CLI starts (empty: your home folder) |
| Key text language | FlexDesigner language | English or Simplified Chinese |

A failed tap says why on the key: "Folder not found", "Gemini CLI not found" or "Gemini app not found". The CLI is found through the **Gemini CLI program** setting, else `PATH` and the usual install folders (Homebrew, npm, Volta, Bun, pnpm, nvm).

Requirements: [Gemini CLI](https://github.com/google-gemini/gemini-cli) installed (and, for the usage key, logged in with Google on a Code Assist Standard or Enterprise account).

## Antigravity keys

Three keys show [Google Antigravity](https://antigravity.google): the desktop app (Antigravity.app), the IDE (Antigravity IDE.app) and the `agy` CLI, with the Antigravity mark (turn it off with **Show Antigravity mark**).

The app and the IDE each run a local language server on `127.0.0.1`. The usage and session keys find it with `ps` and `lsof` (only your own processes), read the CSRF token from its command line and ask it read-only questions over HTTP on the loopback interface. The token stays in memory: it is sent only in a request header to a port that `lsof` lists for the same process, and never logged, shown or put on a command line.

**Antigravity Usage** shows the model quota Antigravity reports for your Google account: a 5-hour and a weekly limit for each model group (today Gemini, and Claude / GPT-OSS). It asks the running app first, then the IDE (`RetrieveUserQuotaSummary`, about 1 KB, at most one round every 30 seconds). The language server is asked to refresh from Google on the first fetch, every 15 minutes, after a limit's reset time has passed and when the settings page opens; when Google takes longer than 20 seconds, the key shows the numbers the language server already has. The percentage is the share used, as on the other single-limit meters. Narrow keys name the limit by a short tag that keeps the group's initial: "G 5h" (Gemini), "C 7d" (Claude / GPT-OSS).

| Setting | Default | Description |
| --- | --- | --- |
| Usage limit | Default | Default: the limit with the least left of any group. Or a group (its limit with the least left), one limit (Gemini 5h, Gemini weekly, Claude 5h, Claude weekly, and any new limit the server reports), or a group's 5-hour and weekly limits on one key in two rows (from about 180 px with a column naming the group). When the server reports no groups, one meter per model |
| Key text language | FlexDesigner language | English or Simplified Chinese |
| Show time until reset | on | Show the countdown until the limit resets (only once part of the limit is used) |
| Show Antigravity mark | on | Show the Antigravity mark next to the meter |

The settings page lists the limits Antigravity reports, with what is left of each, the plan name and the program that answered. A key that cannot read the quota says why: "Not installed", "Needs the app" (only `agy` is installed: its quota lives inside the CLI process, so the key needs the app or the IDE running), "Not running" (open the app; on macOS it can keep running in the menu bar with its windows closed), "Not signed in", "No quota data", "Update needed", "No answer", or "Not supported" on Windows. A network or server error keeps the last meter for up to 30 minutes; after the app and the IDE quit it stays about two minutes (enough for a restart), then the key says "Not running", since `agy` can keep using the quota while nothing can read it.

**Antigravity Sessions** works like the Claude Sessions key (same states, `+N`, press for the running list) for the conversations of all three programs. While the app or the IDE runs, its language server reports every conversation's live status (`GetAllCascadeTrajectories`); while it does not, the last known state comes from its `conversation_summaries.db`, read-only (copied to a temporary folder first when the database has a write-ahead log). `agy` conversations come from the CLI's summary database plus the running `agy` processes and their folders: a running `agy` owns the newest conversation in its folder, an `agy` without a conversation yet shows as "New session", and a conversation whose `agy` has exited while it was running shows as Stopped.

States follow Antigravity's own interface: a question for you shows as **Question**, a command, file or URL waiting for your approval as **Approval** ("Run: npm test", "Permission: read_url"), an implementation plan waiting for your review (planning mode) as **Plan ready**, and any other result waiting for your review, such as a walkthrough, as **Approval** ("Review: <task>"). A new conversation without a title or summary yet shows as "New session". Running conversations and background tasks are **Working**, killed or interrupted ones **Stopped**; sub-agents, archived conversations and internal trajectories are hidden. The progress bar comes from the conversation's `task.md` checklist.

| Setting | Default | Description |
| --- | --- | --- |
| Follow | All (app, IDE and CLI) | All three merged, or only the app, the IDE or the CLI |
| Show task progress | on | Show the `task.md` checklist progress (e.g. 2/5) |
| Project filter, Idle after, Key text language, Show project name, Show Antigravity mark | | As on the Claude key |

Cost: a 5-second tick checks a few file times per data folder; `ps` runs at most every 10 seconds (30 seconds when `agy` is not installed) and `lsof` once per new process; the language server is asked when its files change, on a key press, every 10 seconds while a conversation is active and every 60 seconds otherwise. Nothing runs while Antigravity is not installed.

**Antigravity New Session** creates a new empty conversation in the standalone **Antigravity App** on macOS (bundle `com.google.antigravity`). It activates the exact app and invokes the real **New Conversation** sidebar link through Accessibility, then verifies the new page and empty message input. Starting the app alone is not treated as success. No prompt is submitted.

FlexDesigner needs existing macOS Accessibility access. The action checks access without prompting or granting it. Missing access, an app that is still loading, a failed action, or an unverifiable page shows an error. If the app preserves an unsent draft, the key reports **Draft preserved** and leaves it intact. This integration currently recognizes the installed app's English **New Conversation** and **Message input** accessibility labels.

Existing buttons keep their cid, language and stored settings. Old auto, terminal, IDE, folder, resume and permission-mode settings are ignored by the App's new conversation action; there is no CLI or IDE fallback. Select the project inside the App. Usage and session keys retain their existing sources.

Requirements and limitations:

- Antigravity installed and signed in. The usage key needs the app or the IDE running; the session key follows `agy` on its own.
- macOS for the App New Session key. Finding the language servers needs `ps` and `lsof` (macOS; Linux when `lsof` is installed). On Windows the usage key shows "Not supported" and the session key reads the summary databases only, without knowing what still runs.
- The usage key cannot tell a key press from a poll, so a press refetches but does not force a refresh from Google.
- Which steps wait for you comes from the language server's answer; for `agy` it comes from the CLI's summary database, which may only be written when a turn ends, so a running `agy` turn can show its previous state until then.
- Antigravity's summaries carry no error state, so the red **Error** state does not occur.
- On keys narrower than about 180 px, the two-row dual face has no room for the group's name: use the default or a single-limit meter there, whose tag names the group.

## Grok Bot keys

Three keys show the [Grok Bot](https://cursor.com) desktop app (bundle `com.anysphere.sand`). This is the Cursor / SpaceXAI assistant, not Groq and not the Grok Build CLI under `~/.grok`. The mark is a generic rounded head drawn on the key (turn it off with **Show Grok Bot mark**).

**Grok Bot Usage** shows how much of the weekly allowance is used, the same percentage the app's account menu calls "Weekly usage". It asks Cursor's dashboard (`GetSandUsageStatus` on `api2.cursor.sh`) with the Cursor app's access token, read from Cursor's `state.vscdb`. The request runs only when Grok Bot is installed: the same call would otherwise report whichever account Cursor is signed into. The local transcript mirror has no token counts, so this percentage is the only usage number.

| Setting | Default | Description |
| --- | --- | --- |
| Usage limit | Weekly (used) | The weekly allowance, as the percentage used |
| Key text language | FlexDesigner language | English or Simplified Chinese |
| Show time until reset | on | Show the countdown until the allowance resets |
| Show Grok Bot mark | on | Show the Grok Bot mark next to the meter |

A key that cannot show a meter says why: "Not installed", "Not logged in" (sign in to the Cursor app with the account Grok Bot uses), "Login expired", "Cannot read login", "Pooled plan" (a shared enterprise allowance has no per-account reading), "No allowance", "Unreadable data", "Network error", "Usage error" or "Rate limited". A network or server error keeps the last meter. A pooled plan and an account with no included allowance are not drawn as 0%.

![Grok Bot weekly usage (240 px)](docs/media/render-grokbot-usage.png)

**Grok Bot Sessions** lists the bots in the app's local roster. A bot whose roster says it is waiting for you shows as **Question** ("Waiting for you"). A bot with recent activity shows as **Done** until **Idle after**. The app itself, when its session-marker pid still belongs to a Grok process, shows as **Idle** ("Grok Bot"): open, with no evidence it is generating. Local tasks counted by `local-exec-daemon.json` show as **Working** ("Local work"). The agent runs on Grok Bot's remote computer, and the transcript mirror has no live "still generating" flag, so a bot is never marked **Working** from a fresh transcript line. Chat text is not read onto the key.

| Setting | Default | Description |
| --- | --- | --- |
| Bot filter | empty | Part of a bot's name. Empty shows every recent bot, plus the app when it is open |
| Idle after | 15 min | How long a finished bot stays on the key |
| Follow the Grok Bot process | on | A marker or daemon pid counts only while that process name mentions Grok |
| Key text language, Show bot name, Show Grok Bot mark | | As on the Claude key |

Press the key for the list. Cost: a 5-second tick and a watch on the user-data folder and the data root. Nothing is sent off this computer.

![Grok Bot waiting (240 px)](docs/media/render-grokbot-session.png)

**Grok Bot** (the third key) opens the app with `grokbot://app/v1/open`. That link focuses the main window and accepts no prompt. There is no deep link that starts a blank chat, and the in-app New chat control can leave an existing draft in place, so this key does not press it and its face says **Open Grok Bot**, not "New Session".

![Open Grok Bot (200 px)](docs/media/render-grokbot-open.png)

Requirements and limitations:

- Grok Bot installed. The usage key also needs the Cursor app signed in on this computer; it does not decrypt Grok Bot's own secret store.
- The usage percentage is the Cursor account's Grok Bot weekly allowance. It is not a per-bot or per-chat meter.
- Session status is what the local files can prove. An open app with no roster row waiting for you shows as Idle, not Working.
- Windows and Linux can open the link when the app is registered for `grokbot://`. The usage and session keys read the same files on each platform; process names come from `ps` (macOS), `/proc` (Linux) or `tasklist` (Windows).

## DeepSeek keys

Three keys are listed for DeepSeek. **DeepSeek Usage** is the balance. The session key only says that DeepSeek has no local coding sessions, and **Open DeepSeek** opens `https://chat.deepseek.com/` without sending the API key.

**DeepSeek Usage** calls `GET https://api.deepseek.com/user/balance` with the API key from the plugin settings, or `DEEPSEEK_API_KEY` when that setting is empty. The key is a Bearer token on that request only. The default face shows the first currency's `total_balance` (CNY before USD). Granted balance and topped-up balance are separate choices. `is_available: false` still shows the amounts and says the balance is too low for API calls. Amounts are money, not a used percentage, so there is no quota bar.

| Setting | Default | Description |
| --- | --- | --- |
| Balance | First currency total | Total, granted or topped-up balance for each currency the account returns |
| Key text language | FlexDesigner language | English or Simplified Chinese |
| Show DeepSeek mark | on | Show the DeepSeek mark |

The same refresh interval as the other usage keys applies (180 seconds by default, at least 60, and at most one request every 30 seconds). A network or server error keeps the last amounts. A rejected key does not.

## How it works

The plugin reads the OAuth token that Claude Code stores on your machine (`~/.claude/.credentials.json`, or the Keychain on macOS) and polls the same usage endpoint that Claude Code's own `/usage` command uses. Usage polling costs no tokens and nothing is sent anywhere except to `api.anthropic.com`.

One usage request serves all keys, at most one request every 30 seconds. If the endpoint rate-limits the plugin (HTTP 429), it honors the server's `Retry-After`: keys show a countdown until usage data returns, and no requests are made until then.

When the stored token expires, the plugin refreshes it the same way Claude Code does (via the stored refresh token) and writes the new token pair back to the credential store — so the meters keep working even if you only use the Claude desktop app and never run the CLI. The refresh takes Claude Code's own refresh lock (in the folder of the credentials it refreshes), so the plugin does not refresh while Claude Code does, and it writes the new pair back only if Claude Code has not signed out or logged in again meanwhile. If the refresh token itself has expired or been revoked (the token endpoint answers `invalid_grant`), or Claude Code has signed out because of that, keys show **Login expired · Run claude to log in**: run `claude` in a terminal and log in again (`/login`). Claude Code logins end after a fixed time even while they are refreshed, so this happens now and then. **Not logged in** means no Claude Code credentials were found at all.

FlexDesigner starts the plugin without your shell's proxy variables, and its built-in `fetch` ignores the macOS system proxy, so the plugin picks the proxy for the Claude requests itself: the **Claude proxy** setting, else `HTTPS_PROXY` (minus `NO_PROXY`) from FlexDesigner's environment, else the macOS system proxy (the Proxies page of your network's settings; its HTTP and HTTPS proxies, not a PAC file or SOCKS). Requests go through the proxy's CONNECT tunnel, encrypted end to end to Anthropic. When the proxy cannot be reached the request is sent directly instead; a request that already went through the proxy is never repeated, not even to the token refresh's fallback endpoint. The FlexDesigner log notes the route once per host (e.g. `Claude requests to api.anthropic.com: via system proxy 127.0.0.1:7890`) and again when it changes.

Where Anthropic does not accept connections from your network or region, the usage endpoint answers HTTP 403 "forbidden" before it even looks at the token. Claude Usage keys then show **Region blocked · Check proxy**, and the settings page says so: set **Claude proxy**, or turn on the system proxy.

Requirements:

- [Claude Code](https://claude.com/claude-code) installed and logged in on the same computer
- A Claude subscription (Pro / Max) — API-key-only accounts have no usage limits to display

## Privacy

- The plugin reads your Claude Code credentials locally (`~/.claude/.credentials.json`, `CLAUDE_CODE_OAUTH_TOKEN`, or the macOS Keychain) and sends them only to Anthropic's own endpoints: the usage endpoint on `api.anthropic.com`, and the OAuth token endpoint (`platform.claude.com`, falling back to `console.anthropic.com`) when it refreshes an expired token. With a proxy (see [How it works](#how-it-works)) the connection runs through it, but encrypted end to end: the proxy sees only the host name. A proxy password in the **Claude proxy** setting is stored in plain text in FlexDesigner's plugin settings, like every other setting, and sent to the proxy (not to Anthropic). A refreshed Keychain item is written through `security -i` with the token pair on its standard input, so it never shows up in the process list (an item longer than about 2 KB falls back to the old command-line write, rather than leaving Claude Code with a used-up refresh token).
- Tokens are never logged or shown on a key; error messages are redacted before they reach the FlexDesigner log or the settings page. A refreshed token pair is written back only to the credential store it came from.
- The Claude Sessions key reads transcripts and session status locally and sends nothing anywhere.
- The Claude New Session key only hands a `claude://` link to your system's opener and sends nothing anywhere; its log messages leave out the project folder.
- Kimi Usage sends the Kimi Code login only to the endpoints the Kimi Code CLI itself uses (by default `api.kimi.com` / `auth.kimi.com`, or `api.kimi.ai` / `auth.kimi.ai`; overridden, like the CLI, by its `config.toml` or `KIMI_CODE_BASE_URL` / `KIMI_CODE_OAUTH_HOST`), and only over https. When the quota endpoint keeps refusing a freshly refreshed login, it does not refresh again until another login is stored. With login refresh on, it rewrites the Kimi Code CLI's credential file under the CLI's own lock; with it off, it writes nothing. For a missing membership total, the plugin reads the Kimi desktop app's current `www.kimi.com` access token and sends it only to Kimi's official membership endpoint over https. That app login is read-only: the plugin does not read its refresh token, browser cookies or Keychain items, and does not write or refresh it.
- Gemini Usage sends the Gemini CLI login only to Google (`oauth2.googleapis.com` to refresh the access token in memory, `cloudcode-pa.googleapis.com` for the quota) and never writes to `~/.gemini`.
- The Kimi and Gemini Sessions keys only read local files (and, for Gemini, the process list); they write nothing and send nothing anywhere. Session titles and prompts never reach the log.
- The Antigravity keys send nothing off this computer. They read Antigravity's local data and the process list, and ask the language server of the running Antigravity app or IDE on `127.0.0.1` only, with the CSRF token from its command line in a request header (never logged, shown or written anywhere). Antigravity Usage's request may make the language server refresh the quota from Google, as Antigravity does itself. They write nothing to Antigravity's data; account name, email and conversation titles never reach the log.
- Grok Bot Usage sends the Cursor app's access token only to `api2.cursor.sh` (`GetSandUsageStatus`), over https, and only while Grok Bot is installed. The token is read from Cursor's state database and is never logged, shown or written back. Grok Bot's own encrypted secret store is not decrypted. Grok Bot Sessions and the open key only read local files (and, for the session key, whether a pid still belongs to a Grok process) or hand `grokbot://app/v1/open` to the system opener. Chat text is not logged.
- Kimi Usage sends a Moonshot API key, only when one is set, as a Bearer token to `https://api.moonshot.cn/v1/users/me/balance` or `https://api.moonshot.ai/v1/users/me/balance`. It is not sent to the Kimi Code quota host, not written to disk, and not logged or drawn. The plugin setting is stored by FlexDesigner with the other settings, in the same way as the Claude proxy password.
- DeepSeek Usage sends its API key only as a Bearer token to `https://api.deepseek.com/user/balance`, over https, with redirects refused. The key is not logged, drawn or written into an error. The session key reads nothing. Open DeepSeek only hands `https://chat.deepseek.com/` to the system opener.
- No credentials or personal data are stored in this repository. Contributors: run `npm run setup:hooks` once, list your own identifiers (user name, hostname, device serial, email) in the git-ignored `.privacy-denylist.local`, and run `npm run check:privacy` before pushing; the rules are in [CLAUDE.md](CLAUDE.md#privacy-rules-mandatory).

## Installation

Install from [Flexgate](https://flexgate.enilinx.com/), or download the `.flexplugin` file from the [latest release](https://github.com/Sese-Schneider/flexbar-claude-code-usage/releases) and install it via FlexDesigner.

## Configuration

**Global settings** (plugin config page; the refresh interval applies to every provider, the rest is grouped by provider):

| Setting | Default | Description |
| --- | --- | --- |
| Refresh interval | 180 s | How often usage is polled, for every provider (minimum 60 s) |
| Credentials file | auto-detect | Override path to `.credentials.json` (useful with `CLAUDE_CONFIG_DIR`) |
| Claude Code folder | auto-detect | Override `~/.claude` for Claude Sessions keys |
| Claude proxy | auto | Proxy for the Claude usage and token requests: empty or `auto` uses `HTTPS_PROXY`, else the macOS system proxy; `direct` (or `none`, `off`) uses none; or an HTTP proxy such as `http://127.0.0.1:7890` (`http://user:password@host:port` with a login). SOCKS and PAC are not supported |
| Kimi Code folder | auto-detect | Override `$KIMI_CODE_HOME` or `~/.kimi-code` (login, sessions, `bin/kimi`) |
| Kimi desktop app data folder | auto-detect | Override the Kimi app's data folder (`~/Library/Application Support/kimi-desktop` on macOS) |
| Refresh an expired Kimi Code login | on | Let Kimi Usage refresh and write back an expired Kimi Code login; off keeps it read-only |
| Kimi API key | empty | Moonshot key for the open-platform balance. Empty uses `MOONSHOT_API_KEY` |
| Kimi API site | China (CNY) | `api.moonshot.cn` or the international `api.moonshot.ai` (USD). The key must belong to that site |
| Gemini CLI folder | auto-detect | Override `$GEMINI_CLI_HOME/.gemini` or `~/.gemini` |
| Gemini CLI program | auto-detect | Path to the `gemini` program, if it is not found on `PATH` or the usual install folders |
| Gemini Cloud project | empty | Google Cloud project ID for Gemini Code Assist Standard or Enterprise quota (default `$GOOGLE_CLOUD_PROJECT`) |
| Antigravity data folder | auto-detect | The folder holding `antigravity`, `antigravity-cli` and `antigravity-ide` (default `~/.gemini`) |
| Antigravity CLI program, agy | auto-detect | Path to the `agy` program, if it is not found on `PATH`, `~/.local/bin` or Homebrew's folders |
| Grok Bot user-data folder | auto-detect | Override the Electron userData folder that holds the session marker and client mirror |
| Grok Bot data root | auto-detect | Override `$SAND_DATA_ROOT` or `~/.grokbot` (local-exec daemon) |
| Cursor state database | auto-detect | Override Cursor's `state.vscdb` for the token Grok Bot Usage sends to Cursor |
| DeepSeek API key | empty | Key for the DeepSeek balance. Empty uses `DEEPSEEK_API_KEY` |

**Per key** (Claude Usage; the Kimi, Gemini, Antigravity and Grok Bot keys are described above):

| Setting | Default | Description |
| --- | --- | --- |
| Usage limit | 5 hours + weekly (remaining) | 5 hours + weekly (remaining), or one limit as used: Session (5 hours), Weekly (all models), or Weekly (per model) |
| Show time until reset | on | Show the countdown until the limit resets |
| Show Clawd | off | Show Clawd, the Claude Code crab, next to the meter (single-limit meters on keys from about 170 px) |

**5 hours + weekly (remaining)** shows the 5-hour window in the top row (`5h`) and the weekly window, all models, in the bottom row (`7d`). The number is what is left, 100% minus what you have used: green while plenty is left, orange as it runs low, red when almost nothing is left. The gauge is a battery that empties as you use the limit; next to a full battery the number reads `100`, without the `%`. From about 135 px the time until each limit resets (↻) appears above its battery, and from about 225 px in a column of its own. Between about 97 and 135 px only a limit that has run out shows it, in place of its empty battery and where it fits: any countdown fits from about 113 px, so the default 120 px key always shows it. Keys narrower than about 97 px leave out the batteries and the countdowns.

New Claude Usage keys are 120 px wide. At that width a single-limit meter names its limit with a short `5h` or `7d` chip; on wider keys the chip says Session or Weekly.

In the single-limit meters the countdown sits next to the percentage; on narrow keys with Clawd enabled it moves below the progress bar. A custom background color set in the key's style editor is used as the key background in every mode.

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
