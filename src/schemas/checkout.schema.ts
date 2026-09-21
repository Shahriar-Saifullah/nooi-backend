import { z } from 'zod';

export const shippingAddressSchema = z.object({
  fullName: z.string().min(1, 'Full name is required'),
  street: z.string().min(1, 'Street address is required'),
  city: z.string().min(1, 'City is required'),
  state: z.string().min(1, 'State is required'),
  zipCode: z.string().min(1, 'Zip code is required'),
  country: z.string().min(2, 'Country code is required'),
});

export const createPaymentIntentSchema = z.object({
  shipping_address: shippingAddressSchema,
});

export type ShippingAddressInput = z.infer<typeof shippingAddressSchema>;
export type CreatePaymentIntentInput = z.infer<typeof createPaymentIntentSchema>;
