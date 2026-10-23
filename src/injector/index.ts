// what gets injected into a Notion page: core CSS, the theme, window.notiskin, and plugins
// the daemon (daemon.ts) decides when and where, over Notion's DevTools pipe

// Notion marks colored text and blocks with inline styles that point at its own color tokens:
// color:var(--c-redTexSec) on a span (or color: var(--c-redTexSec) on a colored block like a callout),
// background:var(--ca-yelBacSecTra) on a highlight, background: var(--c-redBacSec) on a block.
// Plain text has no such token, so only plain text takes --ns-text. A theme can recolor the rest with
// --ns-color-<name> (text) and --ns-color-<name>-bg (backgrounds), unset means Notion's own color stays.
const NOTION_HUES: Array<[string, string]> = [
  ['gra', 'gray'], ['bro', 'brown'], ['ora', 'orange'], ['yel', 'yellow'], ['gre', 'green'],
  ['blu', 'blue'], ['pur', 'purple'], ['pin', 'pink'], ['red', 'red'],
];

const coloredText = NOTION_HUES.flatMap(([hue]) => [
  `[style*="color:var(--c-${hue}Tex"]`,
  `[style*="color: var(--c-${hue}Tex"]`,
]);

const COLOR_CSS = [
  `.notion-app-inner :not(${[...coloredText, ...coloredText.map(sel => `${sel} *`)].join(', ')}) { color: var(--ns-text) !important; }`,
  ...NOTION_HUES.flatMap(([hue, name]) => {
    const text = `var(--ns-color-${name}, var(--c-${hue}TexSec))`;
    const block = `var(--ns-color-${name}-bg, var(--c-${hue}BacSec))`;
    const mark = `var(--ns-color-${name}-bg, var(--ca-${hue}BacSecTra))`;
    return [
      `[style*="color:var(--c-${hue}TexSec)"], [style*="color: var(--c-${hue}TexSec)"] { color: ${text} !important; fill: ${text} !important; }`,
      `[style*="background: var(--c-${hue}BacSec)"], [style*="background:var(--c-${hue}BacSec)"] { background: ${block} !important; }`,
      `[style*="background:var(--ca-${hue}BacSecTra)"], [style*="background: var(--ca-${hue}BacSecTra)"] { background: ${mark} !important; }`,
    ];
  }),
].join('\n');

// borders, radius and database views. None of these variables is set by default, each rule falls back to
// the color Notion itself uses (read from the real app) or, where Notion's own value varies per element,
// layers a transparent gradient over it, so a theme that sets nothing changes nothing.
// The three table / board colors are layered with background-image, so they should be plain colors
const LOOK_CSS = `
.notion-table-view-cell { border-color: var(--ns-border-color, var(--ca-borSecTra)) !important; }
.notion-callout-block [style*="border: 1px solid var(--ca-borPriTra)"] { border-color: var(--ns-border-color, var(--ca-borPriTra)) !important; }
.notion-callout-block [style*="border: 1px solid"] { border-radius: var(--ns-radius, 10px) !important; }
.notion-board-group .notion-collection-item > div:first-child { border-radius: var(--ns-radius, 10px) !important; }
.notion-table-view-header-row { background-image: linear-gradient(var(--ns-table-header-bg, transparent), var(--ns-table-header-bg, transparent)) !important; }
.notion-table-view-row:hover .notion-table-view-cell { background-image: linear-gradient(var(--ns-table-row-hover-bg, transparent), var(--ns-table-row-hover-bg, transparent)) !important; }
.notion-board-group .notion-collection-item > div:first-child { background-image: linear-gradient(var(--ns-board-card-bg, transparent), var(--ns-board-card-bg, transparent)) !important; }
`;

// fonts: Notion sets font-family inline (its sans stack on the page root, the title and a few more, its mono
// stack on code), so a plain inherited font does nothing and the override has to be !important.
// Only emitted for the font variables a theme actually sets: with none set, every font stays Notion's
export function fontCss(themeCss: string): string {
  const sets = (name: string) => new RegExp(`${name}\\s*:`).test(themeCss);
  const body = sets('--ns-font');
  const title = sets('--ns-font-title');
  const code = sets('--ns-font-code');
  const rules: string[] = [];
  if (body) rules.push(`.notion-app-inner, [style*="font-family: ui-sans-serif"] { font-family: var(--ns-font) !important; }`);
  if (body || title) {
    rules.push(
      `.notion-page-block:not(.notion-collection-item), .notion-header-block, .notion-sub_header-block, .notion-sub_sub_header-block { font-family: var(--ns-font-title, var(--ns-font)) !important; }`,
      // the text inside a heading carries Notion's sans stack inline too (checked on the real app, its stack even names Apple Color Emoji, so only a style that starts with it counts as emoji), but code and emoji inside it keep their own
      `:is(.notion-header-block, .notion-sub_header-block, .notion-sub_sub_header-block) *:not([style*="SFMono-Regular"], [style*='font-family: "Apple Color Emoji"']) { font-family: var(--ns-font-title, var(--ns-font)) !important; }`
    );
  }
  if (code) rules.push(`[style*="SFMono-Regular"], .notion-code-block, .notion-code-block * { font-family: var(--ns-font-code) !important; }`);
  return rules.join('\n');
}

