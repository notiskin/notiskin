// Plugin settings. A plugin declares them in a comment at the top of its file, one line per setting:
//
//   /**
//    * @notiskin-setting {"key":"accent","type":"color","label":"Accent color","default":"#e8590c"}
//    * @notiskin-setting {"key":"compact","type":"toggle","label":"Compact sidebar","default":false}
//    */
//
// The app reads the comment as text and never runs the plugin to do it, so the Settings form works for a plugin
// that is switched off, and a plugin can't use its own declaration to run anything. A line that doesn't parse or
// doesn't make sense is skipped with a note, the rest still work. Values the user picks live in the config
// (pluginSettings, by plugin name) and reach the page next to the plugin's code

export type SettingValue = boolean | string | number;
export type SettingValues = Record<string, SettingValue>;

interface SettingBase {
  key: string;
  label: string;
  description?: string;
}

export type SettingDecl =
  | (SettingBase & { type: 'toggle'; default: boolean })
  | (SettingBase & { type: 'text'; default: string; maxLength: number })
  | (SettingBase & { type: 'number'; default: number; min?: number; max?: number; step?: number })
  | (SettingBase & { type: 'select'; default: string; options: string[] })
  | (SettingBase & { type: 'color'; default: string });

export interface ParsedSettings {
  settings: SettingDecl[];
  // one plain sentence per line that was skipped, for the form and for plugin authors
  problems: string[];
}

export const MAX_SETTINGS = 20;
const MAX_HEADER_CHARS = 20_000;
const MAX_LINE_CHARS = 1_000;
const MAX_TEXT_LENGTH = 2_000;
const DEFAULT_TEXT_LENGTH = 200;
const MAX_OPTIONS = 20;
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const TAG = '@notiskin-setting';

// the comments before the first line of code: block comments and // lines, nothing else
function headerComments(source: string): string {
  let text = source.replace(/^\uFEFF/, '');
  let out = '';
  for (;;) {
    text = text.trimStart();
    if (out.length > MAX_HEADER_CHARS) break;
    if (text.startsWith('/*')) {
      const end = text.indexOf('*/');
      if (end < 0) break;
      out += `${text.slice(2, end)}\n`;
      text = text.slice(end + 2);
    } else if (text.startsWith('//')) {
      const end = text.indexOf('\n');
      out += `${text.slice(2, end < 0 ? undefined : end)}\n`;
      text = end < 0 ? '' : text.slice(end + 1);
    } else {
      break;
    }
  }
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function describe(raw: Record<string, unknown>): SettingBase | string {
  const { key, label, description } = raw;
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) return 'the key must be letters, numbers and underscores, starting with a letter (40 at most)';
  if (typeof label !== 'string' || !label.trim() || label.length > 60) return `"${key}" needs a label of 1 to 60 characters`;
  if (description !== undefined && (typeof description !== 'string' || description.length > 200)) return `"${key}" has a description over 200 characters`;
  return { key, label: label.trim(), ...(typeof description === 'string' && description.trim() ? { description: description.trim() } : {}) };
}

function declaration(raw: unknown): SettingDecl | string {
  if (!isObject(raw)) return 'it is not an object';
  const base = describe(raw);
  if (typeof base === 'string') return base;
  const { key } = base;
  const fail = (why: string) => `"${key}" ${why}`;

  switch (raw.type) {
    case 'toggle':
      if (typeof raw.default !== 'boolean') return fail('needs "default": true or false');
      return { ...base, type: 'toggle', default: raw.default };
    case 'text': {
      const maxLength = raw.maxLength === undefined ? DEFAULT_TEXT_LENGTH : raw.maxLength;
      if (!isFiniteNumber(maxLength) || !Number.isInteger(maxLength) || maxLength < 1 || maxLength > MAX_TEXT_LENGTH) {
        return fail(`needs a "maxLength" from 1 to ${MAX_TEXT_LENGTH}`);
      }
      if (typeof raw.default !== 'string' || raw.default.length > maxLength) return fail('needs a text "default" that fits in maxLength');
      return { ...base, type: 'text', default: raw.default, maxLength };
    }
    case 'number': {
      for (const field of ['min', 'max', 'step'] as const) {
        if (raw[field] !== undefined && !isFiniteNumber(raw[field])) return fail(`has a "${field}" that is not a number`);
      }
      const { min, max, step } = raw as { min?: number; max?: number; step?: number };
      if (step !== undefined && step <= 0) return fail('needs a "step" above 0');
      if (min !== undefined && max !== undefined && min > max) return fail('has a "min" above its "max"');
      if (!isFiniteNumber(raw.default)) return fail('needs a number "default"');
      if ((min !== undefined && raw.default < min) || (max !== undefined && raw.default > max)) return fail('has a "default" outside its min and max');
      return {
        ...base,
        type: 'number',
        default: raw.default,
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
        ...(step !== undefined ? { step } : {}),
      };
    }
    case 'select': {
      const options = raw.options;
      if (!Array.isArray(options) || options.length < 1 || options.length > MAX_OPTIONS || !options.every(o => typeof o === 'string' && o.length >= 1 && o.length <= 60)) {
        return fail(`needs "options": 1 to ${MAX_OPTIONS} texts of up to 60 characters`);
      }
      if (new Set(options).size !== options.length) return fail('lists the same option twice');
      if (typeof raw.default !== 'string' || !options.includes(raw.default)) return fail('needs a "default" that is one of its options');
      return { ...base, type: 'select', default: raw.default, options: options as string[] };
    }
    case 'color':
      if (typeof raw.default !== 'string' || !COLOR_PATTERN.test(raw.default)) return fail('needs a "default" like "#e8590c"');
      return { ...base, type: 'color', default: raw.default.toLowerCase() };
    default:
      return fail('has a "type" that is not toggle, text, number, select or color');
  }
}

