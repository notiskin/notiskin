# Phase 6: Code health

Paste-ready brief for a Claude Code session on the owner's Mac. Four parts, one PR each, in this order. Nothing here should change what users see, except where a part says so.

---

You're working in a clone of github.com/notiskin/notiskin (public repo). First read `CLAUDE.md`, `ROADMAP.md` (Phase 6), and the four GUI pages in `src/gui/` (`themes.html`, `plugins.html`, `settings.html`, `review.html`) with the shared scripts next to them (`marketplace.js`, `tour.js`, `brand.css`). The owner, Remi, is a high schooler. Explain each step in short plain English before doing it, and say where something could break.

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
- Everything lives in one repository: the app (CLI, injector, Electron, GUI), the Supabase backend (`supabase/`) and the docs site (`site/`).

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

## Part 4: One repository or several (a decision, not a refactor)

Remi isn't sure whether to keep one repository (monorepo) or split into several (polyrepo). Decide this first, before the other parts move any files, because it changes where they land. Nothing is split in this part unless Remi says so.

What is in the repository today, and what ties it together:

- The app: `src/`, `test/`, the Electron packaging and the Release workflow.
- The backend: `supabase/` (edge functions, migrations, Deno tests). `test/theme-css.test.js` loads `supabase/functions/_shared/css.ts` directly, and the tag list has to match in four places (the migration, `_shared/details.ts`, `core/marketplace.ts`, `marketplace.js`).
- The docs site: `site/`. `test/site.test.js` checks it against the app's code (every variable, every `notiskin` method, working links, examples that pass the allowlist), so the docs can't drift from what the app does.
- Possible later: starter themes and plugins (Phase 5), a `notiskin.d.ts` or `@notiskin/types` package (Part 3 here), the marketplace content.

Questions to work through with Remi, with a recommendation:

- What does a split buy? Separate release cadence and permissions per piece, a smaller clone for contributors who only want themes or docs, a backend repo that other people could deploy.
- What does it cost? The cross-checks above stop being one `npm test` and become version pinning or a published package, a change to the allowlist then needs two PRs and a deploy order, and the Release workflow, CI and issue tracking multiply.
- Likely recommendation: stay a monorepo for now. The app, backend and docs change together and are tested against each other. The pieces that really are separate are content: starter themes and plugins can live in their own repository (or a `community/` folder) with no code coupling, and a types package can be published from a subfolder. Revisit if outside contributors or a second maintainer make permissions or clone size a problem.
- If Remi does want a split, plan it as its own PRs: which piece first (the docs site is the easiest, it only needs the code's variable and method lists as a published JSON file or package), how the cross-checks survive, and how the Release workflow finds what it needs.

Output: a short decision note in `ROADMAP.md` (what was decided and why), and only then any move.

## Definition of done (each part)

- All suites green, integration tests before the PR, and the pages checked in the browser in light and dark mode.
- `ROADMAP.md` ticks the item, `CLAUDE.md` is updated (the GUI structure section for Part 1), PR merged.