// core CSS plus whatever the theme asks for
export function coreCssFor(themeCss: string): string {
  const fonts = fontCss(themeCss);
  return fonts ? `${CORE_CSS}\n${fonts}\n` : CORE_CSS;
}

export const CORE_CSS = `
:root {
  --ns-bg: transparent;
  --ns-sidebar-bg: transparent;
  --ns-topbar-bg: transparent;
  --ns-code-block-bg: transparent;
  --ns-callout-bg: transparent;
  --ns-inline-code-bg: transparent;
  --ns-hover-bg: transparent;
  --ns-text: inherit;
  --ns-title-text: inherit;
  --ns-link-color: inherit;
  --ns-inline-code-color: inherit;
  --ns-divider-color: inherit;
  --ns-quote-border-color: inherit;
  --ns-scrollbar-thumb: #aaa;
  --ns-scrollbar-track: transparent;
}
.notion-app-inner { background: var(--ns-bg) !important; }
.notion-frame { background: var(--ns-bg) !important; }
.notion-page-content, .notion-scroller { background: var(--ns-bg) !important; }
.notion-sidebar { background: var(--ns-sidebar-bg) !important; }
.notion-topbar { background: var(--ns-topbar-bg) !important; }
${COLOR_CSS}
.notion-page-block > [placeholder="Untitled"], .notion-title { color: var(--ns-title-text) !important; }
.notion-selectable:hover { background: var(--ns-hover-bg) !important; }
.notion-link-token { color: var(--ns-link-color) !important; border-bottom-color: var(--ns-link-color) !important; }
.notion-inline-code { background: var(--ns-inline-code-bg) !important; color: var(--ns-inline-code-color) !important; }
.notion-code-block { background: var(--ns-code-block-bg) !important; }
.notion-callout-block { background: var(--ns-callout-bg) !important; }
.notion-divider-block hr { border-color: var(--ns-divider-color) !important; }
.notion-quote-block { border-left-color: var(--ns-quote-border-color) !important; }
${LOOK_CSS}
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: var(--ns-scrollbar-track); }
::-webkit-scrollbar-thumb { background: var(--ns-scrollbar-thumb); border-radius: 3px; }
`;

const CORE_JS = `
if (!window.notiskin) {
  window.notiskin = (() => {
    const _pageChangeListeners = [];
    const _blockLoadListeners = [];

    let _lastUrl = location.href;
    const _urlObserver = new MutationObserver(() => {
      if (location.href !== _lastUrl) {
        _lastUrl = location.href;
        _pageChangeListeners.forEach(fn => {
          try { fn(); } catch(e) { console.error('[notiskin] onPageChange error:', e); }
        });
      }
    });
    _urlObserver.observe(document.body, { childList: true, subtree: true });

    const _contentObserver = new MutationObserver(() => {
      const content = document.querySelector('.notion-page-content');
      if (content) {
        _blockLoadListeners.forEach(fn => {
          try { fn(content); } catch(e) { console.error('[notiskin] onBlockLoad error:', e); }
        });
      }
    });
    _contentObserver.observe(document.body, { childList: true, subtree: true });

    return {
      version: '1.0.0',
      onPageChange(fn) { _pageChangeListeners.push(fn); },
      onBlockLoad(fn) { _blockLoadListeners.push(fn); },
      getPageTitle() {
        const el = document.querySelector('.notion-page-block [placeholder="Untitled"]')
                || document.querySelector('.notion-title');
        return el ? el.textContent.trim() : null;
      },
      addToolbarButton(label, onClick) {
        const topbar = document.querySelector('.notion-topbar-action-buttons')
                    || document.querySelector('.notion-topbar');
        if (!topbar) { console.warn('[notiskin] addToolbarButton: topbar not found'); return null; }
        const btn = document.createElement('button');
        btn.textContent = label;
        btn.style.cssText = 'margin:0 4px;padding:4px 10px;border-radius:4px;border:none;background:rgba(0,0,0,0.06);cursor:pointer;font-size:13px;font-family:inherit';
        btn.addEventListener('click', () => {
          try { onClick(btn); } catch(e) { console.error('[notiskin] toolbar button error:', e); }
        });
        topbar.appendChild(btn);
        return btn;
      },
      removeToolbarButton(btn) {
        if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
      },
      getPageUrl() { return location.href; },
      ready(fn) {
        if (document.readyState === 'complete') {
          try { fn(); } catch(e) { console.error('[notiskin] ready error:', e); }
        } else {
          window.addEventListener('load', () => {
            try { fn(); } catch(e) { console.error('[notiskin] ready error:', e); }
          });
        }
      }
    };
  })();
}
`;

