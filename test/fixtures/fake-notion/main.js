// stand-in for Notion: an Electron app serving a page that uses Notion's class names
// DevTools comes over the pipe on fds 3 and 4 when started with --remote-debugging-pipe, like the wrapper does
// only the injector may use that pipe, so tests look inside the pages through POST /__eval here instead
const { app, BrowserWindow } = require('electron');
const http = require('http');

const { PAGE_PORT, USER_DATA } = process.env;
app.setPath('userData', USER_DATA);

// the inline script records what theme was already present before the page's own code ran
const html = '<!doctype html><html><head><title>fake notion</title>' +
  '<script>window.__styleAtStart = document.getElementById("notiskin-styles")?.textContent ?? null;' +
  'window.__styledAtStart = window.__styleAtStart !== null</script>' +
  '<style>:root{--c-texPri:rgb(1,2,3);--c-redTexSec:rgb(200,0,0);--c-bluTexSec:rgb(0,0,200);' +
  '--c-redBacSec:rgb(250,200,200);--ca-yelBacSecTra:rgba(250,250,0,0.3);' +
  '--c-bacPri:rgb(10,10,10);--ca-borSecTra:rgb(20,20,20);--ca-borPriTra:rgb(30,30,30);--c-yelBacEle:rgb(40,40,40)}</style></head>' +
  '<body><div class="notion-app-inner" style="font-family: ui-sans-serif, -apple-system, sans-serif"><div class="notion-frame">hello' +
  // how Notion marks text: plain has its default token, colored text and blocks point at a hue token
  '<div id="plain" style="color: var(--c-texPri)">plain</div>' +
  '<span id="red-text" style="color:var(--c-redTexSec)">red</span>' +
  '<span id="highlight" style="background:var(--ca-yelBacSecTra);color:var(--c-redTexSec)">highlight</span>' +
  '<div id="blue-block" style="color: var(--c-bluTexSec)"><span id="blue-child">blue child</span></div>' +
  '<div id="red-bg" style="background: var(--c-redBacSec)">red background</div>' +
  // databases, a bordered callout, and the inline fonts Notion sets on titles and code
  '<div class="notion-table-view-header-row" id="th" style="background: var(--c-bacPri)">header</div>' +
  '<div class="notion-table-view-row"><div class="notion-table-view-cell" id="tc" style="border-inline-end: 1px solid var(--ca-borSecTra); border-bottom: 1px solid var(--ca-borSecTra)">cell</div></div>' +
  '<div class="notion-board-group"><div class="notion-collection-item"><div id="card" style="border-radius: 10px; background: var(--c-yelBacEle)">card</div></div></div>' +
  '<div class="notion-callout-block"><div><div id="callout" style="border-radius: 10px; border: 1px solid var(--ca-borPriTra)">callout</div></div></div>' +
  '<div id="title-block" class="notion-selectable notion-page-block" style="font-family: ui-sans-serif, -apple-system, sans-serif">title</div>' +
  '<span id="code" style="font-family: &quot;SFMono-Regular&quot;, Menlo, monospace">code</span>' +
  '</div></div></body></html>';

function openWindow(win) {
  // new windows from window.open stay hidden too, like Notion's own extra tabs from the test's point of view
  win.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { show: false } }));
  win.webContents.on('did-create-window', child => openWindow(child));
}

// runs the request body as JS in every window, answers [{ id, url, value }]
async function evalEverywhere(expression) {
  return Promise.all(
    BrowserWindow.getAllWindows().map(async win => {
      const url = win.webContents.getURL();
      try {
        return { id: win.id, url, value: await win.webContents.executeJavaScript(expression) };
      } catch (err) {
        return { id: win.id, url, error: String(err) };
      }
    })
  );
}

app.whenReady().then(() => {
  http
    .createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/__eval') {
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', async () => {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(await evalEverywhere(body)));
        });
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(html);
    })
    .listen(Number(PAGE_PORT), '127.0.0.1', () => {
      const win = new BrowserWindow({ show: false });
      openWindow(win);
      win.loadURL(`http://127.0.0.1:${PAGE_PORT}/`);
    });
});

app.on('window-all-closed', () => app.quit());
