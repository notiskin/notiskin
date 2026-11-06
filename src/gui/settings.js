// shared helpers (esc, db, githubUsername, hideReviewLink, showNotif, openDocs, openReleasesPage) are in common.js

// checks reviewer access once per sign-in and saves it for every page.
// Cosmetic, the edge functions do the real check
let pendingReviewerCheck = null;

async function checkReviewer(session) {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('notiskin.reviewer')); } catch {}
  if (saved?.userId !== session.user.id) {
    // sign-in fires two events at once, share one request between them
    pendingReviewerCheck ??= fetch('/api/review/pending', {
      headers: { 'Authorization': `Bearer ${session.access_token}` },
    }).catch(() => null);
    const res = await pendingReviewerCheck;
    pendingReviewerCheck = null;
    if (!res || (res.status !== 200 && res.status !== 403)) return false;
    saved = { userId: session.user.id, isReviewer: res.ok };
    try { localStorage.setItem('notiskin.reviewer', JSON.stringify(saved)); } catch {}
  }
  document.getElementById('nav-review').style.display = saved.isReviewer ? '' : 'none';
  return saved.isReviewer;
}

// the one place to sign in and out, the other pages share the session
let accountSession = null;

async function renderAccount(session) {
  accountSession = session;
  const label = document.getElementById('account-label');
  const sub = document.getElementById('account-sub');
  const btn = document.getElementById('account-btn');
  btn.disabled = false;
  if (!session) {
    label.textContent = 'Not signed in';
    sub.textContent = 'Needed to publish and rate.';
    btn.textContent = 'Sign in with GitHub';
    hideReviewLink();
    return;
  }
  label.textContent = `Signed in as ${githubUsername(session.user)}`;
  sub.textContent = '';
  btn.textContent = 'Sign out';
  const isReviewer = await checkReviewer(session);
  if (isReviewer && accountSession === session && !label.querySelector('.account-badge')) {
    const badge = document.createElement('span');
    badge.className = 'account-badge';
    badge.textContent = 'Reviewer';
    label.appendChild(badge);
  }
}

// GitHub sign-in happens in the default browser (Google sign-in and passkeys don't work inside the
// app window). The browser lands on /auth/callback, the server holds the one-time code, we poll for it
let signInPoll = null;

function stopSignInPoll() {
  if (signInPoll) clearTimeout(signInPoll);
  signInPoll = null;
}

async function signInFailed(message) {
  stopSignInPoll();
  showNotif(message);
  renderAccount(null);
}

async function waitForBrowserSignIn() {
  let result;
  try {
    result = await fetch('/api/auth/result').then(r => r.json());
  } catch {
    return signInFailed("Can't reach Notiskin");
  }
  if (result.state === 'waiting') {
    signInPoll = setTimeout(waitForBrowserSignIn, 1500);
    return;
  }
  stopSignInPoll();
  if (result.state === 'done') {
    const { error } = await db.auth.exchangeCodeForSession(result.code);
    // success arrives through onAuthStateChange (SIGNED_IN)
    if (error) signInFailed('Sign in failed. Try again.');
    return;
  }
  if (result.state === 'failed') return signInFailed(result.error || 'Sign in was cancelled');
  if (result.state === 'expired') return signInFailed('Sign in took too long. Try again.');
  renderAccount(null);
}

async function toggleSignIn() {
  const btn = document.getElementById('account-btn');
  if (accountSession) {
    btn.disabled = true;
    await db.auth.signOut();
    return;
  }
  // a second click while waiting cancels
  if (signInPoll) {
    stopSignInPoll();
    await fetch('/api/auth/cancel', { method: 'POST' }).catch(() => {});
    renderAccount(null);
    return;
  }
  btn.textContent = 'Opening your browser';
  btn.disabled = true;
  const { data, error } = await db.auth.signInWithOAuth({
    provider: 'github',
    options: {
      redirectTo: window.location.origin + '/auth/callback',
      skipBrowserRedirect: true,
      // always show GitHub's account picker, so switching accounts works
      queryParams: { prompt: 'select_account' },
    },
  });
  if (error || !data?.url) return signInFailed('Sign in failed');
  const res = await fetch('/api/auth/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: data.url }),
  }).catch(() => null);
  if (!res || !res.ok) return signInFailed("Couldn't open your browser");
  btn.disabled = false;
  btn.textContent = 'Cancel';
  document.getElementById('account-label').textContent = 'Finish signing in in your browser';
  signInPoll = setTimeout(waitForBrowserSignIn, 1500);
}

