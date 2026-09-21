export interface ShippingPolicy {
  free_above?: number | null;
  flat_rate?: number | null;
  currency?: string;
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
}

export function calculateShipping(
  retailer: RetailerShippingInput,
  subtotal: number,
  currency = 'USD'
): ShippingCalculationResult {
  let policy: ShippingPolicy | null = null;

  if (retailer.shipping_policy_json) {
    if (typeof retailer.shipping_policy_json === 'string') {
      try {
        policy = JSON.parse(retailer.shipping_policy_json);
      } catch {
        policy = null;
      }
    } else {
      policy = retailer.shipping_policy_json;
    }
  }

  // Calculate realistic delivery date (4 business days)
  const deliveryDate = new Date();
  deliveryDate.setDate(deliveryDate.getDate() + 4);
  const estimated_delivery = deliveryDate.toISOString();

  // Case 1: Missing or empty policy
  if (!policy || Object.keys(policy).length === 0) {
    return {
      shipping_amount: 0,
      estimated_delivery,
      policy_applied: 'policy_missing_defaulted_zero',
    };
  }

  // Case 2: Currency mismatch
  if (policy.currency && policy.currency.toUpperCase() !== currency.toUpperCase()) {
    return {
      shipping_amount: 0,
      estimated_delivery,
      policy_applied: 'currency_mismatch_defaulted_zero',
    };
  }

  // Case 3: Invalid flat rate (negative or NaN)
  const flatRate = policy.flat_rate;
  if (flatRate !== undefined && flatRate !== null) {
    if (typeof flatRate !== 'number' || isNaN(flatRate) || flatRate < 0) {
      return {
        shipping_amount: 0,
        estimated_delivery,
        policy_applied: 'invalid_policy_defaulted_zero',
      };
    }
  }

  // Case 4: Has free_above and flat_rate
  const freeAbove = policy.free_above;
  if (freeAbove !== undefined && freeAbove !== null && typeof freeAbove === 'number' && freeAbove >= 0) {
    if (subtotal >= freeAbove) {
      return {
        shipping_amount: 0,
        estimated_delivery,
        policy_applied: 'free_above',
      };
    }
    if (flatRate !== undefined && flatRate !== null) {
      return {
        shipping_amount: Number(flatRate.toFixed(2)),
        estimated_delivery,
        policy_applied: 'flat_rate',
      };
    }
  }

  // Case 5: Has flat_rate only
  if (flatRate !== undefined && flatRate !== null) {
    return {
      shipping_amount: Number(flatRate.toFixed(2)),
      estimated_delivery,
      policy_applied: 'flat_rate',
    };
  }

  // Fallback
  return {
    shipping_amount: 0,
    estimated_delivery,
    policy_applied: 'policy_missing_defaulted_zero',
  };
}
