# Phase 3: Marketplace v2

Paste-ready brief for a Claude Code session on the owner's Mac. Phase 3 is several PRs, one per part below, in this order. Each part ends with a merged PR before the next starts.

---

You're working in a clone of github.com/notiskin/notiskin (public repo). Read `CLAUDE.md`, `README.md`, `ROADMAP.md` (Phase 3) and `supabase/legacy/reconstructed-schema.sql` first. The owner, Remi, is a high schooler: explain each step in short plain English before doing it, and say where something could break.

## Hard rules (these override everything else)

1. **The Supabase project is live and real people use it.** Applying a migration, deploying an edge function, creating a storage bucket, or changing project settings are outward actions: say exactly what will change and wait for Remi's clear "yes" each time. Try every migration on a local Supabase first (`supabase start`, needs Docker), and capture the live schema before changing it (as in `docs/prompts/phase-0-security-cleanup.md`, step 4).
2. **The migrations were never applied with the CLI.** Before the first `supabase db push`, run `supabase migration repair --status applied 20261016000000 20261017000000`. Never push the baseline onto the live database.
3. **Every new table gets row level security** in the same migration, and clients get no `update`/`delete`/`truncate` they don't need. Writes that need trust go through an edge function using `verifyUser()` (GitHub identity) and the service role. Never trust `user_metadata`. The service role key never leaves the edge functions and is never printed.
4. **Warn before anything that costs money** (Supabase plan limits: storage, egress, function calls) and say what the free tier allows.
5. Ask Remi before structural decisions: new tables or columns, new files, new config fields, changed endpoints or interfaces. The open decisions are listed per part below; ask them at the start of that part, with a recommendation first.
6. Ask before pushing, opening or merging a PR, or releasing. Commit as notiskin with no Claude attribution: `git -c user.name=notiskin -c user.email=295556921+notiskin@users.noreply.github.com commit ...`. No `Co-Authored-By` lines, no mention of Claude in commits, PRs or release notes.
7. Run `npm run lint`, `npm run typecheck`, `npm test` before every commit, and `npm run test:integration` (macOS) before a PR. Never touch the real Notion app from code or tests.
8. GUI colors only from the tokens in `src/gui/brand.css`. Important new user-facing controls get a welcome-tour step (`src/gui/tour.js`), "Install into Notion" stays last.

## What's true today

- **Tables:** `themes` and `plugins` (id, name, description, author_github, css / js, status `pending`/`approved`/`rejected`, created_at, rejection_reason, name_normalized unique, avg_rating, rating_count), `reviewers` (github_username), `ratings` (user_id, item_id, item_type, rating 1-5, unique per user and item). One row per item, so there are no versions.
- **RLS** (`supabase/migrations/20261017000000_harden_marketplace_auth.sql`): anyone reads approved items, authors read and delete their own unapproved ones, clients can't update anything, ratings are written only by the `rate-item` function.
- **Edge functions** (`supabase/functions/`): `submit-theme` (name 1-60 of `[a-z0-9 ]`, description up to 500, CSS up to 20,000 characters, auto-approved when `validateThemeCss()` in `_shared/css.ts` passes, otherwise pending), `submit-plugin` (always pending), `review-pending`, `review-decide` (reviewers only, `isReviewer()`), `rate-item`. Shared helpers are in `_shared/http.ts`. They're deployed with JWT verification on. **None have tests.**
- **The app** (`src/gui/server.ts`): `POST /api/marketplace/install` fetches an approved item's code by id and writes `~/.notiskin/themes/<name>.css` or `plugins/<name>.js`, and **skips the write if that file already exists**. Nothing records which marketplace item or version a file came from, so the app can't tell when an update is out. Submissions go through the app's proxy with a 5-per-15-minutes `express-rate-limit`, which only limits the app: anyone can call the function directly. `rate-item` is called straight from `themes.html`.
- Installing never turns an item on. A plugin shows a warning the first time (`acknowledgedPlugins` in the config).

## Part 1: Tests for the edge functions (do this first, it's the safety net for everything after)

