/* global module */
// The theme editor on the Themes page (served at /theme-editor.js). The theme is one piece of CSS text and the
// pickers read and write single --ns-* declarations inside it, so everything else in the file (comments, fonts,
// anything the pickers don't know) comes back exactly as it was. The first half is plain text helpers with no page
// in sight, tests load them with require(); the second half is the page: pickers, preview, saving, publishing.
(function (root) {
  // ---- the CSS text ----

  // what the pickers show, grouped. Every variable here takes a color
  const GROUPS = [
    { id: 'page', title: 'Page', vars: [
      ['bg', 'Background'], ['topbar-bg', 'Top bar'], ['hover-bg', 'Hovered block'], ['callout-bg', 'Callout'],
    ] },
    { id: 'sidebar', title: 'Sidebar', vars: [['sidebar-bg', 'Background']] },
    { id: 'text', title: 'Text', vars: [['text', 'Text'], ['title-text', 'Page title'], ['link-color', 'Links']] },
    { id: 'code', title: 'Code', vars: [
      ['inline-code-bg', 'Inline code background'], ['inline-code-color', 'Inline code text'], ['code-block-bg', 'Code block'],
    ] },
    { id: 'accents', title: 'Accents', vars: [
      ['divider-color', 'Dividers'], ['quote-border-color', 'Quote bar'], ['border-color', 'Borders'],
      ['scrollbar-thumb', 'Scrollbar'], ['scrollbar-track', 'Scrollbar track'],
    ] },
    { id: 'database', title: 'Databases', vars: [
      ['table-header-bg', 'Table header'], ['table-row-hover-bg', 'Table row under the cursor'], ['board-card-bg', 'Board card'],
    ] },
  ];

  const START_CSS = name => `/* ${name} */
:root {
  --ns-bg: #ffffff;
  --ns-sidebar-bg: #f7f7f5;
  --ns-topbar-bg: #ffffff;
  --ns-hover-bg: #ebebea;
  --ns-text: #37352f;
  --ns-title-text: #1a1a1a;
  --ns-link-color: #2f6fd1;
  --ns-callout-bg: #f1f1ef;
  --ns-code-block-bg: #f7f6f3;
  --ns-inline-code-bg: #f1f1ef;
  --ns-inline-code-color: #e03e3e;
  --ns-divider-color: #e0e0e0;
  --ns-quote-border-color: #9a9a9a;
}
`;

  // the same text with every comment blanked out (same length), so braces and :root inside a comment are never read as CSS
  function mask(css) {
    return css.replace(/\/\*[\s\S]*?(\*\/|$)/g, m => ' '.repeat(m.length));
  }

  // where the declarations live: the :root blocks outside any @media, and the ones inside
  // @media (prefers-color-scheme: dark | light). Each block is { scope, start, end } with the body between the braces
  function findBlocks(css) {
    const text = mask(css);
    const blocks = [];
    const closeOf = open => {
      let depth = 0;
      for (let i = open; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}' && --depth === 0) return i;
      }
      return -1;
    };
    const rootsIn = (from, to, scope) => {
      const re = /:root\s*\{/g;
      re.lastIndex = from;
      let m;
      while ((m = re.exec(text)) && m.index < to) {
        const open = m.index + m[0].length - 1;
        const close = closeOf(open);
        if (close < 0 || close > to) break;
        blocks.push({ scope, start: open + 1, end: close });
        re.lastIndex = close + 1;
      }
    };
    const mediaRe = /@media\s*\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)\s*\{/g;
    const medias = [];
    let m;
    while ((m = mediaRe.exec(text))) {
      const open = m.index + m[0].length - 1;
      const close = closeOf(open);
      if (close < 0) break;
      medias.push({ scope: m[1], open, close, from: m.index });
      mediaRe.lastIndex = close + 1;
    }
    for (const med of medias) rootsIn(med.open + 1, med.close, med.scope);
    // top-level :root blocks: everything not inside a media block
    let pos = 0;
    for (const med of [...medias, { from: text.length, close: text.length }]) {
      rootsIn(pos, med.from, 'base');
      pos = med.close + 1;
    }
    return blocks.sort((a, b) => a.start - b.start);
  }

  // every declaration of a variable in a scope, as { start, end } over its value and the whole declaration's range
  function findDecls(css, scope, name) {
    const text = mask(css);
    const out = [];
    for (const b of findBlocks(css).filter(x => x.scope === scope)) {
      const re = /(--[\w-]+)\s*:([^;{}]*)(;|$)/g;
      const body = text.slice(b.start, b.end);
      let m;
      while ((m = re.exec(body))) {
        if (m[1] !== `--ns-${name}`) continue;
        const declStart = b.start + m.index;
        const raw = m[2];
        const lead = raw.length - raw.trimStart().length;
        const valueStart = declStart + m[0].indexOf(':') + 1 + lead;
        out.push({
          declStart,
          declEnd: declStart + m[0].length,
          valueStart,
          valueEnd: valueStart + raw.trim().length,
        });
      }
    }
    return out;
  }

  // the value in effect: the last declaration wins, like in CSS
  function getVar(css, scope, name) {
    const found = findDecls(css, scope, name);
    if (!found.length) return null;
    const last = found[found.length - 1];
    return css.slice(last.valueStart, last.valueEnd);
  }

  // every --ns-* variable a scope sets, name without the prefix
  function varsOf(css, scope) {
    const text = mask(css);
    const vars = {};
    for (const b of findBlocks(css).filter(x => x.scope === scope)) {
      for (const m of text.slice(b.start, b.end).matchAll(/--ns-([\w-]+)\s*:/g)) vars[m[1]] = getVar(css, scope, m[1]);
    }
    return vars;
  }

  function setVar(css, scope, name, value) {
    const found = findDecls(css, scope, name);
    if (found.length) {
      const last = found[found.length - 1];
      return css.slice(0, last.valueStart) + value + css.slice(last.valueEnd);
    }
    const decl = `--ns-${name}: ${value};`;
    const block = findBlocks(css).find(b => b.scope === scope);
    if (block) {
      const body = css.slice(block.start, block.end);
      const indent = (/\n([ \t]+)--/.exec(body) || [])[1] ?? (scope === 'base' ? '  ' : '    ');
      const head = css.slice(0, block.end);
      const trimmed = head.replace(/\s+$/, '');
      const semi = /[;{]$/.test(trimmed) ? '' : ';';
      const closeIndent = (/\n([ \t]*)$/.exec(head.slice(trimmed.length)) || [])[1];
      // the closing brace on its own line: the new declaration goes on a line before it, else it stays on the same line
      if (closeIndent !== undefined) return `${trimmed}${semi}\n${indent}${decl}\n${closeIndent}${css.slice(block.end)}`;
      return `${trimmed}${semi} ${decl} ${css.slice(block.end)}`;
    }
    const tail = css.length && !css.endsWith('\n') ? '\n' : '';
    if (scope === 'base') return `${css}${tail}:root {\n  ${decl}\n}\n`;
    return `${css}${tail}@media (prefers-color-scheme: ${scope}) {\n  :root {\n    ${decl}\n  }\n}\n`;
  }

  function removeVar(css, scope, name) {
    let out = css;
    // later declarations first, so the earlier ranges stay put
    for (const d of findDecls(css, scope, name).reverse()) {
      let start = d.declStart;
      let end = d.declEnd;
      // the whole line when the declaration is alone on it
      const before = out.slice(0, start);
      const after = out.slice(end);
      const lineStart = before.lastIndexOf('\n') + 1;
      if (/^[ \t]*$/.test(before.slice(lineStart)) && /^[ \t]*\n/.test(after)) {
        start = lineStart;
        end += after.indexOf('\n') + 1;
      }
      out = out.slice(0, start) + out.slice(end);
    }
    return out;
  }

  // a hex color the native picker accepts, or null for anything else (rgb(), color-mix(), var(), transparent ...)
  function pickerHex(value) {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value || '').trim());
    if (!m) return null;
    const h = m[1].length === 3 ? m[1].replace(/./g, c => c + c) : m[1];
    return `#${h.toLowerCase()}`;
  }

  const helpers = { GROUPS, START_CSS, findBlocks, getVar, varsOf, setVar, removeVar, pickerHex };
  if (typeof module === 'object' && module.exports) {
    module.exports = helpers;
    return;
  }

  // ---- the page ----
  const MAX_CSS = 20000;
  const HEARTBEAT_MS = 5000;
  const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$/;

  const esc = str =>
    String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  let host = null; // what the page gave us: api(), showNotif(), onClose(), onPublish()
  let state = null;

  // any CSS color to #rrggbb through the browser itself, null when it doesn't parse
  function colorToHex(value) {
    const probe = document.createElement('canvas').getContext('2d');
    probe.fillStyle = '#000001';
    probe.fillStyle = value;
    const first = probe.fillStyle;
    probe.fillStyle = '#000002';
    probe.fillStyle = value;
    if (first !== probe.fillStyle) return null; // not a color
    return first.startsWith('#') ? first : pickerHex(rgbaToHex(first));
  }

  function rgbaToHex(rgba) {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgba);
    return m ? '#' + [m[1], m[2], m[3]].map(n => Number(n).toString(16).padStart(2, '0')).join('') : null;
  }

  function el(id) {
    return document.getElementById(id);
  }

  function rowHtml(key, label) {
    return `
      <div class="te-row" data-var="${esc(key)}">
        <span class="te-label">${esc(label)}</span>
        <input type="color" class="te-swatch" aria-label="${esc(label)} color">
        <input type="text" class="te-value" spellcheck="false" autocomplete="off" aria-label="${esc(label)} value">
        <button type="button" class="te-clear" title="Leave this to Notion" aria-label="Clear ${esc(label)}">×</button>
      </div>`;
  }

  function render() {
    el('theme-editor').innerHTML = `
      <div class="te-head">
        <button type="button" class="te-back" id="te-back">← Back</button>
        <h2 id="te-title"></h2>
      </div>
      <div class="te-grid">
        <div class="te-controls">
          <div class="field">
            <label for="te-name">Name</label>
            <input type="text" id="te-name" maxlength="80" autocomplete="off" placeholder="my theme">
            <div class="field-hint"><span id="te-name-hint">The file name in your themes folder.</span></div>
          </div>
          <div class="te-modes" role="group" aria-label="Which version you are editing">
            <button type="button" class="te-mode active" data-scope="base">Default</button>
            <button type="button" class="te-mode" data-scope="dark">Dark</button>
          </div>
          <p class="te-scope-note" id="te-scope-note"></p>
          ${GROUPS.map(g => `<fieldset class="te-group"><legend>${esc(g.title)}</legend>${g.vars.map(([k, l]) => rowHtml(k, l)).join('')}</fieldset>`).join('')}
          <details class="te-advanced">
            <summary>The CSS itself</summary>
            <textarea id="te-css" spellcheck="false"></textarea>
            <div class="field-hint"><span id="te-css-hint"></span><span id="te-css-count" style="float:right"></span></div>
          </details>
        </div>
        <div class="te-side">
          <div class="theme-preview" id="te-preview">${state.mockup}</div>
          <label class="te-live"><input type="checkbox" id="te-live" checked> Preview in Notion</label>
          <div class="te-live-note" id="te-live-note"></div>
          <div class="te-actions">
            <button type="button" class="btn-submit" id="te-save">Save</button>
            <button type="button" class="btn-ghost" id="te-publish">Save and publish</button>
          </div>
          <div class="te-msg" id="te-msg" role="status"></div>
        </div>
      </div>`;
  }

  function currentScheme() {
    return state.scope === 'dark' ? 'dark' : 'light';
  }

  function refresh(opts = {}) {
    const css = state.css;
    if (!opts.keepText) el('te-css').value = css;
    el('te-css-count').textContent = `${css.length}/${MAX_CSS}`;
    el('te-css-count').style.color = css.length > MAX_CSS ? 'var(--danger)' : '';
    el('te-css-hint').textContent = css.length > MAX_CSS ? 'Too long to publish, the marketplace takes up to 20000 characters.' : '';
    el('te-title').textContent = state.isNew ? 'New theme' : `Edit ${state.name}`;
    el('te-scope-note').textContent = state.scope === 'dark'
      ? 'These colors are used when Notion is in dark mode. Anything you leave empty takes the default version.'
      : (/prefers-color-scheme/.test(css) ? 'A dark version exists. Switch to Dark to edit it.' : 'Add a dark version by picking colors under Dark.');
    document.querySelectorAll('.te-mode').forEach(b => b.classList.toggle('active', b.dataset.scope === state.scope));

    for (const row of el('theme-editor').querySelectorAll('.te-row')) {
      const name = row.dataset.var;
      const own = getVar(css, state.scope, name);
      const fallback = state.scope === 'dark' ? getVar(css, 'base', name) : null;
      const shown = own ?? fallback ?? '';
      const text = row.querySelector('.te-value');
      if (document.activeElement !== text) text.value = own ?? '';
      text.placeholder = fallback ?? 'Notion\'s own';
      const hex = shown ? (pickerHex(shown) || colorToHex(shown)) : null;
      row.querySelector('.te-swatch').value = hex || '#808080';
      row.classList.toggle('empty', own === null);
    }
    applyMock();
    pushPreview();
  }

  function applyMock() {
    window.nsTheme.applyPreview('te-preview', state.css, currentScheme(), true);
  }

  // ---- showing it in Notion ----
  let heartbeat = null;
  let sentCss = null;
  let sendTimer = null;

  async function pushPreview(force) {
    const live = el('te-live');
    if (!live || !live.checked) return;
    clearTimeout(sendTimer);
    sendTimer = setTimeout(async () => {
      if (!state) return;
      const css = state.css;
      if (!css.trim() || css.length > 100000) return;
      sentCss = css;
      const note = el('te-live-note');
      try {
        const res = await host.api('POST', '/theme-editor/preview', { css });
        if (!state) return;
        note.textContent = res.safeMode
          ? 'Safe mode is on, so Notion shows no theme. Turn it off in Settings to preview there.'
          : res.live ? 'Showing in Notion. It goes back by itself when you close the editor.'
          : res.error ? res.error : 'Notion isn\'t running, so the preview below is all there is.';
      } catch {
        if (state) note.textContent = 'Can\'t reach Notiskin.';
      }
    }, force ? 0 : 200);
  }

  function startHeartbeat() {
    stopHeartbeat();
    // the same request again keeps the preview alive, if this page goes away the injector drops it after a few seconds
    heartbeat = setInterval(() => {
      if (state && el('te-live')?.checked && sentCss !== null) host.api('POST', '/theme-editor/preview', { css: sentCss }).catch(() => {});
    }, HEARTBEAT_MS);
  }

  function stopHeartbeat() {
    clearInterval(heartbeat);
    heartbeat = null;
  }

  function endPreview() {
    clearTimeout(sendTimer);
    sentCss = null;
    // keepalive so it still goes out while the page is closing
    return fetch('/api/theme-editor/preview/end', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' } }).catch(() => {});
  }

  // ---- saving ----
  function say(text, kind) {
    const m = el('te-msg');
    m.textContent = text;
    m.className = `te-msg${kind ? ` ${kind}` : ''}`;
  }

  async function save() {
    const name = el('te-name').value.trim();
    if (!NAME_PATTERN.test(name)) {
      say('Use letters, numbers, spaces, dashes, dots and underscores in the name.', 'error');
      return null;
    }
    if (!state.css.trim()) {
      say('The theme is empty.', 'error');
      return null;
    }
    const replace = !state.isNew && name === state.name;
    const res = await host.api('POST', '/theme-editor/save', { name, css: state.css, replace });
    if (res.error) {
      say(res.error, 'error');
      return null;
    }
    state.isNew = false;
    state.name = name;
    state.saved = state.css;
    el('te-title').textContent = `Edit ${name}`;
    say('Saved. It is in your themes.', 'ok');
    host.onSaved?.(name);
    return name;
  }

  function dirty() {
    return state && state.css !== state.saved;
  }

  async function close(force) {
    if (!state) return;
    if (!force && dirty() && !window.confirm('Close without saving your changes?')) return;
    stopHeartbeat();
    const done = host.onClose;
    state = null;
    await endPreview();
    el('theme-editor').hidden = true;
    el('theme-editor').innerHTML = '';
    done?.();
  }

  // ---- wiring ----
  function wire() {
    const editor = el('theme-editor');
    editor.querySelector('#te-back').addEventListener('click', () => close());
    editor.querySelector('#te-name').value = state.name;
    editor.querySelector('#te-name').addEventListener('input', () => {
      const name = el('te-name').value.trim();
      el('te-name-hint').textContent = name && !NAME_PATTERN.test(name) ? 'Letters, numbers, spaces, dashes, dots and underscores.' : 'The file name in your themes folder.';
    });
    editor.querySelectorAll('.te-mode').forEach(btn =>
      btn.addEventListener('click', () => {
        state.scope = btn.dataset.scope;
        refresh();
      })
    );
    editor.querySelector('#te-css').addEventListener('input', e => {
      state.css = e.target.value;
      refresh({ keepText: true });
    });
    for (const row of editor.querySelectorAll('.te-row')) {
      const name = row.dataset.var;
      row.querySelector('.te-swatch').addEventListener('input', e => {
        state.css = setVar(state.css, state.scope, name, e.target.value);
        refresh();
      });
      row.querySelector('.te-value').addEventListener('input', e => {
        const value = e.target.value.trim();
        state.css = value ? setVar(state.css, state.scope, name, value) : removeVar(state.css, state.scope, name);
        refresh();
      });
      row.querySelector('.te-clear').addEventListener('click', () => {
        state.css = removeVar(state.css, state.scope, name);
        refresh();
      });
    }
    editor.querySelector('#te-live').addEventListener('change', e => {
      if (e.target.checked) pushPreview(true);
      else {
        endPreview();
        el('te-live-note').textContent = 'Notion shows your normal theme.';
      }
    });
    editor.querySelector('#te-save').addEventListener('click', async () => {
      await save();
    });
    editor.querySelector('#te-publish').addEventListener('click', async () => {
      const name = await save();
      if (!name) return;
      const css = state.css;
      await close(true);
      host.onPublish?.(name, css);
    });
  }

  // host: { api, mockup, onClose, onSaved, onPublish }. mockup is the preview's inner HTML
  function init(options) {
    host = options;
    window.addEventListener('pagehide', () => {
      if (state) endPreview();
    });
  }

  // open({ name, css, isNew }): a new theme starts from a plain light theme, an existing one from its file
  function open({ name, css, isNew }) {
    const editor = el('theme-editor');
    state = { name: name || '', css, saved: isNew ? null : css, isNew: !!isNew, scope: 'base', mockup: host.mockup };
    editor.hidden = false;
    render();
    wire();
    refresh();
    startHeartbeat();
    editor.scrollIntoView?.({ block: 'start' });
  }

  root.nsThemeEditor = { ...helpers, init, open, close };
})(typeof window !== 'undefined' ? window : globalThis);
