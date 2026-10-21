// installing and updating marketplace items on disk. The server fetches approved code from Supabase and
// hands it here; nothing in this file talks to the network
import { readFileSync } from 'fs';
import { ItemType, isValidItemName, itemExists, itemPath, toFileStem, writeItem } from './library';
import { InstalledManifest, installedEntry, readInstalled, recordInstall } from './installed';

// must match TAGS in supabase/functions/_shared/details.ts and the tags migration
export const MARKETPLACE_TAGS = ['dark', 'light', 'minimal', 'colorful', 'productivity', 'fun', 'accessibility', 'fonts'] as const;

export type MarketplaceSort = 'newest' | 'rating' | 'downloads';

export function parseSort(raw: unknown): MarketplaceSort {
  return raw === 'rating' || raw === 'downloads' ? raw : 'newest';
}

export function parseTag(raw: unknown): string | null {
  return typeof raw === 'string' && (MARKETPLACE_TAGS as readonly string[]).includes(raw) ? raw : null;
}

export interface MarketplaceItem {
  id: string;
  name: string;
  code: string;
  version: number;
}

export type InstallResult =
  | { outcome: 'installed' | 'already-installed'; name: string }
  | { outcome: 'conflict'; name: string };

// writes an approved item to disk and remembers where it came from. A file with the same name that the
// user made themselves (or that came from a different item) is never replaced
export function installFromMarketplace(type: ItemType, item: MarketplaceItem): InstallResult {
  const name = toFileStem(item.name);
  if (!isValidItemName(name)) throw new Error('Item has an unusable name');

  if (itemExists(type, name)) {
    const entry = installedEntry(type, name);
    if (entry?.id === item.id) return { outcome: 'already-installed', name };
    if (entry) return { outcome: 'conflict', name };
    // installed before the manifest existed: adopt it only when it's exactly the marketplace code
    if (readFileSync(itemPath(type, name), 'utf-8') === item.code) {
      recordInstall(type, name, { id: item.id, version: item.version });
      return { outcome: 'already-installed', name };
    }
    return { outcome: 'conflict', name };
  }

  writeItem(type, name, item.code);
  recordInstall(type, name, { id: item.id, version: item.version });
  return { outcome: 'installed', name };
}

// replaces an installed marketplace file with a newer approved version of the same item
export function updateFromMarketplace(type: ItemType, name: string, item: MarketplaceItem): void {
  const entry = installedEntry(type, name);
  if (!entry || !itemExists(type, name)) throw new Error(`That ${type} didn't come from the marketplace.`);
  if (entry.id !== item.id) throw new Error(`That ${type} came from a different marketplace item.`);
  if (item.version <= entry.version) throw new Error(`That ${type} is already up to date.`);
  writeItem(type, name, item.code);
  recordInstall(type, name, { id: item.id, version: item.version });
}

export interface LatestInfo {
  version: number;
  // what changed in each version, newest first
  changes: { version: number; changelog: string }[];
}

export interface AvailableUpdate {
  type: ItemType;
  name: string;
  id: string;
  installedVersion: number;
  latestVersion: number;
  changes: { version: number; changelog: string }[];
}

// installed items whose marketplace version is newer, for one type. latest is keyed by item id
export function findUpdates(
  type: ItemType,
  latest: Map<string, LatestInfo>,
  manifest: InstalledManifest = readInstalled(),
): AvailableUpdate[] {
  const updates: AvailableUpdate[] = [];
  for (const [key, entry] of Object.entries(manifest)) {
    if (!key.startsWith(`${type}:`)) continue;
    const name = key.slice(type.length + 1);
    const info = latest.get(entry.id);
    if (!info || info.version <= entry.version || !itemExists(type, name)) continue;
    updates.push({
      type,
      name,
      id: entry.id,
      installedVersion: entry.version,
      latestVersion: info.version,
      changes: info.changes.filter(c => c.version > entry.version && c.version <= info.version && c.changelog),
    });
  }
  return updates.sort((a, b) => a.name.localeCompare(b.name));
}

// ids of installed marketplace items of one type, to ask Supabase about
export function installedIds(type: ItemType, manifest: InstalledManifest = readInstalled()): string[] {
  return [...new Set(Object.entries(manifest).filter(([k]) => k.startsWith(`${type}:`)).map(([, e]) => e.id))];
}
