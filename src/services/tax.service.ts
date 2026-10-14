export interface TaxCalculationResult {
  tax_amount: number;
  provider: string;
  note: string;
}

/**
 * Saudi VAT.
 *
 * Listed prices are NET — a shopper sees 2,400 on the product page and pays
 * 2,760. That is a deliberate choice, and it means the number has to appear in
 * the cart as well as at checkout: a total that jumps at the payment step is
 * the same failure the promo code had, and the reason both the cart quote and
 * the checkout snapshot call this function.
 *
 * VAT applies to shipping as well as goods, which is why the rate is applied to
 * the sum rather than to the subtotal alone.
 *
 * Deliberately flat at 15% for every destination, including cross-border. A
 * Saudi vendor selling to a UAE customer is an export and is treated
 * differently in reality — charging 15% there is a known simplification, not an
 * oversight, and it needs revisiting before Nooi sells outside Saudi in
 * earnest. The provider string says so, so whoever reads an order later can
 * tell which rule produced the number.
 */
const VAT_RATE = 0.15;

export function calculateTax(
  items: any[],
  subtotal: number,
  shipping: number
): TaxCalculationResult {
  const taxable = Number(subtotal || 0) + Number(shipping || 0);

  // A zero-value basket is not an error, and 0 * 0.15 is a perfectly good
  // answer — but returning the configured provider either way keeps the two
  // cases distinguishable from a genuinely unconfigured one.
  if (!(taxable > 0)) {
    return {
      tax_amount: 0,
      provider: 'ksa_vat_15',
      note: 'Nothing taxable.',
    };
  }

  // Rounded to two decimal places per group, which is how it is charged and
  // how it must reconcile: order totals are summed from these, so a rate held
  // at full precision here would drift against the amount on the card.
  const tax_amount = Number((taxable * VAT_RATE).toFixed(2));

  return {
    tax_amount,
    provider: 'ksa_vat_15',
    note: 'Saudi VAT at 15% on goods and shipping. Flat rate for all destinations.',
  };
}

/** For a UI that wants to label the line rather than hardcode "15%". */
export function vatRatePercent(): number {
  return VAT_RATE * 100;
}