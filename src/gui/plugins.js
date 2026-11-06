// shared helpers (esc, db, githubUsername, hideReviewLink, showNotif, openDocs, openReleasesPage, update banner) are in common.js

let pendingPluginName = null;

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch('/api' + path, opts);
  return res.json();
}

function setBusy(active, msg) {
  const overlay = document.getElementById('busy-overlay');
  document.getElementById('busy-msg').textContent = msg || 'Working';
  overlay.classList.toggle('visible', active);
}

function filenameToDisplayName(stem) {
  return stem.replace(/[-_]/g, ' ').toLowerCase();
}

const userRatings = {};

function buildRateBtn(itemId, itemType) {
  const rated = !!userRatings[itemId];
  return `
    <div class="popover-wrapper" id="popover-wrapper-${itemId}">
      <button class="rate-btn ${rated ? 'rated' : ''}" title="Rate" ${nsAct('click', 'toggleRatingPopover', itemId, itemType)}>★</button>
    </div>
  `;
}

function toggleRatingPopover(itemId, itemType, e) {
  e.stopPropagation();
  closeAllPopovers();
  const wrapper = document.getElementById(`popover-wrapper-${itemId}`);
  if (!wrapper) return;
  const currentRating = userRatings[itemId] || 0;
  const stars = [1,2,3,4,5].map(n => `
    <span
      class="popover-star ${n <= currentRating ? 'filled' : ''}"
      data-value="${n}"
      ${nsAct('mouseenter', 'hoverPopoverStars', itemId, n)}
      ${nsAct('mouseleave', 'resetPopoverStars', itemId, currentRating)}
      ${nsAct('click', 'submitRating', itemId, itemType, n)}
    >★</span>
  `).join('');
  const popover = document.createElement('div');
  popover.className = 'rating-popover';
  popover.id = `popover-${itemId}`;
  popover.onclick = e => e.stopPropagation();
  popover.innerHTML = `
    <div class="popover-stars" id="popover-stars-${itemId}">${stars}</div>
    ${currentRating > 0
      ? `<button class="remove-rating-btn" ${nsAct('click', 'removeRating', itemId, itemType)}>× Remove rating</button>`
      : `<div class="popover-label">Rate this</div>`
    }
  `;
  wrapper.appendChild(popover);
}

function hoverPopoverStars(itemId, value) {
  document.querySelectorAll(`#popover-stars-${itemId} .popover-star`).forEach(s => {
    s.classList.toggle('filled', parseInt(s.dataset.value) <= value);
  });
}

function resetPopoverStars(itemId, currentRating) {
  document.querySelectorAll(`#popover-stars-${itemId} .popover-star`).forEach(s => {
    s.classList.toggle('filled', parseInt(s.dataset.value) <= currentRating);
  });
}

function closeAllPopovers() {
  document.querySelectorAll('.rating-popover').forEach(p => p.remove());
}

document.addEventListener('click', e => {
  if (!e.target.closest('.popover-wrapper')) closeAllPopovers();
});

async function submitRating(itemId, itemType, rating, e) {
  e.stopPropagation();
  e.preventDefault();
  const previousRating = userRatings[itemId] || 0;
  userRatings[itemId] = rating;
  const btn = document.querySelector(`#popover-wrapper-${itemId} .rate-btn`);
  if (btn) btn.classList.add('rated');
  closeAllPopovers();
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) {
      showNotif('Sign in from Settings to rate');
      userRatings[itemId] = previousRating;
      if (btn) btn.classList.toggle('rated', !!previousRating);
      return;
    }
    const res = await fetch(`${SUPABASE_URL}/functions/v1/rate-item`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
      body: JSON.stringify({ item_id: itemId, item_type: itemType, rating })
    });
    if (!res.ok) {
      const data = await res.json();
      showNotif(data.error || 'Couldn\'t submit rating');
      userRatings[itemId] = previousRating;
      if (btn) btn.classList.toggle('rated', !!previousRating);
    }
  } catch {
    showNotif('Couldn\'t submit rating');
    userRatings[itemId] = previousRating;
    if (btn) btn.classList.toggle('rated', !!previousRating);
  }
}

