/**
 * Moyasar API client — services/payments/moyasar.ts
 * ============================================================================
 * Basic auth with the SECRET key as the username and no password. All amounts
 * are minor units (halalas). Docs: https://docs.moyasar.com
 *
 * Env:
 *   MOYASAR_SECRET_KEY        sk_test_… / sk_live_…
 *   MOYASAR_PUBLISHABLE_KEY   pk_test_… / pk_live_… (sent to the browser)
 *   MOYASAR_WEBHOOK_SECRET    the "secret token" set on the webhook in the
 *                             Moyasar dashboard
 *   MOYASAR_PAYOUT_SOURCE_ID  the payout account (Nooi's bank account) that
 *                             vendor payouts are sent from
 */

const BASE = process.env.MOYASAR_API_BASE || 'https://api.moyasar.com/v1';

export class MoyasarError extends Error {
  status: number;
  type?: string;
  errors?: unknown;
  constructor(message: string, status: number, type?: string, errors?: unknown) {
    super(message);
    this.name = 'MoyasarError';
    this.status = status;
    this.type = type;
    this.errors = errors;
  }
  /** Moyasar looked at the request and said no. Safe to treat as final. */
  get rejected() { return this.status >= 400 && this.status < 500; }
}

export interface MoyasarPayment {
  id: string;
  status: 'initiated' | 'paid' | 'authorized' | 'captured' | 'voided' | 'refunded' | 'failed' | string;
  amount: number;
  fee?: number;
  currency: string;
  refunded?: number;
  captured?: number;
  description?: string | null;
  metadata?: Record<string, string> | null;
  source?: { type?: string; company?: string; message?: string } | null;
  created_at?: string;
}

export interface MoyasarRefund {
  id?: string;
  status: string;
  amount: number;
  refunded: number;
}

export interface MoyasarPayout {
  id: string;
  source_id: string;
  sequence_number: string;
  channel?: string;
  status: 'queued' | 'initiated' | 'paid' | 'failed' | 'canceled' | 'returned';
  amount: number;
  currency: string;
  message?: string | null;
  failure_reason?: string | null;
}

export function moyasarConfigured(): boolean {
  return Boolean(process.env.MOYASAR_SECRET_KEY);
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const key = process.env.MOYASAR_SECRET_KEY;
  if (!key) throw new MoyasarError('MOYASAR_SECRET_KEY is not set', 500);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err: any) {
    // Network failure or timeout: we do NOT know whether Moyasar acted.
    throw new MoyasarError(`Moyasar unreachable: ${err?.message || err}`, 0);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const msg = data?.message || `Moyasar ${method} ${path} failed (${res.status})`;
    throw new MoyasarError(msg, res.status, data?.type, data?.errors);
  }
  return data as T;
}

export const moyasar = {
  getPayment: (id: string) =>
    call<MoyasarPayment>('GET', `/payments/${encodeURIComponent(id)}`),

  /** Omit amount for a full refund. Partial refunds may be repeated up to the total. */
  refundPayment: (id: string, amountMinor?: number) =>
    call<MoyasarRefund>('POST', `/payments/${encodeURIComponent(id)}/refund`,
      amountMinor === undefined ? {} : { amount: amountMinor }),

  createPayout: (body: {
    source_id: string;
    sequence_number: string;
    amount: number;
    purpose: string;
    destination: { type: 'bank'; iban: string; name: string; mobile: string; country: string; city: string };
    comment?: string;
    metadata?: Record<string, string>;
  }) => call<MoyasarPayout>('POST', '/payouts', body),

  getPayout: (id: string) =>
    call<MoyasarPayout>('GET', `/payouts/${encodeURIComponent(id)}`),
};
