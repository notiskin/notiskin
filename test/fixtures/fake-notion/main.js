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
  'window.__styledAtStart = window.__styleAtStart !== null</script></head>' +
  '<body><div class="notion-app-inner"><div class="notion-frame">hello</div></div></body></html>';

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