async function removeRating(itemId, itemType, e) {
  e.stopPropagation();
  e.preventDefault();
  const previousRating = userRatings[itemId] || 0;
  delete userRatings[itemId];
  const btn = document.querySelector(`#popover-wrapper-${itemId} .rate-btn`);
  if (btn) btn.classList.remove('rated');
  closeAllPopovers();
  try {
    const session = (await db.auth.getSession()).data.session;
    if (!session) {
      showNotif('Sign in to manage ratings');
      userRatings[itemId] = previousRating;
      if (btn) btn.classList.add('rated');
      return;
    }
    const res = await fetch(`${SUPABASE_URL}/functions/v1/rate-item`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`
      },
      body: JSON.stringify({ item_id: itemId, item_type: itemType, rating: 0 })
    });
    if (!res.ok) {
      const data = await res.json();
      showNotif(data.error || 'Couldn\'t remove rating');
      userRatings[itemId] = previousRating;
      if (btn) btn.classList.add('rated');
    }
  } catch {
    showNotif('Couldn\'t remove rating');
    userRatings[itemId] = previousRating;
    if (btn) btn.classList.add('rated');
  }
}

async function loadUserRatings(session, itemIds, itemType) {
  if (!session || itemIds.length === 0) return;
  const { data } = await db
    .from('ratings')
    .select('item_id, rating')
    .eq('user_id', session.user.id)
    .eq('item_type', itemType)
    .in('item_id', itemIds);
  if (data) data.forEach(r => { userRatings[r.item_id] = r.rating; });
}

let currentInstalledPlugins = [];

// the tag checkboxes on the publish form, at most 3
let readPublishTags = () => [];
function resetPublishTags() {
  const box = document.getElementById('f-tags');
  box.innerHTML = nsBrowse.tagPickerHtml('f', []);
  readPublishTags = nsBrowse.wireTagPicker(box);
}
resetPublishTags();

async function sessionToken() {
  return (await db.auth.getSession()).data.session?.access_token || null;
}

async function switchTab(name) {
  document.getElementById('tab-installed').hidden    = name !== 'installed';
  document.getElementById('tab-browse').hidden       = name !== 'browse';
  document.getElementById('tab-publish').hidden      = name !== 'publish';
  document.getElementById('tab-submissions').hidden  = name !== 'submissions';
  document.querySelectorAll('.tab-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.tab === name)
  );
  if (name === 'publish') {
    initCharacterCounters();
    await nsVersions.renderPublishVersion('plugin', document.getElementById('publish-version-section'), sessionToken);
    return;
  }
  if (name === 'submissions') { await loadSubmissions('plugin'); return; }

  let pluginsData;
  try {
    pluginsData = await api('GET', '/plugins');
  } catch (e) {
    console.error('Failed to fetch state:', e);
  }

  if (name === 'installed') {
    await loadPlugins(pluginsData);
  } else if (name === 'browse') {
    await loadBrowse();
  }
}

async function loadPlugins(preloaded) {
  const { plugins, enabledPlugins, withSettings, dev } = preloaded || await api('GET', '/plugins');
  renderDevPlugins(dev);
  const el = document.getElementById('plugins-list');
  if (!plugins || !plugins.length) {
    el.innerHTML = '<span class="empty">No plugins installed yet</span>';
    return;
  }

  let nameToId = {};
  // ratings are a nice-to-have, never let a slow or offline marketplace block the local list
  const { data: rows } = await db.from('plugins').select('id, name').eq('status', 'approved').abortSignal(AbortSignal.timeout(3000));
  if (rows) {
    rows.forEach(r => {
      const normalizedDbName = normalizeName(r.name);
      plugins.forEach(localName => {
        if (normalizeName(localName) === normalizedDbName) {
          nameToId[localName] = r.id;
        }
      });
    });
  }

  el.innerHTML = plugins.map(p => {
    const enabled = (enabledPlugins || []).includes(p);
    return `
      <div class="card" data-name="${esc(filenameToDisplayName(p))}" data-file="${esc(p)}">
        <div class="card-info">
          <div class="card-name">${esc(filenameToDisplayName(p))}</div>
        </div>
        <label class="toggle" ${nsAct('click', 'stop')}>
          <input type="checkbox" ${enabled ? 'checked' : ''} ${nsAct('change', 'togglePluginFromSwitch', p)}>
          <span class="toggle-track"></span>
          <span class="toggle-thumb"></span>
        </label>
        ${(nameToId[p] || nameToId[p.toLowerCase()]) ? buildRateBtn(nameToId[p] || nameToId[p.toLowerCase()], 'plugin') : ''}
        ${(withSettings || []).includes(p) ? `<button class="btn-settings" ${nsAct('click', 'togglePluginSettings', p)}>Settings</button>` : ''}
        <button class="btn-delete" title="Delete plugin" ${nsAct('click', 'deletePlugin', p)}>×</button>
        <div class="ps-panel" hidden></div>
      </div>
    `;
  }).join('');

  nsVersions.decorateInstalled('plugin', () => loadPlugins(), { turnOff: name => togglePlugin(name, false) });

  const session = (await db.auth.getSession()).data.session;
  const itemIds = Object.values(nameToId);
  await loadUserRatings(session, itemIds, 'plugin');
  itemIds.forEach(id => {
    if (userRatings[id]) {
      const btn = document.querySelector(`#popover-wrapper-${id} .rate-btn`);
      if (btn) btn.classList.add('rated');
    }
  });
}

