/**
 * 360° tours — services/tour.service.ts
 * ============================================================================
 * A tour is one panorama per room, rendered by the photo render worker
 * (services/render.service.ts) in panorama mode, plus what the viewer needs:
 *
 *   nodes   where each panorama is taken from, and its pins to the next rooms
 *   plan    the rooms' outlines, for the floor-plan map
 *
 * Coordinates are the 3D scene's (three.js: x right, y up, z towards you).
 * The browser works them out; here they are only checked and bounded.
 */

import crypto from 'crypto';
import { supabase } from './supabase';
import { BUCKET } from './render.service';

export const MAX_TOUR_ROOMS = 16;

type V2 = [number, number];
type V3 = [number, number, number];

export interface TourLink { to: string; at: V2 }
export interface TourNode { id: string; roomId: string; name: string; position: V3; links: TourLink[] }
export interface TourPlan { rooms: { id: string; name: string; poly: V2[] }[]; bounds: [number, number, number, number] }

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const num = (v: unknown, lim = 1e4): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= lim ? n : null;
};
const v2 = (v: unknown): V2 | null => {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const a = num(v[0]), b = num(v[1]);
  return a === null || b === null ? null : [a, b];
};
const v3 = (v: unknown): V3 | null => {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const a = num(v[0]), b = num(v[1]), c = num(v[2]);
  return a === null || b === null || c === null ? null : [a, b, c];
};
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** The browser's nodes, checked. Links to unknown nodes are dropped. */
export function cleanNodes(raw: unknown): TourNode[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_TOUR_ROOMS) return null;
  const nodes: TourNode[] = [];
  for (const r of raw as any[]) {
    const position = v3(r?.position);
    if (!r || !ID.test(String(r.id)) || !position) return null;
    nodes.push({
      id: String(r.id),
      roomId: text(r.roomId, 80),
      name: text(r.name, 80) || 'Room',
      position,
      links: (Array.isArray(r.links) ? r.links.slice(0, 12) : [])
        .map((l: any) => ({ to: String(l?.to ?? ''), at: v2(l?.at) }))
        .filter((l: any): l is TourLink => ID.test(l.to) && !!l.at),
    });
  }
  const ids = new Set(nodes.map(n => n.id));
  if (ids.size !== nodes.length) return null;
  for (const n of nodes) n.links = n.links.filter(l => ids.has(l.to) && l.to !== n.id);
  return nodes;
}

/** The plan outline for the map, checked and bounded. */
export function cleanPlan(raw: unknown): TourPlan | null {
  const r = (raw ?? {}) as any;
  if (!Array.isArray(r.rooms) || r.rooms.length > 64) return null;
  const rooms = [];
  for (const room of r.rooms) {
    const poly = Array.isArray(room?.poly) ? room.poly.slice(0, 200).map(v2) : [];
    if (poly.length < 3 || poly.some((p: V2 | null) => !p)) continue;
    rooms.push({ id: text(room.id, 80), name: text(room.name, 80), poly: poly as V2[] });
  }
  const b = Array.isArray(r.bounds) && r.bounds.length === 4 ? r.bounds.map((x: unknown) => num(x)) : null;
  if (!b || b.some((x: number | null) => x === null) || b[2] <= b[0] || b[3] <= b[1]) return null;
  return { rooms, bounds: b as TourPlan['bounds'] };
}

export const newShareToken = () => crypto.randomBytes(18).toString('base64url');

/**
 * The tour as a viewer needs it: nodes with each panorama's status and a
 * signed link to its image. `forPublic` leaves out anything internal.
 */
export async function tourView(tour: any, forPublic = false) {
  const { data: jobs } = await supabase.from('render_jobs')
    .select('id, node_id, status, result_path, width, height')
    .eq('tour_id', tour.id);
  const byNode = new Map((jobs ?? []).map((j: any) => [j.node_id, j]));
  const paths = (jobs ?? []).filter((j: any) => j.status === 'done' && j.result_path).map((j: any) => j.result_path);
  const urls = new Map<string, string>();
  if (paths.length) {
    const { data } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 12 * 3600);
    for (const d of data ?? []) if (d.path && d.signedUrl) urls.set(d.path, d.signedUrl);
  }
  const nodes = (tour.nodes as TourNode[]).map(n => {
    const j: any = byNode.get(n.id);
    return {
      ...n,
      status: j?.status ?? 'failed',
      url: j?.result_path ? urls.get(j.result_path) ?? null : null,
    };
  });
  const done = nodes.filter(n => n.status === 'done').length;
  return {
    id: tour.id,
    title: tour.title,
    status: tour.status,
    quality: tour.quality,
    createdAt: tour.created_at,
    progress: { done, total: nodes.length },
    nodes: forPublic ? nodes.filter(n => n.status === 'done') : nodes,
    plan: tour.plan,
    ...(forPublic ? {} : { projectId: tour.project_id, shared: !!tour.share_token, shareToken: tour.share_token ?? null }),
  };
}
