# Notiskin

> **Warning:** Plugins run with full, unrestricted access to your Notion page and data. Only enable plugins from sources you trust. Marketplace plugins are reviewed by a human before they're listed, but Notiskin doesn't sandbox plugin code.

Notiskin is an open source modding tool for the Notion desktop app on macOS. It applies CSS themes and JavaScript plugins to Notion, similar to Spicetify for Spotify or BetterDiscord for Discord.

## How it works

Notion loads its interface live from `notion.so`, so Notiskin doesn't edit Notion's files. Instead it:

1. Starts Notion with `--remote-debugging-port=9222`, which turns on the Chrome DevTools Protocol (CDP).
2. Runs a small background injector for as long as Notion is open. It themes every Notion tab and window, re-applies after reloads (with no flash of the default look), and picks up theme, plugin, and settings changes live. It exits when Notion quits.
3. Optionally **installs into Notion** (Settings → Notion → Install): the Notion executable is replaced by a tiny wrapper script that always adds the debug port and starts the injector on every launch. The original binary is kept as `Notion.real` and backed up to `~/.notiskin/backup/`. If Notiskin is later moved or deleted, Notion still starts, just without a theme.

Themes and plugins live in `~/.notiskin/themes/*.css` and `~/.notiskin/plugins/*.js`. The active theme and enabled plugins are stored in `~/.notiskin/notiskin.config.json`.

## Install

