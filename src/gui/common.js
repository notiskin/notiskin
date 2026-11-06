// Shared by Themes, Plugins, Settings and Review: loaded before each page's own script (and after
// /vendor/supabase.js). Everything here used to be copied into every page.

const SUPABASE_URL = 'https://rdsoztlxtbfwdjcfqhmt.supabase.co';
const SUPABASE_KEY = 'sb_publishable_4B-pmRj4FBVVqIsvlF1fjQ_Lzby0Yrq';

// PKCE: sign-in finishes in the default browser, which only gets a one-time code; the verifier
// that turns it into a session stays in this window's storage. Every page shares the session
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { flowType: 'pkce' } });

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// the GitHub identity, not user_metadata, which users can edit
function githubUsername(user) {
  return user?.identities?.find(i => i.provider === 'github')?.identity_data?.user_name || 'your GitHub account';
}

// Settings checks reviewer access once at sign-in and saves it, so the link shows instantly
try {
  if (JSON.parse(localStorage.getItem('notiskin.reviewer'))?.isReviewer) {
    document.getElementById('nav-review').style.display = '';
  }
} catch {}

// signed out: forget the saved reviewer access, Settings checks again at the next sign-in
function hideReviewLink() {
  try { localStorage.removeItem('notiskin.reviewer'); } catch {}
  document.getElementById('nav-review').style.display = 'none';
}

function showNotif(message) {
  const stack = document.getElementById('notif-stack');
  const el = document.createElement('div');
  el.className = 'notif';
  el.textContent = message;
  stack.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
  setTimeout(() => {
    el.classList.remove('show');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
  }, 2000);
}

// ---- links the app opens in the default browser (the server decides what is allowed) ----

const DOCS_URL = 'https://notiskin.github.io/notiskin/';

async function openExternal(url) {
  await fetch('/api/open-external', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
}

function openDocs(page) {
  return openExternal(DOCS_URL + page);
}

function openReleasesPage() {
  return openExternal('https://github.com/notiskin/notiskin/releases/latest');
}

// "Notiskin X is out" banner, shown on every page that has one
async function checkUpdateBanner() {
  try {
    const res = await fetch('/api/update-status');
    const status = await res.json();
    const banner = document.getElementById('update-banner');
    const bannerText = document.getElementById('banner-text');
    // installed by hand until Developer ID signing, see src/updater/index.ts
    if ((status.state === 'available' || status.state === 'ready') && banner && bannerText) {
      bannerText.textContent = `Notiskin ${status.version} is out`;
      banner.style.display = 'flex';
    }
  } catch {}
}

// ---- buttons and inputs without inline handlers ----
// The pages send a strict Content Security Policy, which refuses onclick="..." attributes. Markup
// names an action instead, and one listener per event type finds it:
//   <button data-click="switchTab" data-click-args='["browse"]'>
//   <input type="checkbox" data-change="togglePlugin" data-change-args='["my plugin"]'>
// A page registers its actions with nsActions({ switchTab, togglePlugin }). An action is called with
// the markup's arguments, then the event; `this` is the element. data-<type>-prevent also cancels
// the browser's default (a link opening, a form submitting). Like inline handlers, the action on the
// element closest to the click runs first, then the ones around it, until one calls
// event.stopPropagation(). Markup built in JavaScript uses nsAct() to write the attributes.
// The listeners sit on <body>, so they run before the pages' own document-level click listeners,
// like an inline handler did.

const nsHandlers = Object.create(null);

function nsActions(actions) {
  Object.assign(nsHandlers, actions);
}

function nsAct(type, name, ...args) {
  const argsAttr = args.length ? ` data-${type}-args="${esc(JSON.stringify(args))}"` : '';
  return `data-${type}="${esc(name)}"${argsAttr}`;
}

function nsRun(type, el, ev) {
  const name = el.getAttribute(`data-${type}`);
  const action = nsHandlers[name];
  if (!action) {
    console.error(`Notiskin: no action called "${name}"`);
    return;
  }
  if (el.hasAttribute(`data-${type}-prevent`)) ev.preventDefault();
  let args = [];
  try { args = JSON.parse(el.getAttribute(`data-${type}-args`) || '[]'); } catch {}
  return action.call(el, ...args, ev);
}

function nsDispatch(type, ev) {
  if (!(ev.target instanceof Element)) return;
  for (let el = ev.target.closest(`[data-${type}]`); el; el = el.parentElement?.closest(`[data-${type}]`)) {
    nsRun(type, el, ev);
    if (ev.cancelBubble) break;
  }
}

for (const type of ['click', 'change', 'input', 'submit']) {
  document.body.addEventListener(type, ev => nsDispatch(type, ev));
}
// mouseenter / mouseleave don't bubble, the capture phase still sees them on every element
for (const type of ['mouseenter', 'mouseleave']) {
  document.body.addEventListener(type, ev => {
    if (ev.target instanceof Element && ev.target.hasAttribute(`data-${type}`)) nsRun(type, ev.target, ev);
  }, true);
}

nsActions({
  // the container of a button that must not trigger what's around it (a card's own click)
  stop: (ev) => ev.stopPropagation(),
  stopAndPrevent: (ev) => { ev.stopPropagation(); ev.preventDefault(); },
});
