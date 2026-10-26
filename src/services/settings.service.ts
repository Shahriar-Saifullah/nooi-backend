/**
 * Platform settings — services/settings.service.ts
 * ============================================================================
 * One row in public.platform_settings, edited on the admin Settings page.
 * Read through a 60-second cache: these change rarely and are read on hot
 * paths (every payout, every return request). Env vars remain as the fallback
 * if the table is missing or unreadable, so a fresh environment still works.
 */

import { supabase } from './supabase';

export interface PlatformSettings {
  default_commission_rate: number;
  payout_hold_days: number;
  return_window_days: number;
  min_payout_sar: number;
  support_email: string | null;
  support_phone: string | null;
  legal_name: string | null;
  legal_address: string | null;
  vat_number: string | null;
  cr_number: string | null;
  updated_at?: string | null;
  updated_by?: string | null;
}

const FALLBACK: PlatformSettings = {
  default_commission_rate: 10,
  payout_hold_days: Math.max(0, Math.floor(Number(process.env.PAYOUT_HOLD_DAYS ?? 0)) || 0),
  return_window_days: 30,
  min_payout_sar: Math.max(1, Number(process.env.PAYOUT_MIN_SAR || 1)),
  support_email: null,
  support_phone: null,
  legal_name: null,
  legal_address: null,
  vat_number: null,
  cr_number: null,
};

let cache: { at: number; value: PlatformSettings } | null = null;
const TTL_MS = 60_000;

export async function getSettings(fresh = false): Promise<PlatformSettings> {
  if (!fresh && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const { data, error } = await supabase.from('platform_settings').select('*').eq('id', 1).maybeSingle();
  if (error || !data) {
    if (error) console.error('[settings] read failed, using defaults:', error.message);
    return cache?.value ?? FALLBACK;
  }
  const value: PlatformSettings = {
    ...FALLBACK,
    ...data,
    default_commission_rate: Number(data.default_commission_rate),
    payout_hold_days: Number(data.payout_hold_days),
    return_window_days: Number(data.return_window_days),
    min_payout_sar: Number(data.min_payout_sar),
  };
  cache = { at: Date.now(), value };
  return value;
}

export function clearSettingsCache() { cache = null; }

/** Validate and normalise an admin's edit. Returns an error message or the patch. */
export function validateSettingsPatch(body: any): { error: string } | { patch: Partial<PlatformSettings> } {
  const patch: Partial<PlatformSettings> = {};
  const num = (k: keyof PlatformSettings, min: number, max: number, int = false) => {
    if (body[k] === undefined) return null;
    const n = Number(body[k]);
    if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) {
      return `${String(k).replace(/_/g, ' ')} must be ${int ? 'a whole number ' : ''}between ${min} and ${max}.`;
    }
    (patch as any)[k] = n;
    return null;
  };
  const errs = [
    num('default_commission_rate', 0, 100),
    num('payout_hold_days', 0, 90, true),
    num('return_window_days', 0, 365, true),
    num('min_payout_sar', 1, 1_000_000),
  ].filter(Boolean);
  if (errs.length) return { error: errs[0] as string };

  for (const k of ['support_email', 'support_phone', 'legal_name', 'legal_address', 'vat_number', 'cr_number'] as const) {
    if (body[k] === undefined) continue;
    const v = String(body[k] ?? '').trim().slice(0, 300);
    (patch as any)[k] = v || null;
  }
  if (patch.support_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.support_email)) {
    return { error: 'Support email is not a valid email address.' };
  }
  return { patch };
}
