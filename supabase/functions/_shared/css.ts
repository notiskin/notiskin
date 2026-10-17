// themes that pass this check are auto-approved and run in every user's Notion,
// so this is an allowlist: only --ns-* variables inside :root, only color-ish values
// no quotes or backslashes (blocks CSS escapes like \75rl( and string-based image loads)

const ALLOWED_FUNCTIONS = new Set([
  'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix',
  'var', 'calc', 'min', 'max', 'clamp',
  'linear-gradient', 'radial-gradient', 'conic-gradient',
  'repeating-linear-gradient', 'repeating-radial-gradient', 'repeating-conic-gradient',
]);

const PROPERTY_PATTERN = /^--ns-[a-z0-9-]{1,64}$/;
const VALUE_CHARSET = /^[a-zA-Z0-9#%.,+\-*/()\s!]*$/;
const MAX_CSS_LENGTH = 20_000;

export function validateThemeCss(css: unknown): string | null {
  if (typeof css !== 'string' || !css.trim()) return 'Theme CSS is empty';
  if (css.length > MAX_CSS_LENGTH) return `Theme CSS is too long (max ${MAX_CSS_LENGTH} characters)`;

  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/\/\*|\*\//.test(stripped)) return 'Unclosed comment';

  const blocks = [...stripped.matchAll(/:root\s*\{([^{}]*)\}/g)];
  const outside = stripped.replace(/:root\s*\{[^{}]*\}/g, '');
  if (blocks.length === 0 || /\S/.test(outside)) return 'All rules must be inside a :root block';

  for (const [, body] of blocks) {
    for (const rawDecl of body.split(';')) {
      const decl = rawDecl.trim();
      if (!decl) continue;
      const colon = decl.indexOf(':');
      if (colon === -1) return `Invalid declaration: ${decl.slice(0, 40)}`;
      const prop = decl.slice(0, colon).trim();
      const value = decl.slice(colon + 1).trim();
      if (!PROPERTY_PATTERN.test(prop)) return `${prop.slice(0, 40)} must start with --ns-`;
      if (!value) return `${prop} has no value`;
      if (!VALUE_CHARSET.test(value)) return `${prop} contains characters that aren't allowed`;
      for (const [, fn] of value.matchAll(/([a-zA-Z-]+)\s*\(/g)) {
        if (!ALLOWED_FUNCTIONS.has(fn.toLowerCase())) return `${fn}() isn't allowed`;
      }
    }
  }
  return null;
}