export function parseSettingDeclarations(source: string): ParsedSettings {
  const settings: SettingDecl[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of headerComments(source).split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*\*?\s*/, '');
    if (!line.startsWith(TAG)) continue;
    const json = line.slice(TAG.length).trim();
    if (json.length > MAX_LINE_CHARS) {
      problems.push(`A setting line is longer than ${MAX_LINE_CHARS} characters, skipped.`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      problems.push(`Skipped a setting that isn't valid JSON: ${json.slice(0, 50)}`);
      continue;
    }
    const decl = declaration(parsed);
    if (typeof decl === 'string') {
      problems.push(`Skipped a setting: ${decl}.`);
      continue;
    }
    if (seen.has(decl.key)) {
      problems.push(`Skipped a second setting called "${decl.key}".`);
      continue;
    }
    if (settings.length >= MAX_SETTINGS) {
      problems.push(`Only the first ${MAX_SETTINGS} settings are used.`);
      break;
    }
    seen.add(decl.key);
    settings.push(decl);
  }
  return { settings, problems };
}

export type CheckResult = { ok: true; value: SettingValue } | { ok: false; error: string };

// strict: what the form may send. Anything off is an error, nothing is quietly fixed
export function checkSettingValue(decl: SettingDecl, value: unknown): CheckResult {
  const bad = (error: string): CheckResult => ({ ok: false, error: `${decl.label}: ${error}` });
  switch (decl.type) {
    case 'toggle':
      return typeof value === 'boolean' ? { ok: true, value } : bad('must be on or off');
    case 'text':
      if (typeof value !== 'string') return bad('must be text');
      return value.length <= decl.maxLength ? { ok: true, value } : bad(`is longer than ${decl.maxLength} characters`);
    case 'number':
      if (!isFiniteNumber(value)) return bad('must be a number');
      if (decl.min !== undefined && value < decl.min) return bad(`must be at least ${decl.min}`);
      if (decl.max !== undefined && value > decl.max) return bad(`must be at most ${decl.max}`);
      return { ok: true, value };
    case 'select':
      return typeof value === 'string' && decl.options.includes(value) ? { ok: true, value } : bad('must be one of the choices');
    case 'color':
      return typeof value === 'string' && COLOR_PATTERN.test(value) ? { ok: true, value: value.toLowerCase() } : bad('must be a color like #e8590c');
  }
}

// lenient: what a plugin gets. The default for a missing or no longer valid saved value, a number pulled inside
// a range that has changed since it was saved
export function resolveSettings(decls: SettingDecl[], saved?: Record<string, unknown>): SettingValues {
  const values: SettingValues = {};
  for (const decl of decls) {
    let value: SettingValue = decl.default;
    const have = saved?.[decl.key];
    if (have !== undefined) {
      const candidate =
        decl.type === 'number' && isFiniteNumber(have)
          ? Math.min(decl.max ?? Infinity, Math.max(decl.min ?? -Infinity, have))
          : have;
      const result = checkSettingValue(decl, candidate);
      if (result.ok) value = result.value;
    }
    values[decl.key] = value;
  }
  return values;
}

// what the config keeps: plain values only, by plugin name, and nothing for a name that isn't text
export function parsePluginSettings(raw: unknown): Record<string, Record<string, SettingValue>> {
  const out: Record<string, Record<string, SettingValue>> = {};
  if (!isObject(raw)) return out;
  for (const [plugin, values] of Object.entries(raw)) {
    if (!isObject(values)) continue;
    const clean: Record<string, SettingValue> = {};
    for (const [key, value] of Object.entries(values)) {
      if (KEY_PATTERN.test(key) && (typeof value === 'boolean' || typeof value === 'string' || isFiniteNumber(value))) clean[key] = value;
    }
    if (Object.keys(clean).length) out[plugin] = clean;
  }
  return out;
}
