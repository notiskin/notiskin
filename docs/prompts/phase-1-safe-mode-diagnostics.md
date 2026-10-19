# Phase 1, part 2: safe mode and diagnostics

What was built and why, so a later session can extend it without re-deciding. Same hard rules as `phase-1-install-button.md` (ask before pushing, never touch the real Notion from code, commit as notiskin, run lint/typecheck/tests).

## Safe mode

- One setting, `safeMode` in `notiskin.config.json` (default off, only a real `true` turns it on). The active theme and enabled plugins stay saved.
- `currentPayload(config)` in `src/core/library.ts` decides what Notion gets: nothing in safe mode. Both `notiskin inject` (the long-running injector) and `applyConfig()` use it, so they can't disagree. The wrapper inside Notion.app is unchanged.
- The injector already re-applies when the config file changes, so the theme leaves every tab at once. Plugins can't be un-run: turning safe mode on reloads Notion's visible page (`applyConfig({ reload: true })`). Other open tabs drop plugins on their next reload, the same limitation as disabling a plugin.
- Safe mode never restarts Notion: with nothing to inject, a restart would only close the user's windows.
- Settings has the switch, Themes and Plugins show a notice with **Turn off** while it's on. CLI: `notiskin safe-mode [on|off]`. Endpoint: `POST /api/safe-mode {"on": true|false}`, anything else is a 400.

## Diagnostics

- `src/core/diagnostics.ts` builds a plain-text report: Notiskin, system and Notion versions, install status, whether Notion runs, whether the debug port answers, whether the injector runs (`pidLockHolder()` checks the pid is alive), safe mode, theme, plugins, data folder, and the last 40 lines of `inject.log` (read from the end, never the whole file).
- Everything goes through `redact()`: Notion links become `<notion page>`, Notion IDs `<id>`, the home folder `~`, other `/Users/<name>` paths `/Users/<you>`, and the user's name `<you>` (names under 3 letters and `root` are left alone).
- Settings builds it only when asked (**Show diagnostics**), with **Copy** and **Refresh**. CLI: `notiskin diagnostics`. Endpoint: `GET /api/diagnostics`.

## Tests

- Unit: config parsing, `currentPayload`, the CLI command, the endpoint's input checks, redaction, the log tail.
- Integration (fake Notion): safe mode removes the theme from every tab and turning it off brings it back.
- In a cloud container the integration tests run as a normal user under a virtual display: `runuser -u ubuntu -- xvfb-run -a node --test --test-concurrency=1 test/integration/*.test.js` (Electron refuses to run as root).

## Mac check

1. Settings → Safe mode → **Turn on**: Notion's page reloads without the theme or plugins. Quit and reopen Notion: still no theme.
2. Themes shows the yellow notice, **Turn off** brings the theme back.
3. Settings → Diagnostics → **Show diagnostics**: versions and statuses look right, no Notion links, page IDs, or your username anywhere. **Copy**, then paste into Notes.
4. `notiskin safe-mode on`, `notiskin safe-mode off`, `notiskin diagnostics` from Terminal (`npm run build` first, then `node dist/cli/index.js ...`).
