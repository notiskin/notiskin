# Notiskin roadmap

Weeks assume roughly 5–8 hours of work a week. ✅ = done.

## ✅ Phase 0: Finish the security cleanup (done October 2026)

Detailed plan: [docs/prompts/phase-0-security-cleanup.md](docs/prompts/phase-0-security-cleanup.md)

- ✅ Confirm the GitHub token that leaked in old releases is revoked
- ✅ Restore the Supabase project (it stopped resolving on 2026-10-17, it was paused)
- ✅ Apply the auth-hardening migration and deploy the rewritten edge functions
- ✅ Build releases in GitHub Actions instead of on a laptop, so no personal token is needed
- ✅ Release 0.4.0, then remove the v0.1.0–v0.3.0 builds that contain `.env`
- ✅ Sign in from Settings only, and only show the Review tab to reviewers

## ✅ Phase 1: Reliability (done October 2026)

- ✅ Long-running injector: themes every tab and window, survives reloads without flashing, applies changes live, exits with Notion
- ✅ "Install into Notion" button in Settings ([plan](docs/prompts/phase-1-install-button.md)). The app patches Notion with its own bundled runtime, so DMG users keep themes across restarts. No password: macOS App Management blocks the admin-prompt route, so it installs as the user and needs App Management for Notiskin instead
- ✅ Uninstall button that fully reverses it, and Repair after a Notion update
- ✅ Safe mode: pause every theme and plugin from Settings or `notiskin safe-mode on`, in case a plugin breaks Notion ([plan](docs/prompts/phase-1-safe-mode-diagnostics.md))
- ✅ Diagnostics in Settings: versions, install status, injector status, recent log lines, "copy diagnostics" for bug reports, with Notion links, IDs and the user name hidden

## Phase 2: Distribution (weeks 4–6, about 8–10 hours plus Apple's wait)

- ✅ New look: "paper and ink" (warm paper, ink, vermilion, Fraunces), light and dark following macOS
- ✅ App icon: an ink rounded square with a cream page peeling back to vermilion, also the sidebar logo
- ✅ Intel Mac builds: separate downloads for Apple Silicon and Intel
- Apple Developer ID signing and notarization ($99/year): removes "damaged app" warnings and makes auto-update work
- ✅ First-run walkthrough: a short tour of every page that ends at Install into Notion, replayable from Settings → Help

## Phase 3: Marketplace v2 (weeks 6–10, about 25–30 hours)

- Item versions: authors publish updates, installed items show "update available", plugin updates are re-reviewed with a diff
- Screenshots, tags, sort by rating or downloads, download counts
- Report button and a reviewer action log
- Rate limits enforced server-side
- [x] Tests for the edge functions (Deno, mocked database, runs in CI)

## Phase 4: Creator tools (weeks 10–14, about 25 hours)

- Theme editor with color pickers and live preview in Notion
- More theme variables: fonts, borders, database views, light/dark variants
- Stop themes from flattening Notion's colored text (the core CSS forces one text color today)
- Plugin settings API (`notiskin.settings`) with settings forms in the app
- Plugin developer mode with auto-reload from a local folder
- Docs site

## Phase 5: Code health (ongoing, about 10 hours)

- Pull duplicated code out of the four GUI pages into one shared script: the escape helper, the Supabase client, the update banner, and about 40 inline `onclick` handlers. Removing the inline handlers also allows a strict Content Security Policy
- Browser tests for the GUI
- Type definitions for plugin authors

## Later, maybe

- Windows support (large)
- Theme sync across devices
- Plugin permissions or sandboxing (hard)

## Known limitations

- Disabling a plugin removes it from the current tab right away. Other open tabs drop it on their next reload.
- Installing into Notion needs App Management for Notiskin. Until releases are signed with a Developer ID, macOS may forget that permission after a Notiskin update (remove Notiskin from the list and add it again).
- The long-running injector has been tested against a fake Notion (an Electron app in `test/fixtures/fake-notion`), not yet against the real Notion's tabs.
