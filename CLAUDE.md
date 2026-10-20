# Notiskin — Claude Code Context

## What this is

Notiskin is an open-source macOS tool that injects custom CSS themes and JavaScript plugins into the Notion desktop app. It works by starting Notion with `--remote-debugging-pipe` (DevTools over two private FIFOs, no network port) and using the Chrome DevTools Protocol (CDP) to inject a `<style>` or `<script>` element into the live running page. It does **not** edit Notion's bundled files — Notion loads its content live from `app.notion.com`, so asar editing doesn't work for main content injection.

Reference projects: Spicetify, BetterDiscord, Vencord. MIT licensed. Hosted at github.com/notiskin/notiskin.

---

## Stack

- **Language:** TypeScript, compiled to `dist/` via `tsc`
- **Runtime:** Node.js
- **GUI server:** Express on port 3845
- **Desktop app:** Electron (entry point: `src/electron/main.ts`)
- **Injection mechanism:** Chrome DevTools Protocol over Notion's DevTools pipe (`src/injector/pipe.ts`, no library)
- **Marketplace backend:** Supabase (Postgres + Auth + Storage)
- **Auth:** GitHub OAuth via Supabase
- **Packaging:** electron-builder (separate Apple Silicon `arm64` and Intel `x64` dmg/zip, currently unsigned). File names carry the chip and `-mac` so future Windows/Linux builds don't clash; electron-updater picks the right zip by chip
- **Config file:** `~/.notiskin/notiskin.config.json`
- **Themes/plugins:** `~/.notiskin/themes/*.css`, `~/.notiskin/plugins/*.js` (CLI and GUI share these)

`.env` at repo root is for development/release only and must never be packaged (check-bundle.js enforces this):
- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` (optional overrides, defaults live in src/utils/constants.ts)
- `GH_TOKEN` (only for the local `npm run publish` fallback, releases normally run in GitHub Actions)

See `.env.example` for the template.

---

## Project structure

```
src/
  cli/index.ts            — CLI entry point (npm bin target, also the launch-time `inject` command)
  core/library.ts         — Shared theme/plugin logic (paths, name validation, apply, currentPayload). CLI + server both use it
  core/diagnostics.ts     — Redacted bug-report text for Settings → Diagnostics and `notiskin diagnostics`
  electron/main.ts        — Electron main process entry point
  gui/
    server.ts             — Express server; exports startServer() and app
    run.ts                — Dev entry point; calls startServer(true) for standalone mode
    themes.html / plugins.html / review.html / settings.html — GUI pages (Settings has the Notion section: Install / Repair / Uninstall)
    tour.js               — Welcome tour shared by Themes, Plugins and Settings (served at /tour.js, packaged via build.files)
    brand.css, fonts/     — The "paper and ink" look: color tokens (light + dark, follows macOS), Fraunces + Inter bundled (SIL OFL). Served from a fixed list in server.ts
  injector/index.ts       — What gets injected (core CSS, theme, window.notiskin, plugins), plugins run once per page load
  injector/daemon.ts      — Long-running injector: the only CDP client, themes every Notion tab, re-applies on reload and on file changes, exits when Notion quits
  injector/pipe.ts        — CDP client over Notion's FIFOs in ~/.notiskin/run/<pid>, findNotionRun()
  injector/control.ts     — The injector's control socket (~/.notiskin/run/injector.sock): apply / reload / status
  utils/pidlock.ts        — Single-instance lock (~/.notiskin/injector.pid)
  patcher/
    index.ts              — Patches Notion's app bundle; exports patchNotion(), unpatchNotion(), getNotionStatus(), makeWrapperScript()
    admin.ts              — osascript admin-prompt runner, unused (App Management blocks it); shellQuote/errorFromOutput are used
    watcher.ts            — FSEvents watcher; detects Notion updates and repatches (runs patchNotion as the user)
  updater/index.ts        — electron-updater wrapper (Electron only)
  utils/
    constants.ts          — Paths (~/.notiskin, overridable via NOTISKIN_DIR), the GUI port, public Supabase config
    config.ts             — Read/write notiskin.config.json (atomic writes)
    sleep.ts

