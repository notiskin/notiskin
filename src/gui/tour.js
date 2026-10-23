// Welcome tour: a card that points at one control at a time, across the Themes, Plugins and Settings pages.
// Progress lives in sessionStorage: it survives the page changes and is gone when the window closes,
// so a tour left half-way starts over next launch instead of popping up on some later visit. Finishing or closing
// tells the server (setupDone in the config), so the tour never starts on its own again. Settings → Help replays it.
(() => {
  const KEY = 'notiskin.tour';
  const MOVE_MS = 520;
  const EASE = 'cubic-bezier(0.65, 0, 0.35, 1)';
  const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // the settings row holding a control: its label and button, not the whole section around it
  const row = id => () => document.getElementById(id)?.closest('.settings-row');

  // target: a selector or a function returning the element to point at, none means a centered card.
  // fit 'content' hugs what's inside the element (text, cards, buttons) instead of its full box
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
      fit: 'content',
      before: () => window.switchTab?.('installed'),
      title: 'Your themes',
      text: 'Pick a theme and Notion changes right away. "No theme" puts Notion back to normal. When a theme you installed gets a new version, an Update button shows up on it.',
    },
    {
      page: '/',
      target: '#new-theme-btn',
      fit: 'content',
      before: () => window.switchTab?.('installed'),
      title: 'Make your own theme',
      text: 'New theme opens an editor with a color picker for each part of Notion. Notion shows your changes live while you pick, and goes back when you close the editor. Edit on any theme card opens that theme the same way, and Save and publish sends it to the marketplace.',
    },
    {
      page: '/',
      target: '.tab-btn[data-tab="browse"]',
      fit: 'content',
      title: 'Browse',
      text: 'Themes other people made. Sort by newest, top rated or most downloaded, and filter by tag. Installing one adds it to Your themes, it doesn\'t switch to it. If something looks wrong, Report sends it to a reviewer.',
    },
    {
      page: '/',
      target: '.tab-btn[data-tab="publish"]',
      fit: 'content',
      title: 'Publish and Submissions',
      text: 'Share a theme you made, and publish new versions of it later. A reviewer checks every submission before anyone can install it, and Submissions shows where yours are.',
    },
    {
      page: '/',
      target: '.sidebar-link[href="/plugins.html"]',
      fit: 'content',
      title: 'Plugins',
      text: 'Plugins add features to Notion with JavaScript. They have the same tabs: your plugins, Browse, Publish, and Submissions.',
    },
    {
      page: '/plugins.html',
      target: '#plugins-list',
      fit: 'content',
      before: () => window.switchTab?.('installed'),
      title: 'Turning plugins on',
      text: 'Each installed plugin has a switch. A plugin can do anything Notion can, so only turn on plugins you trust.',
    },
    {
      page: '/settings.html',
      target: row('safe-btn'),
      fit: 'content',
      title: 'Safe mode',
      text: 'If a theme or plugin breaks Notion, turn this on. Everything pauses at once, and your choices are kept for when you turn it off.',
    },
    {
      page: '/settings.html',
      target: row('account-btn'),
      fit: 'content',
      title: 'Account',
      text: 'Sign in with GitHub to publish, rate, and see your submissions. You don\'t need an account to install themes.',
    },
    {
      page: '/settings.html',
      target: row('diag-btn'),
      fit: 'content',
      title: 'Diagnostics',
      text: 'Something not working? Copy this report into a bug report. Notion links, page IDs, and your Mac username are hidden.',
    },
    {
      page: '/settings.html',
      target: row('native-btn'),
      fit: 'content',
      title: 'Notion updates',
      text: 'Notion is rebuilding its Mac app, and Notiskin can\'t theme the new one. While this is on, Notion keeps updating but holds that version back, since there\'s no easy way back once it\'s installed.',
    },
    {
      page: '/settings.html',
      target: row('repair-btn'),
      fit: 'content',
      title: 'Repairing after Notion updates',
      text: 'A Notion update switches Notiskin off until you click Repair. Turn this on and a small helper runs in the background to do that for you. It\'s off by default, so nothing runs when Notiskin is closed.',
    },
    {
      page: '/settings.html',
      target: row('notion-btn'),
      fit: 'content',
      title: 'Install into Notion',
      text: 'One step left: Install makes your theme load every time Notion starts. macOS may ask you to allow Notiskin under App Management first, a button for that appears here when needed. After a Notion update, come back and click Repair.',
      next: 'Done',
    },
  ];

  let root = null;
  let current = -1;
  // while a step change is still gliding, layout updates keep animating instead of snapping
  let movingUntil = 0;
  // presses that arrive while a step is still moving are ignored, so each click is exactly one step
  let lockedUntil = 0;
  let leaving = false;
  let shown = false;
  let frame = 0;
  let observer = null;
  let targetSize = null;
  let targetContent = null;
  let swapTimer = 0;

  function saved() {
    try {
      const state = JSON.parse(sessionStorage.getItem(KEY));
      const step = state?.step;
      return Number.isInteger(step) && step >= 0 && step < STEPS.length ? state : null;
    } catch {
      return null;
    }
  }

  function save(step, from) {
    try { sessionStorage.setItem(KEY, JSON.stringify({ step, from })); } catch {}
  }

  // where the box and card are right now, so the next page can start the glide from the same spot
  function snapshot() {
    if (!root) return undefined;
    const s = root.querySelector('.tour-spot').getBoundingClientRect();
    const c = root.querySelector('.tour-card').getBoundingClientRect();
    const r = parseFloat(getComputedStyle(root.querySelector('.tour-spot')).borderTopLeftRadius) || 8;
    return { x: s.left, y: s.top, w: s.width, h: s.height, r, cx: c.left, cy: c.top };
  }

  function go(index) {
    lockedUntil = performance.now() + 380;
    if (STEPS[index].page !== location.pathname) {
      save(index, snapshot());
      leaving = true;
      location.href = STEPS[index].page;
      return;
    }
    save(index);
    show(index);
  }

  function move(delta) {
    if (leaving || current < 0 || performance.now() < lockedUntil) return;
    const to = current + delta;
    if (to < 0) return;
    if (to >= STEPS.length) finish();
    else go(to);
  }

  function finish() {
    try { sessionStorage.removeItem(KEY); } catch {}
    close();
    fetch('/api/setup-done', { method: 'POST' }).catch(() => {});
  }

  function close() {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('scroll', schedule, true);
    window.removeEventListener('resize', schedule);
    observer?.disconnect();
    targetSize?.disconnect();
    targetContent?.disconnect();
    cancelAnimationFrame(frame);
    clearTimeout(swapTimer);
    const old = root;
    root = null;
    current = -1;
    shown = false;
    if (!old) return;
    old.classList.remove('open');
    setTimeout(() => old.remove(), reduceMotion() ? 0 : 220);
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); finish(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1); }
  }

  function elementOf(step) {
    if (!step.target) return null;
    return (typeof step.target === 'function' ? step.target() : document.querySelector(step.target)) || null;
  }

  // the box to light up, in viewport pixels, or null for a centered card
  function measure(step) {
    const el = elementOf(step);
    if (!el) return null;
    let r = el.getBoundingClientRect();
    let padX = 4;
    let padY = 4;
    let radius = (parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0) + 4;
    if (step.fit === 'content') {
      const range = document.createRange();
      range.selectNodeContents(el);
      const inner = range.getBoundingClientRect();
      if (inner.width && inner.height) r = inner;
      padX = 8;
      padY = 6;
      radius = 10;
    }
    if (!r.width || !r.height) return null;
    return { el, x: r.left - padX, y: r.top - padY, w: r.width + padX * 2, h: r.height + padY * 2, r: Math.max(radius, 6) };
  }

  function button(label, className, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function build(from) {
    const style = document.createElement('style');
    const move = `${MOVE_MS}ms ${EASE}`;
    style.textContent = `
      #notiskin-tour { position: fixed; inset: 0; z-index: 10000; font-family: var(--font-body); -webkit-font-smoothing: antialiased; opacity: 0; transition: opacity 220ms ease; }
      #notiskin-tour.open { opacity: 1; }
      #notiskin-tour .tour-blocker { position: absolute; inset: 0; }
      #notiskin-tour .tour-spot {
        position: fixed; pointer-events: none;
        box-shadow: 0 0 0 200vmax var(--overlay); outline: 2px solid var(--accent); outline-offset: 0;
        transition: top ${move}, left ${move}, width ${move}, height ${move}, border-radius ${move}, outline-color 200ms ease;
      }
      #notiskin-tour .tour-spot.empty { outline-color: transparent; }
      #notiskin-tour .tour-card {
        position: fixed; width: 300px; box-sizing: border-box; padding: 16px;
        background: var(--surface); border: 1px solid var(--border); border-radius: 12px; color: var(--text);
        box-shadow: var(--shadow); transform: translateY(6px) scale(0.98);
        transition: top ${move}, left ${move}, transform 260ms ${EASE};
      }
      #notiskin-tour.open .tour-card { transform: none; }
      #notiskin-tour.still .tour-spot, #notiskin-tour.still .tour-card { transition: none; }
      #notiskin-tour .tour-body { transition: opacity 140ms ease, transform 140ms ease; }
      #notiskin-tour .tour-body.swap { opacity: 0; transform: translateY(3px); }
      #notiskin-tour .tour-title { font-family: var(--font-display); font-size: 17px; font-weight: 560; margin: 0 28px 6px 0; }
      #notiskin-tour .tour-text { font-size: 13px; line-height: 1.5; color: var(--text-2); margin: 0 0 14px; }
      #notiskin-tour .tour-footer { display: flex; align-items: center; gap: 8px; }
      #notiskin-tour .tour-count { font-size: 11px; color: var(--text-3); margin-right: auto; }
      #notiskin-tour button { font-size: 12px; padding: 5px 12px; border-radius: 6px; cursor: pointer; }
      #notiskin-tour .tour-close {
        position: absolute; top: 10px; right: 10px; width: 26px; height: 26px; padding: 0;
        display: grid; place-items: center; background: none; border: none; color: var(--text-3);
        border-radius: 7px; transition: background 120ms ease, color 120ms ease;
      }
      #notiskin-tour .tour-close:hover { background: var(--surface-hover); color: var(--text); }
      #notiskin-tour .tour-close svg { width: 14px; height: 14px; }
      #notiskin-tour .tour-back { background: var(--surface); border: 1px solid var(--border); color: var(--text); }
      #notiskin-tour .tour-back:hover { background: var(--surface-hover); }
      #notiskin-tour .tour-next { background: var(--ink); border: 1px solid var(--ink); color: var(--on-ink); }
      #notiskin-tour .tour-next:hover { background: var(--ink-hover); }
      @media (prefers-reduced-motion: reduce) {
        #notiskin-tour, #notiskin-tour * { transition: none !important; }
      }
    `;

    root = document.createElement('div');
    root.id = 'notiskin-tour';
    // the page underneath can't be clicked while the tour is open, the × or Esc closes it
    const blocker = document.createElement('div');
    blocker.className = 'tour-blocker';
    const spot = document.createElement('div');
    spot.className = 'tour-spot empty';
    const card = document.createElement('div');
    card.className = 'tour-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'tour-title');
    card.innerHTML = `
      <button type="button" class="tour-close" aria-label="Close tour">
        <svg viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      </button>
      <div class="tour-body">
        <h3 class="tour-title" id="tour-title"></h3>
        <p class="tour-text"></p>
        <div class="tour-footer"><span class="tour-count"></span></div>
      </div>
    `;
    card.querySelector('.tour-close').addEventListener('click', finish);
    root.append(style, blocker, spot, card);
    // on <html>, not <body>: when a step continues on a new page this runs from <head>, before the body exists
    document.documentElement.appendChild(root);

    // start where the previous page left off (no fade, the tour was already showing), or as a dot in the middle
    const start = from || { x: innerWidth / 2, y: innerHeight / 2, w: 0, h: 0, r: 12 };
    root.classList.add('still');
    Object.assign(spot.style, { left: `${start.x}px`, top: `${start.y}px`, width: `${start.w}px`, height: `${start.h}px`, borderRadius: `${start.r}px` });
    if (from) {
      if (from.w) spot.classList.remove('empty');
      Object.assign(card.style, { left: `${from.cx}px`, top: `${from.cy}px` });
      root.classList.add('open');
    } else {
      Object.assign(card.style, { left: `${(innerWidth - card.offsetWidth) / 2}px`, top: `${(innerHeight - card.offsetHeight) / 2}px` });
    }

    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
  }

  // lists load after the page does: follow the page's layout and the target's own contents as they settle
  function watch(el) {
    if (!observer) {
      observer = new ResizeObserver(schedule);
      observer.observe(document.body);
    }
    targetSize?.disconnect();
    targetContent?.disconnect();
    if (!el) return;
    targetSize = new ResizeObserver(schedule);
    targetSize.observe(el);
    targetContent = new MutationObserver(schedule);
    targetContent.observe(el, { childList: true, subtree: true, characterData: true });
  }

  function schedule() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => place(false));
  }

  function fill(index) {
    const step = STEPS[index];
    const card = root.querySelector('.tour-card');
    card.querySelector('.tour-title').textContent = step.title;
    card.querySelector('.tour-text').textContent = step.text;
    card.querySelector('.tour-count').textContent = `${index + 1} of ${STEPS.length}`;
    const footer = card.querySelector('.tour-footer');
    footer.querySelectorAll('button').forEach(b => b.remove());
    if (index > 0) footer.append(button('Back', 'tour-back', () => move(-1)));
    const nextBtn = button(step.next || 'Next', 'tour-next', () => move(1));
    footer.append(nextBtn);
    nextBtn.focus({ preventScroll: true });
  }

  function show(index, from) {
    const step = STEPS[index];
    try { step.before?.(); } catch {}
    const first = !shown;
    if (!root) build(from);
    shown = true;
    current = index;
    movingUntil = performance.now() + MOVE_MS + 300;
    clearTimeout(swapTimer);

    const el = elementOf(step);
    watch(el);
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.top < 16 || r.bottom > innerHeight - 16) {
        el.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' });
      }
    }

    if (first) {
      fill(index);
      // commit the start position (reading layout forces it), then everything glides to the first target
      root.getBoundingClientRect();
      root.classList.add('open');
      place(true);
      return;
    }

    // the box starts moving at once, the card's words fade out and back in as it arrives
    place(true);
    const body = root.querySelector('.tour-body');
    body.classList.add('swap');
    swapTimer = setTimeout(() => {
      if (!root || current !== index) return;
      fill(index);
      body.classList.remove('swap');
      place(true);
    }, reduceMotion() ? 0 : 140);
  }

  function place(animate) {
    if (!root || current < 0) return;
    const m = measure(STEPS[current]);
    const spot = root.querySelector('.tour-spot');
    const card = root.querySelector('.tour-card');
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const gap = 14;

    // scrolling and late layout changes follow instantly, unless a step change is still gliding
    root.classList.toggle('still', !animate && performance.now() > movingUntil);

    let left;
    let y;
    if (!m) {
      Object.assign(spot.style, { left: `${vw / 2}px`, top: `${vh / 2}px`, width: '0px', height: '0px', borderRadius: '12px' });
      spot.classList.add('empty');
      left = (vw - cw) / 2;
      y = (vh - ch) / 2;
    } else {
      // a long list would cover the whole window, only light up what's on screen
      const top = Math.max(m.y, 8);
      const bottom = Math.min(m.y + m.h, vh - 8);
      Object.assign(spot.style, {
        left: `${m.x}px`, top: `${top}px`, width: `${m.w}px`, height: `${Math.max(bottom - top, 0)}px`, borderRadius: `${m.r}px`,
      });
      spot.classList.remove('empty');

      // right of the target if it fits, else below, above, then left
      if (m.x + m.w + gap + cw <= vw - 16) {
        left = m.x + m.w + gap;
        y = top;
      } else if (bottom + gap + ch <= vh - 16) {
        left = m.x;
        y = bottom + gap;
      } else if (top - gap - ch >= 16) {
        left = m.x;
        y = top - gap - ch;
      } else {
        left = m.x - gap - cw;
        y = top;
      }
    }
    card.style.left = `${Math.min(Math.max(left, 16), vw - cw - 16)}px`;
    card.style.top = `${Math.min(Math.max(y, 16), vh - ch - 16)}px`;
  }

  // a step that continues on this page: draw the dimming and card at once, where the last page left them,
  // so the page change never shows the app undimmed. They glide to the new target once the page is ready
  const resume = saved();
  if (resume && STEPS[resume.step].page === location.pathname && resume.from) {
    build(resume.from);
    current = resume.step;
    fill(resume.step);
  }

  async function init() {
    const state = saved();
    if (state && STEPS[state.step].page === location.pathname) {
      show(state.step, state.from);
      return;
    }
    // the app opens on Themes, so that's the only page the tour starts from on its own
    if (location.pathname !== '/') return;
    try {
      const res = await fetch('/api/setup');
      if (res.ok && (await res.json()).showTour) go(0);
    } catch {}
  }

  // the page crossfade (brand.css) is skipped when the window is hidden, which is fine, not an error to report
  for (const type of ['pageswap', 'pagereveal']) {
    addEventListener(type, e => {
      e.viewTransition?.ready.catch(() => {});
      e.viewTransition?.finished.catch(() => {});
    });
  }

  window.notiskinTour = { start: () => go(0) };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