// ---- plugin settings ----
// the form is made from what the plugin declares in its header comment (the server reads it as text, the plugin is never run)
async function togglePluginSettings(name, event) {
  event.preventDefault();
  event.stopPropagation();
  const btn = event.target.closest('.btn-settings');
  const panel = btn.closest('.card').querySelector('.ps-panel');
  const open = panel.hidden;
  btn.setAttribute('aria-expanded', String(open));
  if (!open) { panel.hidden = true; return; }
  panel.hidden = false;
  panel.innerHTML = '<span class="loading">Loading</span>';
  try {
    renderPluginSettings(panel, name, await api('GET', `/plugin-settings/${encodeURIComponent(name)}`));
  } catch {
    panel.innerHTML = '<span class="error">Couldn\'t load the settings.</span>';
  }
}

function pluginSettingControl(decl, value) {
  const id = `ps-${decl.key}`;
  const attr = (name, v) => (v === undefined ? '' : ` ${name}="${esc(v)}"`);
  if (decl.type === 'toggle') {
    return `<label class="toggle"><input type="checkbox" id="${id}" data-key="${esc(decl.key)}" ${value ? 'checked' : ''}><span class="toggle-track"></span><span class="toggle-thumb"></span></label>`;
  }
  if (decl.type === 'select') {
    return `<select id="${id}" data-key="${esc(decl.key)}">${decl.options.map(o => `<option value="${esc(o)}"${o === value ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  }
  if (decl.type === 'number') {
    return `<input type="number" id="${id}" data-key="${esc(decl.key)}" value="${esc(value)}"${attr('min', decl.min)}${attr('max', decl.max)}${attr('step', decl.step)}>`;
  }
  if (decl.type === 'color') {
    return `<input type="color" id="${id}" data-key="${esc(decl.key)}" value="${esc(value)}">`;
  }
  return `<input type="text" id="${id}" data-key="${esc(decl.key)}" value="${esc(value)}" maxlength="${esc(decl.maxLength)}">`;
}

function renderPluginSettings(panel, name, data) {
  const { settings, problems, values, enabled } = data;
  panel.innerHTML = `
    ${enabled ? '' : '<div class="ps-note">Off. Your choices are kept until you turn it on.</div>'}
    ${settings.map(decl => `
      <div class="ps-field">
        <label class="ps-label" for="ps-${esc(decl.key)}">${esc(decl.label)}</label>
        ${pluginSettingControl(decl, values[decl.key])}
        ${decl.description ? `<div class="ps-desc">${esc(decl.description)}</div>` : ''}
      </div>`).join('')}
    <div class="ps-error" role="status"></div>
    ${problems.length ? `<div class="ps-problems">${problems.map(esc).join('<br>')}</div>` : ''}
    <div class="ps-actions"><button type="button" class="btn-ghost ps-reset">Reset to defaults</button></div>`;
  const error = panel.querySelector('.ps-error');

  async function save(key, value) {
    const res = await api('POST', `/plugin-settings/${encodeURIComponent(name)}`, { values: { [key]: value } });
    error.textContent = res.error || '';
    return res;
  }
  const timers = {};
  panel.querySelectorAll('[data-key]').forEach(input => {
    const key = input.dataset.key;
    const decl = settings.find(d => d.key === key);
    const read = () => {
      if (decl.type === 'toggle') return input.checked;
      if (decl.type === 'number') return input.value.trim() === '' ? NaN : input.valueAsNumber;
      return input.value;
    };
    const send = () => {
      const value = read();
      if (decl.type === 'number' && Number.isNaN(value)) { error.textContent = `${decl.label}: enter a number.`; return; }
      save(key, value);
    };
    // a color picker fires on every drag, so it waits a moment; the rest save when the value is settled
    if (decl.type === 'color') {
      input.addEventListener('input', () => { clearTimeout(timers[key]); timers[key] = setTimeout(send, 300); });
    } else {
      input.addEventListener('change', send);
    }
  });
  panel.querySelector('.ps-reset').addEventListener('click', async () => {
    const res = await api('POST', `/plugin-settings/${encodeURIComponent(name)}`, { reset: true });
    if (res.error) { error.textContent = res.error; return; }
    renderPluginSettings(panel, name, { ...data, values: res.values });
  });
}

// developer mode: plugins that run from a folder while they are being written. Always on, no switch, never published
function renderDevPlugins(dev) {
  const section = document.getElementById('dev-section');
  section.hidden = !dev || !dev.enabled;
  if (section.hidden) return;
  document.getElementById('dev-note').textContent = dev.error
    ? dev.error
    : `Running from ${dev.folder}`;
  document.getElementById('dev-plugins-list').innerHTML = dev.plugins.length
    ? dev.plugins.map(p => `
      <div class="card" data-file="${esc(p.name)}">
        <div class="card-info">
          <div class="card-name">${esc(p.file)} <span class="badge dev">dev</span></div>
        </div>
        ${p.hasSettings ? `<button class="btn-settings" ${nsAct('click', 'togglePluginSettings', p.name)}>Settings</button>` : ''}
        <div class="ps-panel" hidden></div>
      </div>`).join('')
    : '<span class="empty">No .js files in that folder</span>';
}

async function togglePlugin(name, enable) {
  if (enable) {
    setBusy(true, `Enabling ${name}`);
    try {
      const res = await api('POST', `/plugin/enable/${encodeURIComponent(name)}`);
      if (res.needsWarning) {
        pendingPluginName = name;
        document.getElementById('warning-dialog').classList.add('visible');
        await loadPlugins();
        return;
      }
      if (!res.ok) { await loadPlugins(); return; }
    } catch (e) {
    } finally {
      setBusy(false);
    }
  } else {
    setBusy(true, `Disabling ${name}`);
    try {
      await api('POST', `/plugin/disable/${encodeURIComponent(name)}`);
    } catch (e) {
    } finally {
      setBusy(false);
    }
  }
  await loadPlugins();
}

function cancelWarning() {
  pendingPluginName = null;
  document.getElementById('warning-dialog').classList.remove('visible');
}

async function confirmWarning() {
  document.getElementById('warning-dialog').classList.remove('visible');
  if (!pendingPluginName) return;
  const name = pendingPluginName;
  pendingPluginName = null;

  await api('POST', `/plugin/acknowledge/${encodeURIComponent(name)}`);
  setBusy(true, `Enabling ${name}`);
  try {
    await api('POST', `/plugin/enable/${encodeURIComponent(name)}`);
  } catch (e) {
  } finally {
    setBusy(false);
    await loadPlugins();
  }
}

async function deletePlugin(name, event) {
  event.preventDefault();
  event.stopPropagation();
  const card = event.target.closest('.card');
  if (card) card.style.display = 'none';
  try {
    const res = await api('DELETE', `/plugins/${encodeURIComponent(name)}`);
    if (!res.success) {
      if (card) card.style.display = '';
      showNotif(res.error || 'Couldn\'t delete that plugin');
      return;
    }
  } catch (e) {
    if (card) card.style.display = '';
    showNotif('Couldn\'t delete that plugin');
    return;
  }
  showNotif(`${name} removed`);
  await loadPlugins();
}

const browseItems = {};

function normalizeName(n) { return n.toLowerCase().replace(/[\s\-_]/g, ''); }

function renderBrowsePluginCard(item) {
  const key = `plugin:${item.name}`;
  browseItems[key] = { ...item, type: 'plugin' };
  return `
    <div class="card">
      <div class="card-row">
        <div class="card-info">
          <div class="card-name">${esc(item.name)}</div>
          ${item.description ? `<div class="card-desc">${esc(item.description)}</div>` : ''}
          <div class="card-meta">by <a href="https://github.com/${esc(item.author_github)}" target="_blank" rel="noopener noreferrer">${esc(item.author_github)}</a></div>
          ${nsBrowse.browseMetaHtml(browseItems[key])}
        </div>
        <button class="btn-install" data-key="${esc(key)}" ${nsAct('click', 'installFromBrowse')}>Install</button>
      </div>
      <div class="install-error"></div>
    </div>
  `;
}

async function installFromBrowse(btn) {
  const item = browseItems[btn.dataset.key];
  if (!item) return;

  btn.disabled = true;
  btn.textContent = 'Installing';
  btn.closest('.card').querySelector('.install-error').textContent = '';

  try {
    const res = await fetch('/api/marketplace/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await nsBrowse.authHeader(sessionToken)) },
      body: JSON.stringify({ type: 'plugin', id: item.id }),
    });
    const data = await res.json();
    if (data.success) {
      showNotif(`${item.name} installed`);
      const card = btn.closest('.card');
      const list = card.parentElement;
      card.style.transition = 'opacity 0.3s';
      card.style.opacity = '0';
      setTimeout(() => {
        card.remove();
        if (!list.querySelector('.card')) {
          list.innerHTML = '<span class="empty">Nothing installed yet</span>';
        }
      }, 300);
    } else {
      btn.closest('.card').querySelector('.install-error').textContent = data.error || 'Installation failed';
      btn.disabled = false;
      btn.textContent = 'Install';
    }
  } catch {
    btn.closest('.card').querySelector('.install-error').textContent = "Can't reach Notiskin. Is the app open?";
    btn.disabled = false;
    btn.textContent = 'Install';
  }
}

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

