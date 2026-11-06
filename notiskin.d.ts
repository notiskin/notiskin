// Type definitions for the Notiskin page API, `window.notiskin`, version 1.2.0
// https://github.com/notiskin/notiskin
//
// Notiskin gives every plugin a `notiskin` object. Plugins are plain JavaScript files that run inside Notion's
// page, so these types are for editor help (autocomplete, hover docs, mistakes underlined) and nothing is
// compiled or shipped with your plugin.
//
// Use it in a plugin by putting this file next to the plugin and starting the plugin with:
//
//   // @ts-check
//   /// <reference path="./notiskin.d.ts" />
//
// or in a TypeScript project by adding it to "include" in tsconfig.json. A test in the Notiskin repository
// checks this file against the code that creates `window.notiskin`, so it doesn't drift from what really runs.

/** What a plugin setting can hold: the `type` of its declaration decides which one. */
type NotiskinSettingValue = boolean | string | number;

/** The user's values for a plugin's settings, by key. Only keys the plugin declared are in it. */
type NotiskinSettingValues = Record<string, NotiskinSettingValue>;

/**
 * Plugin settings. A plugin that wants a Settings form in the app declares its settings in a comment at the top
 * of its file, one `@notiskin-setting` line each, with the JSON of a {@link NotiskinSettingDeclaration}:
 *
 *   /**
 *    * @notiskin-setting {"key":"color","type":"color","label":"Bar color","default":"#e8590c"}
 *    * @notiskin-setting {"key":"height","type":"number","label":"Bar thickness","default":3,"min":1,"max":20}
 *    *\/
 *
 * Up to 20 settings. Keys are letters, numbers and underscores, starting with a letter (40 characters at most).
 */
interface NotiskinSettingBase {
  /** Letters, numbers and underscores, starting with a letter, up to 40 characters. What `settings.get()` is asked for. */
  key: string;
  /** What the form shows, 1 to 60 characters. */
  label: string;
  /** A line of help under the field, up to 200 characters. */
  description?: string;
}

/** A setting as written in the `@notiskin-setting` line of a plugin's header comment. */
type NotiskinSettingDeclaration =
  | (NotiskinSettingBase & { type: 'toggle'; default: boolean })
  | (NotiskinSettingBase & { type: 'text'; default: string; /** 1 to 2000, 200 when left out. */ maxLength?: number })
  | (NotiskinSettingBase & { type: 'number'; default: number; min?: number; max?: number; /** Above 0. */ step?: number })
  /** Up to 20 options. The default is one of them. */
  | (NotiskinSettingBase & { type: 'select'; default: string; options: string[] })
  /** `#rrggbb`. */
  | (NotiskinSettingBase & { type: 'color'; default: string });

/** The plugin's own settings, `notiskin.settings`. Values come from the user's choices, else from your defaults. */
interface NotiskinSettings {
  /** The current value of one setting, or `undefined` for a key the plugin didn't declare. */
  get(key: string): NotiskinSettingValue | undefined;
  /** A copy of every setting's current value. */
  getAll(): NotiskinSettingValues;
  /**
   * Called when the user changes a setting in the app, with the key that changed, its new value and a copy of
   * all values. Nothing reloads, so a plugin that reads its settings once should listen here too.
   * Returns a function that stops listening.
   */
  onChange(fn: (key: string, value: NotiskinSettingValue, all: NotiskinSettingValues) => void): () => void;
}

/** The page API Notiskin gives every plugin. */
interface Notiskin {
  /** The version of this API. New methods raise the minor number, nothing is ever removed in a minor version. */
  readonly version: '1.2.0';

  /** Runs `fn` when Notion opens another page (the address changes, with no reload). */
  onPageChange(fn: () => void): void;

  /** Runs `fn` with the page's content element whenever Notion changes something in it. Can fire very often. */
  onBlockLoad(fn: (content: HTMLElement) => void): void;

  /**
   * Like {@link Notiskin.onBlockLoad}, but at most four times a second, which is what most plugins want.
   * Returns a function that stops listening.
   */
  onContentChange(fn: (content: HTMLElement) => void): () => void;

  /** The title of the page being shown, or `null` when there isn't one. */
  getPageTitle(): string | null;

  /** The address of the page being shown. */
  getPageUrl(): string;

  /** The page's id (32 hex characters, lowercase) from its address, or `null` outside a page. */
  getPageId(): string | null;

  /**
   * The element that scrolls the page, or `null` if there isn't one right now. Notion unloads blocks that are far
   * from the screen, so a plugin can't read a whole long page's text.
   */
  getPageScroller(): HTMLElement | null;

  /**
   * Adds a button to Notion's top bar, in Notion's colors. If Notion rebuilds the top bar the button is put
   * back. Returns the button, or `null` when the top bar wasn't there.
   */
  addToolbarButton(label: string, onClick: (button: HTMLButtonElement) => void): HTMLButtonElement | null;

  /** Takes a button made by {@link Notiskin.addToolbarButton} away for good. */
  removeToolbarButton(button: HTMLButtonElement | null | undefined): void;

  /**
   * Adds CSS to the page, or replaces the CSS you added with the same `id`. Ids are yours alone: two plugins can use
   * the same id without touching each other's CSS.
   */
  addStyle(id: string, css: string): HTMLStyleElement;

  /** Takes CSS made by {@link Notiskin.addStyle} away. */
  removeStyle(id: string): void;

  /** Whether Notion is showing its light or its dark look right now. */
  getColorScheme(): 'light' | 'dark';

  /** Runs `fn` when Notion changes between light and dark. Returns a function that stops listening. */
  onColorSchemeChange(fn: (scheme: 'light' | 'dark') => void): () => void;

  /** Runs `fn` once the page has finished loading (right away if it already has). */
  ready(fn: () => void): void;

  /** This plugin's settings, see {@link NotiskinSettingDeclaration} for how to declare them. */
  readonly settings: NotiskinSettings;
}

/** `notiskin` is in scope in every plugin, like `window` is. */
declare const notiskin: Notiskin;

interface Window {
  notiskin: Notiskin;
}