db.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') renderAccount(session);
});

// onAuthStateChange alone misses an already stored session
db.auth.getSession().then(({ data: { session } }) => {
  renderAccount(session);
  if (window.location.hash) history.replaceState(null, '', window.location.pathname);
});

// Install into Notion: one button whose job depends on the status
const NOTION_STATES = {
  'not-installed': {
    badge: 'Not installed', tone: 'neutral', button: 'Install', action: 'install',
    sub: 'Notion needs a restart afterwards.',
  },
  'installed': {
    badge: 'Installed', tone: 'up-to-date', button: 'Uninstall', action: 'uninstall',
    sub: '',
  },
  'needs-repair': {
    badge: 'Needs repair', tone: 'available', button: 'Repair', action: 'install',
    sub: 'A Notion update or moving Notiskin switched this off. Repair it, then restart Notion.',
  },
  // installed, but by another copy of Notiskin (a source checkout or an older download)
  'other-copy': {
    badge: 'Needs repair', tone: 'available', button: 'Repair', action: 'install',
    sub: 'Notion is set up to use another copy of Notiskin. Repair to switch it to this one, then restart Notion.',
  },
  'unsupported': {
    badge: 'Not supported yet', tone: 'neutral', button: null,
    sub: "This version of Notion is built differently, so Notiskin can't theme it yet. Notion itself works as normal.",
  },
  'notion-missing': {
    badge: 'Notion not found', tone: 'error', button: null,
    sub: 'Put Notion in your Applications folder, then come back here.',
  },
};
const LOG_HINT = 'Details are in ~/.notiskin/logs/inject.log';
// error text often ends in a full stop already, avoid "Notion.app.."
const asClause = text => (text || 'something went wrong').replace(/[.\s]+$/, '');

let notionState = null;
let notionBusy = false;

function showNotionError(message, { settingsButton = false } = {}) {
  const el = document.getElementById('notion-error');
  el.textContent = message || '';
  el.style.display = message ? '' : 'none';
  document.getElementById('notion-settings-btn').style.display = message && settingsButton ? '' : 'none';
}

// plain words for why an install or uninstall failed
function notionFailure(action, data) {
  const verb = action === 'install' ? 'install into' : 'uninstall from';
  if (data?.reason === 'app-management') {
    const name = data.appName || 'Notiskin';
    return {
      message: `macOS blocked ${name} from changing Notion. Turn on ${name} under Privacy & Security → App Management, then try again. ` +
        `If it's already on, remove it with − and add it again.`,
      settingsButton: true,
    };
  }
  if (data?.reason === 'not-owner') {
    return { message: `Notion belongs to another account on this Mac, so Notiskin can't change it. Reinstall Notion by dragging it into Applications, then try again.` };
  }
  return { message: `Couldn't ${verb} Notion: ${asClause(data?.error)}. ${LOG_HINT}` };
}

async function openAppManagement() {
  try {
    const res = await fetch('/api/notion/app-management', { method: 'POST' });
    if ((await res.json()).ok) return;
  } catch {}
  showNotif('Open System Settings → Privacy & Security → App Management');
}