async function loadBrowse() {
  const controls = document.getElementById('browse-controls');
  if (!controls.firstChild) {
    nsBrowse.mountBrowseControls(controls, () => debouncedBrowseSearch(document.getElementById('browse-search-plugins').value.trim()));
  }
  const pluginsEl = document.getElementById('browse-plugins-list');
  pluginsEl.innerHTML = '<span class="loading">Loading</span>';
  try {
    const data = await api('GET', '/plugins');
    currentInstalledPlugins = data?.plugins || [];
  } catch (e) { /* ignore */ }
  try {
    const res = await api('GET', `/plugins/search?${nsBrowse.browseQuery('')}`);
    const list = (res.plugins || [])
      .filter(p => !currentInstalledPlugins.some(n => normalizeName(n) === normalizeName(p.name)));
    pluginsEl.innerHTML = list.map(p => renderBrowsePluginCard(p)).join('') || '<span class="empty">No plugins here yet</span>';
  } catch (e) {
    pluginsEl.innerHTML = `<span class="error">Couldn't load the catalog. Try again later.</span>`;
  }
}

const debouncedBrowseSearch = debounce(async (q) => {
  const pluginsEl = document.getElementById('browse-plugins-list');
  pluginsEl.innerHTML = '<span class="loading">Searching…</span>';
  try {
    const res = await api('GET', `/plugins/search?${nsBrowse.browseQuery(q)}`);
    const list = (res.plugins || [])
      .filter(p => !currentInstalledPlugins.some(n => normalizeName(n) === normalizeName(p.name)));
    pluginsEl.innerHTML = list.map(p => renderBrowsePluginCard(p)).join('') || '<span class="empty">No plugins found</span>';
  } catch (e) {
    pluginsEl.innerHTML = '<span class="error">Couldn\'t load results</span>';
  }
}, 300);

