# CLAUDE.md

Guide for coding agents working on this repository: the **Claude Code Usage**
plugin for FlexDesigner / Flexbar (uuid `dev.sese.flexbar_claude_code_usage`),
a fork of `Sese-Schneider/flexbar-claude-code-usage`.

## Privacy rules (mandatory)

This repository is public. Nothing committed (file content, file names, commit
messages, author/committer metadata) may contain private information. The
repository owner requires this without exception.

**Never commit:**

- Tokens and keys: OAuth access/refresh tokens, Anthropic keys (`sk-ant-…`),
  OpenAI-style keys (`sk-…`), GitHub tokens (`ghp_…`, `gho_…`, `ghs_…`,
  `ghu_…`, `ghr_…`, `github_pat_…`), AWS key ids (`AKIA…`), Slack tokens
  (`xoxb-…`), Google API keys (`AIza…`), JWTs, `Bearer` tokens, PEM private
  keys, passwords, client secrets.
- Credential files: `.credentials.json`, `.env` / `.env.*`, `*.pem`, `*.key`,
  `*.p12` (all git-ignored; keep it that way).
- Personal email addresses, in files or in commit metadata.
- Real local paths such as `/Users/<name>/…`, `/home/<name>/…` or
  `C:\Users\<name>\…`. Write `~/…` or `/Users/you/…`, or use `os.homedir()` /
  `os.tmpdir()` in code.
- Hostnames (`*.local`), device serial numbers, real Claude Code session ids,
  transcript content, and logs or screenshots that show any of the above.

**Rules:**

1. Commit with the GitHub noreply identity
   (`<id>+<user>@users.noreply.github.com`). Check `git config user.email`
   before committing and never switch it to a personal address.
2. Fixtures are synthetic. When test code needs a token-shaped string, build it
   at runtime (e.g. `['sk-', 'ant-', body].join('')`) so the source never
   contains a literal token.
3. Never log, print or draw a token or credential. Error text from the
   credential and usage code goes through `safeErrorMessage` (`src/redact.ts`).
   Never log raw error objects there (a failed Keychain write's error repeats
   its command line, token pair included), and never parse credential data with
   a bare `JSON.parse` (its error message quotes the input).
4. Run `npm run check:privacy` before every push, and
   `npm run check:privacy:history` for the commits you are about to push. Both
   must report 0 errors.
5. Activate the git hooks once per clone with `npm run setup:hooks`: pre-commit
   scans the staged changes and the commit identity, pre-push scans every new
   commit including author/committer. CI (`.github/workflows/privacy.yml`) runs
   the same checks on every push and pull request.
6. `.privacy-allowlist` is only for values verified to be public (e.g. Claude
   Code's public OAuth client id), each with a comment saying why. When a check
   fails, remove the data instead of allowlisting it. A credential that was
   ever committed must be rotated: deleting it in a later commit leaves it in
   the history.

## Commands

```bash
npm run build                 # rollup: src/plugin.ts -> dev.sese.flexbar_claude_code_usage.plugin/backend/plugin.cjs
npx eslint "src/**/*.ts"      # lint + Prettier (npm run format fixes)
npx tsc --noEmit -p .         # type check
npm run test:session          # Session Status tests (tsc -> .test-build/, node --test)
npm run test:privacy          # privacy scanner, hooks and redaction tests
npm run check:privacy         # privacy scan of tracked files + staged changes
npm run check:privacy:history # privacy scan of commits not in upstream/main (or origin/main)
```

- `node scripts/session-report.mjs` (after `npm run test:session`) classifies
  the local Claude Code sessions read-only. Its output describes your machine:
  never paste it into the repository.
- Do not run `npm install` in a worktree whose `node_modules` is shared or
  symlinked. Add no runtime dependencies: FlexDesigner provides Node built-ins,
  `@eniac/flexdesigner`, `@napi-rs/canvas`, `sharp`, `express` and `axios`.
- `npm run dev` and the other `plugin:*` scripts need a running FlexDesigner.

## Rendering keys

Key images are 60 px tall PNGs drawn with `@napi-rs/canvas` (`src/render.ts`,
`src/sessionRender.ts`, fonts in `src/fonts.ts`). For results identical to the
device, render with FlexDesigner's own runtime instead of your local Node:
compile the needed `src/*.ts` (include `src/fonts.ts`) to CommonJS with
`tsc --outDir <tmp> --module commonjs --target ES2022 --moduleResolution node --esModuleInterop --skipLibCheck --strict --types node`,
then run a script that writes PNGs to a temp directory:

```sh
env -i HOME="$HOME" ELECTRON_RUN_AS_NODE=1 PATH=/usr/bin:/bin \
  NODE_PATH="/Applications/FlexDesigner.app/Contents/Resources/app.asar.unpacked/node_modules:/Applications/FlexDesigner.app/Contents/Resources/app.asar/node_modules" \
  "/Applications/FlexDesigner.app/Contents/Frameworks/FlexDesigner Helper.app/Contents/MacOS/FlexDesigner Helper" render.cjs
```

Look at every rendered PNG. Images in `docs/media` must be rendered from
synthetic data. Never modify the FlexDesigner app or its Application Support
folder.

## flexcli caveat

`@eniac/flexcli` 1.0.x imports JSON with `assert { type: 'json' }`, which
Node 22+ rejects, so `npm run plugin:validate` and `plugin:pack` fail on
current Node. Use Node 20 (as the release workflows do) or a copy of flexcli
outside the repository with `assert` changed to `with` in
`src/commands/pack.js`. Do not edit `node_modules`.

## Structure

- `src/plugin.ts`: entry point. FlexDesigner events (`plugin.alive`/`dead`/
  `data`, `device.status`, `ui.message`, config updates), usage polling with
  the rate-limit lockout, and the serialized draw queue all keys share.
- `src/credentials.ts`: reads Claude Code's OAuth credentials (env,
  `~/.claude/.credentials.json`, macOS Keychain), refreshes them and writes the
  new pair back. `src/api.ts`: usage endpoint client (`UsageError`).
  `src/redact.ts`: credential redaction for logs and key text.
- Usage meter key: `src/usage.ts`, `src/render.ts`, `src/clawd.ts`,
  `src/fonts.ts`, `src/types.ts`.
- Session Status key: `src/session.ts` (transcript parser, status derivation),
  `src/sessionSource.ts` (`SessionMonitor`: transcripts in `~/.claude/projects`,
  live status in `~/.claude/sessions`), `src/sessionView.ts` (view model,
  en/zh-CN), `src/sessionRender.ts`, `src/sessionKey.ts`.
- `dev.sese.flexbar_claude_code_usage.plugin/`: `manifest.json` (keys, `local`
  strings for `en` and `zh-CN`), `ui/*.vue` key settings (file name = last
  segment of the key's cid), resources. `backend/` is build output.
- `scripts/`: tests, session report, privacy scanner. `.githooks/`: privacy
  hooks. `.github/workflows/`: release-please, release and privacy checks.
