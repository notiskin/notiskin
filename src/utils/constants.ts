import { join } from 'path';
import { homedir } from 'os';

// under sudo, $HOME = /var/root, use SUDO_USER so patch/unpatch still find the real user's files
export const USER_HOME = process.env.SUDO_USER ? join('/Users', process.env.SUDO_USER) : homedir();

// NOTISKIN_DIR env override lets tests and development use a throwaway folder
export const NOTISKIN_DIR = process.env.NOTISKIN_DIR || join(USER_HOME, '.notiskin');
export const THEMES_DIR = join(NOTISKIN_DIR, 'themes');
export const PLUGINS_DIR = join(NOTISKIN_DIR, 'plugins');
export const CONFIG_PATH = join(NOTISKIN_DIR, 'notiskin.config.json');
export const LOGS_DIR = join(NOTISKIN_DIR, 'logs');
export const INJECTOR_PID_PATH = join(NOTISKIN_DIR, 'injector.pid');

export const CDP_PORT = 9222;
export const GUI_PORT = 3845;
export const GUI_HOST = '127.0.0.1';

// publishable key is meant to ship to clients, row level security guards the data
export const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rdsoztlxtbfwdjcfqhmt.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_4B-pmRj4FBVVqIsvlF1fjQ_Lzby0Yrq';

// marketplace items are small, anything bigger is almost certainly a mistake or abuse
export const MAX_ITEM_BYTES = 512 * 1024;