document.getElementById('installed-search-plugins').addEventListener('input', function () {
  const q = this.value.toLowerCase();
  document.querySelectorAll('#plugins-list .card').forEach(card => {
    const name = card.dataset.name || card.querySelector('.card-name')?.textContent || '';
    card.style.display = name.toLowerCase().includes(q) ? '' : 'none';
  });
});

document.getElementById('browse-search-plugins').addEventListener('input', function () {
  debouncedBrowseSearch(this.value.trim());
});

let publishCurrentUser = null;

function showPublishLogin() {
  document.getElementById('publish-login-section').style.display = 'block';
  document.getElementById('publish-form-section').style.display  = 'none';
}

function showPublishForm(user) {
  document.getElementById('publish-login-section').style.display = 'none';
  document.getElementById('publish-form-section').style.display  = 'block';
  document.getElementById('publish-username-display').textContent = githubUsername(user);
}

function showPublishMsg(type, text) {
  const el = document.getElementById('publish-msg');
  el.className = `publish-msg ${type}`;
  el.textContent = text;
}

function initCharacterCounters() {
  const nameInput = document.getElementById('f-name');
  const nameCount = document.getElementById('name-count');
  const descInput = document.getElementById('f-description');
  const descCount = document.getElementById('desc-count');
  const codeInput = document.getElementById('f-code');
  const codeCount = document.getElementById('code-count');

  function updateCount(input, countEl, max) {
    const len = input.value.length;
    countEl.textContent = `${len}/${max}`;
    countEl.style.color = len >= max ? 'var(--danger)' : '';
  }

  nameInput.addEventListener('input', function () {
    this.value = this.value.replace(/[^a-z0-9 ]/gi, '');
    updateCount(this, nameCount, 50);
  });
  descInput.addEventListener('input', () => updateCount(descInput, descCount, 300));
  codeInput.addEventListener('input', () => {
    if (codeInput.value.length > 50000) {
      codeInput.value = codeInput.value.slice(0, 50000);
    }
    updateCount(codeInput, codeCount, 50000);
  });
}

