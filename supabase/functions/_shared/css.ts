// themes that pass this check are auto-approved and run in every user's Notion,
// so this is an allowlist: only --ns-* variables inside :root, only color-ish values
// no quotes or backslashes (blocks CSS escapes like \75rl( and string-based image loads)
// two exceptions: the font variables may hold font names in double quotes (a name can only pick a font
// that is already installed, there is no @font-face and no url()), and the :root block may be wrapped
// in @media (prefers-color-scheme: dark | light) for a dark or light variant

const ALLOWED_FUNCTIONS = new Set([
  'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix',
  'var', 'calc', 'min', 'max', 'clamp',
  'linear-gradient', 'radial-gradient', 'conic-gradient',
  'repeating-linear-gradient', 'repeating-radial-gradient', 'repeating-conic-gradient',
]);

const PROPERTY_PATTERN = /^--ns-[a-z0-9-]{1,64}$/;
const VALUE_CHARSET = /^[a-zA-Z0-9#%.,+\-*/()\s!]*$/;
const MAX_CSS_LENGTH = 20_000;

// the only variables that may contain quotes, and only as a short list of font names:
// a name in double quotes (letters, digits, spaces, hyphens) or a plain word like serif or Georgia
const FONT_PROPERTIES = new Set(['--ns-font', '--ns-font-title', '--ns-font-code']);
const FONT_NAME = '(?:"[A-Za-z0-9][A-Za-z0-9 \\-]{0,39}"|[A-Za-z][A-Za-z0-9-]{0,39})';
const FONT_LIST = new RegExp(`^${FONT_NAME}(?:\\s*,\\s*${FONT_NAME}){0,7}$`);

// exactly this wrapper and nothing else: no other media queries, no other rules inside, no nesting
const ROOT_BLOCK = /:root\s*\{([^{}]*)\}/g;
const SCHEME_BLOCK = /@media\s*\(\s*prefers-color-scheme\s*:\s*(?:dark|light)\s*\)\s*\{\s*((?::root\s*\{[^{}]*\}\s*)+)\}/g;
const MAX_SCHEME_BLOCKS = 2;

export function validateThemeCss(css: unknown): string | null {
  if (typeof css !== 'string' || !css.trim()) return 'Theme CSS is empty';
  if (css.length > MAX_CSS_LENGTH) return `Theme CSS is too long (max ${MAX_CSS_LENGTH} characters)`;

  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/\/\*|\*\//.test(stripped)) return 'Unclosed comment';

  const bodies: string[] = [];
  let schemeBlocks = 0;
  const withoutSchemes = stripped.replace(SCHEME_BLOCK, (_match, inner: string) => {
    schemeBlocks++;
    for (const [, body] of inner.matchAll(ROOT_BLOCK)) bodies.push(body);
    return '';
  });
  const outside = withoutSchemes.replace(ROOT_BLOCK, (_match, body: string) => {
    bodies.push(body);
    return '';
  });
  if (bodies.length === 0 || /\S/.test(outside)) return 'All rules must be inside a :root block';
  if (schemeBlocks > MAX_SCHEME_BLOCKS) return `At most ${MAX_SCHEME_BLOCKS} prefers-color-scheme blocks (one dark, one light)`;

  for (const body of bodies) {
    for (const rawDecl of body.split(';')) {
      const decl = rawDecl.trim();
      if (!decl) continue;
      const colon = decl.indexOf(':');
      if (colon === -1) return `Invalid declaration: ${decl.slice(0, 40)}`;
      const prop = decl.slice(0, colon).trim();
      const value = decl.slice(colon + 1).trim();
      if (!PROPERTY_PATTERN.test(prop)) return `${prop.slice(0, 40)} must start with --ns-`;
      if (!value) return `${prop} has no value`;
      if (FONT_PROPERTIES.has(prop)) {
        if (!FONT_LIST.test(value)) return `${prop} must be a list of up to 8 font names, like "Inter", Georgia, serif`;
        continue;
      }
      if (!VALUE_CHARSET.test(value)) return `${prop} contains characters that aren't allowed`;
      for (const [, fn] of value.matchAll(/([a-zA-Z-]+)\s*\(/g)) {
        if (!ALLOWED_FUNCTIONS.has(fn.toLowerCase())) return `${fn}() isn't allowed`;
      }
    }
  }
  return null;
}
