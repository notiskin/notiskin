# Notiskin

> **Warning:** Plugins run with full, unrestricted access to your Notion page and data. Only enable plugins from sources you trust. Marketplace plugins are reviewed by a human before they're listed, but Notiskin doesn't sandbox plugin code.

Notiskin is an open source modding tool for the Notion desktop app on macOS. It applies CSS themes and JavaScript plugins to Notion, similar to Spicetify for Spotify or BetterDiscord for Discord.

## How it works

Notion loads its interface live from `notion.so`, so Notiskin doesn't edit Notion's files. Instead it:

1. Starts Notion with `--remote-debugging-pipe`, which turns on the Chrome DevTools Protocol (CDP) over two private pipes in `~/.notiskin/run` that only your user account can open. There is no network port, so other apps and other accounts on the Mac can't reach Notion.
2. Runs a small background injector for as long as Notion is open. It themes every Notion tab and window, re-applies after reloads (with no flash of the default look), and picks up theme, plugin, and settings changes live. It exits when Notion quits.
3. Optionally **installs into Notion** (Settings → Notion → Install): the Notion executable is replaced by a tiny wrapper script that sets up the pipe and starts the injector on every launch. The original binary is kept as `Notion.real` and backed up to `~/.notiskin/backup/`. If Notiskin is later moved or deleted, or the injector crashes, Notion keeps working, just without a theme.

Themes and plugins live in `~/.notiskin/themes/*.css` and `~/.notiskin/plugins/*.js`. The active theme and enabled plugins are stored in `~/.notiskin/notiskin.config.json`.

## Install

