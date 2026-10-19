// Welcome tour: a card that points at one control at a time, across the Themes, Plugins and Settings pages.
// Progress lives in sessionStorage: it survives the page changes and is gone when the window closes,
// so a tour left half-way starts over next launch instead of popping up on some later visit. Finishing or skipping tells the server
// (setupDone in the config), so the tour never starts on its own again. Settings → Help replays it.
(() => {
  const KEY = 'notiskin.tour';

  const section = id => () => document.getElementById(id)?.closest('.settings-section');

  // target: a selector or a function returning the element to point at, none means a centered card
  const STEPS = [
    {
      page: '/',
      title: 'Welcome to Notiskin',
      text: 'Notiskin adds themes and plugins to the Notion desktop app. It changes how Notion looks and works on this Mac, never your pages. This quick tour shows where everything is.',
      next: 'Show me around',
    },
    {
      page: '/',
      target: '#themes-list',
      before: () => window.switchTab?.('installed'),
      title: 'Your themes',
      text: 'Pick a theme and Notion changes right away. "No theme" puts Notion back to normal.',
    },
    {
      page: '/',
      target: '.tab-btn[data-tab="browse"]',
      title: 'Browse',
      text: 'Themes other people made. Installing one adds it to Your themes, it doesn\'t switch to it.',
    },
    {
      page: '/',
      target: '.tab-btn[data-tab="publish"]',
      title: 'Publish and Submissions',
      text: 'Share a theme you made. A reviewer checks every submission before anyone can install it, and Submissions shows where yours are.',
    },
    {
      page: '/',
      target: '.sidebar-link[href="/plugins.html"]',
      title: 'Plugins',
      text: 'Plugins add features to Notion with JavaScript. They have the same tabs: your plugins, Browse, Publish, and Submissions.',
    },
    {
      page: '/plugins.html',
      target: '#plugins-list',
      before: () => window.switchTab?.('installed'),
      title: 'Turning plugins on',
      text: 'Each installed plugin has a switch. A plugin can do anything Notion can, so only turn on plugins you trust.',
    },
    {
      page: '/settings.html',
      target: section('safe-btn'),
      title: 'Safe mode',
      text: 'If a theme or plugin breaks Notion, turn this on. Everything pauses at once, and your choices are kept for when you turn it off.',
    },
    {
      page: '/settings.html',
      target: section('account-btn'),
      title: 'Account',
      text: 'Sign in with GitHub to publish, rate, and see your submissions. You don\'t need an account to install themes.',
    },
    {
      page: '/settings.html',
      target: section('diag-btn'),
      title: 'Diagnostics',
      text: 'Something not working? Copy this report into a bug report. Notion links, page IDs, and your Mac username are hidden.',
    },
    {
      page: '/settings.html',
      target: section('notion-btn'),
      title: 'Install into Notion',
      text: 'One step left: Install makes your theme load every time Notion starts. macOS may ask you to allow Notiskin under App Management first, a button for that appears here when needed. After a Notion update, come back and click Repair.',
      next: 'Done',
    },
  ];

  let root = null;
  let current = -1;
  let timer = null;

  function saved() {
    try {
      const step = JSON.parse(sessionStorage.getItem(KEY))?.step;
      return Number.isInteger(step) && step >= 0 && step < STEPS.length ? step : null;
    } catch {
      return null;
    }
  }

  function save(step) {
    try { sessionStorage.setItem(KEY, JSON.stringify({ step })); } catch {}
  }

  function go(index) {
    save(index);
    if (STEPS[index].page !== location.pathname) {
      location.href = STEPS[index].page;
      return;
    }
    show(index);
  }

  function finish() {
    try { sessionStorage.removeItem(KEY); } catch {}
    close();
    fetch('/api/setup-done', { method: 'POST' }).catch(() => {});
  }

  function close() {
    clearInterval(timer);
    document.removeEventListener('keydown', onKey, true);
    root?.remove();
    root = null;
    current = -1;
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); finish(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft' && current > 0) { e.preventDefault(); go(current - 1); }
  }

  function next() {
    if (current >= STEPS.length - 1) finish();
    else go(current + 1);
  }

  function targetOf(step) {
    if (!step.target) return null;
    const el = typeof step.target === 'function' ? step.target() : document.querySelector(step.target);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return rect.width && rect.height ? el : null;
  }

  function button(label, className, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function build() {
    const style = document.createElement('style');
    style.textContent = `
      #notiskin-tour { position: fixed; inset: 0; z-index: 10000; font-family: inherit; }
      #notiskin-tour .tour-blocker { position: absolute; inset: 0; }
      #notiskin-tour .tour-blocker.dim { background: rgba(0, 0, 0, 0.62); }
      #notiskin-tour .tour-spot {
        position: fixed; border-radius: 8px; pointer-events: none;
        box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.62); outline: 2px solid #6366f1; outline-offset: 0;
        transition: top 0.2s, left 0.2s, width 0.2s, height 0.2s;
      }
      #notiskin-tour .tour-card {
        position: fixed; width: 300px; box-sizing: border-box; padding: 16px;
        background: #1a1a1a; border: 1px solid #333; border-radius: 10px; color: #e0e0e0;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
      }
      #notiskin-tour .tour-title { font-size: 14px; font-weight: 700; margin: 0 0 6px; }
      #notiskin-tour .tour-text { font-size: 13px; line-height: 1.5; color: #bbb; margin: 0 0 14px; }
      #notiskin-tour .tour-footer { display: flex; align-items: center; gap: 8px; }
      #notiskin-tour .tour-count { font-size: 11px; color: #666; margin-right: auto; }
      #notiskin-tour button { font-size: 12px; padding: 5px 12px; border-radius: 6px; cursor: pointer; }
      #notiskin-tour .tour-skip { background: none; border: none; color: #777; padding: 5px 4px; }
      #notiskin-tour .tour-skip:hover { color: #bbb; }
      #notiskin-tour .tour-back { background: #1c1c1c; border: 1px solid #333; color: #e0e0e0; }
      #notiskin-tour .tour-back:hover { background: #252525; }
      #notiskin-tour .tour-next { background: #6366f1; border: 1px solid #6366f1; color: #fff; }
      #notiskin-tour .tour-next:hover { background: #575ae6; }
    `;

    root = document.createElement('div');
    root.id = 'notiskin-tour';
    // the page underneath can't be clicked while the tour is open, Skip or Esc closes it
    const blocker = document.createElement('div');
    blocker.className = 'tour-blocker';
    const spot = document.createElement('div');
    spot.className = 'tour-spot';
    const card = document.createElement('div');
    card.className = 'tour-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'tour-title');
    card.innerHTML = `
      <h3 class="tour-title" id="tour-title"></h3>
      <p class="tour-text"></p>
      <div class="tour-footer"><span class="tour-count"></span></div>
    `;
    root.append(style, blocker, spot, card);
    document.body.appendChild(root);
    document.addEventListener('keydown', onKey, true);
    // lists load after the page does and Settings can scroll, so keep the card next to its target
    timer = setInterval(place, 250);
    window.addEventListener('resize', place);
  }

  function show(index) {
    const step = STEPS[index];
    try { step.before?.(); } catch {}
    if (!root) build();
    current = index;

    const card = root.querySelector('.tour-card');
    card.querySelector('.tour-title').textContent = step.title;
    card.querySelector('.tour-text').textContent = step.text;
    card.querySelector('.tour-count').textContent = `${index + 1} of ${STEPS.length}`;

    const footer = card.querySelector('.tour-footer');
    footer.querySelectorAll('button').forEach(b => b.remove());
    const isLast = index === STEPS.length - 1;
    if (!isLast) footer.append(button('Skip tour', 'tour-skip', finish));
    if (index > 0) footer.append(button('Back', 'tour-back', () => go(index - 1)));
    const nextBtn = button(step.next || 'Next', 'tour-next', next);
    footer.append(nextBtn);

    targetOf(step)?.scrollIntoView({ block: 'center' });
    place();
    nextBtn.focus();
  }

  function place() {
    if (!root || current < 0) return;
    const el = targetOf(STEPS[current]);
    const blocker = root.querySelector('.tour-blocker');
    const spot = root.querySelector('.tour-spot');
    const card = root.querySelector('.tour-card');
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const gap = 14;

    if (!el) {
      blocker.classList.add('dim');
      spot.style.display = 'none';
      card.style.left = `${Math.max(16, (vw - cw) / 2)}px`;
      card.style.top = `${Math.max(16, (vh - ch) / 2)}px`;
      return;
    }

    blocker.classList.remove('dim');
    spot.style.display = '';
    const r = el.getBoundingClientRect();
    const pad = 6;
    // a long list would cover the whole window, only light up what's on screen
    const top = Math.max(r.top - pad, 8);
    const bottom = Math.min(r.bottom + pad, vh - 8);
    spot.style.left = `${r.left - pad}px`;
    spot.style.top = `${top}px`;
    spot.style.width = `${r.width + pad * 2}px`;
    spot.style.height = `${Math.max(bottom - top, 0)}px`;

    // right of the target if it fits, else below, above, then left
    let left;
    let y;
    if (r.right + pad + gap + cw <= vw - 16) {
      left = r.right + pad + gap;
      y = top;
    } else if (bottom + gap + ch <= vh - 16) {
      left = r.left;
      y = bottom + gap;
    } else if (top - gap - ch >= 16) {
      left = r.left;
      y = top - gap - ch;
    } else {
      left = r.left - pad - gap - cw;
      y = top;
    }
    card.style.left = `${Math.min(Math.max(left, 16), vw - cw - 16)}px`;
    card.style.top = `${Math.min(Math.max(y, 16), vh - ch - 16)}px`;
  }

  async function init() {
    const step = saved();
    if (step !== null && STEPS[step].page === location.pathname) {
      show(step);
      return;
    }
    // the app opens on Themes, so that's the only page the tour starts from on its own
    if (location.pathname !== '/') return;
    try {
      const res = await fetch('/api/setup');
      if (res.ok && (await res.json()).showTour) go(0);
    } catch {}
  }

  window.notiskinTour = { start: () => go(0) };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
