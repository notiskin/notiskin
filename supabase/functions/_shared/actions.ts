import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';

// the reviewer action log (review_actions, append-only). Every review decision goes through here
export type ReviewAction =
  | 'approve'
  | 'reject'
  | 'approve_version'
  | 'reject_version'
  | 'hide'
  | 'unhide'
  | 'dismiss_report';

export interface ActionEntry {
  actor: string;
  action: ReviewAction;
  itemType?: 'theme' | 'plugin';
  itemId?: string;
  versionId?: string;
  reportId?: string;
  reason?: string | null;
}

// returns false if the entry couldn't be written, the caller tells the reviewer
export async function logAction(db: SupabaseClient, entry: ActionEntry): Promise<boolean> {
  const { error } = await db.from('review_actions').insert({
    actor_github: entry.actor,
    action: entry.action,
    item_type: entry.itemType ?? null,
    item_id: entry.itemId ?? null,
    version_id: entry.versionId ?? null,
    report_id: entry.reportId ?? null,
    reason: (entry.reason ?? '').slice(0, 1000),
  });
  if (error) console.error('review action log failed', error);
  return !error;
}

export const REPORT_REASONS = ['harmful', 'broken', 'offensive', 'copyright', 'spam', 'other'] as const;
