// shared helpers (esc, db, githubUsername, hideReviewLink, showNotif, openDocs, openReleasesPage, update banner) are in common.js

// signed out: forget the saved reviewer access, Settings checks again at the next sign-in

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch('/api' + path, opts);
  return res.json();
}

function setBusy(active, msg) {
  const overlay = document.getElementById('busy-overlay');
  document.getElementById('busy-msg').textContent = msg || 'Applying. Notion will restart.';
  overlay.classList.toggle('visible', active);
}

function filenameToDisplayName(stem) {
  return stem.replace(/[-_]/g, ' ').toLowerCase();
}

const userRatings = {};

function buildRateBtn(itemId, itemType) {
  const rated = !!userRatings[itemId];
  return `
    <div class="popover-wrapper" id="popover-wrapper-${itemId}" ${nsAct('click', 'stopAndPrevent')}>
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

let currentInstalledThemes = [];

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
    await nsVersions.renderPublishVersion('theme', document.getElementById('publish-version-section'), sessionToken);
    return;
  }
  if (name === 'submissions') { await loadSubmissions('theme'); return; }

  let themesData;
  try {
    const state = await fetch('/api/state').then(r => r.json());
    themesData = {
      themes: state.themes.map(t => t.name),
      activeTheme: state.activeTheme,
    };
  } catch (e) {
    console.error('Failed to fetch state:', e);
  }

  if (name === 'installed') {
    await loadThemes(themesData);
  } else if (name === 'browse') {
    currentInstalledThemes = themesData?.themes || [];
    await loadBrowse(currentInstalledThemes);
  }
}

async function loadThemes(preloaded) {
  const { themes, activeTheme } = preloaded || await api('GET', '/themes');
  const el = document.getElementById('themes-list');
  const noThemeActive = !activeTheme;

  const defaultCard = `
    <label class="card${noThemeActive ? ' active' : ''}">
      <input type="radio" name="theme" value="" ${noThemeActive ? 'checked' : ''} ${nsAct('change', 'clearTheme')}>
      <div class="card-info">
        <div class="card-name">No theme</div>
      </div>
    </label>
  `;

  if (!themes || !themes.length) {
    el.innerHTML = defaultCard;
    return;
  }

  let nameToId = {};
  // ratings are a nice-to-have, never let a slow or offline marketplace block the local list
  const { data: rows } = await db.from('themes').select('id, name').eq('status', 'approved').abortSignal(AbortSignal.timeout(3000));
  if (rows) {
    rows.forEach(r => {
      const normalizedDbName = normalizeName(r.name);
      themes.forEach(localName => {
        if (normalizeName(localName) === normalizedDbName) {
          nameToId[localName] = r.id;
        }
      });
    });
  }

  el.innerHTML = defaultCard + themes.map(t => {
    const sid = nameToId[t];
    return `
      <label class="card${t === activeTheme ? ' active' : ''}" data-name="${esc(filenameToDisplayName(t))}" data-file="${esc(t)}">
        <input type="radio" name="theme" value="${esc(t)}" ${t === activeTheme ? 'checked' : ''} ${nsAct('change', 'switchTheme', t)}>
        <div class="card-info">
          <div class="card-name">${esc(filenameToDisplayName(t))}</div>
        </div>
        ${sid ? buildRateBtn(sid, 'theme') : ''}
        <button class="btn-edit" title="Edit this theme" ${nsAct('click', 'editTheme', t)}>Edit</button>
        <button class="btn-delete" title="Delete theme" ${nsAct('click', 'deleteTheme', t)}>×</button>
      </label>
    `;
  }).join('');

  nsVersions.decorateInstalled('theme', () => loadThemes());

  const session = (await db.auth.getSession()).data.session;
  const itemIds = Object.values(nameToId);
  await loadUserRatings(session, itemIds, 'theme');
  itemIds.forEach(id => {
    if (userRatings[id]) {
      const btn = document.querySelector(`#popover-wrapper-${id} .rate-btn`);
      if (btn) btn.classList.add('rated');
    }
  });
}

async function clearTheme() {
  setBusy(true, 'Removing theme');
  try {
    await api('POST', '/theme/clear');
  } catch (e) {
  } finally {
    setBusy(false);
    await loadThemes();
  }
}