supabase/
  functions/_shared/      — Auth verification (http.ts) and theme CSS allowlist (css.ts)
  functions/*/index.ts    — Edge functions (submit, review, rate)
  migrations/             — SQL migrations (RLS policies)

scripts/check-bundle.js   — electron-builder afterPack hook, fails the build if .env etc. get packaged
test/                     — node:test suites (npm test builds first)
.github/workflows/ci.yml  — lint, typecheck, test, audit, package check
.github/workflows/release.yml — manual Release workflow (macOS): tests, draft release, build, publish once every file is attached
```

---

## How each piece fits together

**CLI (`src/cli/index.ts`):** The npm bin target. Commands: `patch`, `unpatch`, `themes`, `theme <name>`, `plugins`, `plugin enable/disable <name>`, `apply`, `safe-mode [on|off]`, `diagnostics`, `watch:install`, `watch:uninstall`. These work independently of the Electron app.

**Electron app (`src/electron/main.ts`):** Starts the Express server, creates a BrowserWindow loading `http://localhost:3845`, quits fully when the window is closed. Single-instance lock prevents duplicate windows. On start it quietly repairs a wrapper from before the DevTools pipe (`repairLegacyWrapper()` in server.ts, same as clicking Repair, never restarts Notion); if that fails Settings still shows Repair. This is what opens when you launch Notiskin from Spotlight or Applications.

**Express server (`src/gui/server.ts`):** Serves `themes.html`, `plugins.html`, `review.html`, and `settings.html`. Exposes REST endpoints for the GUI: theme switching, plugin toggling, marketplace search/install (the server fetches approved code from Supabase by id), submissions, and proxies to the edge functions. `/api/notion/*` (status, install, uninstall, restart, app-management) is macOS only: install/uninstall run the CLI's `patch`/`unpatch` as the current user with `process.execPath` + `ELECTRON_RUN_AS_NODE=1`, one at a time, through the swappable `notionSetup` object (tests mock it). Failures come back with a reason (`app-management` for EPERM, `not-owner` for EACCES). Does **not** auto-start on import — call `startServer()` explicitly. `src/gui/run.ts` is a thin dev entry point that calls `startServer(true)` directly.

**Injector (`src/injector/`):** Notion has no debug port. The wrapper makes two FIFOs in `~/.notiskin/run/<Notion's pid>/` (folder 0700, FIFOs 0600) and gives them to Notion as fd 3 (commands) and fd 4 (replies) with `--remote-debugging-pipe`. `daemon.ts` is the only thing that talks to that pipe (two clients would garble each other). It is started by `notiskin inject <pipe folder>` (the wrapper runs it on every Notion launch), or by `ensureInjector()` in core/library.ts with no folder, which finds the running Notion with `findNotionRun()`. It attaches to every Notion page target via `Target.setDiscoverTargets` + flat sessions, registers a document-start style script so reloads don't flash, re-injects on `Page.loadEventFired`, and re-applies to all tabs when files in ~/.notiskin change. The CLI and the app reach it through its control socket: `applyConfig()` sends `apply` or `reload` (reload re-themes first, then reloads every Notion tab and waits for them), starts an injector if Notion has a pipe but no injector, and only with `restartIfNeeded` quits and relaunches Notion (through `open` if patched, or with its own FIFOs if not). Theme CSS is a `<style id="notiskin-styles">` element; core CSS and `window.notiskin` are only injected when a theme / plugin is active. `index.ts` only holds what gets injected.

**Patcher (`src/patcher/index.ts`):** Replaces the Notion executable with a wrapper shell script that sets up the pipe, starts `inject` in the background and `exec`s `Notion.real --remote-debugging-pipe` (exec keeps the pid, so the pipe folder is named after Notion). If the Notiskin program is gone or any step fails, it runs plain `exec Notion.real "$@"` with no debugging. The original binary is renamed to `Notion.real`. Re-signing is `signNotion()`, see the signing constraint below. `patchNotion()` and `unpatchNotion()` are the main exports. App mode (`{ appMode: true }`, used when the CLI runs on Electron's binary) adds `ELECTRON_RUN_AS_NODE=1` to the inject line only, never to `Notion.real`. Wrappers from before the pipe (they contain `--remote-debugging-port`) count as `needs-repair`, `hasLegacyWrapper()` finds them. Patching again rewrites a wrapper that differs, which is how Repair fixes a moved Notiskin or an old wrapper. When run as root it gives `Notion.app` back to its previous owner, and the CLI gives `dist/` back to `SUDO_USER`. `getNotionStatus()` (not-installed, installed, needs-repair, notion-missing, unsupported) needs no root. `blockNativeNotion` in the config (on unless turned off; Settings → Notion switch, tour step, `notiskin block-native on|off`) adds `and info[NSPrincipalClass] = "AtomApplication"` to the Notion half of the signing requirement, so Notion's updater refuses a Notion-signed update that isn't Electron. Changing it re-signs a patched Notion (server runs the CLI `patch`, the CLI calls `resignNotion()`), and `hasOldSignature()` also catches a signature that doesn't match the setting, so the app retries on start. Unpatch always signs without it. It can't stop Notion turning native features on from its servers inside the Electron app. `unsupported` means Notion.app has no `Contents/Frameworks/Electron Framework.framework`: Notion announced a move to SwiftUI at WWDC 2026, a native Notion has no web page or DevTools to theme, so `patchNotion()` refuses it before touching anything (`UNSUPPORTED_MESSAGE`), Settings shows "Not supported yet" with no button, and the watcher leaves it alone. Notion 7.39.0 (Oct 2026) is still Electron. A Notion update swaps the whole app and leaves no `Notion.real`, so patch sets `notionInstalled` in the config (unpatch clears it) and status says needs-repair instead of not-installed. `NOTISKIN_NOTION_APP` overrides the Notion location, for tests only.

**Watcher (`src/patcher/watcher.ts`):** An FSEvents watcher installed as a LaunchAgent. Watches the folder holding Notion.app (Notion's updater swaps the whole bundle) and Contents/MacOS, plus a check every 10 minutes. When status is needs-repair it waits for Notion to close and runs `patchNotion()` as the user, no sudo.

**Marketplace (Supabase):** Tables `themes`, `plugins`, `reviewers`, `ratings`. Edge functions in `supabase/functions/` handle submit, review, and rating with the service role after verifying the user. Installing from the Browse tab writes to `~/.notiskin/themes/` or `~/.notiskin/plugins/` — it does **not** auto-activate. The live schema was never fully committed; `supabase/legacy/reconstructed-schema.sql` is the best record, see the notes in it.

---

## Important constraints and known behaviour

- Notion preloads hidden duplicate pages. The daemon deliberately themes all Notion pages, hidden ones included, so preloaded tabs are ready when shown.
- The DevTools pipe (checked on Electron 41.3.0, Notion 7.22's version, and 42): Chromium quits when its pipe closes, so Notion holds both ends of both FIFOs itself (`3<>` / `4<>`). The injector can crash, be killed or be deleted and Notion carries on; a new injector reconnects mid-session. Keep these:
  - `command exec 3<>...` in the wrapper, a plain `exec` whose redirect fails ends the script before Notion starts
  - the injector's `3<&- 4<&-`, it must not hold Notion's pipes
  - never read or write the FIFOs with `net.Socket`: macOS's kqueue misses FIFO data (a reply over the 8 KB pipe buffer stalled the reader for good on a real Mac) and never reports their end-of-file. `PipeConnection` uses blocking `fs.read`/`fs.write` on the thread pool, and also polls Notion's pid
  - `notiskin inject` keeps its pid lock until the process exits (it calls `process.exit` after stopping), a second injector reading the same pipe steals replies
  - `Target.detachedFromTarget` only drops the session it names; detaching an old injector's session must not drop the daemon's own session for that tab
  - command ids start at a random number and unknown replies are ignored, the pipe can still hold an earlier injector's replies
  - a killed injector's sessions stay attached with their document-start CSS, the daemon detaches them (by targetId on start, and any unknown sessionId it hears from)
- No TCP debug port should ever be open: `lsof -iTCP -sTCP:LISTEN` while Notion runs. Diagnostics reports whether port 9222 is open (an old wrapper).
- Integration tests use a fake Notion (test/fixtures/fake-notion, an Electron app, in pipe mode when given `--remote-debugging-pipe`). Tests look inside its pages through its own `POST /__eval`, never the pipe. Never point tests at the real Notion app.
- Changing `/Applications/Notion.app` needs macOS App Management for whichever app starts it (Notiskin, or Electron/Terminal when running from source). Root doesn't help: a command run through the admin password dialog (`osascript ... with administrator privileges`) gets EPERM even from Terminal, checked on macOS 26. So the app patches as the user, which works because Notion.app normally belongs to the user. Unsigned (ad-hoc) builds may lose the permission after an update until Developer ID signing.
- Notion's updater (Squirrel.Mac) takes the *running* process's designated requirement (`SecCodeCopySelf`, so `Notion.real` while patched) and refuses any update that doesn't meet it. Plain ad hoc signing makes that requirement "this exact build" (cdhash), which blocked every update from June to Oct 2026. `signNotion()` signs only `Notion.real` and the outer bundle, ad hoc with identifier `com.notiskin.patched` and the requirement `(Notion's Developer ID requirement, team LBQJ96FQ8D) or identifier "com.notiskin.patched"`. Notion-signed updates pass the first half; the patched Notion meets the second, which the keychain needs (an unmet own requirement made a test app unable to read its own keychain item). Notion's frameworks and helpers keep Notion's signatures (no `--deep`, except as a fallback when something inside is broken). Trade-off, known and accepted: a forged ad hoc update labelled `com.notiskin.patched` would also pass, so it relies on Notion's update servers and HTTPS. Keeping Notion's own signature on `Notion.real` doesn't work (macOS kills it). Installs signed the old way are re-signed by the next patch, and the desktop app does that on start (`hasOldSignature()`). Unpatch signs the same way, so Notion can still update after an uninstall. ShipIt (Notion's installer, in `Squirrel.framework/Versions/A/Resources`) runs when Notion quits and swaps in the update. `--deep` skips it, so in a bundle signed the old way it kept Notion's team while Mantle etc. became ad hoc, and macOS refused to load them into it ("different Team IDs" in `~/Library/Caches/notion.id.ShipIt/ShipIt_stderr.log`). The update was accepted, then never installed. `signNotion()` signs ShipIt and Squirrel.framework ad hoc whenever their teams don't match (`shipItMismatch()`), and that counts as an old signature too.
- Nothing needs `sudo` any more. Older versions made `/etc/sudoers.d/notiskin` and `~/.notiskin/Notiskin.app` for the watcher; they aren't created now, unpatch still removes them (the sudoers rule only with sudo).
- A full clean uninstall is a single command: `npm run unpatch`. It removes the wrapper script, restores the Notion binary, removes the LaunchAgent, removes an old sudoers rule (when run with sudo) and signing helper if they're there. `npm run watch:uninstall` still works independently if only the watcher needs to be removed.
- Safe mode (`safeMode` in the config) makes `currentPayload()` return nothing, and both the injector and `applyConfig()` go through it. Turning it on reloads every Notion tab (plugins can't be un-run) and never restarts Notion. Diagnostics text always goes through `redact()` (Notion links, IDs, home folder, user name), keep it that way for anything new added to the report.
- Integration tests can run in a cloud container as a normal user under a virtual display: `runuser -u ubuntu -- xvfb-run -a node --test --test-concurrency=1 test/integration/*.test.js` (Electron refuses to run as root).
- Important user-facing features get a step in the welcome tour (`src/gui/tour.js`, the `STEPS` list): one short card pointing at the control, in plain words. Keep "Install into Notion" as the last step. A target that's hidden falls back to a centered card, so the step is safe when the control isn't shown.
- GUI colors only come from the tokens in `src/gui/brand.css`, never hardcoded hex, so light and dark mode both work. The exception is the `.theme-preview` / `.ns-*` block in themes.html, which imitates Notion's own colors on purpose.
- MutationObserver plugins can self-trigger infinite loops. Scope observers tightly, wrap in try/catch, include loop guards.
- `onAuthStateChange` alone doesn't catch already-persisted sessions. Always call `getSession()` on page load too.
- The local server binds 127.0.0.1 and every `/api` call needs the per-launch `X-Notiskin-Token` header (injected into pages by server.ts, added automatically by a fetch wrapper). New pages must be served through `sendPage()`.
- Never trust `user_metadata` for identity, users can edit it. Edge functions use `verifyUser()` (GitHub identity), RLS uses `public.current_github_username()`, and the GUI shows `githubUsername(user)` from the identity.
- Sign-in only happens in Settings (always shows GitHub's account picker). The Review link only shows for reviewers: Settings checks once per sign-in and saves `notiskin.reviewer` in localStorage, every page reads it right after the sidebar. Cosmetic only, the edge functions do the real check.
- The Supabase migrations were never applied with the CLI (there's no migration history table on the live project). Before the first `supabase db push`, run `supabase migration repair --status applied 20261016000000 20261017000000`, never push the baseline onto the live database.

---

## Commits

- Commit as the notiskin account: `git -c user.name=notiskin -c user.email=295556921+notiskin@users.noreply.github.com commit ...`
- No `Co-Authored-By` lines and no mention of Claude in commits, PRs, or release notes.
- Run `npm run lint`, `npm run typecheck`, and `npm test` before committing. `npm run test:integration` needs macOS (it launches Electron); CI runs it on a macOS runner.

---

## Current status and open items (update this section as things change)

Done (Oct 2026): security hardening (commit 7ea8a9d), the long-running injector (commit 3275a8f), and Phase 0:
- The GitHub token that leaked in v0.1.0–v0.3.0 is revoked, and those releases are deleted (their tags are kept)
- Releases are built by `.github/workflows/release.yml` with the workflow's own token, no personal token needed
- Supabase restored. The live schema is committed as a baseline migration (`supabase/snapshots/2026-10-pre-hardening.txt` is the raw capture), the hardening migration is applied and checked, and the edge functions are redeployed with JWT verification on
- Checked against the real backend: a forged `user_metadata` reviewer gets no access, direct client writes are refused, authorship comes from the GitHub identity, CSS escapes and `image-set` are held for review, and reviewing, rating and installing still work
- v0.4.0 published by the workflow, bundle checked free of `.env`
- Sign-in moved to Settings, Review tab only shown to reviewers
- Deleting your own pending submission from My Submissions checked in the real app
- Supabase Auth's Site URL set to `http://localhost:3845`

Done (Oct 2026), Phase 1:
- "Install into Notion" in Settings (PRs #9 and #10): Install, Repair, and Uninstall with no password, checked on a real Mac (install, restart, reopen from the Dock, file owners, uninstall, CLI patch/unpatch). The original plan's single admin password prompt was dropped because App Management blocks it, see the constraint above
- v0.5.0 published by the workflow, bundle checked free of `.env`. The DMG app installed into Notion on a real Mac: macOS blocked it first, the Settings "Open App Management" button (`x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles`) opened the right page, and after turning on notiskin there Install worked
- Safe mode and diagnostics (PR #14, plan in `docs/prompts/phase-1-safe-mode-diagnostics.md`), checked on a real Mac: safe mode removes the theme and survives a Notion restart, the notice's Turn off brings it back, and the diagnostics report shows correct statuses with the home folder, user name and Notion links hidden. Phase 1 is complete

Done (Oct 2026), debug port closed (branch `debug-pipe`):
- Notion runs with `--remote-debugging-pipe` instead of `--remote-debugging-port=9222`, so no other program or user account on the Mac can connect to it. Old wrappers are repaired by the app on start
- To check on a real Mac: the checklist in the debug-pipe PR (Dock icon, reopen from the Dock, Quit, notion:// links, Notion's own update relaunch, theme after restart, no listening port)

Known until Developer ID signing (Phase 2): a downloaded release shows "notiskin is damaged and can't be opened" on Apple Silicon, and right-click → Open doesn't help. The fix is `xattr -dr com.apple.quarantine /Applications/notiskin.app` (in the README).

Phase 2 in progress:
- Notion updates itself again (branch notion-updates, also refuses to patch a non-Electron Notion): signing keeps Notion's requirement, status shows needs-repair after an update, the watcher repatches as the user. Checked on a real Mac on Oct 20, 2026: 7.22.0 updated itself to 7.39.0 (after the ShipIt fix), status said needs-repair, and Repair brought the theme back. Still open from the PR checklist: mic/camera prompts, uninstall, and the watcher on the next Notion update
- Intel builds done (the Release workflow checks both chips were built and every built file is attached)
- Welcome tour done: a card points at each control across Themes, Plugins and Settings, ending at Install into Notion. It starts on its own only when `setupDone` isn't set and Notion isn't installed (`GET /api/setup`), so existing users aren't interrupted. Finishing or skipping calls `POST /api/setup-done`; Settings → Help replays it. Progress is in sessionStorage, so a half-finished tour restarts next launch
- New look, "paper and ink": warm paper, ink text, one vermilion accent, Fraunces headings, lowercase "notiskin" wordmark next to a small copy of the app icon (its colors are fixed `--logo-*` tokens). Main buttons are ink, vermilion is for selection, tabs, toggles and focus (white on vermilion is below 4.5:1 contrast)
- App icon done: `build/icon.png` (1024px on Apple's grid, 824px body), electron-builder turns it into icon.icns; `npm start` shows it in the Dock. Cut from a ChatGPT image with a superellipse mask fitted to the artwork's corners
- Still to do: Developer ID signing (on hold until the Apple account is sorted) The Phase 0 plan is kept for reference in `docs/prompts/phase-0-security-cleanup.md`.

---

## Working style

- Explain what each change does in plain English before making it.
- Warn before any operation that touches real Notion files, modifies system paths, or costs money.
- Ask before making structural decisions (new files, renamed exports, changed interfaces).
- Do not auto-start destructive operations — patch/unpatch/publish should always require explicit confirmation.
- Keep CLI commands working alongside the Electron app. Changes to `server.ts` or `injector` must not break the CLI.
- Never extract files from an `app.asar` into the repo folder (it can overwrite the real `.env`). Inspect bundles in a temp folder with list-only checks.
- Never print secret values. Check that a key exists by name only.