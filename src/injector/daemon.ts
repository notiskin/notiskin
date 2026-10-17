// long-running injector: stays connected to Notion for as long as it runs, so the theme and plugins
// survive page reloads and reach every tab and window, not just the one that was visible at launch
import CDP = require('chrome-remote-interface');
import http from 'http';
import { watch, FSWatcher, mkdirSync } from 'fs';
import { sleep } from '../utils/sleep';
import { injectEverything, earlyStyleScript, PluginEntry } from './index';

export interface InjectPayload {
  css: string;
  plugins: PluginEntry[];
}

export interface DaemonOptions {
  port: number;
  // read fresh on every injection, so config changes apply without restarting the daemon
  loadPayload: () => InjectPayload;
  // which page targets to theme, defaults to Notion's own pages
  isTargetUrl?: (url: string) => boolean;
  // folders to watch, any change re-applies to every tab
  watchPaths?: string[];
  connectTimeoutMs?: number;
  log?: (msg: string) => void;
}

export interface DaemonHandle {
  // resolves when Notion quits or stop() is called
  done: Promise<void>;
  stop(): Promise<void>;
  attachedTargets(): string[];
  // re-apply to every attached tab, resolves once all are done
  reapplyAll(): Promise<void>;
}

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

interface Session {
  targetId: string;
  sessionId: string;
  earlyScriptId?: string;
  // one injection at a time per tab, a reload mid-injection queues behind it
  queue: Promise<void>;
}

const NOTION_HOST = /(^|\.)notion\.(so|com)$/;

export function isNotionUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && NOTION_HOST.test(hostname);
  } catch {
    return false;
  }
}

function fetchBrowserWsUrl(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1000 }, res => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => {
        try {
          const url = JSON.parse(body).webSocketDebuggerUrl;
          if (typeof url === 'string') resolve(url);
          else reject(new Error('no browser websocket url'));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function waitForBrowser(port: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await fetchBrowserWsUrl(port);
    } catch (err) {
      lastError = err;
      await sleep(500);
    }
  }
  throw new Error(`Notion's debug port ${port} never came up: ${(lastError as Error)?.message ?? 'timed out'}`);
}

export async function startInjectorDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  const log = opts.log ?? (() => {});
  const isTarget = opts.isTargetUrl ?? isNotionUrl;
  const wsUrl = await waitForBrowser(opts.port, opts.connectTimeoutMs ?? 30_000);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const browser: any = await CDP({ target: wsUrl, local: true });
  const sessions = new Map<string, Session>();
  const attaching = new Set<string>();
  const watchers: FSWatcher[] = [];
  let stopped = false;

  let resolveDone!: () => void;
  const done = new Promise<void>(r => (resolveDone = r));

  function sessionClient(sessionId: string) {
    return { send: (method: string, params: object = {}) => browser.send(method, params, sessionId) };
  }

  function findBySessionId(sessionId: string): Session | undefined {
    for (const s of sessions.values()) if (s.sessionId === sessionId) return s;
    return undefined;
  }

  async function injectInto(session: Session): Promise<void> {
    const { css, plugins } = opts.loadPayload();
    const client = sessionClient(session.sessionId);

    // swap the document-start CSS so the next reload paints with the current theme
    if (session.earlyScriptId) {
      await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: session.earlyScriptId }).catch(() => {});
      session.earlyScriptId = undefined;
    }
    const early = earlyStyleScript(css);
    if (early) {
      const res = await client.send('Page.addScriptToEvaluateOnNewDocument', { source: early });
      session.earlyScriptId = (res as { identifier: string }).identifier;
    }

    await injectEverything(css, plugins, client);
  }

  function schedule(session: Session, reason: string): Promise<void> {
    session.queue = session.queue
      .then(() => injectInto(session))
      .then(
        () => log(`applied to ${session.targetId.slice(0, 8)} (${reason})`),
        err => {
          // a tab closing mid-injection is normal, anything else is worth a log line
          if (sessions.has(session.targetId)) log(`apply to ${session.targetId.slice(0, 8)} failed: ${(err as Error).message}`);
        }
      );
    return session.queue;
  }

  async function consider(info: TargetInfo): Promise<void> {
    if (stopped || info.type !== 'page' || !isTarget(info.url)) return;
    if (sessions.has(info.targetId) || attaching.has(info.targetId)) return;
    attaching.add(info.targetId);
    try {
      const { sessionId } = await browser.send('Target.attachToTarget', { targetId: info.targetId, flatten: true });
      const session: Session = { targetId: info.targetId, sessionId, queue: Promise.resolve() };
      sessions.set(info.targetId, session);
      const client = sessionClient(sessionId);
      await client.send('Page.enable');
      const ready = await client.send('Runtime.evaluate', { expression: 'document.readyState' });
      log(`attached to ${info.targetId.slice(0, 8)} ${info.url}`);
      if ((ready as { result: { value: string } }).result.value === 'complete') {
        await schedule(session, 'attach');
      }
      // otherwise Page.loadEventFired will trigger the first injection
    } catch (err) {
      log(`could not attach to ${info.targetId.slice(0, 8)}: ${(err as Error).message}`);
    } finally {
      attaching.delete(info.targetId);
    }
  }

  function forget(targetId: string): void {
    sessions.delete(targetId);
  }

  browser.on('Target.targetCreated', ({ targetInfo }: { targetInfo: TargetInfo }) => void consider(targetInfo));
  // a tab often starts as about:blank and only then navigates to Notion
  browser.on('Target.targetInfoChanged', ({ targetInfo }: { targetInfo: TargetInfo }) => void consider(targetInfo));
  browser.on('Target.targetDestroyed', ({ targetId }: { targetId: string }) => forget(targetId));
  browser.on('Target.detachedFromTarget', ({ targetId }: { targetId?: string }) => {
    if (targetId) forget(targetId);
  });
  browser.on('Page.loadEventFired', (_params: unknown, sessionId?: string) => {
    const session = sessionId ? findBySessionId(sessionId) : undefined;
    if (session) void schedule(session, 'reload');
  });

  async function reapplyAll(): Promise<void> {
    await Promise.all([...sessions.values()].map(s => schedule(s, 'settings changed')));
  }

  let debounce: NodeJS.Timeout | undefined;
  for (const path of opts.watchPaths ?? []) {
    try {
      mkdirSync(path, { recursive: true });
      watchers.push(
        watch(path, (_event, filename) => {
          // temp files from atomic writes, logs, and the lock file aren't settings
          if (filename && /\.(tmp|log|pid)$|\.corrupt-/.test(String(filename))) return;
          clearTimeout(debounce);
          debounce = setTimeout(() => void reapplyAll(), 300);
        })
      );
    } catch (err) {
      log(`can't watch ${path}: ${(err as Error).message}`);
    }
  }

  function shutdown(): void {
    if (stopped) return;
    stopped = true;
    clearTimeout(debounce);
    for (const w of watchers) w.close();
    sessions.clear();
    resolveDone();
  }

  // Notion quitting closes the browser socket, that's the daemon's cue to exit
  browser.on('disconnect', () => {
    log('Notion closed, injector exiting.');
    shutdown();
  });

  await browser.send('Target.setDiscoverTargets', { discover: true });
  const { targetInfos } = (await browser.send('Target.getTargets')) as { targetInfos: TargetInfo[] };
  await Promise.all(targetInfos.map(consider));

  return {
    done,
    attachedTargets: () => [...sessions.keys()],
    reapplyAll,
    async stop() {
      shutdown();
      try { await browser.close(); } catch {}
    },
  };
}
