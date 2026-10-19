// long-running injector: stays connected to Notion for as long as it runs, so the theme and plugins
// survive page reloads and reach every tab and window, not just the one that was visible at launch
// it is the only thing that talks to Notion, the CLI and the app ask it to apply or reload over its control socket
import { watch, FSWatcher, mkdirSync, rmSync } from 'fs';
import type { Server } from 'net';
import { sleep } from '../utils/sleep';
import { injectEverything, earlyStyleScript, PluginEntry } from './index';
import { PipeConnection, PipeRun } from './pipe';
import { ControlReply, ControlRequest, startControlServer, stopControlServer } from './control';

export interface InjectPayload {
  css: string;
  plugins: PluginEntry[];
}

export interface DaemonOptions {
  // Notion's pipe folder and pid
  run: PipeRun;
  // read fresh on every injection, so config changes apply without restarting the daemon
  loadPayload: () => InjectPayload;
  // which page targets to theme, defaults to Notion's own pages
  isTargetUrl?: (url: string) => boolean;
  // folders to watch, any change re-applies to every tab
  watchPaths?: string[];
  connectTimeoutMs?: number;
  // answer apply / reload / status on ~/.notiskin/run/injector.sock
  controlSocket?: boolean;
  // remove the pipe folder once Notion has quit
  cleanUpRun?: boolean;
  log?: (msg: string) => void;
}

export interface DaemonHandle {
  // resolves when Notion quits or stop() is called
  done: Promise<void>;
  stop(): Promise<void>;
  attachedTargets(): string[];
  // re-apply to every attached tab, resolves once all are done
  reapplyAll(): Promise<void>;
  // reload every attached tab, resolves once each one has been themed again
  reloadAll(): Promise<void>;
  // the connection to Notion, tests use it to look inside pages
  cdp: PipeConnection;
}

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  attached?: boolean;
}

interface Session {
  targetId: string;
  sessionId: string;
  earlyScriptId?: string;
  // one injection at a time per tab, a reload mid-injection queues behind it
  queue: Promise<void>;
  // reloadAll() waits here for the injection after the next page load
  onLoaded: (() => void)[];
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

export async function startInjectorDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  const log = opts.log ?? (() => {});
  const isTarget = opts.isTargetUrl ?? isNotionUrl;
  const browser = await PipeConnection.open(opts.run, opts.connectTimeoutMs ?? 30_000);
  const sessions = new Map<string, Session>();
  const attaching = new Set<string>();
  const watchers: FSWatcher[] = [];
  // sessions left attached by an injector that was killed, their events still arrive
  const detached = new Set<string>();
  let control: Server | undefined;
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
      const { sessionId } = (await browser.send('Target.attachToTarget', { targetId: info.targetId, flatten: true })) as { sessionId: string };
      const session: Session = { targetId: info.targetId, sessionId: sessionId as string, queue: Promise.resolve(), onLoaded: [] };
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
    if (!session) return;
    const waiting = session.onLoaded.splice(0);
    void schedule(session, 'reload').then(() => waiting.forEach(fn => fn()));
  });
  // an earlier injector's session would keep putting its old theme in at every reload, let it go
  browser.on('event', (_method: string, _params: unknown, sessionId?: string) => {
    if (!sessionId || detached.has(sessionId) || findBySessionId(sessionId)) return;
    detached.add(sessionId);
    browser.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  });

  async function reapplyAll(): Promise<void> {
    await Promise.all([...sessions.values()].map(s => schedule(s, 'settings changed')));
  }

  async function reloadAll(): Promise<void> {
    // the document-start CSS has to be current before the reload, or the old theme flashes in
    await reapplyAll();
    await Promise.all(
      [...sessions.values()].map(session => {
        const loaded = new Promise<void>(resolve => session.onLoaded.push(resolve));
        return sessionClient(session.sessionId)
          .send('Page.reload')
          .then(() => Promise.race([loaded, sleep(20_000)]))
          .catch(() => {});
      })
    );
  }

  async function handleControl(req: ControlRequest): Promise<ControlReply> {
    const base = { ok: true, tabs: sessions.size, pid: opts.run.pid, runDir: opts.run.dir };
    if (req.cmd === 'status') return base;
    if (req.cmd === 'apply') {
      clearTimeout(debounce);
      await reapplyAll();
      return { ...base, tabs: sessions.size };
    }
    if (req.cmd === 'reload') {
      clearTimeout(debounce);
      await reloadAll();
      return { ...base, tabs: sessions.size };
    }
    return { ok: false, error: 'unknown command' };
  }

  let debounce: NodeJS.Timeout | undefined;
  for (const path of opts.watchPaths ?? []) {
    try {
      mkdirSync(path, { recursive: true });
      watchers.push(
        watch(path, (_event, filename) => {
          // temp files from atomic writes, logs, the lock file, and the pipe folder aren't settings
          if (filename && /\.(tmp|log|pid)$|\.corrupt-|^run$/.test(String(filename))) return;
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
    if (control) stopControlServer(control);
    sessions.clear();
    resolveDone();
  }

  // Notion quitting is the daemon's cue to exit
  browser.on('disconnect', () => {
    if (stopped) return;
    log('Notion closed, injector exiting.');
    shutdown();
    if (opts.cleanUpRun) {
      try { rmSync(opts.run.dir, { recursive: true, force: true }); } catch {}
    }
  });

  const { targetInfos } = (await browser.send('Target.getTargets')) as { targetInfos: TargetInfo[] };
  // works when exactly one old session is attached, the usual case after an injector crash
  await Promise.all(
    targetInfos
      .filter(t => t.attached && t.type === 'page')
      .map(t => browser.send('Target.detachFromTarget', { targetId: t.targetId }).catch(() => {}))
  );
  await browser.send('Target.setDiscoverTargets', { discover: true });
  await Promise.all(targetInfos.map(consider));

  if (opts.controlSocket) control = await startControlServer(handleControl);

  return {
    done,
    attachedTargets: () => [...sessions.keys()],
    reapplyAll,
    reloadAll,
    cdp: browser,
    async stop() {
      // leave Notion as it was: no document-start CSS, no sessions, the pipe still open on Notion's side
      const open = [...sessions.values()];
      shutdown();
      await Promise.all(
        open.map(async s => {
          const client = sessionClient(s.sessionId);
          if (s.earlyScriptId) await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: s.earlyScriptId }).catch(() => {});
          await browser.send('Target.detachFromTarget', { sessionId: s.sessionId }).catch(() => {});
        })
      );
      await browser.send('Target.setDiscoverTargets', { discover: false }).catch(() => {});
      await browser.close();
    },
  };
}
