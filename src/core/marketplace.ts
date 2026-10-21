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

// "dark,minimal" -> ['dark', 'minimal']; unknown tags are dropped, so Browse never sends a bad filter
export function parseTags(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  const known = raw.split(',').filter(t => (MARKETPLACE_TAGS as readonly string[]).includes(t));
  return [...new Set(known)];
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

// marketplace item ids are UUIDs; anything else in the manifest can't be asked about (Postgres would
// refuse the whole query over it)
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ids of installed marketplace items of one type, to ask Supabase about
export function installedIds(type: ItemType, manifest: InstalledManifest = readInstalled()): string[] {
  const ids = Object.entries(manifest).filter(([k]) => k.startsWith(`${type}:`)).map(([, e]) => e.id);
  return [...new Set(ids.filter(id => UUID_PATTERN.test(id)))];
}

// what the marketplace says about an installed item: still live, hidden after reports while a reviewer
// looks, rejected by a reviewer, or gone (not in the answer at all)
export type ItemStatus = 'approved' | 'hidden' | 'rejected';
export type PulledReason = 'hidden' | 'rejected' | 'removed';

export interface PulledItem {
  type: ItemType;
  name: string;
  id: string;
  reason: PulledReason;
}

// installed items whose marketplace item was hidden, rejected or removed, for one type. statuses is keyed
// by item id and must hold every id the marketplace answered for; an id it left out counts as removed.
// Only for showing a warning: nothing here turns anything off or deletes it
export function findPulled(
  type: ItemType,
  statuses: Map<string, ItemStatus>,
  manifest: InstalledManifest = readInstalled(),
): PulledItem[] {
  const pulled: PulledItem[] = [];
  for (const [key, entry] of Object.entries(manifest)) {
    if (!key.startsWith(`${type}:`)) continue;
    const name = key.slice(type.length + 1);
    if (!UUID_PATTERN.test(entry.id) || !itemExists(type, name)) continue;
    const status = statuses.get(entry.id);
    if (status === 'approved') continue;
    pulled.push({ type, name, id: entry.id, reason: status ?? 'removed' });
  }
  return pulled.sort((a, b) => a.name.localeCompare(b.name));
}

// item_statuses() takes at most this many ids per call
export const STATUS_BATCH = 200;

export function inBatches<T>(list: T[], size = STATUS_BATCH): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < list.length; i += size) batches.push(list.slice(i, i + size));
  return batches;
}
