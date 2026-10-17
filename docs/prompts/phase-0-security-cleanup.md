# Phase 0: finish the security cleanup and ship 0.4.0

Paste-ready brief for a Claude Code session. It's written to work in a **cloud session** that cloned this repo: no `.env`, no access to the owner's Mac, Terminal, or Notion app. Steps that need the owner say so.

---

You're working in a fresh clone of github.com/notiskin/notiskin (public repo). Read `CLAUDE.md`, `README.md`, and `ROADMAP.md` first. The owner, Remi, prefers short plain-English explanations: say what each step does before doing it.

## Hard rules (these override everything else)

1. **Ask Remi in chat and wait for a clear "yes" before every outward or irreversible action:** pushing, opening or merging a PR, running SQL against the database, deploying edge functions, setting Supabase secrets, triggering a release, deleting a release, asset, or tag. One approval covers one action.
2. **Never print, log, commit, or echo a secret value** (tokens, the service role key, database passwords). Check whether an environment variable is set by name only, e.g. `[ -n "$SUPABASE_ACCESS_TOKEN" ] && echo set`.
3. **Never extract files from an `app.asar` into the repo folder.** An earlier session did and it overwrote a real `.env`. To inspect a bundle, unzip into a temp folder and use list-only checks: `require('@electron/asar').listPackage(path, { isPack: false })`.
4. **Commit as the notiskin account with no Claude attribution:** `git -c user.name=notiskin -c user.email=295556921+notiskin@users.noreply.github.com commit ...`. No `Co-Authored-By` lines and no mention of Claude in commits, PR text, or release notes.
5. Work on a branch (e.g. `phase-0-cleanup`) and open a PR. Remi merges it. Don't push to `main` directly.
6. Things only Remi can do (dashboard clicks, GitHub settings, anything on their Mac): give exact, numbered instructions and wait for them to report back. Don't guess at what a dashboard shows.

## What's already true

- **Leaked token:** releases v0.1.0, v0.2.0, and v0.3.0 on GitHub were built with `.env` packed inside `app.asar` (`/.env` is listed in all three). That file held a GitHub personal access token with write access to this repo. Remi said they'd revoke it; this hasn't been confirmed in writing.
- **Fixed in code (commit 7ea8a9d, CI green):** `.env` is no longer packaged; `scripts/check-bundle.js` (electron-builder `afterPack` hook) fails any build that contains `.env` or dev-only files; the local server is locked down; the edge functions verify sign-ins properly; `publish.js` refuses unsafe runs.
- **Long-running injector** landed in commit 3275a8f.
- **Supabase is down:** project `rdsoztlxtbfwdjcfqhmt` stopped resolving in DNS on 2026-10-17 (`rdsoztlxtbfwdjcfqhmt.supabase.co` → NXDOMAIN). Probably paused for inactivity, possibly deleted.
- **Written but not deployed:**
  - `supabase/functions/{submit-theme,submit-plugin,review-pending,review-decide,rate-item}/index.ts`, plus shared helpers in `supabase/functions/_shared/{http.ts,css.ts}`. They read the secret `NS_SERVICE_ROLE_KEY` and pin `esm.sh/@supabase/supabase-js@2.108.2`.
  - `supabase/migrations/20261017000000_harden_marketplace_auth.sql`. It drops **every** policy on `themes` and `plugins` and recreates them using `public.current_github_username()` (read from `auth.identities`, never `user_metadata`), removes client UPDATE access, locks `reviewers` to the server, and makes `ratings` writable only by the edge function.
- **The live schema was never fully committed.** `supabase/legacy/reconstructed-schema.sql` is the best record, and its header lists columns whose DDL is missing.
- **The public Supabase URL and publishable key are set in four places:** `src/utils/constants.ts`, and `SUPABASE_URL` / `SUPABASE_KEY` near the top of the script in `src/gui/themes.html`, `src/gui/plugins.html`, and `src/gui/review.html`.
- **Releases are built on a Mac** with `npm run publish` (`publish.js`), which needs a `GH_TOKEN` in `.env`. Electron-builder can't make macOS builds on Linux, so a cloud session can't run it.
- **Known doc bug:** README's release section says `npm version minor`, which creates a git tag. `publish.js` then refuses to run because the tag already exists.
- CI (`.github/workflows/ci.yml`) runs lint, typecheck, unit tests, and audit on Ubuntu, then integration tests and an unpacked-app build on macOS.

