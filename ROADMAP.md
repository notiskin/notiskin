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

Only Developer ID signing is left: [plan](docs/prompts/phase-2-developer-id.md), on hold until the Apple account is sorted.

- ✅ New look: "paper and ink" (warm paper, ink, vermilion, Fraunces), light and dark following macOS
- ✅ App icon: an ink rounded square with a cream page peeling back to vermilion, also the sidebar logo
- ✅ Intel Mac builds: separate downloads for Apple Silicon and Intel
- Apple Developer ID signing and notarization ($99/year): removes "damaged app" warnings, keeps the App Management permission across updates, and lets updates install themselves
- ✅ The microphone works in a patched Notion: macOS asked for permission and AI Meeting Notes recorded (checked Oct 21, 2026 on 7.40.0). Notion has no camera feature to check
- ✅ A real Notion update repaired with one click: 7.39.0 updated itself to 7.40.0 on Oct 21, 2026, Settings showed Needs repair, Repair brought the theme back
- ✅ First-run walkthrough: a short tour of every page that ends at Install into Notion, replayable from Settings → Help

## ✅ Phase 3: Marketplace v2 (done October 2026, released in 0.8.0)

Detailed plan: [docs/prompts/phase-3-marketplace-v2.md](docs/prompts/phase-3-marketplace-v2.md). Everything was checked on the live backend with real accounts.

- ✅ Tests for the edge functions (Deno, mocked database, runs in CI)
- ✅ Rate limits enforced server-side (publishing, rating, reporting, editing details)
- ✅ Item versions: authors publish updates, installed items show "update available", plugin updates are re-reviewed with a diff
- ✅ Tags, an optional GitHub link (instead of screenshots, which would use paid storage), sorting by rating or downloads, download counts, and a Tags button on Browse
- ✅ Report button, automatic hiding after 3 "harmful" reports from accounts at least a day old, and an append-only reviewer action log
- ✅ A warning on installed items that later get pulled from the marketplace
- ✅ GitHub sign-in in the default browser, so Google sign-in and passkeys work

## Phase 4: Creator tools (weeks 10–14, about 25 hours)

Detailed plan: [docs/prompts/phase-4-creator-tools.md](docs/prompts/phase-4-creator-tools.md)

- ✅ Keep Notion's colored text instead of flattening it, plus a colored text palette themes can set (`--ns-color-red` … `--ns-color-pink` and `-bg` versions)
- ✅ Theme editor with color pickers and live preview in Notion
- ✅ More theme variables: fonts (quoted names in the font variables only), borders and radius, database views, light/dark variants in one file
- ✅ Plugin settings API (`notiskin.settings`) with settings forms in the app
- ✅ Plugin developer mode with auto-reload from a local folder
- Docs site

## Phase 5: Code health (ongoing, about 10 hours)

Detailed plan: [docs/prompts/phase-5-code-health.md](docs/prompts/phase-5-code-health.md)

- Pull duplicated code out of the four GUI pages into one shared script: the escape helper, the Supabase client, the update banner, and about 40 inline `onclick` handlers. Removing the inline handlers also allows a strict Content Security Policy
- Browser tests for the GUI
- Type definitions for plugin authors

## Checks on a real Mac

Small things not yet seen end to end:

- The watcher repairing a real Notion update by itself ("Repair automatically after Notion updates" is off by default; one-click Repair after an update is proven)
- The rest of the DevTools-pipe checklist from the debug-pipe PR: reopening Notion from the Dock, `notion://` links, Notion relaunching itself after its own update

## Later, maybe

- Windows support (large)
- Theme sync across devices
- Plugin permissions or sandboxing (hard)

## Known limitations

- Disabling a plugin removes it from the current tab right away. Other open tabs drop it on their next reload.
- Installing into Notion needs App Management for Notiskin. Until releases are signed with a Developer ID, macOS may forget that permission after a Notiskin update (remove Notiskin from the list and add it again).
- Until Developer ID signing, a downloaded release says it "is damaged" and needs the `xattr` command from the README, and updates are downloaded and installed by hand.
