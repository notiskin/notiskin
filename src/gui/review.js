// shared helpers (esc, db, githubUsername, hideReviewLink, update banner) are in common.js

let currentUser = null;
let queueLoaded = false;

function dbg(msg) {
  fetch('/api/debug-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg: '[review] ' + msg }),
  }).catch(() => {});
}

function showLogin() {
  document.getElementById('login-section').style.display = 'block';
  document.getElementById('review-section').style.display = 'none';
}

async function showReview(user) {
  document.getElementById('login-section').style.display = 'none';
  document.getElementById('review-section').style.display = 'block';
  document.getElementById('username-display').textContent = githubUsername(user);
  dbg('showReview → calling loadQueue()');
  await loadQueue();
}

const applyThemePreview = nsTheme.applyPreview;

function themeCard(item) {
  const previewId = `preview-${item.id}`;
  return `
    <div class="card" id="submission-${esc(item.id)}">
      <div class="theme-preview" id="${previewId}">
        <div class="ns-preview-sidebar">
          <div class="ns-preview-nav-item"></div>
          <div class="ns-preview-nav-item"></div>
          <div class="ns-preview-nav-item active"></div>
        </div>
        <div class="ns-preview-content">
          <div class="ns-preview-title"></div>
          <div class="ns-preview-block"></div>
          <div class="ns-preview-block short"></div>
        </div>
      </div>
      <div class="card-header">
        <div>
          <div class="card-name">${esc(item.name)}</div>
          <div class="card-meta">by ${esc(item.author_github)}${item.description ? ', ' + esc(item.description) : ''}</div>
          ${item.rejection_reason ? `<p class="auto-flag">⚠ ${esc(item.rejection_reason)}</p>` : ''}
        </div>
        <div class="card-actions" id="actions-${esc(item.id)}">
          <button class="btn-approve" data-id="${esc(item.id)}" data-type="theme">Approve</button>
          <button class="btn-reject"  data-id="${esc(item.id)}" data-type="theme">Reject</button>
        </div>
      </div>
      <pre>${esc(item.css)}</pre>
    </div>
  `;
}

function pluginCard(item) {
  return `
    <div class="card" id="submission-${esc(item.id)}">
      <div class="card-header">
        <div>
          <div class="card-name">${esc(item.name)}</div>
          <div class="card-meta">by ${esc(item.author_github)}${item.description ? ', ' + esc(item.description) : ''}</div>
        </div>
        <div class="card-actions" id="actions-${esc(item.id)}">
          <button class="btn-approve" data-id="${esc(item.id)}" data-type="plugin">Approve</button>
          <button class="btn-reject"  data-id="${esc(item.id)}" data-type="plugin">Reject</button>
        </div>
      </div>
      <pre>${esc(item.js)}</pre>
    </div>
  `;
}

function rejectedThemeCard(item) {
  const previewId = `preview-rej-${item.id}`;
  return `
    <div class="card" style="opacity:0.6">
      <div class="theme-preview" id="${previewId}">
        <div class="ns-preview-sidebar">
          <div class="ns-preview-nav-item"></div>
          <div class="ns-preview-nav-item"></div>
          <div class="ns-preview-nav-item active"></div>
        </div>
        <div class="ns-preview-content">
          <div class="ns-preview-title"></div>
          <div class="ns-preview-block"></div>
          <div class="ns-preview-block short"></div>
        </div>
      </div>
      <div class="card-header">
        <div>
          <div class="card-name">${esc(item.name)}</div>
          <div class="card-meta">by ${esc(item.author_github)}${item.description ? ', ' + esc(item.description) : ''}</div>
        </div>
      </div>
      ${item.rejection_reason ? `<div class="rejection-reason-badge"><strong>Rejection reason</strong>${esc(item.rejection_reason)}</div>` : ''}
      <pre>${esc(item.css)}</pre>
    </div>
  `;
}

function rejectedPluginCard(item) {
  return `
    <div class="card" style="opacity:0.6">
      <div class="card-header">
        <div>
          <div class="card-name">${esc(item.name)}</div>
          <div class="card-meta">by ${esc(item.author_github)}${item.description ? ', ' + esc(item.description) : ''}</div>
        </div>
      </div>
      ${item.rejection_reason ? `<div class="rejection-reason-badge"><strong>Rejection reason</strong>${esc(item.rejection_reason)}</div>` : ''}
      <pre>${esc(item.js)}</pre>
    </div>
  `;
}

// version ids on this page, so a decision on one goes to the version, not the item
const versionTypes = {};

