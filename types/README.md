# @notiskin/types

Type definitions for the [Notiskin](https://github.com/notiskin/notiskin) plugin API, the `notiskin` object every plugin gets inside Notion.

Plugins are plain JavaScript files. These types only give your editor help: autocomplete, hover docs, and mistakes underlined. Nothing from this package ends up in your plugin.

## Install

```sh
npm install --save-dev @notiskin/types
```

## Use it in a plugin

Start your plugin file with these two lines:

```js
// @ts-check
/// <reference types="@notiskin/types" />

notiskin.addToolbarButton('Hello', () => alert('hi'));
```

`// @ts-check` turns on checking for the file, and the second line tells the editor where `notiskin` comes from. It works in VS Code and any editor that uses TypeScript, with no other setup.

### Or once for the whole folder

If you'd rather not add the line to every file, put a `jsconfig.json` next to your plugins:

```json
{
  "compilerOptions": {
    "checkJs": true,
    "types": ["@notiskin/types"]
  }
}
```

The package is not picked up on its own (only packages named `@types/...` are), so one of the two is needed.

## Versions

The package version is the version of the plugin API it describes, the same as `notiskin.version` in the page. People on an older Notiskin app have an older API, so a plugin that uses a newer method can check `notiskin.version` first.

## More

- How to write a plugin: https://notiskin.github.io/plugins.html
- The source of these types is [`notiskin.d.ts`](https://github.com/notiskin/notiskin/blob/main/notiskin.d.ts) in the Notiskin repository, where a test checks it against the code that really runs. You can also just copy that file next to your plugin and use `/// <reference path="./notiskin.d.ts" />`.

MIT licensed.