function renderNotion(status, unavailableReason, otherCopy = false) {
  notionState = NOTION_STATES[otherCopy ? 'other-copy' : status] ?? null;
  const badge = document.getElementById('notion-badge');
  const sub = document.getElementById('notion-sub');
  const btn = document.getElementById('notion-btn');
  if (!notionState) {
    badge.className = 'update-badge neutral';
    badge.textContent = 'Unavailable';
    sub.textContent = unavailableReason || 'Could not check Notion.';
    btn.style.display = 'none';
    return;
  }
  badge.className = `update-badge ${notionState.tone}`;
  badge.textContent = notionState.badge;
  sub.textContent = notionState.sub;
  btn.textContent = notionState.button ?? '';
  btn.style.display = notionState.button ? '' : 'none';
  btn.disabled = notionBusy;
}

async function loadNotionStatus() {
  if (notionBusy) return null;
  try {
    const res = await fetch('/api/notion/status');
    const data = await res.json();
    renderNotion(data.status, data.error, data.otherCopy === true);
    renderBlockNative(data);
    renderAutoRepair(data);
    return data;
  } catch {
    renderNotion(null, 'Could not check Notion.');
    renderBlockNative(null);
    renderAutoRepair(null);
    return null;
  }
}

// Notion is moving its Mac app to SwiftUI. While this is on, Notion's updater refuses an update that isn't
// Electron, because Notiskin can't theme that and there's no easy way back to the old app
let blockNativeOn = true;
let nativeBusy = false;

function renderBlockNative(data) {
  const row = document.getElementById('native-row');
  // only useful while Notion is still the Electron app Notiskin themes
  const relevant = data && typeof data.blockNative === 'boolean' && ['not-installed', 'installed', 'needs-repair'].includes(data.status);
  row.style.display = relevant ? 'flex' : 'none';
  if (!relevant || nativeBusy) return;
  blockNativeOn = data.blockNative;
  const badge = document.getElementById('native-badge');
  badge.className = `update-badge ${blockNativeOn ? 'up-to-date' : 'neutral'}`;
  badge.textContent = blockNativeOn ? 'On' : 'Off';
  document.getElementById('native-sub').textContent = blockNativeOn
    ? 'Notion still updates, but refuses a version Notiskin can\'t theme, such as the SwiftUI Notion.'
    : 'Notion installs every update, including ones Notiskin can\'t theme. There\'s no easy way back.';
  const btn = document.getElementById('native-btn');
  btn.textContent = blockNativeOn ? 'Turn off' : 'Turn on';
  btn.disabled = notionBusy;
}

async function toggleBlockNative() {
  if (nativeBusy || notionBusy) return;
  const on = !blockNativeOn;
  const btn = document.getElementById('native-btn');
  nativeBusy = true;
  btn.disabled = true;
  btn.textContent = on ? 'Turning on...' : 'Turning off...';
  showNotionError('');
  let data = null;
  try {
    const res = await fetch('/api/notion/block-native', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on }),
    });
    data = await res.json();
  } catch {}
  nativeBusy = false;
  if (data?.ok) {
    showNotif(data.applied ? 'Saved, applies after Notion restarts' : 'Saved');
  } else if (data && typeof data.blockNative === 'boolean') {
    // saved, but Notion couldn't be re-signed yet. The app retries when it next starts
    const failure = notionFailure('install', data);
    showNotionError(`Saved, but Notion wasn't re-signed yet. ${failure.message}`, { settingsButton: failure.settingsButton });
  } else {
    showNotif('Could not change this setting');
  }
  await loadNotionStatus();
}

// the watcher: a background process that repairs Notion after its updates, even with Notiskin closed. Off by default
let autoRepairOn = false;
let repairBusy = false;

function renderAutoRepair(data) {
  const row = document.getElementById('repair-row');
  const relevant = data && data.autoRepairAvailable === true && typeof data.autoRepair === 'boolean' &&
    ['not-installed', 'installed', 'needs-repair'].includes(data.status);
  row.style.display = relevant ? 'flex' : 'none';
  if (!relevant || repairBusy) return;
  autoRepairOn = data.autoRepair;
  const badge = document.getElementById('repair-badge');
  badge.className = `update-badge ${autoRepairOn ? 'up-to-date' : 'neutral'}`;
  badge.textContent = autoRepairOn ? 'On' : 'Off';
  document.getElementById('repair-sub').textContent = autoRepairOn
    ? 'Runs in the background, even when Notiskin is closed.'
    : 'After a Notion update, open Notiskin and click Repair.';
  const btn = document.getElementById('repair-btn');
  btn.textContent = autoRepairOn ? 'Turn off' : 'Turn on';
  btn.disabled = notionBusy;
}