## Environment check (do this first)

Run `npm ci` (set `ELECTRON_SKIP_BINARY_DOWNLOAD=1` on Linux), `npm run lint`, `npm run typecheck`, and `npm test`. All must pass before you change anything. `npm run test:integration` needs macOS, so skip it here; CI covers it.

Check which of these environment variables exist, by name only: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`. Tell Remi which ones are missing. They're only needed for the CLI route in steps 4–5; the dashboard route works without them.

## Steps, in order

Keep a task list. After each step, tell Remi in one or two sentences what changed and what's next.

### 1. Confirm the old token is dead
Ask Remi to confirm they revoked the leaked token at github.com/settings/tokens. If they still use any personal token for pushing from their Mac, it should be a new fine-grained one scoped to notiskin/notiskin (Contents and Workflows: read and write).
**Done when:** Remi confirms the revocation.

### 2. Move releases to GitHub Actions
This removes the need for a personal token in `.env` entirely.

- Add `.github/workflows/release.yml`:
  - trigger: `workflow_dispatch` only
  - runner: `macos-latest`
  - permissions: `contents: write`
  - steps:
    1. checkout and set up Node 24
    2. `npm ci`
    3. lint, typecheck, `npm test`, `npm run test:integration`
    4. fail if tag `v<package.json version>` already exists on the remote
    5. `npx electron-builder --mac --publish always` with `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` and `CSC_IDENTITY_AUTO_DISCOVERY: 'false'`
  - The afterPack bundle check runs as part of step 5.
- Fix the README "Releasing" section:
  1. bump with `npm version minor --no-git-tag-version`
  2. commit
  3. merge to main
  4. run the Release workflow from the Actions tab

  Keep `npm run publish` documented as the local fallback.
- Commit on your branch (rule 4) and open a PR (**approval**). Ask Remi to merge it once CI is green.

**Done when:** the workflow file is on `main`.

### 3. Bring Supabase back
Ask Remi to open supabase.com/dashboard and tell you what the project shows: paused, deleted, or something else.

- **Paused:** Remi clicks Restore. Then confirm `curl -s -o /dev/null -w "%{http_code}" https://rdsoztlxtbfwdjcfqhmt.supabase.co/rest/v1/` returns an HTTP status instead of a DNS failure.
- **Deleted or not restorable:** stop and lay out the rebuild with Remi before doing anything:
  - a new project
  - the schema from `supabase/legacy/reconstructed-schema.sql`, with the missing columns filled in and committed as a migration
  - GitHub OAuth configured, with the redirect URL `http://localhost:3845`
  - the new URL and publishable key in the four places listed above
  - a `reviewers` row for `notiskin`
  - the `NS_SERVICE_ROLE_KEY` secret

**Done when:** the REST endpoint answers.

### 4. Capture the live state before changing it
Have Remi run this in the dashboard SQL editor and paste the output to you:

```sql
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public' and tablename in ('themes','plugins','reviewers','ratings')
order by 1, 2;
```

Also ask for the column list of those four tables, from `information_schema.columns`, and their grants.

- Save the output as `supabase/snapshots/2026-10-pre-hardening.txt`.
- Turn the real column definitions into a proper baseline migration, timestamped before 20261017, so the schema is finally in git.
- Check the hardening migration's assumptions against the snapshot:
  - `themes` / `plugins` have `author_github`, `status`, `created_at`, `updated_at`, `rejection_reason`, `avg_rating`, `rating_count`, `name_normalized` (unique)
  - `reviewers.github_username` exists
  - `ratings` has `user_id`, `item_id`, `item_type`, `rating`, `updated_at`, and a unique `(user_id, item_id, item_type)`

  If anything differs, fix the migration and show Remi the diff.
- Commit and open a PR (**approval**).

### 5. Apply the migration
Explain in plain English what the migration changes and what it removes. Mention that reading approved items and ratings keeps working, because SELECT stays open.

