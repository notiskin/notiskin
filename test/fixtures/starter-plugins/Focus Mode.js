/**
 * Focus Mode
 * Adds a Focus button to the top bar. While it is on, the sidebar is hidden and the top bar fades out
 * until the pointer is over it. Press the button again to bring everything back.
 * It only hides things with CSS, it never changes your pages. Focus is off again after a reload.
 *
 * @notiskin-setting {"key":"hideSidebar","type":"toggle","label":"Hide the sidebar","default":true}
 * @notiskin-setting {"key":"fadeTopbar","type":"toggle","label":"Fade the top bar until the pointer is over it","default":true}
 */
const settings = notiskin.settings;
const root = document.documentElement;
let focusOn = false;
let button = null;
let timer = null;

const style = document.createElement('style');
style.id = 'notiskin-focus-mode';
style.textContent = [
  'html[data-ns-focus-sidebar] .notion-sidebar-container { display: none !important; }',
  // Notion gives the page a fixed width that leaves room for the sidebar, so let it fill the window
  'html[data-ns-focus-sidebar] .notion-frame { width: 100% !important; }',
  'html[data-ns-focus-topbar] .notion-topbar { opacity: 0 !important; }',
  'html[data-ns-focus-topbar] .notion-topbar:hover { opacity: 1 !important; }',
].join('\n');
document.head.appendChild(style);

function setFlag(name, value) {
  if (value) root.setAttribute(name, '');
  else root.removeAttribute(name);
}

function apply() {
  setFlag('data-ns-focus-sidebar', focusOn && settings.get('hideSidebar'));
  setFlag('data-ns-focus-topbar', focusOn && settings.get('fadeTopbar'));
  if (button) button.textContent = focusOn ? 'Focus: on' : 'Focus';
}

function ensureButton() {
  timer = null;
  try {
    // Notion can rebuild its top bar, so put the button back when it is gone
    if (button && button.isConnected) return;
    button = notiskin.addToolbarButton('Focus', () => {
      focusOn = !focusOn;
      apply();
    });
    if (!button) return;
    button.style.color = 'inherit';
    button.style.background = 'transparent';
    apply();
  } catch (error) {
    console.error('[Focus Mode]', error);
  }
}

function schedule() {
  if (!timer) timer = setTimeout(ensureButton, 500);
}

notiskin.ready(ensureButton);
notiskin.onPageChange(schedule);
notiskin.onBlockLoad(schedule);
settings.onChange(apply);
