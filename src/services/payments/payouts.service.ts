/**
 * Vendor payouts through Moyasar Payouts — services/payments/payouts.service.ts
 * ============================================================================
 * 1. claim_vendor_payout (SQL) moves everything payable for the vendor into a
 *    new payout row, status 'creating', with a 16-digit sequence number.
 * 2. We send it to Moyasar. The sequence number is Moyasar's duplicate guard,
 *    so if the call times out we can send the SAME payout again safely.
 * 3. Moyasar's status comes back on the response, by webhook, or when an
 *    admin opens the payouts screen (syncOpenPayouts). settle_vendor_payout
 *    applies it: paid → earnings paid; failed/canceled/returned → earnings
 *    payable again for the next run.
 */

import { supabase } from '../supabase';
import { moyasar, MoyasarError, MoyasarPayout } from './moyasar';
import { payoutHoldDays } from './index';
import { getSettings } from '../settings.service';
import { notify, links } from '../notifications.service';
import { fromMinor } from './ledger';

export class PayoutError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}


function claimErrorMessage(msg: string): PayoutError {
  if (msg.includes('NO_PAYOUT_ACCOUNT')) return new PayoutError('This vendor has not added a bank account.', 409);
  if (msg.includes('PAYOUT_ACCOUNT_UNVERIFIED')) return new PayoutError('Verify the vendor\'s bank account before paying them.', 409);
  if (msg.includes('NOTHING_TO_PAY')) return new PayoutError('Nothing is payable to this vendor right now.', 409);
  return new PayoutError(msg, 400);
}

async function applyStatus(payoutId: string, p: Pick<MoyasarPayout, 'id' | 'status' | 'channel' | 'failure_reason' | 'message'>) {
  const { data: before } = await supabase.from('vendor_payouts').select('status').eq('id', payoutId).maybeSingle();
  const { error } = await supabase.rpc('settle_vendor_payout', {
    p_payout_id: payoutId,
    p_status: p.status,
    p_provider_payout_id: p.id,
    p_channel: p.channel ?? null,
    p_failure_reason: p.failure_reason || (p.status === 'failed' ? p.message || null : null),
  });
  if (error) throw new Error(error.message);
  if (before?.status !== p.status) await notifyPayout(payoutId, p.status, before?.status ?? null, p.failure_reason || p.message || null).catch(() => undefined);
}

/** Vendors hear when a payout is on its way, arrives, or bounces. */
async function notifyPayout(payoutId: string, status: string, previous: string | null, reason: string | null) {
  const { data: payout } = await supabase.from('vendor_payouts')
    .select('vendor_id, amount_minor, status').eq('id', payoutId).maybeSingle();
  if (!payout) return;
  const amount = `SAR ${fromMinor(Number(payout.amount_minor || 0)).toFixed(2)}`;
  const byStatus: Record<string, { title: string; message: string }> = {
    queued:    { title: `Payout of ${amount} is on its way`, message: 'Nooi has sent your earnings to your bank. Transfers usually arrive within 1–2 working days.' },
    initiated: { title: `Payout of ${amount} is on its way`, message: 'Nooi has sent your earnings to your bank. Transfers usually arrive within 1–2 working days.' },
    paid:      { title: `Payout of ${amount} sent`, message: 'The bank transfer is complete. Check your bank account for the deposit.' },
    failed:    { title: `Payout of ${amount} didn't go through`, message: `${reason ? `${reason}. ` : ''}The amount is payable again — check your bank details in Payments.` },
    returned:  { title: `Payout of ${amount} was returned by the bank`, message: 'The amount is payable again — check your bank details in Payments.' },
    canceled:  { title: `Payout of ${amount} was cancelled`, message: 'The amount is payable again and will go in the next payout.' },
  };
  const n = byStatus[status];
  // queued → initiated is the same news twice; only say it once.
  if (!n || (status === 'initiated' && previous === 'queued')) return;
  await notify(payout.vendor_id, {
    ...n, type: 'payout', link: links.vendorPayments,
    essential: ['failed', 'returned', 'canceled'].includes(status),
  });
}