async function switchTheme(name) {
  setBusy(true, `Switching to ${name}. Notion will restart.`);
  try {
    await api('POST', `/theme/${encodeURIComponent(name)}`);
  } catch (e) {
  } finally {
    setBusy(false);
    await loadThemes();
  }
}

// ---- theme editor ----
// the editor (theme-editor.js) draws itself into #theme-editor and takes over the page until it is closed
nsThemeEditor.init({
  api,
  mockup: themeMockupHtml(),
  onClose() {
    document.querySelector('.tabs').style.display = '';
    switchTab('installed');
  },
  onPublish: (name, css) => publishFromEditor(name, css),
});

function showEditor(opts) {
  document.querySelector('.tabs').style.display = 'none';
  ['installed', 'browse', 'publish', 'submissions'].forEach(t => { document.getElementById(`tab-${t}`).hidden = true; });
  nsThemeEditor.open(opts);
}

function newTheme() {
  showEditor({ name: '', css: nsThemeEditor.START_CSS(nsThemeEditor.PLACEHOLDER_NAME), isNew: true });
}

async function editTheme(name, event) {
  event.preventDefault();
  event.stopPropagation();
  const res = await api('GET', `/theme-editor/${encodeURIComponent(name)}`);
  if (res.error) { showNotif(res.error); return; }
  if (res.fromMarketplace) {
    // an installed theme is updated by the marketplace, so editing makes a copy next to it
    showNotif('Installed from the marketplace, so this makes your own copy');
    showEditor({ name: `${name} copy`, css: res.css, isNew: true });
  } else {
    showEditor({ name, css: res.css, isNew: false });
  }
}

// "Save and publish": the editor has saved the file, the Publish tab does the rest (a new theme, or a new version of one you own)
async function publishFromEditor(name, css) {
  await switchTab('publish');
  const display = name.replace(/[-_.]/g, ' ').replace(/[^a-z0-9 ]/gi, '').replace(/ +/g, ' ').trim().toLowerCase();
  const fill = (id, value) => {
    const input = document.getElementById(id);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    return input;
  };
  const select = document.getElementById('v-item-theme');
  const own = select && [...select.options].find(o => o.textContent.replace(/ \((now )?version.*$/, '') === display);
  if (own) {
    select.value = own.value;
    fill('v-code-theme', css).closest('form').scrollIntoView({ block: 'center' });
    showNotif('Say what changed, then publish the new version');
    return;
  }
  fill('f-name', display.slice(0, 50));
  fill('f-code', css).scrollIntoView({ block: 'center' });
  showNotif('Add a description, then submit');
}

async function deleteTheme(name, event) {
  event.preventDefault();
  event.stopPropagation();
  const card = event.target.closest('.card');
  if (card) card.style.display = 'none';
  try {
    const res = await api('DELETE', `/themes/${encodeURIComponent(name)}`);
    if (!res.success) {
      if (card) card.style.display = '';
      showNotif(res.error || 'Couldn\'t delete that theme');
      return;
    }
  } catch (e) {
    if (card) card.style.display = '';
    showNotif('Couldn\'t delete that theme');
    return;
  }
  showNotif(`${name} removed`);
  await loadThemes();
}

const browseItems = {};

const applyThemePreview = nsTheme.applyPreview;

function normalizeName(n) { return n.toLowerCase().replace(/[\s\-_]/g, ''); }

// the mock Notion page the theme previews draw (Browse cards and the editor)
function themeMockupHtml() {
  return `
        <div class="ns-mockup">
          <div class="ns-sidebar">
            <div class="ns-sidebar-item ns-sidebar-item--active">📄 My Page</div>
            <div class="ns-sidebar-item">📁 Projects</div>
            <div class="ns-sidebar-item">📝 Notes</div>
            <div class="ns-sidebar-item">🗂 Archive</div>
          </div>
          <div class="ns-main">
            <div class="ns-topbar">
              <span class="ns-breadcrumb">Workspace / My Page</span>
            </div>
            <div class="ns-body">
              <div class="ns-title">My Notion Page</div>
              <div class="ns-divider"></div>
              <div class="ns-paragraph">This is a paragraph of body text. It shows how readable content looks with this theme applied.</div>
              <div class="ns-callout">💡 This is a callout block with a background color.</div>
              <div class="ns-code">const hello = "world"; // inline code block</div>
              <div class="ns-quote">A quote block with a colored left border.</div>
              <div class="ns-db">
                <div class="ns-table">
                  <div class="ns-table-row ns-table-row--head">Name</div>
                  <div class="ns-table-row ns-table-row--hover">Row under the cursor</div>
                </div>
                <div class="ns-card">Board card</div>
              </div>
            </div>
          </div>
        </div>
  `;
}

function renderBrowseThemeCard(item) {
  const key = `theme:${item.name}`;
  browseItems[key] = { ...item, type: 'theme' };
  const previewId = `preview-${esc(item.name)}`;
  return `
    <div class="card">
      <div class="theme-preview" id="${previewId}">
        ${themeMockupHtml()}
      </div>
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
      body: JSON.stringify({ type: item.type, id: item.id }),
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

async function loadBrowse(installedThemes) {
  const controls = document.getElementById('browse-controls');
  if (!controls.firstChild) {
    nsBrowse.mountBrowseControls(controls, () => debouncedBrowseSearch(document.getElementById('browse-search-themes').value.trim()));
  }
  const themesEl = document.getElementById('browse-themes-list');
  themesEl.innerHTML = '<span class="loading">Loading</span>';
  try {
    const res = await api('GET', `/themes/search?${nsBrowse.browseQuery('')}`);
    const list = (res.themes || [])
      .filter(t => !installedThemes.some(n => normalizeName(n) === normalizeName(t.name)));
    themesEl.innerHTML = list.map(t => renderBrowseThemeCard(t)).join('') || '<span class="empty">No themes here yet</span>';
    list.forEach(t => applyThemePreview(`preview-${t.name}`, t.css));
  } catch (e) {
    themesEl.innerHTML = `<span class="error">Couldn't load the catalog. Try again later.</span>`;
  }
}

