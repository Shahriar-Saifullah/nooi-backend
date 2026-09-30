export interface ShippingPolicy {
  free_above?: number | null;
  flat_rate?: number | null;
  currency?: string;
  /** Vendor-wide fallback when a product has no lead_time_days of its own. */
  lead_time_days?: number | null;
}

export interface RetailerShippingInput {
  id: string;
  name: string;
  shipping_policy_json?: ShippingPolicy | string | null;
}

export interface ShippingCalculationResult {
  shipping_amount: number;
  estimated_delivery: string;
  policy_applied: string;
  /** What the date was actually derived from, so callers can show it. */
  lead_time_days: number;
}

/** Used only when neither the product nor the retailer states a lead time. */
const DEFAULT_LEAD_TIME_DAYS = 14;

function parsePolicy(raw: RetailerShippingInput['shipping_policy_json']): ShippingPolicy | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as ShippingPolicy;
    } catch {
      return null;
    }
  }
  return raw;
}

/**
 * Resolve the delivery date.
 *
 * Previously this added a flat four days regardless of the goods, so a
 * made-to-order sofa with a 21-day lead time and a rug with a 7-day one both
 * promised the same date — and both contradicted the "21 days" printed on the
 * product page the shopper had just read.
 *
 * Calendar days, not business days: the seeded lead times (21, 28, 30) are the
 * vendor's own calendar estimates, and "21 days" on a product card has to mean
 * the same thing here as it does there.
 */
function resolveDelivery(leadTimeDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + Math.max(0, Math.round(leadTimeDays)));
  return d.toISOString();
}

export function calculateShipping(
  retailer: RetailerShippingInput,
  subtotal: number,
  currency = 'USD',
  /**
   * Slowest lead time among the items in this vendor's group. A shipment is
   * only as fast as its slowest piece, so the caller passes the max rather than
   * an average — promising an earlier date than one item can meet is the
   * failure worth avoiding.
   */
  leadTimeDays?: number | null
): ShippingCalculationResult {
  const policy = parsePolicy(retailer.shipping_policy_json);

  const resolvedLead =
    leadTimeDays != null && Number.isFinite(Number(leadTimeDays))
      ? Number(leadTimeDays)
      : policy?.lead_time_days != null && Number.isFinite(Number(policy.lead_time_days))
        ? Number(policy.lead_time_days)
        : DEFAULT_LEAD_TIME_DAYS;

  const estimated_delivery = resolveDelivery(resolvedLead);
  const base = { estimated_delivery, lead_time_days: resolvedLead };

  // Case 1: Missing or empty policy
  if (!policy || Object.keys(policy).length === 0) {
    return { ...base, shipping_amount: 0, policy_applied: 'policy_missing_defaulted_zero' };
  }

  // Case 2: Currency mismatch
  if (policy.currency && policy.currency.toUpperCase() !== currency.toUpperCase()) {
    return { ...base, shipping_amount: 0, policy_applied: 'currency_mismatch_defaulted_zero' };
  }

  // Case 3: Invalid flat rate (negative or NaN)
  const flatRate = policy.flat_rate;
  if (flatRate !== undefined && flatRate !== null) {
    if (typeof flatRate !== 'number' || isNaN(flatRate) || flatRate < 0) {
      return { ...base, shipping_amount: 0, policy_applied: 'invalid_policy_defaulted_zero' };
    }
  }

  // Case 4: Has free_above and flat_rate
  const freeAbove = policy.free_above;
  if (freeAbove !== undefined && freeAbove !== null && typeof freeAbove === 'number' && freeAbove >= 0) {
    if (subtotal >= freeAbove) {
      return { ...base, shipping_amount: 0, policy_applied: 'free_above' };
    }
    if (flatRate !== undefined && flatRate !== null) {
      return { ...base, shipping_amount: Number(flatRate.toFixed(2)), policy_applied: 'flat_rate' };
    }
  }

  // Case 5: Has flat_rate only
  if (flatRate !== undefined && flatRate !== null) {
    return { ...base, shipping_amount: Number(flatRate.toFixed(2)), policy_applied: 'flat_rate' };
  }

  // Fallback
  return { ...base, shipping_amount: 0, policy_applied: 'policy_missing_defaulted_zero' };
}