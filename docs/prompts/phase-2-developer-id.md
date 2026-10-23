# Phase 2 (last item): Developer ID signing and notarization

Paste-ready brief for a Claude Code session on the owner's Mac. Start only once Remi has a paid Apple Developer Program membership ($99 a year). Two PRs: signed builds first, then updates that install themselves.

---

You're working in a clone of github.com/notiskin/notiskin (public repo). First read `CLAUDE.md` (especially the signing constraint, the App Management constraint and the Electron app section), `README.md` (the "damaged" workaround), `package.json` (`build`), `.github/workflows/release.yml`, `src/updater/index.ts` and `scripts/check-bundle.js`. The owner, Remi, is a high schooler. Explain each step in short plain English before doing it, and say where something could break.

## Hard rules

1. **Secrets never get printed, committed or pasted into chat.** The certificate (`.p12`), its password, the Apple ID app-specific password or API key go only into GitHub Actions secrets. Remi adds them himself in the repo's Settings → Secrets, and you check by name only (`gh secret list`). Keep `.env` out of bundles: `check-bundle.js` must still pass.
2. **Anything on Apple's side (enrollment, certificates, app-specific passwords, API keys) is Remi's to click.** Give exact steps and wait.
3. **Releasing is outward.** Ask before running the Release workflow, and before deleting or replacing any release or tag.
4. **Notion's own signature handling is a separate thing and must not change.** `signNotion()` in `src/patcher/index.ts` signs the *patched Notion* ad hoc with Notion's team requirement, and that stays exactly as it is. This brief signs the *Notiskin app*. Don't touch Notion from tests. Check patching only with the fake Notion and the integration tests, and give Remi a checklist for his real Mac.
5. Commit as notiskin with no Claude attribution: `git -c user.name=notiskin -c user.email=295556921+notiskin@users.noreply.github.com commit ...`. Run lint, typecheck, `npm test` and `npm run test:integration` before a PR.

## What's true today

- Builds are ad hoc signed (`CSC_IDENTITY_AUTO_DISCOVERY: 'false'` in the workflow), with no hardened runtime and no notarization. A downloaded release says "notiskin is damaged and can't be opened". The README tells people to run `xattr -dr com.apple.quarantine /Applications/notiskin.app`.
- `src/updater/index.ts` only checks for updates (`autoDownload = false`). Squirrel.Mac won't install one ad hoc build over another, so the UI says "Notiskin X is out" with a Download link. `installUpdate()` is kept for later.
- macOS can forget the App Management permission for an ad hoc app after an update, so Install / Repair into Notion fails until it's turned on again.
- The app runs its own binary as Node with `ELECTRON_RUN_AS_NODE=1` in three places: the CLI for patch / unpatch, the injector that Notion's wrapper starts on every launch, and the watcher LaunchAgent. All three must keep working once the app is signed with the hardened runtime.

## Part 1: Signed and notarized builds

1. Walk Remi through it: enroll in the Apple Developer Program, create a "Developer ID Application" certificate, export it as `.p12` with a password, and create notarization credentials. Decision to ask: an App Store Connect API key (recommended, no personal Apple ID password) or an Apple ID with an app-specific password. Remi adds the secrets to GitHub, e.g. `CSC_LINK` (base64 of the `.p12`), `CSC_KEY_PASSWORD`, plus `APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` or `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`.
2. `package.json` `build.mac`: `hardenedRuntime: true`, an entitlements file (ask before adding it) with only what Electron needs (`com.apple.security.cs.allow-jit`; check whether `allow-unsigned-executable-memory` is still needed for the Electron version in use), and notarization turned on.
3. **`ELECTRON_RUN_AS_NODE` must keep working.** Check whether the electron-builder / Electron version in use flips the `RunAsNode` fuse off when signing. If it does, keep it on explicitly and say why in a comment, because patching, the injector and the watcher all depend on it. Prove it in CI: after building, run the packaged binary with `ELECTRON_RUN_AS_NODE=1` against `dist/cli/index.js --version` (or a harmless command) and fail the job if it doesn't run.
4. Release workflow: drop `CSC_IDENTITY_AUTO_DISCOVERY: 'false'`, pass the secrets, and fail the run if the result isn't signed with the Developer ID, notarized and stapled (`codesign --verify --deep --strict`, `spctl -a -vv`, `stapler validate` on both chips).
5. CI's `package` job keeps building unsigned (no secrets on pull requests).
6. README: replace the `xattr` section with "open it normally", and keep a short note for people still on a version before the first signed one.
7. Checklist for Remi on his real Mac, from a release built by the workflow:
   - the dmg opens with no warning
   - Install into Notion works (App Management prompt once)
   - after a restart of Notiskin the permission is still there
   - Notion's theme loads, so the injector ran
   - Repair works
   - the watcher switch works
   - diagnostics looks right

## Part 2: Updates that install themselves

- With signed builds, Squirrel.Mac can install updates. Turn downloading back on (or download when the user clicks), add the "Downloading" / "Ready, restart to install" states the comment in `src/updater/index.ts` mentions, and wire `installUpdate()` to a button in Settings and the banner.
- Decision to ask: download in the background and offer Restart (recommended, like most Mac apps), or only download after a click.
- Only from a signed version to a newer signed one. The first signed release still has to be installed by hand by people on 0.8.x and earlier, so say so in its release notes.
- Check end to end with two real signed releases (e.g. 0.9.0 then 0.9.1, ask before publishing): the app finds, downloads and installs the update, and Notion's theme still loads afterwards. The injector path inside the app bundle doesn't change, so no Repair should be needed. Confirm that.

## Definition of done

- A release built by the workflow, signed, notarized and stapled for both chips, opens on a fresh download with no warning, and Remi's checklist passes.
- In-app update from one signed release to the next works on Remi's Mac.
- `ROADMAP.md` ticks the item and drops the "damaged" known limitation. `CLAUDE.md` updates the Packaging line, the updater description and the "Known until Developer ID signing" note.