async function toggleAutoRepair() {
  if (repairBusy || notionBusy) return;
  const on = !autoRepairOn;
  const btn = document.getElementById('repair-btn');
  repairBusy = true;
  btn.disabled = true;
  btn.textContent = on ? 'Turning on...' : 'Turning off...';
  let data = null;
  try {
    const res = await fetch('/api/notion/auto-repair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on }),
    });
    data = await res.json();
  } catch {}
  repairBusy = false;
  if (!data?.ok) showNotif('Could not change this setting');
  else if (on && !data.running) showNotif('Saved, starts once Notion is installed from this app');
  else showNotif(on ? 'Turned on' : 'Turned off, nothing runs in the background');
  await loadNotionStatus();
}

function showRestartOffer(message) {
  document.getElementById('notion-restart-sub').textContent = message;
  document.getElementById('notion-restart-row').style.display = 'flex';
}

function hideRestartOffer() {
  document.getElementById('notion-restart-row').style.display = 'none';
}

async function runNotionAction() {
  if (!notionState?.action || notionBusy) return;
  const action = notionState.action;
  const btn = document.getElementById('notion-btn');
  notionBusy = true;
  btn.disabled = true;
  btn.textContent = { install: notionState.button === 'Repair' ? 'Repairing...' : 'Installing...', uninstall: 'Uninstalling...' }[action];
  showNotionError('');
  hideRestartOffer();
  let data = null;
  try {
    const res = await fetch(`/api/notion/${action}`, { method: 'POST' });
    data = await res.json();
  } catch {}
  notionBusy = false;

  if (!data?.ok) {
    const failure = notionFailure(action, data);
    showNotionError(failure.message, { settingsButton: failure.settingsButton });
  } else {
    showNotif(action === 'install' ? 'Installed into Notion' : 'Removed from Notion');
  }
  const status = await loadNotionStatus();
  if (!data?.ok) return;
  // quitting Notion closes the user's windows, so only offer it, never do it on its own
  if (status?.notionRunning) {
    showRestartOffer(
      action === 'install'
        ? 'Your theme loads after Notion restarts. This closes your Notion windows.'
        : 'Notion keeps the theme until it restarts. This closes your Notion windows.'
    );
  } else if (action === 'install') {
    showNotif('Open Notion and your theme will load');
  }
}

async function restartNotion() {
  const btn = document.getElementById('notion-restart-btn');
  btn.disabled = true;
  btn.textContent = 'Restarting...';
  let data = null;
  try {
    const res = await fetch('/api/notion/restart', { method: 'POST' });
    data = await res.json();
  } catch {}
  btn.disabled = false;
  btn.textContent = 'Restart Notion';
  if (data?.ok) {
    hideRestartOffer();
    showNotif('Notion restarted');
  } else {
    showNotionError(`Couldn't restart Notion: ${asClause(data?.error)}. Quit and reopen it yourself.`);
  }
}

loadNotionStatus();
// a Notion update or a CLI patch can change things while Settings is open
window.addEventListener('focus', () => loadNotionStatus());

// Safe mode: one switch, the injector stops sending anything while it's on
let safeModeOn = false;

function renderSafeMode(on) {
  safeModeOn = on;
  const badge = document.getElementById('safe-badge');
  badge.className = `update-badge ${on ? 'available' : 'neutral'}`;
  badge.textContent = on ? 'On' : 'Off';
  document.getElementById('safe-sub').textContent = on
    ? 'Themes and plugins are paused.'
    : 'For when a plugin breaks Notion. Nothing is deleted.';
  const btn = document.getElementById('safe-btn');
  btn.textContent = on ? 'Turn off' : 'Turn on';
  btn.disabled = false;
}

