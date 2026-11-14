# Notiskin roadmap

Weeks assume roughly 5–8 hours of work a week. ✅ = done.

## ✅ Phase 0: Finish the security cleanup (done October 2026)

- ✅ Confirm the GitHub token that leaked in old releases is revoked
- ✅ Restore the Supabase project (it stopped resolving on 2026-10-17, it was paused)
- ✅ Apply the auth-hardening migration and deploy the rewritten edge functions
- ✅ Build releases in GitHub Actions instead of on a laptop, so no personal token is needed
- ✅ Release 0.4.0, then remove the v0.1.0–v0.3.0 builds that contain `.env`
- ✅ Sign in from Settings only, and only show the Review tab to reviewers

## ✅ Phase 1: Reliability (done October 2026)

- ✅ Long-running injector: themes every tab and window, survives reloads without flashing, applies changes live, exits with Notion
- ✅ "Install into Notion" button in Settings. The app patches Notion with its own bundled runtime, so DMG users keep themes across restarts. No password: macOS App Management blocks the admin-prompt route, so it installs as the user and needs App Management for Notiskin instead
- ✅ Uninstall button that fully reverses it, and Repair after a Notion update
- ✅ Safe mode: pause every theme and plugin from Settings or `notiskin safe-mode on`, in case a plugin breaks Notion
- ✅ Diagnostics in Settings: versions, install status, injector status, recent log lines, "copy diagnostics" for bug reports, with Notion links, IDs and the user name hidden

## Phase 2: Distribution (weeks 4–6, about 8–10 hours plus Apple's wait)

Only Developer ID signing is left, on hold until the Apple account is sorted.

- ✅ New look: "paper and ink" (warm paper, ink, vermilion, Fraunces), light and dark following macOS
- ✅ App icon: an ink rounded square with a cream page peeling back to vermilion, also the sidebar logo
- ✅ Intel Mac builds: separate downloads for Apple Silicon and Intel
- Apple Developer ID signing and notarization ($99/year): removes "damaged app" warnings, keeps the App Management permission across updates, and lets updates install themselves
- ✅ The microphone works in a patched Notion: macOS asked for permission and AI Meeting Notes recorded (checked Oct 21, 2026 on 7.40.0). Notion has no camera feature to check
- ✅ A real Notion update repaired with one click: 7.39.0 updated itself to 7.40.0 on Oct 21, 2026, Settings showed Needs repair, Repair brought the theme back
- ✅ First-run walkthrough: a short tour of every page that ends at Install into Notion, replayable from Settings → Help

## ✅ Phase 3: Marketplace v2 (done October 2026, released in 0.8.0)

Everything was checked on the live backend with real accounts.

- ✅ Tests for the edge functions (Deno, mocked database, runs in CI)
- ✅ Rate limits enforced server-side (publishing, rating, reporting, editing details)
- ✅ Item versions: authors publish updates, installed items show "update available", plugin updates are re-reviewed with a diff
- ✅ Tags, an optional GitHub link (instead of screenshots, which would use paid storage), sorting by rating or downloads, download counts, and a Tags button on Browse
- ✅ Report button, automatic hiding after 3 "harmful" reports from accounts at least a day old, and an append-only reviewer action log
- ✅ A warning on installed items that later get pulled from the marketplace
- ✅ GitHub sign-in in the default browser, so Google sign-in and passkeys work

## ✅ Phase 4: Creator tools (done October 2026, released in 0.9.0)

- ✅ Keep Notion's colored text instead of flattening it, plus a colored text palette themes can set (`--ns-color-red` … `--ns-color-pink` and `-bg` versions)
- ✅ Theme editor with color pickers and live preview in Notion
- ✅ More theme variables: fonts (quoted names in the font variables only), borders and radius, database views, light/dark variants in one file
- ✅ Plugin settings API (`notiskin.settings`) with settings forms in the app
- ✅ Plugin developer mode with auto-reload from a local folder
- ✅ Docs site (plain HTML in `site/`, published with GitHub Pages)

## ✅ Phase 5: Starter content and real-app checks (done November 2026)