Download the latest `.dmg` from [Releases](https://github.com/notiskin/notiskin/releases/latest) and drag Notiskin into Applications. The app isn't signed with an Apple Developer ID yet, so macOS says it "is damaged and can't be opened" (it isn't). Click **Cancel**, not "Move to Bin", then run this once in Terminal and open it normally:

```bash
xattr -dr com.apple.quarantine /Applications/notiskin.app
```

That removes the "downloaded from the internet" mark, which tells macOS you trust the app. Only do this for apps you trust.

To keep your theme every time Notion starts, open **Settings → Notion** and click **Install**, then restart Notion when it offers. No password is needed. After a Notion update the status shows **Needs repair**: click **Repair**. **Uninstall** puts Notion back exactly as it was.

macOS may block the install under **System Settings → Privacy & Security → App Management**, which controls which apps may change other apps. If it does, Notiskin says so and has a button to that page: turn on Notiskin and try again. Until Notiskin is signed with a Developer ID, macOS may forget that permission after a Notiskin update; if Notiskin is already switched on and still blocked, remove it with **−** and add it again.

## Desktop app

The app has tabs for themes, plugins, the marketplace (browse, install, rate, publish), and settings. It runs a small server on `127.0.0.1:3845` that only the app's own window can use: every API call needs a secret token that is generated fresh each launch, and requests from other websites are rejected.

### Safe mode and diagnostics

If a plugin breaks Notion, open **Settings → Safe mode → Turn on**. Every theme and plugin is paused (Notion's page reloads to drop plugins) until you turn it off, and nothing you've chosen is forgotten. From Terminal: `notiskin safe-mode on` / `off`.

**Settings → Diagnostics** shows versions, install status, whether the injector is running, and recent log lines, with a **Copy** button for bug reports. Notion page links, IDs, and your Mac username are hidden before anything is shown or copied. From Terminal: `notiskin diagnostics`.

## Command line

```bash
npm install
npm run build

npm run apply                       # apply the active theme and enabled plugins
npm run themes                      # list installed themes (* = active)
npm run theme -- <name>             # switch theme and apply
npm run theme -- clear              # go back to Notion's default look
npm run theme -- delete <name>
npm run plugins                     # list installed plugins (* = enabled)
npm run plugin -- enable <name>
npm run plugin -- disable <name>    # reloads Notion's page, JS can't be un-run
npm run plugin -- delete <name>
node dist/cli/index.js safe-mode on   # pause all themes and plugins (off to resume)
node dist/cli/index.js diagnostics    # the same report as Settings → Diagnostics
```

### Patching Notion from the command line (alternative to the app's Install button, touches /Applications/Notion.app)

```bash
npm run patch               # wrapper, works without sudo when you own Notion.app (the usual case)
sudo npm run patch          # same, plus a passwordless re-signing rule the watcher uses
npm run watch:install       # LaunchAgent that repatches after Notion auto-updates
npm run unpatch             # restores everything: binary, signature, LaunchAgent, helper
```

Terminal needs App Management (System Settings → Privacy & Security) to change Notion. `sudo` is only needed for the watcher: the sudoers rule it installs (`/etc/sudoers.d/notiskin`) only allows that one exact `codesign` command, so the watcher can re-sign Notion after an update without asking. Removing that rule needs root too: `sudo npm run unpatch`, or `sudo rm /etc/sudoers.d/notiskin`.

An admin password can't get past App Management: macOS checks which app asks, not which user, and a command run through the admin password dialog loses track of the app that started it. That's why the app installs as you instead of asking for a password.

## Writing a theme

Themes set `--ns-*` variables inside `:root`. Marketplace themes must contain only those variables, with color values (hex, `rgb()`, `hsl()`, `color-mix()`, gradients, `var()`, `calc()`). `url()`, `@import`, quotes and backslashes are rejected.

```css
:root {
  --ns-bg: #1a1a1a;
  --ns-sidebar-bg: #111111;
  --ns-topbar-bg: #1a1a1a;
  --ns-hover-bg: #2a2a2a;
  --ns-text: #e0e0e0;
  --ns-title-text: #ffffff;
  --ns-link-color: #7eb8f7;
  --ns-inline-code-bg: #2d2d2d;
  --ns-inline-code-color: #e06c75;
  --ns-code-block-bg: #141414;
  --ns-callout-bg: #222222;
  --ns-divider-color: #333333;
  --ns-quote-border-color: #555555;
  --ns-scrollbar-thumb: #444444;
  --ns-scrollbar-track: transparent;
}
```

## Writing a plugin

Plugins are plain JavaScript that runs inside each Notion tab once the page has loaded. Each plugin runs at most once per page load, so re-applying a theme won't double up listeners. Disabling a plugin reloads the current tab; other open tabs drop it on their next reload. A small helper API is available as `window.notiskin`:

```js
notiskin.onPageChange(() => console.log('now on', notiskin.getPageTitle()));
notiskin.addToolbarButton('Hello', () => alert('hi'));
```

Keep `MutationObserver`s tightly scoped and guard against triggering yourself, or you can freeze Notion.

## Development

```bash
cp .env.example .env        # only needed for publishing and pointing at a different Supabase project
npm run gui                 # run the GUI server in your browser without Electron
npm start                   # run the desktop app
npm run lint
npm run typecheck
npm test
npm run test:integration    # runs the injector and the patcher against a fake Notion made with Electron
```

Set `NOTISKIN_DIR=/some/folder` to use a throwaway data folder instead of `~/.notiskin`. Tests also set `NOTISKIN_NOTION_APP` to patch a copy of the fake Notion in a temp folder, never `/Applications`. macOS App Management doesn't guard that temp folder, so only a real Mac can check the App Management behaviour.

### Project layout

```
src/cli/          command line entry point
src/core/         shared theme/plugin logic used by the CLI, the GUI server, and launch-time injection
src/electron/     desktop app main process
src/gui/          Express server + HTML pages
src/injector/     CDP injection (index.ts one-shot, daemon.ts long-running)
src/patcher/      Notion wrapper patching and the auto-repatch watcher
src/updater/      update checks
supabase/         marketplace edge functions and database migrations
scripts/          build helpers (check-bundle.js blocks secrets from ever being packaged)
test/             node:test suites
```

### Marketplace backend

The marketplace runs on Supabase. Edge functions in `supabase/functions/` verify every sign-in with Supabase Auth and read the GitHub username from the linked GitHub identity (never from `user_metadata`, which users can edit). Database policies live in `supabase/migrations/`.

```bash
supabase db push
supabase functions deploy
```

The functions need an `NS_SERVICE_ROLE_KEY` secret (`supabase secrets set NS_SERVICE_ROLE_KEY=...`). Never put the service role key in `.env` or the app.

### Releasing

Releases are built by the **Release** workflow in GitHub Actions, so no personal token is needed.

1. Bump the version without tagging: `npm version minor --no-git-tag-version`
2. Commit `package.json` and `package-lock.json`
3. Merge to `main`
4. Run the **Release** workflow from the Actions tab (Actions → Release → Run workflow, on `main`)

The workflow runs lint, typecheck, unit and integration tests, refuses to run if the version's tag already exists, then builds and uploads to GitHub Releases. The build fails if `.env` or other dev-only files end up inside the app.

Local fallback (macOS only, needs a `GH_TOKEN` with "contents: write" in `.env`):

```bash
npm run publish:dry-run     # lint, test, build, and secret-check without publishing
npm run publish             # tags, builds, and uploads to GitHub Releases
```

`publish` refuses to run with uncommitted changes, off `main`, or if the version's tag already exists. Bump with `--no-git-tag-version` as above, since `publish` creates the tag itself.

## Roadmap

See [ROADMAP.md](ROADMAP.md).

## License

MIT