- Deno tests for `_shared/css.ts` (the allowlist, including the escape and `image-set` cases already checked by hand in Phase 0) and `_shared/http.ts` (name/description cleaning, `normalizeName`).
- Tests for each function's request handling with the database mocked: method checks, sign-in required, bad input, reviewer-only paths, duplicate names (409).
- A CI job in `.github/workflows/ci.yml` that runs them (`denoland/setup-deno`).
- Decision to ask: mock the database in Deno, or run them against a local Supabase in CI (slower, closer to real)?

## Part 2: Server-side rate limits

- Limit submissions, ratings and reports in the edge functions themselves, per GitHub user, so calling a function directly doesn't get around them. Keep the app's limiter as a first line.
- Decision to ask: a small Postgres table of recent actions checked inside each function (recommended, no new service) vs. another approach. Pick limits with Remi (e.g. 5 submissions an hour, 30 ratings an hour).
- Tests from Part 1 cover the limit and the error message.

## Part 3: Item versions and "update available"

The biggest part. Authors publish a new version of their own item. Users see that an installed item has an update and update it with one click.

- **Database.** Decision to ask: an `item_versions` table (item id, version number, code, status, changelog, created_at) with the item row pointing at its latest approved version (recommended, keeps history and enables the diff), vs. a version column on the item row.
- **Submitting a new version** is only allowed for the item's author (`author_github` from the verified identity). Theme versions go through the same allowlist and auto-approve. **Plugin versions go back to review**, and the reviewer sees a diff against the last approved version (a simple line diff in `review.html`). The approved version stays live until the new one is approved.
- **The app has to remember where an installed file came from.** Decision to ask: a manifest such as `~/.notiskin/installed.json` (`{ "theme:dark": { id, version } }`, written atomically like the config, recommended) vs. a header comment inside each file. Files the user wrote themselves have no entry and are never touched.
- **Update available:** the Installed tab checks installed items against the marketplace and shows an Update button. Updating a plugin shows the plugin warning again and says what changed (the changelog). Decision to ask: notify only and update on click (recommended), or update themes automatically?
- Installing over an existing file with the same name must not silently replace a theme the user made themselves.
- Publish tab: "Publish a new version" for items you own, with a changelog field. My Submissions shows pending versions.
- Tests: manifest read/write, the update check, the install endpoint refusing unapproved versions, and the Deno tests for the new function.

## Part 4: Screenshots, tags, sorting and download counts

- **Screenshots.** Decision to ask: Supabase Storage bucket, size and type limits (e.g. PNG/JPEG/WebP, up to 1 MB, up to 3 per item), uploads private until the item is approved, served from a public URL after. Check the free tier's storage and egress first and tell Remi.
- **Tags.** Decision to ask: a fixed list (dark, light, minimal, colorful, productivity, fun..., recommended, nothing to moderate) vs. free text.
- **Sorting:** newest, top rated, most downloaded. Search keeps using `sanitizeSearch()`.
- **Download counts:** counted server-side when the app installs an item (a function or RPC the install endpoint calls), at most once per user per item per day so they can't be pumped up. Decision to ask how strict.

## Part 5: Report button and reviewer action log

- **Report:** signed-in users report an item with a reason from a short list plus an optional note. Stored in a `reports` table only reviewers can read, rate limited (Part 2). Decision to ask: should several reports hide an item automatically until a reviewer looks?
- **Action log:** every review decision, hide or unhide, and report resolution is written to an append-only table (who, what, when, why), shown on the Review page. Clients can't write or change it.

## Definition of done (each part)

- Migrations tried on a local Supabase, applied to the live project only after Remi's yes, and the live schema captured before and after.
- Edge functions deployed with JWT verification on, and checked against the real backend the way Phase 0 did: a non-author can't publish a version of someone else's item, a non-reviewer can't approve, limits refuse the next request.
- GUI checked in the browser (for a quick look, run this branch's server with the Notion setup mocked and a throwaway `NOTISKIN_DIR`, since port 3845 is fixed), and in a packaged build when the change is in the app.
- `ROADMAP.md` ticks the item, `CLAUDE.md` describes what was built (tables, functions, files), PR merged. A release only when Remi asks.
