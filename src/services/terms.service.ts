/**
 * Terms acceptance — services/terms.service.ts
 * ============================================================================
 * Every role accepts its own set of documents, and each acceptance is stored
 * with the version, time, IP and browser, so Nooi can show who agreed to what.
 *
 *   client    terms + privacy                       (at checkout)
 *   vendor    terms + privacy + vendor agreement    (before listing)
 *   factory   same as vendor (a vendor with fulfilment type "factory")
 *   employee  terms + privacy + employee policy     (Nooi admins)
 *
 * Bumping a version below makes everyone of that role accept again: the
 * status check compares against these exact strings. The frontend keeps the
 * same table in lib/legal/terms.ts — change both together.
 */

import { supabase } from './supabase';

export type TermsRole = 'client' | 'vendor' | 'factory' | 'employee';
export type TermsDocument = 'terms' | 'privacy' | 'vendor_agreement' | 'employee_policy';

export const TERMS_VERSIONS: Record<TermsDocument, string> = {
  terms: '2026-11-06',
  privacy: '2026-11-06',
  vendor_agreement: '2026-11-06',
  employee_policy: '2026-11-06',
};

export const REQUIRED_BY_ROLE: Record<TermsRole, TermsDocument[]> = {
  client: ['terms', 'privacy'],
  vendor: ['terms', 'privacy', 'vendor_agreement'],
  factory: ['terms', 'privacy', 'vendor_agreement'],
  employee: ['terms', 'privacy', 'employee_policy'],
};

export const TERMS_ROLES = Object.keys(REQUIRED_BY_ROLE) as TermsRole[];
export const TERMS_DOCUMENTS = Object.keys(TERMS_VERSIONS) as TermsDocument[];

export interface AcceptanceRow {
  role: string;
  document: string;
  version: string;
  accepted_at?: string;
}

/** Documents (at their current version) this role still has to accept. */
export function missingFor(role: TermsRole, rows: AcceptanceRow[]): TermsDocument[] {
  return REQUIRED_BY_ROLE[role].filter(doc =>
    !rows.some(r => r.role === role && r.document === doc && r.version === TERMS_VERSIONS[doc]),
  );
}

/**
 * Which terms role an account plays. A shopper is a client; a vendor whose
 * fulfilment type is "factory" is a factory; Nooi staff are employees.
 * `asClient` — a vendor or admin buying something accepts as a client.
 */
export async function termsRoleFor(userId: string, asClient = false): Promise<TermsRole> {
  if (asClient) return 'client';
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', userId).maybeSingle();
  const role = profile?.role;
  if (role === 'admin' || role === 'super_admin') return 'employee';
  if (role === 'vendor') {
    const { data: vp } = await supabase.from('vendor_profiles').select('fulfillment_type').eq('id', userId).maybeSingle();
    return String(vp?.fulfillment_type || '').toLowerCase() === 'factory' ? 'factory' : 'vendor';
  }
  return 'client';
}

export async function acceptancesOf(userId: string): Promise<AcceptanceRow[]> {
  const { data, error } = await supabase
    .from('terms_acceptances')
    .select('role, document, version, context, accepted_at')
    .eq('user_id', userId)
    .order('accepted_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as AcceptanceRow[];
}

export async function missingDocuments(userId: string, role: TermsRole): Promise<TermsDocument[]> {
  return missingFor(role, await acceptancesOf(userId));
}

export interface AcceptMeta {
  context?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/** Record acceptance of the current version of each document. Idempotent. */
export async function recordAcceptance(
  userId: string,
  role: TermsRole,
  documents: TermsDocument[],
  meta: AcceptMeta = {},
): Promise<void> {
  const docs = [...new Set(documents)].filter(d => TERMS_DOCUMENTS.includes(d));
  if (!docs.length) return;
  const rows = docs.map(document => ({
    user_id: userId,
    role,
    document,
    version: TERMS_VERSIONS[document],
    context: meta.context ? String(meta.context).slice(0, 40) : null,
    ip: meta.ip ? String(meta.ip).slice(0, 64) : null,
    user_agent: meta.userAgent ? String(meta.userAgent).slice(0, 300) : null,
  }));
  const { error } = await supabase
    .from('terms_acceptances')
    .upsert(rows, { onConflict: 'user_id,role,document,version', ignoreDuplicates: true });
  if (error) throw new Error(error.message);
}

/** The caller's IP as Express sees it behind Railway's proxy. */
export function requestIp(req: { headers: Record<string, any>; ip?: string }): string | null {
  const fwd = req.headers['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : typeof fwd === 'string' ? fwd.split(',')[0] : null;
  return (first || req.ip || '').trim() || null;
}
