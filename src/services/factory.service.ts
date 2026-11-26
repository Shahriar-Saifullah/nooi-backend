/**
 * Factory files — services/factory.service.ts
 * ============================================================================
 * Phase 1 of working with factories: what a factory needs with a listing or
 * an order line, as attachments and plain text. Nothing here is enforced —
 * factories told us their size rules are guidance they confirm, not limits.
 *
 *   drawings   DWG / DXF / PDF files on a listing (the vendor's own product
 *              drawings) or on an order line (the client's or designer's
 *              drawing of what to build; the factory may add its own)
 *   spec       the options form from the factory's own drawing sheets:
 *              carcass, back, doors, hinges, handles, runners, fillers, kick
 *              board, end panels, how it's installed — all optional text
 *   sizes      size ranges + a note on listings, shown as guidance
 *
 * Files sit in the PRIVATE bucket "factory-drawings". Browsers upload
 * straight to storage with a signed upload URL (a DWG can be 10 MB+), then
 * tell the API to attach the file; reads get signed links for an hour.
 */

import { randomUUID } from 'crypto';
import { supabase } from './supabase';

export const DRAWINGS_BUCKET = 'factory-drawings';
export const MAX_DRAWINGS = 10;
export const MAX_DRAWING_BYTES = 50 * 1024 * 1024;
const SIGNED_FOR_SECONDS = 3600;

export type DrawingKind = 'dwg' | 'dxf' | 'pdf';
export type DrawingRole = 'vendor' | 'customer' | 'admin';

export interface Drawing {
  path: string;
  name: string;
  size: number;
  kind: DrawingKind;
  uploaded_at: string;
  uploaded_by: string;
  role: DrawingRole;
}
export interface SignedDrawing extends Drawing { url: string | null }

/** The file type from its name: only drawings and PDFs. */
export function drawingKind(name: unknown): DrawingKind | null {
  const ext = String(name ?? '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return ext === 'dwg' || ext === 'dxf' || ext === 'pdf' ? ext : null;
}

/** A storage-safe file name that keeps the extension (Chinese names become "drawing"). */
export function safeFileName(name: string): string {
  const kind = drawingKind(name) ?? 'bin';
  const stem = name.replace(/\.[^.]*$/, '').normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `${stem || 'drawing'}.${kind}`;
}

export type UploadScope =
  | { scope: 'listing'; productId: string }
  | { scope: 'listing-draft'; userId: string }
  | { scope: 'order-item'; orderId: string; itemId: string };

/** Where an upload goes. Everything for one listing / order line shares a prefix. */
export function prefixFor(s: UploadScope): string {
  if (s.scope === 'listing') return `listings/${s.productId}/`;
  if (s.scope === 'listing-draft') return `listings/draft/${s.userId}/`;
  return `orders/${s.orderId}/${s.itemId}/`;
}

export function newDrawingPath(s: UploadScope, name: string): string {
  return `${prefixFor(s)}${randomUUID()}/${safeFileName(name)}`;
}

/** Check an upload request: a drawing type, under the size limit. */
export function uploadProblem(name: unknown, size: unknown): string | null {
  if (!drawingKind(name)) return 'Only DWG, DXF or PDF files can be attached.';
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return 'That file is empty.';
  if (n > MAX_DRAWING_BYTES) return `Each file must be under ${MAX_DRAWING_BYTES / 1024 / 1024} MB.`;
  return null;
}

/** A file reference from a client, accepted only under the expected prefix. */
export function cleanDrawingRef(raw: unknown, prefix: string, who: { id: string; role: DrawingRole }, now = new Date()): Drawing | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const path = typeof r.path === 'string' ? r.path : '';
  if (!path.startsWith(prefix) || path.includes('..') || path.length > 400) return null;
  const name = String(r.name ?? '').trim().slice(0, 160) || path.split('/').pop()!;
  const kind = drawingKind(path);
  const size = Math.round(Number(r.size));
  if (!kind || !Number.isFinite(size) || size <= 0 || size > MAX_DRAWING_BYTES) return null;
  return { path, name, size, kind, uploaded_at: now.toISOString(), uploaded_by: who.id, role: who.role };
}