const debouncedBrowseSearch = debounce(async (q) => {
  const themesEl = document.getElementById('browse-themes-list');
  themesEl.innerHTML = '<span class="loading">Searching…</span>';
  try {
    const res = await api('GET', `/themes/search?${nsBrowse.browseQuery(q)}`);
    const list = (res.themes || [])
      .filter(t => !currentInstalledThemes.some(n => normalizeName(n) === normalizeName(t.name)));
    themesEl.innerHTML = list.map(t => renderBrowseThemeCard(t)).join('') || '<span class="empty">No themes found</span>';
    list.forEach(t => applyThemePreview(`preview-${t.name}`, t.css));
  } catch (e) {
    themesEl.innerHTML = '<span class="error">Couldn\'t load results</span>';
  }
}, 300);

document.getElementById('installed-search-themes').addEventListener('input', function () {
  const q = this.value.toLowerCase();
  document.querySelectorAll('#themes-list .card').forEach(card => {
    const name = card.dataset.name || card.querySelector('.card-name')?.textContent || '';
    card.style.display = name.toLowerCase().includes(q) ? '' : 'none';
  });
});

document.getElementById('browse-search-themes').addEventListener('input', function () {
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
    if (codeInput.value.length > 50000) codeInput.value = codeInput.value.slice(0, 50000);
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
    const res = await fetch('/api/submit/theme', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ name, description, css: code, tags: readPublishTags(), link: document.getElementById('f-link').value.trim() }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error ?? 'Submission failed');

    btn.disabled = false;
    btn.textContent = 'Submit';
    showPublishMsg('success', result.autoApproved
      ? 'Theme published.'
      : 'Theme submitted for review.' + (result.reason ? ` ${result.reason}.` : ''));
    document.getElementById('publish-form').reset();
    resetPublishTags();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Submit';
    showPublishMsg('error', err.message);
  }
}

// OAuth redirects land here regardless of active tab
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
  switchTab, newTheme, openDocs, openReleasesPage, turnOffSafeMode, handlePublishSubmit,
  switchTheme, clearTheme, editTheme, deleteTheme, deleteSubmission,
  toggleRatingPopover, hoverPopoverStars, resetPopoverStars, submitRating, removeRating,
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