- ✅ Starter content (published October 28 and November 4, 2026 from the notiskin account): 6 themes (Parchment, Midnight Ink, Serif and Mono, Daybreak, Confetti, Quiet) and 4 plugins (Reading Progress, Focus Mode, Wide Pages, Numbered Headings). The source is in its own repository, [notiskin/starter](https://github.com/notiskin/starter), and a test there keeps it valid. Alongside it: theme variables for Notion's own menus, icons and accents, and plugin API 1.2.0 (released in 0.10.0)
- ✅ Real-app checks: things that were only checked against source, a browser page or a fake Notion, run on November 4 and 5, 2026 with the packaged 0.10.0 app on a real Notion (7.40.1, then 7.42.1 after Notion updated itself during the checks):
  - ✅ The theme editor inside the packaged window, with the live preview in Notion. Save and publish for a signed-in author on an existing theme did not open the new-version form; fixed in #61, released in 0.10.1
  - ✅ A real plugin with settings enabled in the packaged app (Reading Progress, changed live, reset, safe mode, removed again)
  - ✅ Developer mode with the native folder picker, and a saved file reloading the real Notion (a `.txt` file does not reload, a badly named `.js` file is skipped with its reason, safe mode and turning it off both let go). The "N plugins running" line in Settings is only read when the page opens
  - ✅ The docs links opening https://notiskin.github.io/notiskin/ from the app (the address at the time, the docs are at https://notiskin.github.io/ since 0.11.0)
  - ✅ Settings shows the Restart Notion row after Repair when Notion is running, and its button restarts Notion with the theme (checked after a real Notion update, 7.40.1 to 7.42.1)
  - ✅ Dark mode and Notion's System mode with the new variables; board, gallery, list and calendar database views. Found and fixed: Notion's tooltips got unreadable text with a light theme (#60). Those three spots, the gallery card preview area, the empty database title and the calendar's today marker, have their own variables since 0.12.0 (`--ns-gallery-card-bg`, `--ns-title-placeholder`, `--ns-calendar-today-bg`, checked on Notion 7.42.3)
  - ✅ Reopening Notion from the Dock, `notion://` links and no open TCP port (only Notiskin's own server on 127.0.0.1:3845). Checked by opening the app the way the Dock does, not by a physical Dock click
  - ✅ The watcher repairing a real Notion update by itself: with "Repair automatically after Notion updates" on (it is off by default) and the packaged 0.12.0 app, Notion updated itself from 7.42.3 to 7.43.0 on November 13, 2026, and the watcher put the wrapper back and re-signed Notion about one second after Notion's installer finished, with no click and no macOS prompt. Opening Notion the next day loaded the theme, with no debugging port open
  - ✅ Does Notion relaunch itself after its own update? No. The update is installed when Notion quits and Notion stays closed (seen three times: 7.40.1 to 7.42.1, to 7.42.3, to 7.43.0), so the theme shows the next time you open Notion. Not seen: pressing Notion's own restart-to-update button

## ✅ Phase 6: Code health (done November 2026, released in 0.11.0)

- ✅ Decided (November 6, 2026): three repositories, not one and not many. The split follows what is coupled by code:
  - **notiskin/notiskin** (this one) keeps the app (CLI, injector, Electron, GUI), the Supabase backend in `supabase/` and the plugin types file (`notiskin.d.ts`, Part 3). These change together: the theme CSS allowlist decides what the app and the marketplace accept, the tag list is copied in four places, and one `npm test` checks all of it. Splitting them would mean two PRs and a deploy order for every allowlist change
  - **The docs site** (`site/`) moves to its own repository. It only shows pages. Its checks against the app (`test/site.test.js`: every variable, every `notiskin` method, working links, examples that pass the allowlist) must survive the move, either by keeping the test here and fetching the site, or by the app publishing a small list of its variables and methods that the site's repo checks against
  - **Starter themes and plugins** (`starter/`) move to their own repository. No code coupling, only `test/starter.test.js` (each file passes the allowlist and the plugin header parser), so someone can add a theme without cloning the app
  - The old docs address `https://notiskin.github.io/notiskin/` is baked into every release since 0.7, and this repository's name can't be reused for the new site, so the new site gets another address and this repository keeps a small redirect page at the old one. New app versions link to the new address (`isOpenableUrl()` in `server.ts` allows only the docs address)
  - The moves are their own PRs, done after the rest of Phase 6 so they don't collide with the GUI refactor: docs site first (with the redirect), starter content second
- ✅ Docs site moved to its own repository, [notiskin/notiskin.github.io](https://github.com/notiskin/notiskin.github.io), at https://notiskin.github.io/ (the user-site repo name gives the short address, and `notiskin` is a user account so the old `/notiskin/` project path keeps working). Its CI checks out this repository, builds it and runs `test/site.test.js` against it on every push and pull request and once a week. Here `site/` only holds redirect pages at the old address (releases 0.7 to 0.10.2 open it), `test/docs-redirect.test.js` keeps them true, the app links to the new address and `isOpenableUrl()` allows the `notiskin.github.io` host. A new variable or `notiskin` method now needs a docs PR over there, the docs CI fails until it has one
- ✅ Starter themes and plugins moved to their own repository, [notiskin/starter](https://github.com/notiskin/starter) (`themes/`, `plugins/`). Its CI checks out this repository, builds it and runs `test/starter.test.js` against it on every push and pull request and once a week: each theme passes the marketplace check, each plugin's settings parse, it stays off the network, compiles and type-checks against `notiskin.d.ts`, and names don't clash. The 10 live marketplace items link to the new folders. A change there is not live by itself, a new version is still published from the app
- ✅ The four GUI pages share one script (`common.js`: the escape helper, the Supabase client, the update banner, notifications) and each page's code lives in its own file. The ~70 inline `onclick` and similar handlers are gone, so every page is served with a strict Content Security Policy (scripts only from the app's own server plus one nonced bootstrap, connections only to the app and Supabase). Looks and works the same in light and dark
- ✅ Browser tests for the GUI: Playwright (Chromium) against the real server, with Supabase, Notion and the default browser faked, every test in light and dark (`npm run test:browser`, run in CI). Covers installed lists and switching, plugin toggles and the warning, Browse (search, sort, tags, install, report), Publish and Submissions, the Update and pulled-item rows, Review, Settings (sign-in, Install into Notion states, safe mode, updates), the welcome tour and the policy
- ✅ Type definitions for plugin authors: `notiskin.d.ts` in the repository root, linked from the plugin docs and the README. A test runs the code that makes `window.notiskin` and checks every name, method and the version against the file, checks that wrong calls are errors. Publishing it as an npm package (`@notiskin/types`) stays possible later from the same file

## Later, maybe

- Windows support (large)
- Theme sync across devices
- Plugin permissions or sandboxing (hard)

## Known limitations

- Disabling a plugin reloads every open Notion tab and window, because code that has already run can't be taken back.
- Installing into Notion needs App Management for Notiskin. Until releases are signed with a Developer ID, macOS may forget that permission after a Notiskin update (remove Notiskin from the list and add it again).
- Until Developer ID signing, a downloaded release says it "is damaged" and needs the `xattr` command from the README, and updates are downloaded and installed by hand.
