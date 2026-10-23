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
  // answer apply / reload / preview / status on ~/.notiskin/run/injector.sock
  controlSocket?: boolean;
  // false while previews must not show (safe mode), checked on every injection
  canPreview?: () => boolean;
  // a preview ends this long after the last request for it, defaults to 15 seconds
  previewTtlMs?: number;
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
const CONTROL_REPLY_MS = 20_000;
const DEFAULT_PREVIEW_TTL_MS = 15_000;
const MAX_PREVIEW_CHARS = 100_000;

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
  // the editor's live preview, kept only in memory so there is never anything to clean up
  let previewCss: string | null = null;
  let previewTimer: NodeJS.Timeout | undefined;

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
    const payload = opts.loadPayload();
    const css = previewCss !== null && (opts.canPreview?.() ?? true) ? previewCss : payload.css;
    const plugins = payload.plugins;
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
  // only when it's our own session: detaching an old injector's session from the same tab must not drop ours
  browser.on('Target.detachedFromTarget', ({ sessionId }: { sessionId?: string }) => {
    const session = sessionId ? findBySessionId(sessionId) : undefined;
    if (session) forget(session.targetId);
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

  function endPreview(): boolean {
    clearTimeout(previewTimer);
    const had = previewCss !== null;
    previewCss = null;
    return had;
  }

  // the answer to a request to change what the tabs show, within a set time even if a tab is slow to respond
  async function applyWithin(work: Promise<void>): Promise<boolean> {
    return Promise.race([work.then(() => true), sleep(CONTROL_REPLY_MS).then(() => false)]);
  }

  async function handleControl(req: ControlRequest): Promise<ControlReply> {
    const base = { ok: true, tabs: sessions.size, pid: opts.run.pid, runDir: opts.run.dir, previewing: previewCss !== null };
    if (req.cmd === 'status') return base;
    if (req.cmd === 'preview') {
      if (typeof req.css !== 'string' || !req.css.trim() || req.css.length > MAX_PREVIEW_CHARS) {
        return { ...base, ok: false, error: 'The preview needs some CSS.' };
      }
      if (opts.canPreview && !opts.canPreview()) {
        return { ...base, ok: false, error: 'Safe mode is on, so Notion shows no theme or preview.' };
      }
      // the editor repeats the same request as a heartbeat, only a change needs the tabs touched
      const changed = previewCss !== req.css;
      previewCss = req.css;
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => {
        if (endPreview()) void reapplyAll();
      }, opts.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS);
      if (changed) {
        clearTimeout(debounce);
        if (!(await applyWithin(reapplyAll()))) {
          return { ...base, previewing: true, ok: false, error: 'Notion is taking too long to respond, try again in a moment.' };
        }
      }
      return { ...base, previewing: true, tabs: sessions.size };
    }
    if (req.cmd === 'preview-end') {
      if (endPreview()) {
        clearTimeout(debounce);
        await applyWithin(reapplyAll());
      }
      return { ...base, previewing: false, tabs: sessions.size };
    }
    if (req.cmd === 'apply' || req.cmd === 'reload') {
      clearTimeout(debounce);
      // the app waits on this answer, so it comes within a set time even if a tab is slow to respond
      const finished = await Promise.race([
        (req.cmd === 'reload' ? reloadAll() : reapplyAll()).then(() => true),
        sleep(CONTROL_REPLY_MS).then(() => false),
      ]);
      if (!finished) return { ...base, ok: false, error: 'Notion is taking too long to respond, try again in a moment.' };
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
    clearTimeout(previewTimer);
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
