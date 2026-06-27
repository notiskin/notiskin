# Notiskin

> **Warning:** Plugins run with full, unrestricted access to your Notion page and data. Only enable plugins from sources you trust. Notiskin does not sandbox or review plugin code.

Notiskin is an open source modding tool for the Notion desktop app. Apply CSS themes and JavaScript plugins to Notion's Electron client, similar to how Spicetify works for Spotify.

## Commands

```bash
# Apply the active theme and all enabled plugins
npm run apply

# Themes
npm run themes                    # list available themes (* = active)
npm run theme -- <name>           # switch theme and apply

# Plugins
npm run plugins                   # list available plugins (* = enabled)
npm run plugin -- enable <name>   # enable a plugin and apply
npm run plugin -- disable <name>  # disable a plugin and apply
```

## Notes

- Running `apply` twice without restarting Notion will re-run any enabled plugins. Plugins that register event listeners may double up, restart Notion between applies if you see unexpected behavior.
- Plugin files live in `plugins/` as plain `.js` files. Theme files live in `themes/` as plain `.css` files.
