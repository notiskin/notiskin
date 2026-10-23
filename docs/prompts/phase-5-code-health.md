# Phase 5: Code health

Paste-ready brief for a Claude Code session on the owner's Mac. Three parts, one PR each, in this order. Nothing here should change what users see, except where a part says so.

---

You're working in a clone of github.com/notiskin/notiskin (public repo). First read `CLAUDE.md`, `ROADMAP.md` (Phase 5), and the four GUI pages in `src/gui/` (`themes.html`, `plugins.html`, `settings.html`, `review.html`) with the shared scripts next to them (`marketplace.js`, `tour.js`, `brand.css`). The owner, Remi, is a high schooler. Explain each step in short plain English before doing it, and say where something could break.

## Hard rules

1. **Behavior stays the same.** These are refactors. Every page must look and work as before, in light and dark mode. Check each page in the browser against this branch's server (`notiskin-gui` in `.claude/launch.json`, or `node -e "require('./dist/gui/server').startServer(false)"` with a throwaway `NOTISKIN_DIR`). Before clicking anything, stub `switchTheme`, `clearTheme` and `togglePlugin`, because switching a theme restarts the real Notion.
2. Never touch the real Notion app or the live Supabase project from tests.
3. Ask Remi before structural decisions: new files, new dependencies, renamed globals. The open decisions are listed per part. Ask them at the start of that part, with your recommendation first.
4. Ask before pushing, opening or merging a PR. Commit as notiskin with no Claude attribution: `git -c user.name=notiskin -c user.email=295556921+notiskin@users.noreply.github.com commit ...`. No `Co-Authored-By` lines.
5. Run `npm run lint`, `npm run typecheck` and `npm test` before every commit, and `npm run test:integration` before a PR.
6. New shared files are served from the fixed `ASSETS` list in `server.ts` and are already packaged by `build.files` (`src/gui/**/*.js`). Check a packaged build (`npx electron-builder --mac dir --publish never`) still loads them.

## What's true today

- Each of the four pages has its own copy of the same helpers: `esc()`, the Supabase client (`window.supabase.createClient`, PKCE only in Settings), `githubUsername()`, `hideReviewLink()`, the update banner (`checkUpdateBanner()`, `openReleasesPage()`), the busy overlay and notifications.
- About 49 inline `onclick=` handlers across the pages, plus inline `<script>` blocks. `server.ts` injects a small inline bootstrap script (the per-launch `X-Notiskin-Token` and the fetch wrapper) into every page through `sendPage()`.
- The only Content Security Policy is `frame-ancestors 'none'`.
- GUI tests are server-level only (`test/server.test.js`). The pages themselves are checked by hand in a browser.
- Plugin authors get no type definitions for `window.notiskin`.

## Part 1: One shared page script, then a strict Content Security Policy

- Move the duplicated helpers into one shared script (e.g. `src/gui/common.js`, ask), loaded by every page before its own code. Keep each page's behavior. Settings keeps PKCE for sign-in, and other pages may share its client options if nothing changes for them.
- Replace the inline `onclick=` handlers with `addEventListener` in the scripts.
- Move each page's inline `<script>` into a file, or give it a nonce. Decision to ask: per-launch nonces from `sendPage()` for the bootstrap and any remaining inline scripts (recommended), or move everything to files. Then send a strict policy: `default-src 'self'; script-src 'self' 'nonce-…'; connect-src 'self' https://<project>.supabase.co; style-src 'self' 'unsafe-inline'` (inline styles are everywhere today; say whether removing them is worth it), `img-src 'self' data:`, `frame-ancestors 'none'`.
- Tests: a server test that every page response carries the policy and its nonce matches the page's scripts. Then every page checked in the browser with the console open: no CSP violations, and sign-in, Browse, Publish, Review and Settings all still work.

## Part 2: Browser tests for the GUI

- Decision to ask: Playwright as a dev dependency driving Chromium against the real server with a throwaway `NOTISKIN_DIR` and Supabase faked at the server (`marketplaceRemote`, `authBrowser`, `notionSetup` are already swappable), recommended. The alternative is jsdom in node tests, lighter but it can't test layout or real clicks.
- Cover: theme list and switching (with `notionSetup`/apply faked, never the real Notion), plugin toggles and the warning dialog, Browse (search, sort, the Tags card, Install, Report dialog), Publish forms (tags limit, link check), the Update and pulled-item rows, Settings sign-in states, the welcome tour, and safe mode.
- Run them in CI (the `package` job is already macOS; decide whether they get their own job).

## Part 3: Type definitions for plugin authors

- A `notiskin.d.ts` describing `window.notiskin`: every method, its arguments and return values, and the settings API if Phase 4 Part 4 is done.
- Decision to ask: ship it in the repo and link it from the docs (recommended to start), or publish an npm package (`@notiskin/types`, needs an npm account and a release step).
- A test that the declared methods match what `src/injector/index.ts` actually defines, so the types can't drift.

## Definition of done (each part)

- All suites green, integration tests before the PR, and the pages checked in the browser in light and dark mode.
- `ROADMAP.md` ticks the item, `CLAUDE.md` is updated (the GUI structure section for Part 1), PR merged.
