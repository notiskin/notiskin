import { readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else, still alive
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// the pid of the live process holding the lock, null if nobody does (diagnostics uses this)
export function pidLockHolder(path: string): number | null {
  try {
    const pid = Number(readFileSync(path, 'utf-8').trim());
    return pid > 0 && isAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

// returns a release function, or null if another live process already holds the lock
// a lock left behind by a crashed process is taken over
export function acquirePidLock(path: string): (() => void) | null {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(process.pid), { flag: 'wx' });
      const release = () => {
        try {
          if (readFileSync(path, 'utf-8').trim() === String(process.pid)) unlinkSync(path);
        } catch {}
      };
      process.once('exit', release);
      return release;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let holder = 0;
      try { holder = Number(readFileSync(path, 'utf-8').trim()); } catch {}
      if (holder && holder !== process.pid && isAlive(holder)) return null;
      try { unlinkSync(path); } catch {}
    }
  }
  return null;
}