async function handlePublishSubmit(e) {
  e.preventDefault();
  if (!publishCurrentUser) return;

  const btn = document.getElementById('publish-submit-btn');
  btn.disabled = true;
  btn.textContent = 'Submitting';
  document.getElementById('publish-msg').className = 'publish-msg';

  const rawName = document.getElementById('f-name').value;
  const name = rawName.trim().replace(/  +/g, ' ').toLowerCase();
  if (!name) {
    document.getElementById('publish-msg').textContent = 'Name is required.';
    btn.disabled = false;
    btn.textContent = 'Submit';
    return;
  }
  document.getElementById('f-name').value = name;
  const description   = document.getElementById('f-description').value.trim();
  const code          = document.getElementById('f-code').value;

  try {
    const { data: { session } } = await db.auth.getSession();
    const res = await fetch('/api/submit/plugin', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ name, description, js: code, tags: readPublishTags(), link: document.getElementById('f-link').value.trim() }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error ?? 'Submission failed');

    btn.disabled = false;
    btn.textContent = 'Submit';
    showPublishMsg('success', 'Plugin submitted for review.');
    document.getElementById('publish-form').reset();
    resetPublishTags();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Submit';
    showPublishMsg('error', err.message);
  }
}

function initPublishAuth() {
  db.auth.onAuthStateChange((_event, session) => {
    publishCurrentUser = session?.user ?? null;
    if (!session) hideReviewLink();
    if (publishCurrentUser) showPublishForm(publishCurrentUser);
    else showPublishLogin();
  });

  (async () => {
    const { data: { session } } = await db.auth.getSession();
    publishCurrentUser = session?.user ?? null;
    if (!session) hideReviewLink();
    if (publishCurrentUser) showPublishForm(publishCurrentUser);
    else showPublishLogin();
    if (window.location.hash) {
      history.replaceState(null, '', window.location.pathname);
    }
  })();
}