/** Stored drawings, defensively (old rows, hand edits). */
export function drawingsOf(raw: unknown): Drawing[] {
  return Array.isArray(raw) ? raw.filter((d): d is Drawing => !!d && typeof d.path === 'string' && !!drawingKind(d.path)) : [];
}

export async function signDrawings(list: Drawing[]): Promise<SignedDrawing[]> {
  if (!list.length) return [];
  const { data } = await supabase.storage.from(DRAWINGS_BUCKET).createSignedUrls(list.map(d => d.path), SIGNED_FOR_SECONDS, { download: true } as never);
  const urls = new Map<string, string>();
  for (const d of data ?? []) if (d.path && d.signedUrl) urls.set(d.path, d.signedUrl);
  return list.map(d => ({ ...d, url: urls.get(d.path) ?? null }));
}

/** Does the uploaded object exist (the browser really finished the upload)? */
export async function drawingExists(path: string): Promise<boolean> {
  const dir = path.slice(0, path.lastIndexOf('/'));
  const file = path.slice(path.lastIndexOf('/') + 1);
  const { data, error } = await supabase.storage.from(DRAWINGS_BUCKET).list(dir, { search: file, limit: 5 });
  return !error && !!data?.some(o => o.name === file);
}

export async function removeDrawingFiles(paths: string[]) {
  if (paths.length) await supabase.storage.from(DRAWINGS_BUCKET).remove(paths).catch(() => undefined);
}

// ── the factory spec ────────────────────────────────────────────────────────

/** The options form on factory drawing sheets (Chinese labels from the sample factory). */
export const SPEC_FIELDS = [
  { key: 'dimensions', label: 'Overall size (W × H × D, mm)', zh: '尺寸' },
  { key: 'carcass', label: 'Carcass material and colour', zh: '柜体材质/颜色' },
  { key: 'back', label: 'Back panel material and colour', zh: '背板材质/颜色' },
  { key: 'doors', label: 'Hinged doors: model and colour', zh: '开门型号/颜色' },
  { key: 'sliding_doors', label: 'Sliding doors: model and colour', zh: '移门型号/颜色' },
  { key: 'hinges', label: 'Hinges (full overlay / half / inset, how many)', zh: '门铰 全盖/半盖/内掩' },
  { key: 'handles', label: 'Handles', zh: '拉手' },
  { key: 'runners', label: 'Drawer runners', zh: '抽屉滑轨' },
  { key: 'rails', label: 'Hanging rails', zh: '衣通' },
  { key: 'special_hardware', label: 'Special hardware (push openers, lights, baskets …)', zh: '特殊五金' },
  { key: 'fillers', label: 'Fillers / scribes', zh: '收口条' },
  { key: 'top_panel', label: 'Top filler panel', zh: '顶封板' },
  { key: 'kick', label: 'Kick board', zh: '踢脚板' },
  { key: 'end_panels', label: 'Finished end panels', zh: '看面板' },
  { key: 'install_on', label: 'Stands on (finished floor / bare screed)', zh: '安装方式 地板/水泥地上' },
  { key: 'cornice', label: 'Ceiling cornice (yes / no)', zh: '石膏线 有/无' },
  { key: 'notes', label: 'Notes for the factory', zh: '备注' },
] as const;
export type SpecKey = (typeof SPEC_FIELDS)[number]['key'];
export interface FactorySpec { fields: Partial<Record<SpecKey, string>>; updated_at?: string; updated_by?: string }

/** Keep known fields as trimmed text (notes up to 2000 characters, others 300). */
export function cleanSpec(raw: unknown): Partial<Record<SpecKey, string>> {
  const src = ((raw as { fields?: unknown })?.fields ?? raw ?? {}) as Record<string, unknown>;
  const out: Partial<Record<SpecKey, string>> = {};
  for (const f of SPEC_FIELDS) {
    const v = src[f.key];
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    const s = String(v).replace(/\r\n/g, '\n').trim().slice(0, f.key === 'notes' ? 2000 : 300);
    if (s) out[f.key] = s;
  }
  return out;
}

// ── who may see / change what ───────────────────────────────────────────────