Download the latest `.dmg` from [Releases](https://github.com/notiskin/notiskin/releases/latest) and drag Notiskin into Applications: `-arm64.dmg` for Apple Silicon Macs (M1 and later), `-x64.dmg` for Intel Macs. Not sure which you have? Apple menu → About This Mac: "Chip: Apple M…" is Apple Silicon, "Processor: Intel" is Intel. The app isn't signed with an Apple Developer ID yet, so macOS says it "is damaged and can't be opened" (it isn't). Click **Cancel**, not "Move to Bin", then run this once in Terminal and open it normally:

```bash
xattr -dr com.apple.quarantine /Applications/notiskin.app
```

That removes the "downloaded from the internet" mark, which tells macOS you trust the app. Only do this for apps you trust.

To keep your theme every time Notion starts, open **Settings → Notion** and click **Install**, then restart Notion when it offers. No password is needed. After a Notion update the status shows **Needs repair**: click **Repair**. **Uninstall** puts Notion back exactly as it was.

macOS may block the install under **System Settings → Privacy & Security → App Management**, which controls which apps may change other apps. If it does, Notiskin says so and has a button to that page: turn on Notiskin and try again. Until Notiskin is signed with a Developer ID, macOS may forget that permission after a Notiskin update; if Notiskin is already switched on and still blocked, remove it with **−** and add it again.

## Desktop app

The app has tabs for themes, plugins, the marketplace (browse, install, rate, publish), and settings. The first time you open it, a short tour points out where everything is; replay it from **Settings → Help**. It runs a small server on `127.0.0.1:3845` that only the app's own window can use: every API call needs a secret token that is generated fresh each launch, and requests from other websites are rejected.

### Safe mode and diagnostics

If a plugin breaks Notion, open **Settings → Safe mode → Turn on**. Every theme and plugin is paused (Notion's page reloads to drop plugins) until you turn it off, and nothing you've chosen is forgotten. From Terminal: `notiskin safe-mode on` / `off`.

**Settings → Diagnostics** shows versions, install status, whether the injector is running, and recent log lines, with a **Copy** button for bug reports. Notion page links, IDs, and your Mac username are hidden before anything is shown or copied. From Terminal: `notiskin diagnostics`.

### Notion updates

Notion keeps updating itself while Notiskin is installed. An update replaces the whole Notion app, so Settings shows **Needs repair** afterwards: click **Repair** and restart Notion to bring your theme back. Versions of Notiskin up to 0.5 signed Notion in a way that made it refuse every update. Opening the new version re-signs Notion on its own, but a Notion that's already stuck on an old version needs one manual update: quit Notion, download it again from [notion.com/desktop](https://www.notion.com/desktop), drag it into Applications (choose **Replace**), then click **Install** in Notiskin. Your notes and login aren't affected; if macOS asks about "Notion Safe Storage", click **Always Allow**.

Notion is moving its Mac app to SwiftUI, and Notiskin can only theme Notion's web-based (Electron) app. **Settings → Notion → Hold back a Notion Notiskin can't theme** is on by default: Notion keeps updating, but its updater refuses an update that isn't Electron, since there's no easy way back once it's installed. Turn it off to take every update (from Terminal: `notiskin block-native off`). It can't stop Notion switching parts of the current app to native from its servers. If a native Notion does get installed, Settings shows **Not supported yet** and Notiskin leaves Notion alone.

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
node dist/cli/index.js block-native off  # let Notion install updates Notiskin can't theme (on to hold them back)
node dist/cli/index.js diagnostics    # the same report as Settings → Diagnostics
```

### Patching Notion from the command line (alternative to the app's Install button, touches /Applications/Notion.app)

```bash
npm run patch               # wrapper, no sudo needed when you own Notion.app (the usual case)
npm run watch:install       # LaunchAgent that repatches after Notion updates itself
npm run unpatch             # restores the binary, removes the LaunchAgent
```

Terminal needs App Management (System Settings → Privacy & Security) to change Notion. Notion keeps updating itself while Notiskin is installed; an update switches the theme off until you click Repair (or the watcher repatches). Older versions installed a sudoers rule for the watcher with `sudo npm run patch`; it isn't used any more, remove it with `sudo npm run unpatch` or `sudo rm /etc/sudoers.d/notiskin`.

An admin password can't get past App Management: macOS checks which app asks, not which user, and a command run through the admin password dialog loses track of the app that started it. That's why the app installs as you instead of asking for a password.

## Writing a theme

You can make a theme without writing CSS: on the Themes page, **New theme** (or **Edit** on a theme you have) opens an editor with a color picker for each part of Notion, grouped as page, sidebar, text, code, accents and databases, and a Dark tab for the dark version. Notion shows your changes while you pick, and goes back to your normal theme when you close the editor (or if Notiskin quits). **Save** writes a file to `~/.notiskin/themes`, **Save and publish** takes it to the Publish tab, or to a new version if you already published a theme with that name. The CSS itself is under "The CSS itself" and the pickers only change the lines they own, so comments, fonts and anything else in the file stay as they were.

Themes set `--ns-*` variables inside `:root`. Marketplace themes must contain only those variables, with color values (hex, `rgb()`, `hsl()`, `color-mix()`, gradients, `var()`, `calc()`). `url()`, `@import`, quotes and backslashes are rejected, with two exceptions: the font variables may hold font names in double quotes, and the `:root` block can be wrapped in `@media (prefers-color-scheme: dark)` or `light` (nothing else is allowed inside `@media`, at most one of each).

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

Every variable is optional. What each one changes:

| Variable | Changes |
| --- | --- |
| `--ns-bg`, `--ns-sidebar-bg`, `--ns-topbar-bg` | page, sidebar and top bar background |
| `--ns-text`, `--ns-title-text` | plain text and the page title (text Notion colored keeps its color, see below) |
| `--ns-hover-bg` | background of a hovered block |
| `--ns-link-color` | links and their underline |
| `--ns-inline-code-bg`, `--ns-inline-code-color` | inline code |
| `--ns-code-block-bg` | code blocks |
| `--ns-callout-bg` | callouts |
| `--ns-divider-color`, `--ns-quote-border-color` | dividers, the left border of quotes |
| `--ns-scrollbar-thumb`, `--ns-scrollbar-track` | scrollbar |
| `--ns-border-color` | borders of database table cells and callouts |
| `--ns-radius` | corner radius of callouts and board cards, like `6px` (Notion uses `10px`) |
| `--ns-table-header-bg` | the header row of table views |
| `--ns-table-row-hover-bg` | a hovered row of a table view |
| `--ns-board-card-bg` | cards in board views |
| `--ns-font` | the main font |
| `--ns-font-title` | the page title and headings (follows `--ns-font` if you don't set it) |
| `--ns-font-code` | code blocks and inline code |

The three database colors (`--ns-table-header-bg`, `--ns-table-row-hover-bg`, `--ns-board-card-bg`) are painted over what Notion draws, so use a plain color, not a gradient. Anything you don't set stays as Notion draws it.

Fonts take a list of up to 8 names, quoted when they have spaces. They pick fonts that are installed on the Mac, nothing is downloaded: `--ns-font: "Inter Display", "Helvetica Neue", sans-serif;`. If you set no font variable at all, Notion's fonts stay.

Light and dark versions go in one file. Put the shared values in `:root` and what differs in a block that follows the Mac's (Notion's) light or dark setting:

```css
:root { --ns-bg: #ffffff; --ns-text: #1a1a1a; }
@media (prefers-color-scheme: dark) {
  :root { --ns-bg: #1a1a1a; --ns-text: #e0e0e0; }
}
```

Text Notion colors itself (red text, colored mentions, highlights, colored callouts) keeps Notion's colors; only plain text takes `--ns-text`. To recolor those, a theme can set a palette, all optional. Text colors are `--ns-color-<name>` and backgrounds (highlights, colored blocks) are `--ns-color-<name>-bg`, where `<name>` is `gray`, `brown`, `orange`, `yellow`, `green`, `blue`, `purple`, `pink` or `red`:

```css
:root {
  --ns-color-red: #ff7369;
  --ns-color-red-bg: #502c29;
}
```

## Writing a plugin

Plugins are plain JavaScript that runs inside each Notion tab once the page has loaded. Each plugin runs at most once per page load, so re-applying a theme won't double up listeners. Disabling a plugin reloads the current tab; other open tabs drop it on their next reload. A small helper API is available as `window.notiskin`:

```js
notiskin.onPageChange(() => console.log('now on', notiskin.getPageTitle()));
notiskin.addToolbarButton('Hello', () => alert('hi'));
```

Keep `MutationObserver`s tightly scoped and guard against triggering yourself, or you can freeze Notion.

### Developer mode

To write a plugin without installing it each time, turn on **Settings → Developer** and pick a folder. Every `.js` file in it runs in Notion like an installed plugin (it is always on, there is no switch), and **saving a file reloads Notion's tabs** so the new code runs. The files stay where they are, nothing is copied into `~/.notiskin/plugins`, and they never show up in Browse or Publish: they are listed on the Plugins tab under "Developer plugins" with a `dev` label, and a plugin that declares settings gets its Settings button there too.

- only plain `.js` files with a simple name count (letters, numbers, spaces, dashes, dots, underscores), the size limit is the same as for installed plugins, and a link or a folder called `x.js` is skipped, with the reason shown in Settings
- turning it on asks first, since the folder's files run with full access to Notion. Only choose a folder you control
- safe mode pauses developer plugins like any other, and stops watching the folder
- turning developer mode off, or changing the folder, reloads Notion's tabs too, because a plugin that has run can't be un-run

### Plugin settings

A plugin can offer options. Declare them in a comment at the very top of the file, one line per setting, as JSON after `@notiskin-setting`:

```js
/**
 * @notiskin-setting {"key":"compact","type":"toggle","label":"Compact sidebar","default":false}
 * @notiskin-setting {"key":"greeting","type":"text","label":"Greeting","default":"hello","maxLength":40}
 * @notiskin-setting {"key":"size","type":"number","label":"Size","default":14,"min":8,"max":32,"step":2}
 * @notiskin-setting {"key":"mode","type":"select","label":"Mode","default":"calm","options":["calm","loud"]}
 * @notiskin-setting {"key":"accent","type":"color","label":"Accent color","default":"#e8590c","description":"Optional text under the label"}
 */
notiskin.settings.onChange((key, value, all) => console.log(key, 'is now', value));
if (notiskin.settings.get('compact')) { /* ... */ }
```

The Plugins tab then shows a **Settings** button on the plugin's card with a form made from the declaration, and what the user picks shows in Notion right away: no reload, and a plugin that listens with `onChange` hears about the one that changed. The app reads the comment as text and never runs the plugin to do it, so the form works while the plugin is off. A line that isn't valid JSON, has an unknown `type`, a `default` that doesn't fit, a repeated `key`, and anything past the 20th is skipped (the form says why) and the rest still work. Keys are letters, numbers and underscores, starting with a letter.

- `notiskin.settings.get(key)` is the user's value, or your `default`; `getAll()` is a copy of all of them
- `notiskin.settings.onChange(fn)` calls `fn(key, value, all)` after a change, and returns a function that stops listening
- the page API is now version `1.1.0`, every older method works as before
- a plugin that declares settings runs inside a function that is given its own `notiskin`, so settings know whose they are, even inside a later callback. Use that `notiskin`, not `window.notiskin`, and don't count on top-level `var` and `function` becoming globals (use `window.x = ...`). A plugin with no declarations runs exactly as before

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
src/injector/     CDP injection (daemon.ts long-running, pipe.ts the DevTools pipe, control.ts its socket)
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