async function loadSafeMode() {
  try {
    const status = await fetch('/api/status').then(r => r.json());
    renderSafeMode(Boolean(status.safeMode));
  } catch {}
}

async function toggleSafeMode() {
  const btn = document.getElementById('safe-btn');
  const on = !safeModeOn;
  btn.disabled = true;
  btn.textContent = on ? 'Turning on...' : 'Turning off...';
  let data = null;
  try {
    const res = await fetch('/api/safe-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on }),
    });
    data = await res.json();
  } catch {}
  if (!data?.ok) {
    renderSafeMode(safeModeOn);
    showNotif('Could not change safe mode');
    return;
  }
  renderSafeMode(data.safeMode);
  showNotif(on ? 'Safe mode on' : 'Safe mode off');
}

loadSafeMode();

// Developer mode: plugins run from a folder, saving a file reloads Notion's tabs
let developer = { enabled: false, folder: '' };

function renderDeveloper(data) {
  developer = data;
  const badge = document.getElementById('dev-badge');
  badge.textContent = data.enabled ? 'On' : 'Off';
  badge.className = `update-badge ${data.enabled ? 'up-to-date' : 'neutral'}`;
  const btn = document.getElementById('dev-btn');
  btn.textContent = data.enabled ? 'Turn off' : 'Turn on';
  btn.disabled = false;
  const folderRow = document.getElementById('dev-folder-row');
  folderRow.style.display = data.enabled || data.folder ? '' : 'none';
  const input = document.getElementById('dev-folder');
  if (document.activeElement !== input) input.value = data.folder || '';
  const error = document.getElementById('dev-error');
  error.style.display = data.error ? '' : 'none';
  error.textContent = data.error || '';
  const files = document.getElementById('dev-files');
  if (!data.enabled) {
    files.textContent = '';
  } else {
    const found = data.plugins.length;
    const skipped = (data.skipped || []).map(s => `${s.file}: ${s.reason}`);
    files.textContent = `${found} plugin${found === 1 ? '' : 's'} running from this folder.` + (skipped.length ? ` Skipped: ${skipped.join('; ')}.` : '');
  }
}

async function loadDeveloper() {
  try {
    renderDeveloper(await (await fetch('/api/developer')).json());
  } catch {
    document.getElementById('dev-sub').textContent = "Can't reach Notiskin.";
  }
}

async function postDeveloper(body) {
  const res = await fetch('/api/developer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (data.error) {
    showNotif(data.error);
    return false;
  }
  renderDeveloper(data);
  return true;
}

async function toggleDeveloper() {
  const btn = document.getElementById('dev-btn');
  if (developer.enabled) {
    btn.disabled = true;
    if (await postDeveloper({ enabled: false })) showNotif('Developer mode off, Notion reloaded');
    btn.disabled = false;
    return;
  }
  const folder = document.getElementById('dev-folder').value.trim() || developer.folder;
  if (!folder) {
    // the folder comes first
    document.getElementById('dev-folder-row').style.display = '';
    document.getElementById('dev-folder').focus();
    showNotif('Choose the plugins folder first');
    return;
  }
  if (!window.confirm('Every .js file in this folder will run inside Notion with full access to it and your pages, and Notion reloads each time you save one. Only use a folder you control.\n\nTurn on developer mode?')) return;
  btn.disabled = true;
  if (await postDeveloper({ enabled: true, folder })) showNotif('Developer mode on, Notion reloaded');
  btn.disabled = false;
}

async function saveDeveloperFolder() {
  const folder = document.getElementById('dev-folder').value.trim();
  if (await postDeveloper({ folder })) showNotif(developer.enabled ? 'Folder changed, Notion reloaded' : 'Folder saved');
}

async function chooseDeveloperFolder() {
  const res = await (await fetch('/api/developer/choose-folder', { method: 'POST' })).json();
  if (res.unsupported) { showNotif('Type the folder path instead'); document.getElementById('dev-folder').focus(); return; }
  if (res.error) { showNotif(res.error); return; }
  if (!res.folder) return;
  document.getElementById('dev-folder').value = res.folder;
  await saveDeveloperFolder();
}