export interface Caller { id: string; role: string }
const isAdmin = (c: Caller) => c.role === 'admin' || c.role === 'super_admin';

async function vendorRetailers(vendorId: string): Promise<string[]> {
  const { data } = await supabase.from('retailers').select('id').eq('vendor_id', vendorId);
  return (data ?? []).map((r: { id: string }) => r.id);
}

/** A listing the caller may attach drawings to: an admin, or the vendor who sells it. */
export async function listingAccess(c: Caller, productId: string): Promise<{ id: string; drawings: Drawing[]; role: DrawingRole } | null> {
  const { data: p } = await supabase.from('products').select('id, retailer_id, drawings').eq('id', productId).maybeSingle();
  if (!p) return null;
  if (isAdmin(c)) return { id: p.id, drawings: drawingsOf(p.drawings), role: 'admin' };
  if (c.role === 'vendor' && (await vendorRetailers(c.id)).includes(p.retailer_id)) return { id: p.id, drawings: drawingsOf(p.drawings), role: 'vendor' };
  return null;
}

export interface ItemAccess {
  item: { id: string; order_id: string; retailer_id: string; item_status: string | null; drawings: Drawing[]; factory_spec: FactorySpec };
  role: DrawingRole;
  /** may change the spec: the client while it's being made, or an admin */
  canEditSpec: boolean;
}

/** An order line the caller may see: its client, the vendor making it, or an admin. */
export async function orderItemAccess(c: Caller, itemId: string): Promise<ItemAccess | null> {
  const { data: it } = await supabase.from('order_items')
    .select('id, order_id, retailer_id, item_status, drawings, factory_spec, orders!inner(user_id, status)')
    .eq('id', itemId).maybeSingle();
  if (!it) return null;
  const order = (Array.isArray(it.orders) ? it.orders[0] : it.orders) as { user_id: string; status: string } | undefined;
  const item = { ...it, drawings: drawingsOf(it.drawings), factory_spec: (it.factory_spec ?? {}) as FactorySpec };
  const open = (it.item_status ?? 'processing') === 'processing' && order?.status !== 'cancelled';
  if (isAdmin(c)) return { item, role: 'admin', canEditSpec: true };
  if (order?.user_id === c.id) return { item, role: 'customer', canEditSpec: open };
  if (c.role === 'vendor' && (await vendorRetailers(c.id)).includes(it.retailer_id)) return { item, role: 'vendor', canEditSpec: false };
  return null;
}

/** The order lines of one order the caller may see (a vendor sees only their own). */
export async function orderLines(c: Caller, orderId: string) {
  const { data: order } = await supabase.from('orders').select('id, user_id, status').eq('id', orderId).maybeSingle();
  if (!order) return null;
  let q = supabase.from('order_items')
    .select('id, order_id, retailer_id, product_id, quantity, item_status, config_label, drawings, factory_spec, products(title)')
    .eq('order_id', orderId);
  let role: DrawingRole;
  if (isAdmin(c)) role = 'admin';
  else if (order.user_id === c.id) role = 'customer';
  else if (c.role === 'vendor') {
    const mine = await vendorRetailers(c.id);
    if (!mine.length) return null;
    q = q.in('retailer_id', mine);
    role = 'vendor';
  } else return null;
  const { data: items, error } = await q;
  if (error) throw new Error(error.message);
  if (role === 'vendor' && !(items ?? []).length) return null;
  const out = [];
  for (const it of items ?? []) {
    const p = (Array.isArray(it.products) ? it.products[0] : it.products) as { title?: string } | undefined;
    const open = (it.item_status ?? 'processing') === 'processing' && order.status !== 'cancelled';
    out.push({
      id: it.id, product_id: it.product_id, title: p?.title ?? 'Item', quantity: it.quantity,
      item_status: it.item_status, config_label: it.config_label,
      spec: ((it.factory_spec ?? {}) as FactorySpec),
      drawings: await signDrawings(drawingsOf(it.drawings)),
      can_edit_spec: role === 'admin' || (role === 'customer' && open),
      can_attach: true,
    });
  }
  return { role, items: out };
}
