/**
 * Favourites — services/favourites.service.ts
 * Library pieces (catalogue ids) and marketplace products (uuids), per user.
 */

import { supabase } from './supabase';

export type FavouriteKind = 'library' | 'product';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIBRARY_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/** A valid { kind, ref }, or null. Products are uuids; library ids are slugs. */
export function cleanFavourite(raw: any): { kind: FavouriteKind; ref: string } | null {
  const kind = raw?.kind;
  const ref = typeof raw?.ref === 'string' ? raw.ref.trim() : '';
  if (kind === 'product' && UUID.test(ref)) return { kind, ref: ref.toLowerCase() };
  if (kind === 'library' && LIBRARY_ID.test(ref)) return { kind, ref };
  return null;
}

export async function listFavourites(userId: string) {
  const { data, error } = await supabase
    .from('favourites').select('kind, ref, created_at')
    .eq('user_id', userId).order('created_at', { ascending: false }).limit(1000);
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function setFavourite(userId: string, fav: { kind: FavouriteKind; ref: string }, on: boolean) {
  const q = on
    ? supabase.from('favourites').upsert({ user_id: userId, ...fav }, { onConflict: 'user_id,kind,ref', ignoreDuplicates: true })
    : supabase.from('favourites').delete().eq('user_id', userId).eq('kind', fav.kind).eq('ref', fav.ref);
  const { error } = await q;
  if (error) throw new Error(error.message);
}

/** Bring favourites saved while signed out into the account. */
export async function mergeFavourites(userId: string, raw: unknown) {
  const items = (Array.isArray(raw) ? raw : []).map(cleanFavourite).filter(Boolean).slice(0, 200) as { kind: FavouriteKind; ref: string }[];
  if (!items.length) return 0;
  const { error } = await supabase.from('favourites')
    .upsert(items.map(i => ({ user_id: userId, ...i })), { onConflict: 'user_id,kind,ref', ignoreDuplicates: true });
  if (error) throw new Error(error.message);
  return items.length;
}