/** Send (or re-send) a 'creating' payout to Moyasar. */
export async function sendPayout(payoutId: string) {
  const { data: payout } = await supabase.from('vendor_payouts').select('*').eq('id', payoutId).maybeSingle();
  if (!payout) throw new PayoutError('Payout not found', 404);
  if (payout.status !== 'creating') return payout;

  const source = process.env.MOYASAR_PAYOUT_SOURCE_ID;
  if (!source) throw new PayoutError('MOYASAR_PAYOUT_SOURCE_ID is not set — add Nooi\'s payout account first.', 500);

  try {
    const res = await moyasar.createPayout({
      source_id: source,
      sequence_number: payout.sequence_number,
      amount: Number(payout.amount_minor),
      purpose: process.env.MOYASAR_PAYOUT_PURPOSE || 'payment_to_merchant',
      destination: payout.destination,
      comment: `Nooi payout ${payout.sequence_number}`,
      metadata: { payout_id: payout.id, vendor_id: payout.vendor_id },
    });
    await applyStatus(payout.id, res);
  } catch (err: any) {
    const message = err?.message || String(err);
    if (err instanceof MoyasarError && err.rejected && !/sequence/i.test(message)) {
      // Moyasar refused it outright (bad IBAN, no balance…): nothing was sent.
      await applyStatus(payout.id, { id: null as any, status: 'failed', failure_reason: message });
    } else {
      // Unknown outcome (timeout, 5xx, or a duplicate sequence). Leave it
      // 'creating'; a retry re-sends with the same sequence number.
      await supabase.from('vendor_payouts')
        .update({ last_error: message.slice(0, 500), updated_at: new Date().toISOString(), last_synced_at: new Date().toISOString() })
        .eq('id', payout.id);
    }
  }
  const { data: fresh } = await supabase.from('vendor_payouts').select('*').eq('id', payoutId).maybeSingle();
  return fresh;
}

export async function createVendorPayout(vendorId: string, adminId: string) {
  const { data: payoutId, error } = await supabase.rpc('claim_vendor_payout', {
    p_vendor_id: vendorId,
    p_admin_id: adminId,
    p_hold_days: await payoutHoldDays(),
    p_min_minor: Math.max(100, Math.round((await getSettings()).min_payout_sar * 100)),
  });
  if (error) throw claimErrorMessage(error.message);
  return sendPayout(payoutId as unknown as string);
}

/** Ask Moyasar about one payout and apply what it says. */
export async function syncPayout(payoutId: string) {
  const { data: payout } = await supabase.from('vendor_payouts').select('*').eq('id', payoutId).maybeSingle();
  if (!payout) throw new PayoutError('Payout not found', 404);
  if (payout.status === 'creating') return sendPayout(payoutId);
  if (!payout.provider_payout_id || !['queued', 'initiated', 'paid'].includes(payout.status)) return payout;
  const p = await moyasar.getPayout(payout.provider_payout_id);
  await applyStatus(payout.id, p);
  const { data: fresh } = await supabase.from('vendor_payouts').select('*').eq('id', payoutId).maybeSingle();
  return fresh;
}

/** Bring in-flight payouts up to date. Cheap enough to run on page load. */
export async function syncOpenPayouts(limit = 10) {
  const stale = new Date(Date.now() - 2 * 60_000).toISOString();
  const { data } = await supabase.from('vendor_payouts')
    .select('id')
    .in('status', ['creating', 'queued', 'initiated'])
    .or(`last_synced_at.is.null,last_synced_at.lt.${stale}`)
    .order('last_synced_at', { ascending: true, nullsFirst: true })
    .limit(limit);
  for (const row of data || []) {
    try { await syncPayout(row.id); }
    catch (err: any) { console.error('[payouts] sync failed', { payout_id: row.id, error: err?.message }); }
  }
}

/** A Moyasar webhook about a payout: find ours and re-read it from the API. */
export async function syncPayoutByProviderId(providerPayoutId: string) {
  const { data } = await supabase.from('vendor_payouts')
    .select('id').eq('provider_payout_id', providerPayoutId).maybeSingle();
  if (data) await syncPayout(data.id);
}
