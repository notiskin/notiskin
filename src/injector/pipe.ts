// Chrome DevTools Protocol over Notion's --remote-debugging-pipe, no TCP port anywhere
// the wrapper makes two FIFOs in ~/.notiskin/run/<Notion's pid>/ and hands them to Notion as fd 3 (commands in)
// and fd 4 (replies out). Notion holds both ends of both FIFOs itself, so the pipe never closes under it:
// the injector can crash or be killed and Notion keeps running, and a new injector can connect later
//
// the pipes are read and written with plain blocking read()/write() on libuv's thread pool, not net.Socket:
// macOS's kqueue misses data on FIFOs (a reply bigger than the 8 KB pipe buffer stalled the reader for good)
// and never reports their end-of-file
import { EventEmitter } from 'events';
import {
  close,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  read,
  readdirSync,
  rmSync,
  statSync,
  chmodSync,
  write,
} from 'fs';
import { join } from 'path';
import { StringDecoder } from 'string_decoder';
import { RUN_DIR } from '../utils/constants';
import { sleep } from '../utils/sleep';

const COMMAND_TIMEOUT_MS = 15_000;
const READ_CHUNK = 64 * 1024;
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

function checkFifo(fd: number, path: string): void {
  const st = fstatSync(fd);
  if (!st.isFIFO() || (process.getuid && st.uid !== process.getuid())) {
    closeSync(fd);
    throw new Error(`${path} is not a pipe Notiskin made`);
  }
}

// the write end, as a blocking fd. O_NONBLOCK first so a missing reader fails with ENXIO instead of hanging,
// then a blocking open, which returns at once because Notion is already reading
function openWriteEnd(path: string): number {
  const probe = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
  try {
    checkFifo(probe, path);
    const fd = openSync(path, constants.O_WRONLY);
    checkFifo(fd, path);
    return fd;
  } finally {
    try { closeSync(probe); } catch {}
  }
}

// only called once the write end opened, so Notion holds this pipe too and the blocking open returns at once
function openReadEnd(path: string): number {
  const fd = openSync(path, constants.O_RDONLY);
  checkFifo(fd, path);
  return fd;
}

export class PipeConnection extends EventEmitter {
  private readonly pending = new Map<number, Pending>();
  // a random start, so replies meant for an injector that died earlier never match our ids
  private nextId = 1 + Math.floor(Math.random() * 1e9);
  private buffer = '';
  private readonly decoder = new StringDecoder('utf8');
  private readonly chunk = Buffer.alloc(READ_CHUNK);
  // writes go out one after another, a message must never be split by another
  private writes: Promise<void> = Promise.resolve();
  private closed = false;
  private reading = true;
  // close() asks Notion one last thing, the read loop stops once that reply is in
  private goodbyeId?: number;
  private stopReading = false;
  private pidTimer?: NodeJS.Timeout;

  private constructor(private readonly inFd: number, private readonly outFd: number, readonly pid: number) {
    super();
    // Notion's pid is the surest sign it quit, end-of-file on the pipe is the other
    this.pidTimer = setInterval(() => {
      if (!isAlive(pid)) this.shutdown();
    }, PID_POLL_MS);
    this.pidTimer.unref?.();
    // ends whatever half-written message a killed injector may have left, Notion answers it with an error
    this.writeRaw('\0');
    this.readLoop();
  }

  static async open(run: PipeRun, timeoutMs = 10_000): Promise<PipeConnection> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!isAlive(run.pid)) throw new Error('Notion is not running');
      try {
        // Notion opens its ends before it starts, ENXIO only happens in the moment before that
        const inFd = openWriteEnd(join(run.dir, 'in'));
        let outFd: number;
        try {
          outFd = openReadEnd(join(run.dir, 'out'));
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
      this.writeRaw(JSON.stringify(message) + '\0');
    });
  }

  private writeRaw(text: string): void {
    const data = Buffer.from(text, 'utf8');
    this.writes = this.writes.then(async () => {
      let offset = 0;
      while (offset < data.length && !this.closed) {
        offset += await new Promise<number>((resolve, reject) =>
          write(this.inFd, data, offset, data.length - offset, null, (err, n) => (err ? reject(err) : resolve(n)))
        );
      }
    }).catch(() => this.shutdown());
  }

  // one blocking read at a time on the thread pool, it wakes the moment Notion writes
  private readLoop(): void {
    read(this.outFd, this.chunk, 0, READ_CHUNK, null, (err, n) => {
      if (err || n === 0) {
        // 0 is end-of-file: every writer is gone, Notion has quit
        this.reading = false;
        this.shutdown();
        return;
      }
      this.onData(this.decoder.write(this.chunk.subarray(0, n)));
      if (this.closed || this.stopReading) {
        this.reading = false;
        close(this.outFd, () => {});
        return;
      }
      this.readLoop();
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
      if (msg.id === this.goodbyeId) this.stopReading = true;
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
    void this.writes.finally(() => close(this.inFd, () => {}));
    // a read in progress can't be cancelled, its callback closes the read end; otherwise close it now
    if (!this.reading) close(this.outFd, () => {});
    this.emit('disconnect');
  }

  // only closes our ends, Notion keeps its own and carries on. The blocking read is woken by one last reply,
  // so it can't hold the process open
  async close(): Promise<void> {
    if (this.closed) return;
    this.goodbyeId = this.nextId;
    await Promise.race([this.send('Browser.getVersion').catch(() => {}), sleep(2000)]);
    await this.writes;
    this.shutdown();
  }
}