// a simple line diff: trims what's the same at both ends, then a longest-common-subsequence on the
// middle. Very large changes skip the LCS and show the old lines removed and the new ones added
function lineDiff(oldText, newText) {
  const a = String(oldText ?? '').split('\n');
  const b = String(newText ?? '').split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const out = a.slice(0, start).map(text => ({ op: ' ', text }));
  const midA = a.slice(start, endA), midB = b.slice(start, endB);
  if (midA.length * midB.length > 4_000_000) {
    midA.forEach(text => out.push({ op: '-', text }));
    midB.forEach(text => out.push({ op: '+', text }));
  } else {
    const n = midA.length, m = midB.length;
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { out.push({ op: ' ', text: midA[i] }); i++; j++; }
      else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ op: '-', text: midA[i++] });
      else out.push({ op: '+', text: midB[j++] });
    }
    while (i < n) out.push({ op: '-', text: midA[i++] });
    while (j < m) out.push({ op: '+', text: midB[j++] });
  }
  a.slice(endA).forEach(text => out.push({ op: ' ', text }));
  return out;
}

// changed lines with 3 lines of context, long unchanged stretches folded
function diffHtml(oldText, newText) {
  const lines = lineDiff(oldText, newText);
  const keep = lines.map(() => false);
  lines.forEach((l, i) => {
    if (l.op === ' ') return;
    for (let k = Math.max(0, i - 3); k <= Math.min(lines.length - 1, i + 3); k++) keep[k] = true;
  });
  if (!keep.some(Boolean)) return '<div class="diff-line">No changes to the code</div>';
  let html = '', skipped = 0;
  lines.forEach((l, i) => {
    if (!keep[i]) { skipped++; return; }
    if (skipped) { html += `<div class="diff-line diff-skip">${skipped} unchanged line${skipped === 1 ? '' : 's'}</div>`; skipped = 0; }
    const cls = l.op === '+' ? 'diff-add' : l.op === '-' ? 'diff-del' : '';
    html += `<div class="diff-line ${cls}">${l.op} ${esc(l.text)}</div>`;
  });
  if (skipped) html += `<div class="diff-line diff-skip">${skipped} unchanged line${skipped === 1 ? '' : 's'}</div>`;
  return html;
}

function versionCard(v) {
  versionTypes[v.id] = v.item_type;
  return `
    <div class="card" id="submission-${esc(v.id)}">
      <div class="card-header">
        <div>
          <div class="card-name">${esc(v.name || 'Unknown item')}, version ${esc(v.version)} (${esc(v.item_type)})</div>
          <div class="card-meta">by ${esc(v.author_github)}: ${esc(v.changelog)}</div>
        </div>
        <div class="card-actions" id="actions-${esc(v.id)}">
          <button class="btn-approve" data-id="${esc(v.id)}" data-type="${esc(v.item_type)}">Approve</button>
          <button class="btn-reject"  data-id="${esc(v.id)}" data-type="${esc(v.item_type)}">Reject</button>
        </div>
      </div>
      <div class="diff">${diffHtml(v.previous_code, v.code)}</div>
    </div>
  `;
}

const REPORT_LABELS = {
  harmful: 'Harmful or steals data',
  broken: "Doesn't work",
  offensive: 'Offensive',
  copyright: 'Copied without permission',
  spam: 'Spam',
  other: 'Something else',
};
const ACTION_LABELS = {
  approve: 'Approved',
  reject: 'Rejected',
  approve_version: 'Approved a version',
  reject_version: 'Rejected a version',
  hide: 'Hid',
  unhide: 'Unhid',
  auto_hide: 'Hid automatically',
  dismiss_report: 'Dismissed a report',
};

