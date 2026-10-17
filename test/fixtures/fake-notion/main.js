// stand-in for Notion: an Electron app with the debug port open, serving a page that uses Notion's class names
const { app, BrowserWindow } = require('electron');
const http = require('http');

const { CDP_PORT, PAGE_PORT, USER_DATA } = process.env;
app.setPath('userData', USER_DATA);
app.commandLine.appendSwitch('remote-debugging-port', CDP_PORT);

// the inline script records whether the theme was already present before the page's own code ran
const html = '<!doctype html><html><head><title>fake notion</title>' +
  '<script>window.__styledAtStart = !!document.getElementById("notiskin-styles")</script></head>' +
  '<body><div class="notion-app-inner"><div class="notion-frame">hello</div></div></body></html>';

function openWindow(win) {
  // new windows from window.open stay hidden too, like Notion's own extra tabs from the test's point of view
  win.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { show: false } }));
  win.webContents.on('did-create-window', child => openWindow(child));
}

app.whenReady().then(() => {
  http
    .createServer((_req, res) => {
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
