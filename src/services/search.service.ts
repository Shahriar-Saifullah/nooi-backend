/**
 * Platform-wide search — services/search.service.ts
 * ============================================================================
 * One call into the platform_search() database function (20261108), which
 * does the matching (substring + typo-tolerant trigram) and the visibility
 * rules per scope. This file decides the scope from the signed-in account —
 * never from the request — and which kinds of result that scope can ask for.
 */

import { supabase } from './supabase';

export type SearchScope = 'public' | 'client' | 'vendor' | 'admin';
export type SearchKind = 'product' | 'vendor' | 'project' | 'order' | 'invoice' | 'ticket' | 'account';

export const KINDS_BY_SCOPE: Record<SearchScope, SearchKind[]> = {
  public: ['product', 'vendor'],
  client: ['product', 'vendor', 'project', 'order', 'invoice', 'ticket'],
  vendor: ['product', 'vendor', 'project', 'order', 'ticket'],
  admin: ['product', 'vendor', 'order', 'invoice', 'ticket', 'account'],
};

export function scopeForRole(role: string | null | undefined, signedIn: boolean): SearchScope {
  if (!signedIn) return 'public';
  if (role === 'admin' || role === 'super_admin') return 'admin';
  if (role === 'vendor') return 'vendor';
  return 'client';
}

/** The kinds asked for, narrowed to what this scope may see. */
export function kindsFor(scope: SearchScope, asked: unknown): SearchKind[] {
  const allowed = KINDS_BY_SCOPE[scope];
  const list = typeof asked === 'string' && asked.trim()
    ? asked.split(',').map(s => s.trim())
    : Array.isArray(asked) ? asked.map(String) : [];
  const picked = list.filter((k): k is SearchKind => (allowed as string[]).includes(k));
  return picked.length ? picked : allowed;
}

/** Trim, collapse spaces, cap the length. Empty / one letter → null. */
export function cleanQuery(raw: unknown): string | null {
  const q = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return q.length >= 2 ? q : null;
}

export interface SearchHit {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle: string | null;
  image: string | null;
  ref: string | null;
  status: string | null;
  score: number;
}

export async function searchPlatform(q: string, userId: string | null, scope: SearchScope, kinds: SearchKind[], perKind = 6) {
  const { data, error } = await supabase.rpc('platform_search', {
    p_q: q,
    p_user: userId,
    p_scope: scope,
    p_kinds: kinds,
    p_limit: perKind,
  });
  if (error) throw new Error(error.message);
  const hits = ((data ?? []) as any[]).map(r => ({
    kind: r.kind, id: r.id, title: r.title, subtitle: r.subtitle || null,
    image: r.image || null, ref: r.ref || null, status: r.status || null, score: Number(r.score) || 0,
  })) as SearchHit[];
  // groups in a fixed order; best first inside each
  const groups = kinds
    .map(kind => ({ kind, hits: hits.filter(h => h.kind === kind).sort((a, b) => b.score - a.score) }))
    .filter(g => g.hits.length);
  return { groups, total: hits.length };
}
