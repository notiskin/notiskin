// how the CLI and the app talk to the running injector: one JSON line in, one JSON line back,
// over a Unix socket in ~/.notiskin/run (0700), so only this user can reach it
// only the injector touches Notion's pipe, two clients writing to it at once would garble each other
import net from 'net';
import { existsSync, unlinkSync } from 'fs';
import { CONTROL_SOCKET } from '../utils/constants';
import { ensureRunDir } from './pipe';

export type ControlRequest =
  | { cmd: 'apply' }
  // reload every Notion tab, plugins can't be un-run any other way
  | { cmd: 'reload' }
  // the theme editor's live preview: this CSS replaces the theme in every tab until preview-end, or until nobody
  // has repeated the request for a few seconds (the editor closed, the app quit). The config is never touched
  | { cmd: 'preview'; css: string }
  | { cmd: 'preview-end' }
  | { cmd: 'status' };

export interface ControlReply {
  ok: boolean;
  error?: string;
  tabs?: number;
  previewing?: boolean;
  pid?: number;
  runDir?: string;
}

// a preview carries a whole theme
const MAX_REQUEST_BYTES = 128 * 1024;

export function startControlServer(handle: (req: ControlRequest) => Promise<ControlReply>): Promise<net.Server> {
  ensureRunDir();
  // a socket file left by an injector that crashed, the pid lock already proved nobody else is serving
  if (existsSync(CONTROL_SOCKET)) {
    try { unlinkSync(CONTROL_SOCKET); } catch {}
  }
  const server = net.createServer(socket => {
    let data = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', (chunk: string) => {
      data += chunk;
      if (data.length > MAX_REQUEST_BYTES) return socket.destroy();
      const end = data.indexOf('\n');
      if (end < 0) return;
      let req: ControlRequest;
      try {
        req = JSON.parse(data.slice(0, end));
      } catch {
        socket.end(JSON.stringify({ ok: false, error: 'bad request' }) + '\n');
        return;
      }
      handle(req).then(
        reply => socket.end(JSON.stringify(reply) + '\n'),
        err => socket.end(JSON.stringify({ ok: false, error: (err as Error).message }) + '\n')
      );
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(CONTROL_SOCKET, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

export function stopControlServer(server: net.Server): void {
  server.close();
  try { unlinkSync(CONTROL_SOCKET); } catch {}
}

// null when no injector is listening
export function askInjector(req: ControlRequest, timeoutMs = 30_000): Promise<ControlReply | null> {
  return new Promise(resolve => {
    if (!existsSync(CONTROL_SOCKET)) return resolve(null);
    const socket = net.connect(CONTROL_SOCKET);
    let data = '';
    let settled = false;
    const finish = (reply: ControlReply | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(reply);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'The injector did not answer in time.' }), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify(req) + '\n'));
    socket.on('data', (chunk: string) => {
      data += chunk;
      const end = data.indexOf('\n');
      if (end < 0) return;
      try {
        finish(JSON.parse(data.slice(0, end)));
      } catch {
        finish({ ok: false, error: 'The injector sent a reply Notiskin could not read.' });
      }
    });
    // ENOENT / ECONNREFUSED: nobody listening, the socket file is left over from a crash
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(null));
  });
}
