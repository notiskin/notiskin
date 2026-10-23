# Phase 4: Creator tools

Paste-ready brief for a Claude Code session on the owner's Mac. Phase 4 is several PRs, one per part below, in this order. Each part ends with a merged PR before the next starts.

---

You're working in a clone of github.com/notiskin/notiskin (public repo). First read `CLAUDE.md`, `README.md`, `ROADMAP.md` (Phase 4), `src/injector/index.ts`, `supabase/functions/_shared/css.ts` and `src/gui/themes.html`. The owner, Remi, is a high schooler. Explain each step in short plain English before doing it, and say where something could break.

## Hard rules (these override everything else)

1. **Never touch the real Notion app from tests or test pages.** Integration tests use the fake Notion in `test/fixtures/fake-notion`. When you check the GUI in a browser against a throwaway `NOTISKIN_DIR`, stub `switchTheme`, `clearTheme` and `togglePlugin` in the page before clicking anything. Switching a theme restarts the real Notion even with a throwaway folder. Warn Remi before anything that would reload or restart his Notion.
2. **The Supabase project is live and real people use it.** Applying a migration, deploying an edge function or changing project settings are outward actions. Say exactly what changes and wait for Remi's clear "yes" each time. Always `supabase db push --linked --dry-run` first, and capture the live schema before and after with `supabase db query --linked` (`supabase db dump` needs Docker). New tables need RLS and explicit `grant ... to service_role` in the same migration (see CLAUDE.md).
3. **Themes that pass `validateThemeCss()` are auto-approved and run in every user's Notion.** Any change to the allowlist in `supabase/functions/_shared/css.ts` (and its copy in the app, if one is added) needs Deno tests for the new cases plus the old escape and `url()` / `image-set` cases, and a line in the PR saying exactly what new CSS becomes auto-approvable.
4. Ask Remi before structural decisions: new files, config fields, endpoints, `window.notiskin` API changes, new dependencies. The open decisions are listed per part below. Ask them at the start of that part, with your recommendation first.
5. Ask before pushing, opening or merging a PR, or releasing. Commit as notiskin with no Claude attribution: `git -c user.name=notiskin -c user.email=295556921+notiskin@users.noreply.github.com commit ...`. No `Co-Authored-By` lines, and no mention of Claude in commits, PRs or release notes.
6. Run `npm run lint`, `npm run typecheck` and `npm test` before every commit (`npm run test:functions` when touching `supabase/functions`), and `npm run test:integration` before a PR.
7. GUI colors come only from the tokens in `src/gui/brand.css`. Important new controls get a welcome-tour step (`src/gui/tour.js`), and "Install into Notion" stays last.
8. Keep the CLI working alongside the app. `notiskin theme <name>`, `apply` and `plugins` must behave the same.

## What's true today

- **Theme variables** (`CORE_CSS` in `src/injector/index.ts`): `--ns-bg`, `--ns-sidebar-bg`, `--ns-topbar-bg`, `--ns-code-block-bg`, `--ns-callout-bg`, `--ns-hover-bg`, `--ns-inline-code-bg`, `--ns-text`, `--ns-title-text`, `--ns-link-color`, `--ns-inline-code-color`, `--ns-divider-color`, `--ns-quote-border-color`, `--ns-scrollbar-thumb`, `--ns-scrollbar-track`. Core CSS is only injected while a theme or plugin is active.
- **Colored text is flattened:** `.notion-app-inner * { color: var(--ns-text) !important; }` overrides every color Notion users pick for text, mentions and highlights.
- **The CSS allowlist** (`validateThemeCss()`): only `--ns-*` properties inside `:root`, values limited to a color-ish character set (no quotes, no backslashes), and functions from a fixed list (rgb, hsl, oklch, color-mix, var, calc, the gradients…). Anything else waits for a human reviewer.
- **Plugins** get `window.notiskin` (version `1.0.0`): `onPageChange`, `onBlockLoad`, `getPageTitle`, `getPageUrl`, `addToolbarButton`, `removeToolbarButton`, `ready`. Plugins run once per page load. Enabling or disabling a plugin reloads Notion's tabs. There's no settings storage for plugins.
- **The injector daemon** re-applies to every Notion tab when files in `~/.notiskin` change, and takes `apply` and `reload` on its control socket (`src/injector/control.ts`).
- **The Themes page** previews marketplace themes with a mock Notion page (`.theme-preview` / `.ns-*` in themes.html). Publishing takes pasted CSS. The marketplace has versions, tags, sorting, reports and an update check (Phase 3).

## Part 1: Keep Notion's colored text

The smallest part, and themes look wrong without it.

