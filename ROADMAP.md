# Notiskin roadmap

Weeks assume roughly 5–8 hours of work a week. ✅ = done.

## Phase 0: Finish the security cleanup (about 2–3 hours, mostly the owner)

Detailed plan: [docs/prompts/phase-0-security-cleanup.md](docs/prompts/phase-0-security-cleanup.md)

- Confirm the GitHub token that leaked in old releases is revoked
- Restore the Supabase project (it stopped resolving on 2026-10-17, probably paused)
- Apply the auth-hardening migration and deploy the rewritten edge functions
- Build releases in GitHub Actions instead of on a laptop, so no personal token is needed
- Release 0.4.0, then remove the v0.1.0–v0.3.0 builds that contain `.env`

## Phase 1: Reliability (weeks 1–4, about 15–20 hours)

- ✅ Long-running injector: themes every tab and window, survives reloads without flashing, applies changes live, exits with Notion
- "Install into Notion" button in the app. Today only the CLI can patch, and the patch points at a local repo checkout and Node install, so people using the DMG can't keep themes across restarts. The app should patch using its own bundled runtime, with one admin password prompt
- Uninstall button that fully reverses it
- Safe mode: start Notion with all mods off, in case a plugin breaks it
- Diagnostics in Settings: patch status, injector status, recent log lines, "copy diagnostics" for bug reports

## Phase 2: Distribution (weeks 4–6, about 8–10 hours plus Apple's wait)

- App icon (it's still the default Electron one)
- Intel Mac builds (only Apple Silicon today)
- Apple Developer ID signing and notarization ($99/year): removes "damaged app" warnings and makes auto-update work
- First-run walkthrough

## Phase 3: Marketplace v2 (weeks 6–10, about 25–30 hours)

- Item versions: authors publish updates, installed items show "update available", plugin updates are re-reviewed with a diff
- Screenshots, tags, sort by rating or downloads, download counts
- Report button and a reviewer action log
- Rate limits enforced server-side
- Tests for the edge functions

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
- The long-running injector has been tested against a fake Notion (an Electron app in `test/fixtures/fake-notion`), not yet against the real Notion's tabs.