loadDeveloper();

// the count of plugins and skipped files changes as files are saved, so look again while developer mode is on
setInterval(async () => {
  if (document.hidden || !developer.enabled) return;
  try {
    const data = await (await fetch('/api/developer')).json();
    if (!data.error) renderDeveloper(data);
  } catch { /* the next look tries again */ }
}, 4000);

// Diagnostics: built on request, already redacted by the server
async function loadDiagnostics() {
  const btn = document.getElementById('diag-btn');
  const report = document.getElementById('diag-report');
  btn.disabled = true;
  btn.textContent = 'Loading...';
  try {
    const data = await fetch('/api/diagnostics').then(r => r.json());
    report.textContent = data.report || 'No report available.';
    document.getElementById('diag-copy-btn').style.display = '';
  } catch {
    report.textContent = 'Could not build the report.';
  }
  report.style.display = '';
  btn.disabled = false;
  btn.textContent = 'Refresh';
}

async function copyDiagnostics() {
  const text = document.getElementById('diag-report').textContent;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // older clipboard route, works without clipboard permission
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  showNotif('Diagnostics copied');
}

const stateLabels = {
  'checking':    'Checking...',
  'up-to-date':  'Up to date',
  'available':   'Update available',
  'downloading': 'Downloading...',
  'ready':       'Ready to install',
  'error':       "Couldn't check",
};

fetch('/api/version')
  .then(r => r.json())
  .then(({ version }) => {
    document.getElementById('current-version').textContent = `Notiskin ${version}`;
  });

async function loadUpdateStatus() {
  try {
    const res = await fetch('/api/update-status');
    const status = await res.json();
    applyStatus(status);
  } catch {}
}

function applyStatus(status) {
  const badge = document.getElementById('update-badge');
  const installRow = document.getElementById('install-row');
  const installLabel = document.getElementById('install-version-label');
  const banner = document.getElementById('update-banner');
  const bannerText = document.getElementById('banner-text');

  badge.className = `update-badge ${status.state}`;
  badge.textContent = stateLabels[status.state] ?? status.state;
  document.getElementById('update-check-btn').style.display = status.state === 'checking' ? 'none' : '';

  // installed by hand until Developer ID signing, see src/updater/index.ts
  if (status.state === 'available' || status.state === 'ready') {
    installRow.style.display = 'flex';
    installLabel.textContent = `Notiskin ${status.version} is out`;
    if (banner && bannerText) {
      bannerText.textContent = `Notiskin ${status.version} is out`;
      banner.style.display = 'flex';
    }
  } else {
    installRow.style.display = 'none';
    if (banner) banner.style.display = 'none';
  }
}

async function checkForUpdates() {
  applyStatus({ state: 'checking' });
  try {
    await fetch('/api/update/check', { method: 'POST' });
  } catch {}
  // the check takes a moment, the answer comes from the status
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const status = await fetch('/api/update-status').then(r => r.json()).catch(() => null);
    if (status && status.state !== 'checking') return applyStatus(status);
  }
  loadUpdateStatus();
}

async function installUpdate() {
  await fetch('/api/update/install', { method: 'POST' });
}

async function clearCache(type) {
  const res = await fetch(`/api/cache/${type}`, { method: 'DELETE' });
  if (res.ok) {
    showNotif(`${type.charAt(0).toUpperCase() + type.slice(1)} cache cleared`);
  } else {
    showNotif('Something went wrong');
  }
}

nsActions({
  startTour: () => window.notiskinTour?.start(),
  toggleSignIn, openAppManagement, toggleBlockNative, toggleAutoRepair, runNotionAction, restartNotion,
  toggleSafeMode, toggleDeveloper, saveDeveloperFolder, chooseDeveloperFolder, loadDiagnostics, copyDiagnostics,
  checkForUpdates, clearCache, openDocs, openReleasesPage,
});

loadUpdateStatus();
setInterval(loadUpdateStatus, 30000);