**With approval**, apply it in one of two ways:
- **Dashboard (easiest):** Remi pastes the file into the SQL editor and runs it.
- **CLI:** needs `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD`. Run `supabase link --project-ref rdsoztlxtbfwdjcfqhmt`, then `supabase db push`. Don't push the baseline migration onto a database that already has those tables; mark it as applied with `supabase migration repair` instead.

Afterwards, have Remi re-run the `pg_policies` query and confirm the new set.

### 6. Deploy the edge functions
Needs the Supabase CLI and `SUPABASE_ACCESS_TOKEN`. If the cloud session doesn't have them, give Remi the exact commands to run on their Mac.

1. Confirm `NS_SERVICE_ROLE_KEY` exists, by name only: `supabase secrets list --project-ref rdsoztlxtbfwdjcfqhmt`.
2. If it's missing, Remi sets it from the dashboard. The key never goes into the repo, `.env`, the app, or chat.
3. **With approval:** `supabase functions deploy --project-ref rdsoztlxtbfwdjcfqhmt`. Keep JWT verification on (the default). Never pass `--no-verify-jwt`.

### 7. Prove the fixes against the real backend
Remi runs these in the desktop app, using a second, non-reviewer GitHub account if they have one. Write each one out as exact instructions and record the results:

- **Fake reviewer:** sign in as the non-reviewer. In the app window's DevTools, run `await db.auth.updateUser({ data: { user_name: 'notiskin' } })`, then open the Review tab → expect **"Not a reviewer"**.
- **Direct database write:** with that user's session, try `await db.from('themes').update({ status: 'approved' }).eq('status', 'pending').select()` → expect an error or an empty result.
- **Author spoofing:** submit a theme normally → the stored `author_github` is the real GitHub username, whatever the client sent.
- **Theme check:** a theme containing `\75rl(` or `image-set("...")` is held for review, not auto-approved.
- **Normal paths, as `notiskin`:** check that each of these still works:
  - the review queue loads
  - approve and reject work
  - rating works
  - Browse → Install works
  - My Submissions lists and deletes your own pending items

Report the results as a checklist. Clean up test submissions afterwards (ask first).

### 8. Release 0.4.0
1. On a branch, run `npm version minor --no-git-tag-version`, commit `package.json` and `package-lock.json` (rule 4), and open a PR (**approval**). Remi merges it once CI is green.
2. Ask Remi to run the Release workflow from the Actions tab (or trigger it yourself if you have access, **with approval**).
3. When it finishes, check through the public API that:
   - there's exactly one v0.4.0 release
   - it has the dmg, zip, blockmaps, and `latest-mac.yml`
   - `latest-mac.yml` says `version: 0.4.0`
4. Download the v0.4.0 zip into a temp folder and confirm its `app.asar` has no `/.env` (list only, rule 3).

### 9. Remove the leaked builds
Only after 0.4.0 is live, so anyone checking for updates lands on it.

- Recommend deleting the v0.1.0, v0.2.0, and v0.3.0 **releases** on GitHub, keeping the git tags. Remi does this in the GitHub UI: Releases → each release → Delete. Alternatively, do it through the API if the session has a token with permission (**approval**).
- Confirm through the public API that no remaining release asset is from a version before 0.4.0.
- Remind Remi to delete their local copies, which also contain `.env`: `release/notiskin-0.1.0-*`, `release/notiskin-0.2.0-*`, `release/notiskin-0.3.0-*` in their checkout on the Mac.

### 10. Wrap up
- Update the "Current status and open items" section of `CLAUDE.md`: remove what's resolved, keep what's still open. Update `ROADMAP.md` (tick off Phase 0). Commit on a branch and open a PR (**approval**).
- Give Remi a short summary: what was done, what was verified and how, and what's next. Next up is Phase 1, the "Install into Notion" button.

## Definition of done
- [ ] Old token confirmed revoked
- [ ] Release workflow on main; README release steps fixed
- [ ] Supabase reachable
- [ ] Live schema snapshotted and committed as a baseline migration
- [ ] Hardening migration applied; new policies confirmed
- [ ] Edge functions deployed with JWT verification on
- [ ] All step 7 checks pass
- [ ] v0.4.0 published by the workflow; bundle confirmed free of `.env`
- [ ] No pre-0.4.0 releases left on GitHub; Remi reminded to delete local copies
- [ ] CLAUDE.md status and ROADMAP.md updated