interface EvaluateResult {
  result: { value: unknown };
  exceptionDetails?: {
    text: string;
    exception?: { description?: string };
  };
}

export interface PluginEntry {
  name: string;
  content: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function injectCoreCSSOnClient(cssContent: string, client: any): Promise<void> {
  const expression = `(function () {
    var prev = document.getElementById('notiskin-core-styles');
    if (prev) prev.remove();
    var el = document.createElement('style');
    el.id = 'notiskin-core-styles';
    el.textContent = ${JSON.stringify(coreCssFor(cssContent))};
    (document.head || document.documentElement).appendChild(el);
    'ok';
  })()`;
  const result = (await client.send('Runtime.evaluate', { expression })) as EvaluateResult;
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'unknown error';
    throw new Error(`Core CSS injection threw an error inside Notion: ${msg}`);
  }
  console.log('[injector] Core CSS injected.');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function injectCoreJSOnClient(client: any): Promise<void> {
  const result = (await client.send('Runtime.evaluate', { expression: CORE_JS })) as EvaluateResult;
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'unknown error';
    throw new Error(`Core JS injection threw an error inside Notion: ${msg}`);
  }
  console.log('[injector] Core JS injected (window.notiskin ready).');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function injectCSSOnClient(cssContent: string, client: any): Promise<void> {
  const expression = `(function () {
    var prev = document.getElementById('notiskin-styles');
    if (prev) prev.remove();
    var el = document.createElement('style');
    el.id = 'notiskin-styles';
    el.textContent = ${JSON.stringify(cssContent)};
    (document.head || document.documentElement).appendChild(el);
    'ok';
  })()`;

  const result = (await client.send('Runtime.evaluate', {
    expression,
  })) as EvaluateResult;

  if (result.exceptionDetails) {
    const msg =
      result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text ||
      'unknown error';
    throw new Error(`CSS injection threw an error inside Notion: ${msg}`);
  }

  console.log('[injector] CSS injected successfully.');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function removeStylesOnClient(client: any): Promise<void> {
  await client.send('Runtime.evaluate', {
    expression: `['notiskin-core-styles', 'notiskin-styles'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.remove();
    })`,
  });
}

// runs at the very start of every new document, before Notion paints, so reloads never flash unthemed
// the full injection after load replaces these same elements by id
export function earlyStyleScript(cssContent: string): string {
  if (!cssContent.trim()) return '';
  return `(function () {
    function add(root, id, css) {
      if (document.getElementById(id)) return;
      var el = document.createElement('style');
      el.id = id;
      el.textContent = css;
      root.appendChild(el);
    }
    function attach() {
      var root = document.head || document.documentElement;
      if (!root) return false;
      add(root, 'notiskin-core-styles', ${JSON.stringify(coreCssFor(cssContent))});
      add(root, 'notiskin-styles', ${JSON.stringify(cssContent)});
      return true;
    }
    // at document start <html> doesn't exist yet, attach the moment the parser creates it
    if (!attach()) {
      var observer = new MutationObserver(function () {
        if (attach()) observer.disconnect();
      });
      observer.observe(document, { childList: true, subtree: true });
    }
  })()`;
}

// plugins run once per page load, re-applying a theme must not double up their listeners
// returns false when the plugin was already running in this page
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function injectPluginOnClient(plugin: PluginEntry, client: any): Promise<boolean> {
  const key = JSON.stringify(plugin.name);
  const check = (await client.send('Runtime.evaluate', {
    expression: `!!(window.__notiskinLoaded && window.__notiskinLoaded[${key}])`,
  })) as EvaluateResult;
  if (check.result.value === true) return false;

  const result = (await client.send('Runtime.evaluate', {
    expression: plugin.content,
  })) as EvaluateResult;

  // mark even on failure, a plugin that threw halfway shouldn't be re-run on top of itself
  await client.send('Runtime.evaluate', {
    expression: `(window.__notiskinLoaded = window.__notiskinLoaded || {})[${key}] = true`,
  });

  if (result.exceptionDetails) {
    const msg =
      result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text ||
      'unknown error';
    throw new Error(msg);
  }
  return true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function injectEverything(cssContent: string, plugins: PluginEntry[], client: any): Promise<void> {
  if (cssContent.trim()) {
    await injectCoreCSSOnClient(cssContent, client);
    await injectCSSOnClient(cssContent, client);
  } else {
    // no theme means stock Notion, the core CSS on its own would still restyle the page
    await removeStylesOnClient(client);
  }
  // window.notiskin observes every DOM change, only pay for it when a plugin needs it
  if (plugins.length > 0) await injectCoreJSOnClient(client);

  for (const plugin of plugins) {
    try {
      const ran = await injectPluginOnClient(plugin, client);
      console.log(`[injector] Plugin '${plugin.name}' ${ran ? 'injected successfully' : 'already running, skipped'}.`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[injector] Plugin '${plugin.name}' failed: ${msg}`);
    }
  }
}
