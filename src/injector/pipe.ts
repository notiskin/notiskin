// Chrome DevTools Protocol over Notion's --remote-debugging-pipe, no TCP port anywhere
// the wrapper makes two FIFOs in ~/.notiskin/run/<Notion's pid>/ and hands them to Notion as fd 3 (commands in)
// and fd 4 (replies out). Notion holds both ends of both FIFOs itself, so the pipe never closes under it:
// the injector can crash or be killed and Notion keeps running, and a new injector can connect later
import { EventEmitter } from 'events';
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, rmSync, statSync, chmodSync } from 'fs';
import net from 'net';
import { join } from 'path';
import { RUN_DIR } from '../utils/constants';
import { sleep } from '../utils/sleep';

const COMMAND_TIMEOUT_MS = 30_000;
const PID_POLL_MS = 500;

export interface PipeRun {
  dir: string;
  pid: number;
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ~/.notiskin/run/12345 -> 12345, the folder is named after Notion's pid (exec keeps the wrapper's pid)
export function runPid(dir: string): number | null {
  const name = dir.split('/').filter(Boolean).pop() ?? '';
  return /^\d+$/.test(name) ? Number(name) : null;
}

function isFifo(path: string): boolean {
  try {
    return statSync(path).isFIFO();
  } catch {
    return false;
  }
}

// the folder only the user can open, FIFOs and the control socket live in here
export function ensureRunDir(): void {
  mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  chmodSync(RUN_DIR, 0o700);
}

// the Notion that's running with the pipe right now, removes folders left by Notions that have quit
export function findNotionRun(): PipeRun | null {
  if (!existsSync(RUN_DIR)) return null;
  let best: PipeRun | null = null;
  let bestTime = -1;
  for (const name of readdirSync(RUN_DIR)) {
    const dir = join(RUN_DIR, name);
    const pid = runPid(dir);
    if (pid === null) {
      // a launch from Node that failed before its folder got Notion's pid
      if (name.startsWith('launch-') && Date.now() - statSync(dir).mtimeMs > 60_000) {
        try { rmSync(dir, { recursive: true, force: true }); } catch {}
      }
      continue;
    }
    if (!isAlive(pid)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      continue;
    }
    if (!isFifo(join(dir, 'in')) || !isFifo(join(dir, 'out'))) continue;
    const time = statSync(dir).mtimeMs;
    if (time > bestTime) {
      best = { dir, pid };
      bestTime = time;
    }
  }
  return best;
}

// O_NONBLOCK so a missing reader fails with ENXIO instead of hanging the process
function openFifo(path: string, flags: number): number {
  const fd = openSync(path, flags | constants.O_NONBLOCK);
  const st = fstatSync(fd);
  if (!st.isFIFO() || (process.getuid && st.uid !== process.getuid())) {
    closeSync(fd);
    throw new Error(`${path} is not a pipe Notiskin made`);
  }
  return fd;
}

export class PipeConnection extends EventEmitter {
  private readonly writer: net.Socket;
  private readonly reader: net.Socket;
  private readonly pending = new Map<number, Pending>();
  // a random start, so replies meant for an injector that died earlier never match our ids
  private nextId = 1 + Math.floor(Math.random() * 1e9);
  private buffer = '';
  private closed = false;
  private pidTimer?: NodeJS.Timeout;

  private constructor(inFd: number, outFd: number, readonly pid: number) {
    super();
    this.writer = new net.Socket({ fd: inFd, readable: false, writable: true });
    this.reader = new net.Socket({ fd: outFd, readable: true, writable: false });
    this.reader.setEncoding('utf8');
    this.reader.on('data', (chunk: string) => this.onData(chunk));
    for (const s of [this.reader, this.writer]) {
      s.on('error', () => this.shutdown());
      s.on('close', () => this.shutdown());
    }
    // macOS never reports end-of-file on a FIFO here, so Notion's pid is how we notice it quit
    this.pidTimer = setInterval(() => {
      if (!isAlive(pid)) this.shutdown();
    }, PID_POLL_MS);
    this.pidTimer.unref?.();
    // ends whatever half-written message a killed injector may have left, Notion answers it with an error
    this.writer.write('\0');
  }

  static async open(run: PipeRun, timeoutMs = 10_000): Promise<PipeConnection> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!isAlive(run.pid)) throw new Error('Notion is not running');
      try {
        // Notion opens its ends before it starts, ENXIO only happens in the moment before that
        const inFd = openFifo(join(run.dir, 'in'), constants.O_WRONLY);
        let outFd: number;
        try {
          outFd = openFifo(join(run.dir, 'out'), constants.O_RDONLY);
        } catch (err) {
          closeSync(inFd);
          throw err;
        }
        return new PipeConnection(inFd, outFd, run.pid);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENXIO' || Date.now() > deadline) throw err;
        await sleep(100);
      }
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send(method: string, params: object = {}, sessionId?: string): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Notion is not connected'));
    const id = this.nextId++;
    const message: Record<string, unknown> = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.writer.write(JSON.stringify(message) + '\0');
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf('\0')) >= 0) {
      const raw = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      this.dispatch(raw);
    }
  }

  private dispatch(raw: string): void {
    let msg: { id?: number; method?: string; params?: unknown; sessionId?: string; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // the tail of a message an earlier injector half-read
    }
    if (typeof msg.id === 'number') {
      const call = this.pending.get(msg.id);
      if (!call) return; // a reply meant for an earlier injector
      this.pending.delete(msg.id);
      clearTimeout(call.timer);
      if (msg.error) call.reject(new Error(msg.error.message ?? 'DevTools error'));
      else call.resolve(msg.result ?? {});
      return;
    }
    if (typeof msg.method === 'string') {
      this.emit(msg.method, msg.params ?? {}, msg.sessionId);
      this.emit('event', msg.method, msg.params ?? {}, msg.sessionId);
    }
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pidTimer);
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error('Notion is not connected'));
    }
    this.pending.clear();
    this.reader.destroy();
    this.writer.destroy();
    this.emit('disconnect');
  }

  // only closes our ends, Notion keeps its own and carries on
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise(resolve => {
      this.writer.end(() => {
        this.shutdown();
        resolve();
      });
    });
  }
}
