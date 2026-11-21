/**
 * Reading Progress
 * A thin bar along the top of the window that fills up as you scroll down a page.
 * It only adds the bar, it never changes your pages.
 *
 * @notiskin-setting {"key":"show","type":"toggle","label":"Show the progress bar","default":true}
 * @notiskin-setting {"key":"color","type":"color","label":"Bar color","default":"#e8590c"}
 * @notiskin-setting {"key":"height","type":"number","label":"Bar thickness in pixels","default":3,"min":1,"max":10,"step":1}
 */
const settings = notiskin.settings;
let bar = null;
let frame = null;

// the element that scrolls the open page
function pageScroller() {
  const layout = document.querySelector('.layout');
  return layout ? layout.closest('.notion-scroller') : null;
}

// how far down the page is, from 0 to 1
function progress() {
  const scroller = pageScroller();
  if (!scroller) return 0;
  const room = scroller.scrollHeight - scroller.clientHeight;
  return room > 0 ? Math.min(1, Math.max(0, scroller.scrollTop / room)) : 0;
}

function draw() {
  frame = null;
  try {
    if (!settings.get('show')) {
      if (bar) bar.remove();
      bar = null;
      return;
    }
    if (!bar || !bar.isConnected) {
      bar = document.createElement('div');
      bar.id = 'notiskin-reading-progress';
      bar.style.cssText = 'position:fixed;top:0;left:0;width:100%;z-index:2147483000;pointer-events:none;transform-origin:left;transition:transform 80ms linear';
      document.body.appendChild(bar);
    }
    bar.style.height = settings.get('height') + 'px';
    bar.style.background = settings.get('color');
    bar.style.transform = 'scaleX(' + progress() + ')';
  } catch (error) {
    console.error('[Reading Progress]', error);
  }
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(draw);
}

// scroll events don't bubble, but a capturing listener on the document sees every scroller
document.addEventListener('scroll', schedule, true);
window.addEventListener('resize', schedule);
notiskin.onPageChange(schedule);
settings.onChange(schedule);
notiskin.ready(draw);