// hide / unhide / dismiss, with a fresh session like sendDecision
async function sendReview(body) {
  const { data: { session } } = await db.auth.refreshSession();
  const token = session?.access_token;
  if (!token) { alert('Session expired. Reload and sign in.'); return false; }
  const res = await fetch('/api/review/decide', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { alert(data.error ?? 'Something went wrong'); return false; }
  return true;
}

async function reviewAndReload(body, btn) {
  if (btn) btn.disabled = true;
  const ok = await sendReview(body);
  if (ok) { queueLoaded = false; await loadQueue(); }
  else if (btn) btn.disabled = false;
}

function reportsHtml(reports) {
  const byItem = new Map();
  for (const r of reports) {
    const key = `${r.item_type}:${r.item_id}`;
    if (!byItem.has(key)) byItem.set(key, []);
    byItem.get(key).push(r);
  }
  return [...byItem.values()].map(list => {
    const first = list[0];
    const hidden = first.item_status === 'hidden';
    const harmful = list.filter(r => r.reason === 'harmful').length;
    const summary = `${list.length} report${list.length === 1 ? '' : 's'}${harmful ? `, ${harmful} harmful` : ''}`;
    return `
      <div class="card" id="report-item-${esc(first.item_id)}">
        <div class="card-header">
          <div>
            <div class="card-name">${esc(first.name || 'Unknown item')} (${esc(first.item_type)})
              <span class="status-pill ${hidden ? 'hidden' : 'live'}">${hidden ? 'Hidden' : first.item_status === 'approved' ? 'Live' : esc(first.item_status || 'Gone')}</span>
            </div>
            <div class="card-meta">${esc(summary)}</div>
          </div>
          <div class="card-actions" id="actions-${esc(first.item_id)}">
            ${first.item_status === 'approved' ? `<button class="btn-reject" data-review="hide" data-type="${esc(first.item_type)}" data-id="${esc(first.item_id)}" data-why="${esc(summary)}">Hide</button>` : ''}
            ${hidden ? `<button class="btn-approve" data-review="unhide" data-type="${esc(first.item_type)}" data-id="${esc(first.item_id)}">Unhide</button>` : ''}
            ${first.item_status === 'approved' || hidden ? `<button class="btn-reject" data-review="reject" data-type="${esc(first.item_type)}" data-id="${esc(first.item_id)}">Reject</button>` : ''}
          </div>
        </div>
        ${list.map(r => `
          <div class="report-row">
            <div>
              <strong>${esc(REPORT_LABELS[r.reason] || r.reason)}</strong>
              <span class="card-meta">by ${esc(r.reporter_github)}, ${esc(new Date(r.created_at).toLocaleString())}${r.counts_for_hiding ? '' : ', new account'}</span>
              ${r.note ? `<div class="report-note">${esc(r.note)}</div>` : ''}
            </div>
            <button data-review="dismiss" data-report="${esc(r.id)}">Dismiss</button>
          </div>`).join('')}
      </div>`;
  }).join('');
}

function logHtml(actions, names) {
  if (!actions.length) return '<span class="empty">Nothing yet</span>';
  return `<div class="log-table">${actions.map(a => `
    <div class="log-row">
      <span class="log-when">${esc(new Date(a.created_at).toLocaleString())}</span>
      <span class="log-who">${esc(a.actor_github)}</span>
      <span class="log-what">${esc(ACTION_LABELS[a.action] || a.action)} ${a.item_type ? esc(a.item_type) + ' ' : ''}${esc(a.name || names.get(a.item_id) || (a.item_id ? String(a.item_id).slice(0, 8) : ''))}${a.reason ? `: ${esc(a.reason)}` : ''}</span>
    </div>`).join('')}</div>`;
}

document.addEventListener('click', e => {
  const btn = e.target.closest('[data-review]');
  if (!btn) return;
  const kind = btn.dataset.review;
  if (kind === 'hide') reviewAndReload({ action: 'hide', type: btn.dataset.type, id: btn.dataset.id, reason: `Reported (${btn.dataset.why})` }, btn);
  if (kind === 'unhide') reviewAndReload({ action: 'unhide', type: btn.dataset.type, id: btn.dataset.id }, btn);
  if (kind === 'dismiss') reviewAndReload({ action: 'dismiss_report', report_id: btn.dataset.report }, btn);
  if (kind === 'reject') startReject(btn.dataset.id, btn.dataset.type);
});

async function loadQueue() {
  dbg('loadQueue() entered, stack: ' + (new Error().stack ?? '').split('\n').slice(1, 5).join(' | '));
  if (queueLoaded) {
    if (document.querySelector('.rejection-form textarea')) { dbg('loadQueue() skipped, rejection form open'); return; }
    dbg('loadQueue() skipped, already loaded');
    return;
  }
  queueLoaded = true;
  const queueEl   = document.getElementById('queue');
  queueEl.style.display = 'block';
  const themesEl  = document.getElementById('themes-list');
  const pluginsEl = document.getElementById('plugins-list');

  let themes = [], plugins = [], rejectedThemes = [], rejectedPlugins = [], versions = [], reports = [], actions = [];
  try {
    const session = await db.auth.getSession();
    const token = session.data.session?.access_token;
    const res = await fetch('/api/review/pending', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (res.status === 403) {
      document.getElementById('unauthorized').style.display = 'block';
      queueEl.style.display = 'block';
      document.getElementById('review-tabs-area').style.display = 'none';
      themesEl.innerHTML = pluginsEl.innerHTML = '';
      return;
    }
    if (!res.ok) {
      themesEl.innerHTML = `<span class="empty">Server error (${res.status}), check the terminal for details.</span>`;
      pluginsEl.innerHTML = '';
      queueEl.style.display = 'block';
      return;
    }
    ({ themes, plugins, rejectedThemes, rejectedPlugins, versions = [], reports = [], actions = [] } = await res.json());
  } catch {
    themesEl.innerHTML = '<span class="empty">Couldn\'t reach the server.</span>';
    pluginsEl.innerHTML = '';
    queueEl.style.display = 'block';
    return;
  }

  dbg('loadQueue() about to overwrite themes-list innerHTML');
  themesEl.innerHTML = themes.length
    ? themes.map(themeCard).join('')
    : '<span class="empty">Nothing to review</span>';
  if (themes.length) {
    themes.forEach(t => applyThemePreview(`preview-${t.id}`, t.css));
    themesEl.querySelectorAll('.btn-approve').forEach(btn => btn.addEventListener('click', () => approve(btn.dataset.id, btn.dataset.type)));
    themesEl.querySelectorAll('.btn-reject').forEach(btn => btn.addEventListener('click', () => startReject(btn.dataset.id, btn.dataset.type)));
    themes.forEach(t => {
      if (t.rejection_reason && t.rejection_reason.startsWith('Auto-check failed:')) {
        startReject(t.id, 'theme');
        const ta = document.getElementById('reason-' + t.id);
        if (ta) {
          ta.value = t.rejection_reason;
          ta.dispatchEvent(new Event('input'));
        }
      }
    });
  }

  dbg('loadQueue() about to overwrite plugins-list innerHTML');
  pluginsEl.innerHTML = plugins.length
    ? plugins.map(pluginCard).join('')
    : '<span class="empty">Nothing to review</span>';
  if (plugins.length) {
    pluginsEl.querySelectorAll('.btn-approve').forEach(btn => btn.addEventListener('click', () => approve(btn.dataset.id, btn.dataset.type)));
    pluginsEl.querySelectorAll('.btn-reject').forEach(btn => btn.addEventListener('click', () => startReject(btn.dataset.id, btn.dataset.type)));
  }

  for (const type of ['theme', 'plugin']) {
    const mine = reports.filter(r => r.item_type === type);
    document.getElementById(`reports-section-${type}`).style.display = mine.length ? 'block' : 'none';
    document.getElementById(`reports-list-${type}`).innerHTML = reportsHtml(mine);
  }

  const names = new Map();
  [...themes, ...plugins, ...rejectedThemes, ...rejectedPlugins].forEach(i => names.set(i.id, i.name));
  versions.forEach(v => v.name && names.set(v.item_id, v.name));
  reports.forEach(r => r.name && names.set(r.item_id, r.name));
  document.getElementById('log-section').style.display = 'block';
  document.getElementById('log-list').innerHTML = logHtml(actions, names);

  for (const type of ['theme', 'plugin']) {
    const mine = versions.filter(v => v.item_type === type);
    const versionsEl = document.getElementById(`versions-list-${type}`);
    document.getElementById(`versions-section-${type}`).style.display = mine.length ? 'block' : 'none';
    versionsEl.innerHTML = mine.map(versionCard).join('');
    versionsEl.querySelectorAll('.btn-approve').forEach(btn => btn.addEventListener('click', () => approve(btn.dataset.id, btn.dataset.type)));
    versionsEl.querySelectorAll('.btn-reject').forEach(btn => btn.addEventListener('click', () => startReject(btn.dataset.id, btn.dataset.type)));
  }

  document.getElementById('rejected-section-theme').style.display = rejectedThemes.length ? 'block' : 'none';
  document.getElementById('rejected-themes-list').innerHTML = rejectedThemes.map(rejectedThemeCard).join('');
  rejectedThemes.forEach(t => applyThemePreview(`preview-rej-${t.id}`, t.css));
  document.getElementById('rejected-section-plugin').style.display = rejectedPlugins.length ? 'block' : 'none';
  document.getElementById('rejected-plugins-list').innerHTML = rejectedPlugins.map(rejectedPluginCard).join('');

  // a number on each tab for what needs a decision, so nothing waits unseen in the tab that isn't open
  const waiting = {
    theme: themes.length + new Set(reports.filter(r => r.item_type === 'theme').map(r => r.item_id)).size + versions.filter(v => v.item_type === 'theme').length,
    plugin: plugins.length + new Set(reports.filter(r => r.item_type === 'plugin').map(r => r.item_id)).size + versions.filter(v => v.item_type === 'plugin').length,
  };
  for (const type of ['theme', 'plugin']) {
    document.getElementById(`count-${type}`).textContent = waiting[type] ? String(waiting[type]) : '';
  }
}

function switchReviewTab(type) {
  for (const t of ['theme', 'plugin']) {
    document.getElementById(`pane-${t}`).hidden = t !== type;
    document.querySelector(`#review-tabs [data-tab="${t}"]`).classList.toggle('active', t === type);
  }
}

async function sendDecision(id, type, status, reason) {
  async function attempt() {
    const { data: { session } } = await db.auth.refreshSession();
    const token = session?.access_token;
    if (!token) return null;
    const res = await fetch('/api/review/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(versionTypes[id] ? { type, version_id: id, status, reason } : { type, id, status, reason }),
    });
    const data = await res.json();
    return { ok: res.ok, data };
  }

  let result = await attempt();
  if (result === null) {
    alert('Session expired. Reload and sign in.');
    return false;
  }
  if (!result.ok) {
    await new Promise(r => setTimeout(r, 500));
    result = await attempt();
    if (result === null || !result.ok) {
      alert(result?.data?.error ?? 'Something went wrong');
      return false;
    }
  }
  return true;
}

async function approve(id, type) {
  const actionsEl = document.getElementById('actions-' + id);
  actionsEl.querySelectorAll('button').forEach(b => b.disabled = true);
  const ok = await sendDecision(id, type, 'approved', null);
  if (ok) {
    queueLoaded = false;
    await loadQueue();
  } else {
    actionsEl.querySelectorAll('button').forEach(b => b.disabled = false);
  }
}

// Reject stays off until there is a reason
function rejectReasonInput(id, ev) {
  document.getElementById('confirm-reject-' + id).disabled = !ev.target.value.trim();
}

function startReject(id, type) {
  const actionsEl = document.getElementById('actions-' + id);
  actionsEl.innerHTML = `
    <div class="rejection-form">
      <textarea id="reason-${id}" placeholder="Reason for rejecting this" ${nsAct('input', 'rejectReasonInput', id)}></textarea>
      <div class="btn-row">
        <button class="btn-reject" id="confirm-reject-${id}" disabled ${nsAct('click', 'submitReject', id, type)}>Reject submission</button>
        <button ${nsAct('click', 'cancelReject', id, type)}>Cancel</button>
      </div>
    </div>
  `;
}

function cancelReject(id, type) {
  const actionsEl = document.getElementById('actions-' + id);
  actionsEl.innerHTML = `
    <button class="btn-approve" ${nsAct('click', 'approve', id, type)}>Approve</button>
    <button class="btn-reject" ${nsAct('click', 'startReject', id, type)}>Reject</button>
  `;
}

async function submitReject(id, type) {
  const reason = document.getElementById('reason-' + id)?.value.trim();
  if (!reason) return;
  const actionsEl = document.getElementById('actions-' + id);
  actionsEl.querySelectorAll('button').forEach(b => b.disabled = true);
  const ok = await sendDecision(id, type, 'rejected', reason);
  if (ok) {
    queueLoaded = false;
    await loadQueue();
  } else {
    actionsEl.querySelectorAll('button').forEach(b => b.disabled = false);
  }
}

db.auth.onAuthStateChange((event, session) => {
  dbg(`onAuthStateChange event=${event} hasUser=${!!session?.user} currentUser=${!!currentUser}`);
  const prevUser = currentUser;
  currentUser = session?.user ?? null;
  if (!session) hideReviewLink();
  if (event === 'SIGNED_OUT') {
    queueLoaded = false;
    showLogin();
  } else if (currentUser && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && prevUser === null) {
    dbg(`onAuthStateChange → calling showReview for event=${event}`);
    showReview(currentUser);
  }
  // TOKEN_REFRESHED: update currentUser silently, don't re-render the queue
});

if (window.location.hash) {
  history.replaceState(null, '', window.location.pathname);
}

nsActions({ openReleasesPage, switchReviewTab, approve, startReject, cancelReject, submitReject, rejectReasonInput });

checkUpdateBanner();
setInterval(checkUpdateBanner, 30000);
