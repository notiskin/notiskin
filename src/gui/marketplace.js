// Marketplace pieces shared by the Themes and Plugins pages. nsVersions: "update available" on
// installed items, publishing a new version, editing tags and link, your versions waiting for review.
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
  const browseState = { sort: 'newest', tag: '' };

  function browseQuery(q) {
    const params = new URLSearchParams({ q: q || '', sort: browseState.sort });
    if (browseState.tag) params.set('tag', browseState.tag);
    return params.toString();
  }

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
        <div class="ns-tag-chips" role="group" aria-label="Filter by tag">
          ${TAGS.map(t => `<button type="button" class="ns-tag-chip" data-tag="${t}" aria-pressed="false">${t}</button>`).join('')}
        </div>
      </div>`;
    const select = container.querySelector('select');
    select.value = browseState.sort;
    select.addEventListener('change', () => { browseState.sort = select.value; onChange(); });
    container.querySelectorAll('.ns-tag-chip').forEach(chip => {
      chip.setAttribute('aria-pressed', String(chip.dataset.tag === browseState.tag));
      chip.addEventListener('click', () => {
        browseState.tag = browseState.tag === chip.dataset.tag ? '' : chip.dataset.tag;
        container.querySelectorAll('.ns-tag-chip').forEach(c => c.setAttribute('aria-pressed', String(c.dataset.tag === browseState.tag)));
        onChange();
      });
    });
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
      if (!res.ok) return [];
      return (await res.json()).updates || [];
    } catch {
      return [];
    }
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
  // whose marketplace item has a newer approved version
  async function decorateInstalled(type, onDone) {
    const updates = (await fetchUpdates()).filter(u => u.type === type);
    for (const update of updates) {
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
        <p class="ns-version-empty">Once one of your ${type}s is approved, you can publish new versions of it here.</p>`;
      renderEditDetails(type, container, getToken, mine);
      return;
    }

    container.innerHTML = `
      <h2 class="ns-version-heading">Publish a new version</h2>
      <p class="ns-version-intro">${type === 'theme'
        ? 'People who installed your theme see an Update button. Themes that pass the automatic check go live at once.'
        : 'People who installed your plugin see an Update button once a reviewer approves the new version. The current version stays live until then.'}</p>
      <form class="ns-version-form">
        <div class="field">
          <label for="v-item-${type}">${type === 'theme' ? 'Theme' : 'Plugin'}</label>
          <select id="v-item-${type}" required>
            ${own.map(s => `<option value="${esc(s.id)}">${esc(s.name)} (now version ${esc(s.version || 1)})</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="v-changelog-${type}">What changed</label>
          <input type="text" id="v-changelog-${type}" maxlength="500" required placeholder="Darker sidebar, fixed the code block colors">
        </div>
        <div class="field">
          <label for="v-code-${type}">${codeLabel}</label>
          <textarea id="v-code-${type}" required placeholder="Paste the full new version"></textarea>
          <div class="field-hint"><span>Paste the whole file, not just the changes.</span></div>
        </div>
        <button class="btn-submit" type="submit">Publish version</button>
      </form>
      <div class="publish-msg"></div>`;

    const form = container.querySelector('form');
    const msg = container.querySelector('.publish-msg');
    const code = container.querySelector(`#v-code-${type}`);
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
            id: container.querySelector(`#v-item-${type}`).value,
            changelog: container.querySelector(`#v-changelog-${type}`).value.trim(),
            code: code.value,
          }),
        });
        msg.className = 'publish-msg success';
        msg.textContent = result.autoApproved
          ? `Version ${result.version} is live.`
          : `Version ${result.version} submitted. The current version stays live until it's reviewed.` +
            (result.reason ? ` Note: ${result.reason}` : '');
        form.reset();
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
      <p class="ns-version-intro">Help people find your ${type} in Browse. Changes show right away, no review needed.</p>
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
          <div class="field-hint"><span>A github.com repo or gist, for screenshots and docs. Shown as a More info button.</span></div>
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

  window.nsVersions = { decorateInstalled, renderPublishVersion, renderPendingVersions, changesHtml };
  window.nsBrowse = { browseQuery, mountBrowseControls, browseMetaHtml, authHeader, tagPickerHtml, wireTagPicker };
})();
