// tags and the optional GitHub link on a theme or plugin. TAGS must match the list in the
// 20261023000000_tags_links_downloads migration and in the GUI

export const TAGS = ['dark', 'light', 'minimal', 'colorful', 'productivity', 'fun', 'accessibility', 'fonts'] as const;
export const MAX_TAGS = 3;

const LINK_PATTERN = /^https:\/\/(gist\.)?github\.com\/[A-Za-z0-9._~/-]{1,200}$/;

// undefined/null -> [], otherwise up to 3 known tags without repeats, null if anything is off
export function cleanTags(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const tags = [...new Set(raw)];
  if (tags.length > MAX_TAGS) return null;
  if (!tags.every(t => typeof t === 'string' && (TAGS as readonly string[]).includes(t))) return null;
  return tags as string[];
}

// '' / undefined / null -> null (no link), a github.com or gist link -> itself, anything else -> false
export function cleanLink(raw: unknown): string | null | false {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return false;
  const link = raw.trim();
  if (!link) return null;
  return LINK_PATTERN.test(link) ? link : false;
}
