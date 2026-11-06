/** A product row (+ its variant) as configure.ts's priceLine wants it. */
export function listingForPricing(product: any, variant: any) {
  return {
    price_unit: product?.price_unit === 'metre' ? 'metre' as const : 'unit' as const,
    min_width_cm: product?.min_width_cm ?? null,
    max_width_cm: product?.max_width_cm ?? null,
    options: Array.isArray(product?.options) ? product.options : [],
    width_cm: Number(variant?.width_cm ?? variant?.dimensions_cm?.width) || null,
  };
}
