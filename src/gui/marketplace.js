// Marketplace pieces shared by the Themes and Plugins pages. nsVersions: "update available" and
// "pulled from the marketplace" on installed items, publishing a new version, editing tags and link, your versions waiting for review.
// nsBrowse: sorting and tag filters, tags / downloads / More info on Browse cards, the sign-in header
// for installs. The page passes its type ('theme' or 'plugin') and a way to get the session's token
(function () {
  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function notify(message) {
    if (typeof window.showNotif === 'function') window.showNotif(message);
  }

  function displayName(stem) {
    return String(stem).replace(/[-_]/g, ' ').toLowerCase();
  }

  function changesHtml(changes) {
    if (!changes || !changes.length) return '';
    return `<ul class="ns-changes">${changes
      .map(c => `<li><strong>Version ${esc(c.version)}</strong>: ${esc(c.changelog)}</li>`)
      .join('')}</ul>`;
  }

  // ---- browse: sorting, tags, downloads, links ----

  // must match TAGS in supabase/functions/_shared/details.ts and the tags migration
  const TAGS = ['dark', 'light', 'minimal', 'colorful', 'productivity', 'fun', 'accessibility', 'fonts'];
  const browseState = { sort: 'newest', tags: [] };

  function browseQuery(q) {
    const params = new URLSearchParams({ q: q || '', sort: browseState.sort });
    if (browseState.tags.length) params.set('tags', browseState.tags.join(','));
    return params.toString();
  }

  // sort menu, and a Tags button that opens a small card of tag checkboxes
  function mountBrowseControls(container, onChange) {
    container.innerHTML = `
      <div class="ns-browse-controls">
        <label class="ns-sort">Sort
          <select>
            <option value="newest">Newest</option>
            <option value="rating">Top rated</option>
            <option value="downloads">Most downloaded</option>
          </select>
        </label>
        <div class="ns-tag-filter">
          <button type="button" class="ns-tag-filter-btn" aria-haspopup="true" aria-expanded="false">Tags</button>
          <div class="ns-tag-popover" role="group" aria-label="Filter by tags" hidden>
            <div class="ns-tag-popover-head">
              <span>Show items tagged</span>
              <button type="button" class="ns-tag-clear">Clear</button>
            </div>
            ${TAGS.map(t => `<label class="ns-tag-check"><input type="checkbox" value="${t}"> ${t}</label>`).join('')}
          </div>
        </div>
      </div>`;
    const select = container.querySelector('select');
    select.value = browseState.sort;
    select.addEventListener('change', () => { browseState.sort = select.value; onChange(); });

    const button = container.querySelector('.ns-tag-filter-btn');
    const popover = container.querySelector('.ns-tag-popover');
    const boxes = [...popover.querySelectorAll('input[type=checkbox]')];
    const label = () => {
      const n = browseState.tags.length;
      button.textContent = n ? `Tags · ${n}` : 'Tags';
      button.classList.toggle('active', n > 0);
    };
    const open = show => {
      popover.hidden = !show;
      button.setAttribute('aria-expanded', String(show));
    };
    boxes.forEach(b => {
      b.checked = browseState.tags.includes(b.value);
      b.addEventListener('change', () => {
        browseState.tags = boxes.filter(x => x.checked).map(x => x.value);
        label();
        onChange();
      });
    });
    popover.querySelector('.ns-tag-clear').addEventListener('click', () => {
      if (!browseState.tags.length) return;
      boxes.forEach(b => { b.checked = false; });
      browseState.tags = [];
      label();
      onChange();
    });
    button.addEventListener('click', () => open(popover.hidden));
    document.addEventListener('click', e => {
      if (!popover.hidden && !e.target.closest?.('.ns-tag-filter')) open(false);
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !popover.hidden) { open(false); button.focus(); }
    });
    label();
  }

  // tags, the download count and a More info button for a Browse card
  function browseMetaHtml(item) {
    const tags = Array.isArray(item.tags) ? item.tags.filter(t => TAGS.includes(t)) : [];
    const downloads = Number(item.download_count) || 0;
    const parts = [];
    if (tags.length) parts.push(`<span class="ns-tags">${tags.map(t => `<span class="ns-tag">${esc(t)}</span>`).join('')}</span>`);
    parts.push(`<span class="ns-downloads">${downloads} download${downloads === 1 ? '' : 's'}</span>`);
    if (typeof item.link === 'string' && /^https:\/\/(gist\.)?github\.com\//.test(item.link)) {
      parts.push(`<button type="button" class="ns-more-info" data-link="${esc(item.link)}">More info</button>`);
    }
    if (item.id && (item.type === 'theme' || item.type === 'plugin')) {
      parts.push(`<button type="button" class="ns-report" data-id="${esc(item.id)}" data-type="${esc(item.type)}" data-name="${esc(item.name)}">Report</button>`);
    }
    return `<div class="ns-browse-meta">${parts.join('')}</div>`;
  }

  // More info opens in the browser through the app (github.com only), never inside the app
  document.addEventListener('click', e => {
    const btn = e.target.closest?.('.ns-more-info');
    if (!btn) return;
    e.preventDefault();
    fetch('/api/open-external', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: btn.dataset.link }),
    }).catch(() => {});
  });

  // ---- reporting ----

  const REPORT_REASONS = [
    ['harmful', 'Harmful or steals data'],
    ['broken', "Doesn't work"],
    ['offensive', 'Offensive'],
    ['copyright', 'Copied without permission'],
    ['spam', 'Spam'],
    ['other', 'Something else'],
  ];

  async function openReportDialog(type, id, name) {
    const token = typeof window.sessionToken === 'function' ? await window.sessionToken() : null;
    const overlay = document.createElement('div');
    overlay.className = 'ns-version-dialog';
    overlay.innerHTML = token ? `
      <form class="ns-version-dialog-box ns-report-box" role="dialog" aria-modal="true" aria-labelledby="ns-report-title">
        <h3 id="ns-report-title">Report ${esc(name)}</h3>
        <p>A reviewer reads every report. The author doesn't see who reported.</p>
        <div class="ns-report-reasons">
          ${REPORT_REASONS.map(([value, label], i) => `
            <label><input type="radio" name="ns-report-reason" value="${value}" ${i === 0 ? 'required' : ''}> ${label}</label>`).join('')}
        </div>
        <textarea maxlength="500" placeholder="What happened? (optional)"></textarea>
        <div class="ns-report-error"></div>
        <div class="ns-dialog-actions">
          <button type="button" class="btn-ghost" data-act="cancel">Cancel</button>
          <button type="submit" class="btn-primary">Send report</button>
        </div>
      </form>` : `
      <div class="ns-version-dialog-box" role="dialog" aria-modal="true">
        <h3>Sign in to report</h3>
        <p>Reports need a GitHub sign-in, so one person can't send hundreds. Sign in from Settings, then come back.</p>
        <div class="ns-dialog-actions">
          <button type="button" class="btn-ghost" data-act="cancel">Close</button>
        </div>
      </div>`;
    const close = () => overlay.remove();
    overlay.addEventListener('click', e => {
      if (e.target === overlay || e.target.closest('[data-act="cancel"]')) close();
    });
    document.body.appendChild(overlay);
    const form = overlay.querySelector('form');
    if (!form) return;
    form.querySelector('input').focus();
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const error = form.querySelector('.ns-report-error');
      const reason = form.querySelector('input[name="ns-report-reason"]:checked')?.value;
      if (!reason) { error.textContent = 'Pick a reason.'; return; }
      const button = form.querySelector('button[type=submit]');
      button.disabled = true;
      try {
        const result = await authed('/api/report', await window.sessionToken(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, id, reason, note: form.querySelector('textarea').value.trim() }),
        });
        close();
        notify(result.hidden
          ? `Thanks. ${name} is hidden until a reviewer looks at it.`
          : 'Thanks, a reviewer will look at it.');
      } catch (err) {
        error.textContent = err.message;
        button.disabled = false;
      }
    });
  }

  document.addEventListener('click', e => {
    const btn = e.target.closest?.('.ns-report');
    if (!btn) return;
    e.preventDefault();
    openReportDialog(btn.dataset.type, btn.dataset.id, btn.dataset.name);
  });

  // signed-in installs count as downloads, signed-out installs just install
  async function authHeader(getToken) {
    try {
      const token = await getToken();
      return token ? { Authorization: `Bearer ${token}` } : {};
    } catch {
      return {};
    }
  }

  function tagPickerHtml(idPrefix, selected) {
    return `
      <div class="ns-tag-picker" id="${idPrefix}-tags">
        ${TAGS.map(t => `<label class="ns-tag-option"><input type="checkbox" value="${t}" ${(selected || []).includes(t) ? 'checked' : ''}> ${t}</label>`).join('')}
      </div>
      <div class="field-hint"><span>Up to 3.</span></div>`;
  }

  // keeps at most 3 boxes ticked and returns the ticked tags
  function wireTagPicker(root) {
    const boxes = [...root.querySelectorAll('input[type=checkbox]')];
    const sync = () => {
      const count = boxes.filter(b => b.checked).length;
      boxes.forEach(b => { b.disabled = !b.checked && count >= 3; });
    };
    boxes.forEach(b => b.addEventListener('change', sync));
    sync();
    return () => boxes.filter(b => b.checked).map(b => b.value);
  }

  // ---- update available ----

  async function fetchUpdates() {
    try {
      const res = await fetch('/api/marketplace/updates');
      if (!res.ok) return { updates: [], pulled: [] };
      const data = await res.json();
      return { updates: data.updates || [], pulled: data.pulled || [] };
    } catch {
      return { updates: [], pulled: [] };
    }
  }

  // why an installed item is no longer in the marketplace, in the words the card shows
  function pulledMessage(item) {
    const what = item.type === 'plugin' ? 'plugin' : 'theme';
    const lead = {
      hidden: `This ${what} was pulled from the marketplace while it's reviewed.`,
      rejected: `A reviewer removed this ${what} from the marketplace.`,
      removed: `This ${what} is no longer in the marketplace.`,
    }[item.reason] || `This ${what} is no longer in the marketplace.`;
    return item.type === 'plugin' ? `${lead} Consider turning it off.` : lead;
  }

  // plugins run code, so updating one shows the plugin warning again with what changed
  function confirmPluginUpdate(update) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'ns-version-dialog';
      overlay.innerHTML = `
        <div class="ns-version-dialog-box" role="dialog" aria-modal="true" aria-labelledby="ns-update-title">
          <h3 id="ns-update-title">Update ${esc(displayName(update.name))} to version ${esc(update.latestVersion)}?</h3>
          <p>This plugin will have full access to your Notion page and data. A reviewer approved this version, but only update if you trust the author.</p>
          ${update.changes.length ? `<p class="ns-dialog-label">What changed</p>${changesHtml(update.changes)}` : ''}
          <div class="ns-dialog-actions">
            <button class="btn-ghost" data-act="cancel">Cancel</button>
            <button class="btn-primary" data-act="ok">Update plugin</button>
          </div>
        </div>`;
      const done = ok => { overlay.remove(); resolve(ok); };
      overlay.addEventListener('click', e => {
        if (e.target === overlay) done(false);
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act) done(act === 'ok');
      });
      document.body.appendChild(overlay);
      overlay.querySelector('[data-act="ok"]').focus();
    });
  }

  async function runUpdate(update, button, onDone) {
    if (update.type === 'plugin' && !(await confirmPluginUpdate(update))) return;
    button.disabled = true;
    button.textContent = 'Updating';
    try {
      const res = await fetch('/api/marketplace/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: update.type, name: update.name, confirmed: update.type === 'plugin' }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Couldn't update");
      notify(`${displayName(update.name)} updated to version ${data.version}`);
      if (onDone) await onDone();
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Update';
      notify(err.message);
    }
  }

  // adds "Version N is out" and an Update button to each installed card (data-file="<file name>")
  // whose marketplace item has a newer approved version, and a warning to each one whose item was
  // hidden, rejected or removed. An enabled plugin's warning has Turn off (opts.turnOff), which only
  // runs when clicked: nothing is ever turned off or deleted on its own
  async function decorateInstalled(type, onDone, opts = {}) {
    const { updates, pulled } = await fetchUpdates();
    for (const update of updates.filter(u => u.type === type)) {
      const card = document.querySelector(`.card[data-file="${CSS.escape(update.name)}"]`);
      if (!card || card.querySelector('.ns-update')) continue;
      const row = document.createElement('div');
      row.className = 'ns-update';
      row.innerHTML = `
        <div class="ns-update-text">
          <span class="ns-update-badge">Version ${esc(update.latestVersion)} is out</span>
          ${update.changes[0] ? `<span class="ns-update-change">${esc(update.changes[0].changelog)}</span>` : ''}
        </div>
        <button class="ns-update-btn" type="button">Update</button>`;
      const button = row.querySelector('button');
      button.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        runUpdate(update, button, onDone);
      });
      // theme cards are <label>s, a click anywhere in them would also pick the theme
      row.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); });
      card.appendChild(row);
    }
    for (const item of pulled.filter(p => p.type === type)) {
      const card = document.querySelector(`.card[data-file="${CSS.escape(item.name)}"]`);
      if (!card || card.querySelector('.ns-update')) continue;
      const enabled = type === 'plugin' && !!card.querySelector('input[type="checkbox"]')?.checked;
      const row = document.createElement('div');
      row.className = 'ns-update ns-pulled';
      row.setAttribute('role', 'status');
      row.innerHTML = `
        <div class="ns-update-text">
          <span class="ns-pulled-text">${esc(pulledMessage(item))}</span>
        </div>
        ${enabled && opts.turnOff ? '<button class="ns-update-btn" type="button">Turn off</button>' : ''}`;
      const button = row.querySelector('button');
      if (button) {
        button.addEventListener('click', async e => {
          e.preventDefault();
          e.stopPropagation();
          button.disabled = true;
          button.textContent = 'Turning off';
          try {
            await opts.turnOff(item.name);
          } catch (err) {
            button.disabled = false;
            button.textContent = 'Turn off';
            notify(err.message);
          }
        });
      }
      row.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); });
      card.appendChild(row);
    }
  }

  // ---- publishing a new version ----

  async function authed(path, token, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  }

  async function renderPublishVersion(type, container, getToken) {
    const token = await getToken();
    if (!token) { container.innerHTML = ''; return; }
    container.innerHTML = '<span class="loading">Loading</span>';
    let mine = [];
    try {
      mine = (await authed(`/api/submissions?type=${type}`, token)).submissions || [];
    } catch {
      container.innerHTML = '';
      return;
    }
    const own = mine.filter(s => s.status === 'approved');

    const codeLabel = type === 'theme' ? 'CSS' : 'JavaScript';
    const maxCode = type === 'theme' ? 20000 : 200000;
    if (!own.length) {
      container.innerHTML = `
        <h2 class="ns-version-heading">Publish a new version</h2>
        <p class="ns-version-empty">No approved ${type}s yet.</p>`;
      renderEditDetails(type, container, getToken, mine);
      return;
    }

    container.innerHTML = `
      <h2 class="ns-version-heading">Publish a new version</h2>
      <form class="ns-version-form">
        <div class="field">
          <label for="v-item-${type}">${type === 'theme' ? 'Theme' : 'Plugin'}</label>
          <select id="v-item-${type}" required></select>
        </div>
        <div class="field">
          <label for="v-changelog-${type}">Changes</label>
          <input type="text" id="v-changelog-${type}" maxlength="500" required autocomplete="off">
        </div>
        <div class="field">
          <label for="v-code-${type}">${codeLabel}</label>
          <textarea id="v-code-${type}" required></textarea>
        </div>
        <button class="btn-submit" type="submit">Publish version</button>
      </form>
      <div class="publish-msg"></div>`;

    const form = container.querySelector('form');
    const msg = container.querySelector('.publish-msg');
    const code = container.querySelector(`#v-code-${type}`);
    const itemSelect = container.querySelector(`#v-item-${type}`);
    // the list shows each item's live version, so it is drawn again after a version goes live
    const fillItems = selectedId => {
      itemSelect.innerHTML = own.map(s => `<option value="${esc(s.id)}">${esc(s.name)} (version ${esc(s.version || 1)})</option>`).join('');
      if (selectedId !== undefined) itemSelect.value = String(selectedId);
    };
    fillItems();
    code.addEventListener('input', () => { if (code.value.length > maxCode) code.value = code.value.slice(0, maxCode); });
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const button = form.querySelector('button');
      button.disabled = true;
      msg.className = 'publish-msg';
      try {
        const fresh = await getToken();
        const result = await authed('/api/submit/version', fresh, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type,
            id: itemSelect.value,
            changelog: container.querySelector(`#v-changelog-${type}`).value.trim(),
            code: code.value,
          }),
        });
        msg.className = 'publish-msg success';
        if (result.autoApproved) {
          const item = own.find(s => String(s.id) === itemSelect.value);
          if (item) item.version = result.version;
          msg.textContent = `Version ${result.version} is live.`;
        } else {
          msg.textContent = `Version ${result.version} submitted for review.${result.reason ? ` ${result.reason}.` : ''}`;
        }
        const keep = itemSelect.value;
        form.reset();
        fillItems(keep);
      } catch (err) {
        msg.className = 'publish-msg error';
        msg.textContent = err.message;
      } finally {
        button.disabled = false;
      }
    });
    renderEditDetails(type, container, getToken, mine);
  }

  // ---- tags and link of your own items, no review needed ----

  function renderEditDetails(type, container, getToken, mine) {
    if (!mine.length) return;
    const section = document.createElement('div');
    section.className = 'ns-details';
    section.innerHTML = `
      <h2 class="ns-version-heading">Tags and link</h2>
      <form class="ns-version-form">
        <div class="field">
          <label for="d-item-${type}">${type === 'theme' ? 'Theme' : 'Plugin'}</label>
          <select id="d-item-${type}">
            ${mine.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>Tags</label>
          <div class="ns-details-tags"></div>
        </div>
        <div class="field">
          <label for="d-link-${type}">GitHub link (optional)</label>
          <input type="text" inputmode="url" id="d-link-${type}" maxlength="220" placeholder="https://github.com/you/your-${type}">
          <div class="field-hint"><span>A github.com repository or gist.</span></div>
        </div>
        <button class="btn-submit" type="submit">Save</button>
      </form>
      <div class="publish-msg"></div>`;
    container.appendChild(section);

    const select = section.querySelector('select');
    const link = section.querySelector(`#d-link-${type}`);
    const tagsBox = section.querySelector('.ns-details-tags');
    const msg = section.querySelector('.publish-msg');
    let readTags = () => [];
    const fill = () => {
      const item = mine.find(s => String(s.id) === select.value) || {};
      tagsBox.innerHTML = tagPickerHtml(`d-${type}`, item.tags || []);
      readTags = wireTagPicker(tagsBox);
      link.value = item.link || '';
      msg.className = 'publish-msg';
    };
    select.addEventListener('change', fill);
    fill();

    section.querySelector('form').addEventListener('submit', async e => {
      e.preventDefault();
      const button = section.querySelector('button[type=submit]');
      button.disabled = true;
      try {
        const result = await authed('/api/item/details', await getToken(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, id: select.value, tags: readTags(), link: link.value.trim() }),
        });
        const item = mine.find(s => String(s.id) === select.value);
        if (item) { item.tags = result.tags; item.link = result.link; }
        msg.className = 'publish-msg success';
        msg.textContent = 'Saved.';
      } catch (err) {
        msg.className = 'publish-msg error';
        msg.textContent = err.message;
      } finally {
        button.disabled = false;
      }
    });
  }

  // ---- your versions waiting for review ----

  async function renderPendingVersions(type, container, getToken, submissions) {
    const token = await getToken();
    if (!token) { container.innerHTML = ''; return; }
    let versions = [];
    try {
      versions = (await authed(`/api/submissions/versions?type=${type}`, token)).versions || [];
    } catch {
      container.innerHTML = '';
      return;
    }
    if (!versions.length) { container.innerHTML = ''; return; }
    const names = new Map((submissions || []).map(s => [String(s.id), s.name]));
    container.innerHTML = `
      <h2 class="ns-version-heading">New versions</h2>
      ${versions.map(v => `
        <div class="card">
          <div class="sub-card-header">
            <div class="sub-card-left">
              <span class="card-name">${esc(names.get(String(v.item_id)) || `Your ${type}`)}, version ${esc(v.version)}</span>
              <span class="status-badge ${esc(v.status)}">${esc(v.status)}</span>
            </div>
          </div>
          <div class="submission-reason">${esc(v.changelog)}</div>
          ${v.rejection_reason ? `<div class="submission-reason">Reviewer: ${esc(v.rejection_reason)}</div>` : ''}
        </div>`).join('')}`;
  }

  // ---- theme previews ----
  // sets a theme's --ns-* variables on a preview box. A theme may carry @media (prefers-color-scheme: dark | light)
  // blocks, only the one that matches the app's own scheme counts, like it does in Notion
  function applyPreview(containerId, css, scheme, reset) {
    const container = document.getElementById(containerId);
    if (!container) return;
    // the editor shows a version it picks, everywhere else it is the scheme the app is in
    const dark = scheme ? scheme === 'dark' : window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    // a repeated call (the editor) starts clean, so a variable that was removed doesn't stay
    if (reset) [...container.style].filter(p => p.startsWith('--ns-')).forEach(p => container.style.removeProperty(p));
    css = String(css).replace(/\/\*[\s\S]*?\*\//g, '');
    const schemeBlocks = /@media\s*\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)\s*\{([\s\S]*?\})\s*\}/g;
    const base = css.replace(schemeBlocks, '');
    const matching = [...css.matchAll(schemeBlocks)].filter(m => (m[1] === 'dark') === dark).map(m => m[2]);
    // quoted font names hold no ';', so splitting on it is safe
    for (const text of [base, ...matching]) {
      for (const decl of text.split(/[;{}]/)) {
        const m = decl.match(/^\s*(--[\w-]+)\s*:\s*([^]+?)\s*$/);
        if (m) container.style.setProperty(m[1], m[2]);
      }
    }
  }

  window.nsTheme = { applyPreview };
  window.nsVersions = { decorateInstalled, renderPublishVersion, renderPendingVersions, changesHtml };
  window.nsBrowse = { browseQuery, mountBrowseControls, browseMetaHtml, authHeader, tagPickerHtml, wireTagPicker };
})();
