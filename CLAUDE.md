# Notiskin — Claude Code Context

## What this is

Notiskin is an open-source macOS tool that injects custom CSS themes and JavaScript plugins into the Notion desktop app. It works by relaunching Notion with `--remote-debugging-port=9222` and using the Chrome DevTools Protocol (CDP) to inject a `<style>` or `<script>` element into the live running page. It does **not** edit Notion's bundled files — Notion loads its content live from `app.notion.com`, so asar editing doesn't work for main content injection.

Reference projects: Spicetify, BetterDiscord, Vencord. MIT licensed. Hosted at github.com/notiskin/notiskin.

---

## Stack

- **Language:** TypeScript, compiled to `dist/` via `tsc`
- **Runtime:** Node.js
- **GUI server:** Express on port 3845
- **Desktop app:** Electron (entry point: `src/electron/main.ts`)
- **Injection mechanism:** Chrome DevTools Protocol via `chrome-remote-interface`
- **Marketplace backend:** Supabase (Postgres + Auth + Storage)
- **Auth:** GitHub OAuth via Supabase
- **Packaging:** electron-builder (produces `.app` bundle, currently unsigned)
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
  core/library.ts         — Shared theme/plugin logic (paths, name validation, apply). CLI + server both use it
  electron/main.ts        — Electron main process entry point
  gui/
    server.ts             — Express server; exports startServer() and app
    run.ts                — Dev entry point; calls startServer(true) for standalone mode
    themes.html / plugins.html / review.html / settings.html — GUI pages
  injector/index.ts       — One-shot CDP injection (CSS + JS into Notion), plugins run once per page load
  injector/daemon.ts      — Long-running injector: one browser-level CDP connection, themes every Notion tab, re-applies on reload and on file changes, exits when Notion quits
  utils/pidlock.ts        — Single-instance lock (~/.notiskin/injector.pid)
  patcher/
    index.ts              — Patches Notion's app bundle; exports patchNotion(), unpatchNotion()
    watcher.ts            — FSEvents watcher; detects Notion updates and repatches
  updater/index.ts        — electron-updater wrapper (Electron only)
  types/chrome-remote-interface.d.ts
  utils/
    constants.ts          — Paths (~/.notiskin, overridable via NOTISKIN_DIR), ports, public Supabase config
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

**CLI (`src/cli/index.ts`):** The npm bin target. Commands: `patch`, `unpatch`, `themes`, `theme <name>`, `plugins`, `plugin enable/disable <name>`, `apply`, `watch:install`, `watch:uninstall`. These work independently of the Electron app.

**Electron app (`src/electron/main.ts`):** Starts the Express server, creates a BrowserWindow loading `http://localhost:3845`, quits fully when the window is closed. Single-instance lock prevents duplicate windows. This is what opens when you launch Notiskin from Spotlight or Applications.

**Express server (`src/gui/server.ts`):** Serves `themes.html`, `plugins.html`, `review.html`, and `settings.html`. Exposes REST endpoints for the GUI: theme switching, plugin toggling, marketplace search/install (the server fetches approved code from Supabase by id), submissions, and proxies to the edge functions. Does **not** auto-start on import — call `startServer()` explicitly. `src/gui/run.ts` is a thin dev entry point that calls `startServer(true)` directly.

**Injector (`src/injector/`):** `index.ts` is the one-shot path the GUI/CLI use for immediate feedback; it targets the visible page (checks `document.visibilityState`). `daemon.ts` is started by `notiskin inject` (the wrapper runs it on every Notion launch, and `ensureInjector()` in core/library.ts starts it whenever a theme is applied). It attaches to every Notion page target via `Target.setDiscoverTargets` + flat sessions, registers a document-start style script so reloads don't flash, re-injects on `Page.loadEventFired`, and re-applies to all tabs when files in ~/.notiskin change. Theme CSS is a `<style id="notiskin-styles">` element; core CSS and `window.notiskin` are only injected when a theme / plugin is active.

**Patcher (`src/patcher/index.ts`):** Replaces the Notion executable with a wrapper shell script that adds `--remote-debugging-port=9222` on every launch and triggers the injector. The original binary is renamed to `Notion.real`. Also manages re-signing with `codesign`. `patchNotion()` and `unpatchNotion()` are the main exports.

**Watcher (`src/patcher/watcher.ts`):** An FSEvents watcher installed as a LaunchAgent. Watches for Notion updates (which overwrite the wrapper), then repatches when Notion is next closed.

**Marketplace (Supabase):** Tables `themes`, `plugins`, `reviewers`, `ratings`. Edge functions in `supabase/functions/` handle submit, review, and rating with the service role after verifying the user. Installing from the Browse tab writes to `~/.notiskin/themes/` or `~/.notiskin/plugins/` — it does **not** auto-activate. The live schema was never fully committed; `supabase/legacy/reconstructed-schema.sql` is the best record, see the notes in it.

---

## Important constraints and known behaviour

- Notion preloads hidden duplicate pages. The one-shot injector checks `document.visibilityState === 'visible'`; the daemon deliberately themes all Notion pages, hidden ones included, so preloaded tabs are ready when shown.
- Integration tests use a fake Notion (test/fixtures/fake-notion, an Electron app). Never point tests at the real Notion app.
- The patcher requires `sudo` for the initial `codesign` call. A scoped sudoers rule at `/etc/sudoers.d/notiskin` enables silent re-signing after that.
- A full clean uninstall is a single command: `npm run unpatch`. It removes the wrapper script, restores the Notion binary, removes the LaunchAgent, removes the sudoers rule, and removes the signing helper. `npm run watch:uninstall` still works independently if only the watcher needs to be removed.
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

Open:
- Deleting your own pending submission from My Submissions wasn't tried in the real app (the database rule was tested on a scratch copy)
- Supabase Auth's Site URL is `http://localhost:3000` with an empty redirect allow list. Sign-in works because Supabase accepts redirects to the same hostname, setting the Site URL to `http://localhost:3845` would be tidier
- GitHub Actions warns that `actions/checkout@v4` and `actions/setup-node@v4` run on deprecated Node 20, bump them when newer majors are out

Next: Phase 1, starting with the "Install into Notion" button (see ROADMAP.md). The Phase 0 plan is kept for reference in `docs/prompts/phase-0-security-cleanup.md`.

---

## Working style

- Explain what each change does in plain English before making it.
- Warn before any operation that touches real Notion files, modifies system paths, or costs money.
- Ask before making structural decisions (new files, renamed exports, changed interfaces).
- Do not auto-start destructive operations — patch/unpatch/publish should always require explicit confirmation.
- Keep CLI commands working alongside the Electron app. Changes to `server.ts` or `injector` must not break the CLI.
- Never extract files from an `app.asar` into the repo folder (it can overwrite the real `.env`). Inspect bundles in a temp folder with list-only checks.
- Never print secret values. Check that a key exists by name only.