async function loadSubmissions(type) {
  const el = document.getElementById('submissions-list');
  el.innerHTML = '<span class="loading">Loading</span>';

  const { data: { session } } = await db.auth.getSession();
  if (!session) {
    el.innerHTML = '<span class="empty">Sign in to see your submissions.</span>';
    return;
  }

  let submissions;
  try {
    const res = await fetch(`/api/submissions?type=${type}`, {
      headers: { 'Authorization': `Bearer ${session.access_token}` },
    });
    if (!res.ok) {
      const d = await res.json();
      el.innerHTML = `<span class="error">${esc(d.error || "Couldn't load your submissions")}</span>`;
      return;
    }
    ({ submissions } = await res.json());
  } catch {
    el.innerHTML = "<span class=\"error\">Can't reach the server</span>";
    return;
  }

  nsVersions.renderPendingVersions(type, document.getElementById('submissions-versions'), sessionToken, submissions);

  if (!submissions.length) {
    el.innerHTML = '<span class="empty">Nothing submitted yet</span>';
    return;
  }

  el.innerHTML = submissions.map(s => `
    <div class="card" id="submission-${esc(String(s.id))}">
      <div class="sub-card-header">
        <div class="sub-card-left">
          <span class="card-name">${esc(s.name)}</span>
          <span class="status-badge ${esc(s.status)}">${esc(s.status)}</span>
        </div>
        ${s.status !== 'approved' ? `<button class="btn-danger" ${nsAct('click', 'deleteSubmission', String(s.id), s.name, type)}>Delete</button>` : ''}
      </div>
      ${s.rejection_reason ? `<div class="submission-reason">${esc(s.rejection_reason)}</div>` : ''}
    </div>
  `).join('');
}

function dbg(msg) {
  fetch('/api/debug-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg }),
  }).catch(() => {});
}

async function deleteSubmission(id, name, type) {
  if (!confirm(`Delete ${name}? This can't be undone.`)) return;
  const { data: { session } } = await db.auth.getSession();
  if (!session) { alert("You're not signed in"); return; }
  const url = `/api/submissions/${encodeURIComponent(id)}?type=${type}`;
  const token = session.access_token;
  dbg(`DELETE ${url}, token prefix: ${token?.slice(0, 20)} length: ${token?.length}`);
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  dbg(`response status: ${res.status}`);
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || "This submission can't be deleted");
    return;
  }
  document.getElementById('submission-' + id)?.remove();
  showNotif(`${name} deleted`);
  const el = document.getElementById('submissions-list');
  if (el && !el.querySelector('.card')) {
    el.innerHTML = '<span class="empty">Nothing submitted yet</span>';
  }
}

async function init() {
  await switchTab('installed');
  initPublishAuth();
}

nsActions({
  switchTab, openDocs, openReleasesPage, turnOffSafeMode, handlePublishSubmit, cancelWarning, confirmWarning,
  togglePluginSettings, deletePlugin, deleteSubmission,
  toggleRatingPopover, hoverPopoverStars, resetPopoverStars, submitRating, removeRating,
  togglePluginFromSwitch(name) { return togglePlugin(name, this.checked); },
  installFromBrowse() { return installFromBrowse(this); },
});

init();
checkUpdateBanner();
setInterval(checkUpdateBanner, 30000);

// shown on Themes and Plugins while safe mode is on, so a theme that won't load isn't a mystery
async function refreshSafeModeNotice() {
  try {
    const status = await fetch('/api/status').then(r => r.json());
    document.getElementById('safe-mode-notice').style.display = status.safeMode ? 'flex' : 'none';
  } catch {}
}

async function turnOffSafeMode() {
  try {
    const res = await fetch('/api/safe-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: false }),
    });
    if ((await res.json()).ok) showNotif('Safe mode off');
  } catch {}
  refreshSafeModeNotice();
}

refreshSafeModeNotice();
