// runs the CLI's patch/unpatch as root behind one macOS password dialog.
// Not used by the app right now: macOS App Management refuses changes to another app's bundle made from
// the admin shell, even with the password (checked on macOS 26), so the server runs the CLI as the user.
// shellQuote and errorFromOutput are still used; the rest is kept in case a privileged route is needed later.
import { execFile } from 'child_process';

export type AdminAction = 'patch' | 'unpatch';

export type AdminResult =
  | { status: 'ok'; output: string }
  | { status: 'cancelled' }
  | { status: 'error'; message: string; output: string };

export interface AdminCommandOptions {
  user: string;
  execPath: string;
  cliPath: string;
}

export const ADMIN_PROMPTS: Record<AdminAction, string> = {
  patch: 'Notiskin wants to install into Notion so your themes load every time Notion starts.',
  unpatch: 'Notiskin wants to remove itself from Notion.',
};

const USERNAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

// single quotes keep everything literal in sh, a ' inside becomes '\''
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// the admin shell runs as root with a bare environment, SUDO_USER tells the CLI whose home and Notion to use
export function buildAdminCommand(action: AdminAction, opts: AdminCommandOptions): string {
  // the name also ends up in the sudoers rule, only accept what macOS allows for account names
  if (!USERNAME_PATTERN.test(opts.user)) throw new Error(`Unexpected user name: ${JSON.stringify(opts.user)}`);
  return [
    `SUDO_USER=${shellQuote(opts.user)}`,
    'ELECTRON_RUN_AS_NODE=1',
    shellQuote(opts.execPath),
    shellQuote(opts.cliPath),
    action,
    '2>&1',
  ].join(' ');
}

// command and prompt go in as argv, never pasted into AppleScript source
export function osascriptArgs(command: string, prompt: string): string[] {
  return [
    '-e', 'on run argv',
    '-e', 'do shell script (item 1 of argv) with prompt (item 2 of argv) with administrator privileges',
    '-e', 'end run',
    command,
    prompt,
  ];
}

// osascript reports a cancelled password dialog as error -128
export function isCancelled(stderr: string): boolean {
  return /\(-128\)/.test(stderr);
}

// osascript wraps failures as "0:123: execution error: <output> (1)", pull out the CLI's own "Error: ..." line
export function errorFromOutput(stderr: string): string {
  const text = stderr
    .replace(/\r/g, '\n')
    .replace(/^\d+:\d+: execution error: /, '')
    .replace(/\s*\(-?\d+\)\s*$/, '');
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const errorLine = [...lines].reverse().find(l => l.startsWith('Error:'));
  if (errorLine) return errorLine.slice('Error:'.length).trim();
  return lines[lines.length - 1] || 'Unknown error';
}

export function runAsAdmin(command: string, prompt: string): Promise<AdminResult> {
  return new Promise(resolve => {
    execFile(
      'osascript',
      osascriptArgs(command, prompt),
      { timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // do shell script hands output back with \r line endings
        const output = `${stdout}${stderr}`.replace(/\r/g, '\n');
        if (!err) return resolve({ status: 'ok', output });
        if (isCancelled(stderr)) return resolve({ status: 'cancelled' });
        resolve({ status: 'error', message: errorFromOutput(stderr || err.message), output });
      }
    );
  });
}