- Replace the blanket `*` color rule so text colors Notion sets (red text, colored mentions, highlights, callout icons) survive, while plain text still takes `--ns-text`. Look at how Notion marks colored text in the DOM of the fake Notion and a real page. Never point a script at the real Notion; Remi can paste a DevTools snippet if needed.
- Decision to ask: let themes set the colored-text palette (e.g. `--ns-color-red`…`--ns-color-pink`, plus their background versions), or only stop overriding them (recommended first, palette in Part 2).
- Tests: the injected CSS no longer has the blanket rule. In the fake Notion, an element with Notion's colored-text styling keeps its color while plain text takes the theme's.

## Part 2: More theme variables

- Fonts: decision to ask. The allowlist bans quotes, so `font-family: "Inter Display"` can't auto-approve. Options are a fixed list of keywords that map to font stacks in core CSS (`--ns-font: serif | sans | mono | rounded`, recommended, nothing to moderate), or allowing quoted font names in the allowlist (riskier, since quotes were banned to block string tricks).
- Borders and radius (`--ns-border-color`, `--ns-radius`), database views (table header, row hover, board card background), and light/dark variants. For variants, decision to ask: one theme file with `:root` plus a `@media (prefers-color-scheme: dark)` block (needs an allowlist change), or a `--ns-*-dark` naming scheme.
- Update the allowlist only as far as the decisions need, with tests (hard rule 3). Update the mock preview in themes.html so new variables show there.
- Document every variable (it feeds Part 6's docs site).

## Part 3: Theme editor with live preview

- In Themes, a "New theme" button and an "Edit" action on your own local themes. They open an editor with a color picker per variable (grouped: page, sidebar, text, code, accents), the mock preview updating as you pick, and Save as a local theme file.
- Live preview in Notion. Decision to ask: a `preview` command on the injector's control socket that applies CSS without touching the config (recommended, nothing to clean up if the app quits), or writing a draft file and switching to it. The preview must end when the editor closes or the app quits, and must never restart Notion.
- "Publish" from the editor reuses the existing publish flow (or "Publish a new version" for a theme you own).
- Tests: the new socket command (unit test with the daemon's handlers or the fake Notion), the editor's CSS output passing `validateThemeCss()`, and the editor round-tripping an existing theme file.

## Part 4: Plugin settings

- A way for a plugin to declare settings (toggles, text, numbers, select, color) and read them: `notiskin.settings.get(key)` and `notiskin.settings.onChange(fn)`. Decision to ask: declared in a header comment the app can read without running the plugin (recommended, the app never executes plugin code), or declared by calling `notiskin.settings.define()` at runtime.
- The Plugins tab shows a Settings button for plugins that have settings, with a form generated from the declaration. Values live in the config, per plugin (new config field, ask). They reach the page with the plugin's code, and changes apply without a reload when the plugin listens with `onChange`.
- Bump `window.notiskin.version` and keep every existing method working.
- Tests: parsing declarations (including bad ones), the config field round-trip, the injected payload carrying the values, and the form in the browser with toggling stubbed.

## Part 5: Plugin developer mode

- Settings → a "Developer" section (off by default): pick a local folder of plugins. Files there run like installed plugins, and saving a file reloads Notion's tabs automatically.
- Decision to ask: read the folder in place (recommended, the injector already watches files) or copy files into `~/.notiskin/plugins` on change. Developer plugins never show in Browse or Publish, and are labelled "dev" in the Plugins tab.
- Safety: only plain `.js` files, the same size limit as installed plugins, and safe mode still pauses everything.

## Part 6: Docs site

- Pages for theme authors (every variable, examples, the allowlist rules, publishing and versions) and plugin authors (`window.notiskin`, settings, developer mode, review rules).
- Decision to ask: plain HTML in a `site/` folder published with GitHub Pages from Actions (recommended, no new tooling), or a generator like VitePress. Note: `docs/*` is gitignored except `docs/prompts/`, so the site can't live in `docs/` without changing `.gitignore`.
- Link it from the README and from the app (Publish tab and Settings → Help).

## Definition of done (each part)

- Tests as listed, all suites green, integration tests before the PR.
- Checked in the browser against a throwaway `NOTISKIN_DIR` with switching stubbed. Anything that needs the real Notion is a checklist for Remi in the PR, not something run by hand from the session.
- Allowlist changes deployed only after Remi's yes (`submit-theme` and `submit-version` use it), then checked against the real backend: a theme using the new syntax auto-approves, and the old escape and `url()` cases are still held.
- `ROADMAP.md` ticks the item, `CLAUDE.md` describes what was built, PR merged. A release only when Remi asks.
