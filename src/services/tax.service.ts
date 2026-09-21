export interface TaxCalculationResult {
  tax_amount: number;
  provider: string;
  note: string;
}

export function calculateTax(
  items: any[],
  subtotal: number,
  shipping: number
): TaxCalculationResult {
  return {
    tax_amount: 0,
    provider: 'unconfigured',
    note: 'No tax provider configured. Tax is zero.',
  };
}
