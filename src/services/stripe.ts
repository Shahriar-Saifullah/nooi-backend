import Stripe from 'stripe';

const stripeKey = process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder';

export const stripe = new Stripe(stripeKey, {
  apiVersion: '2026-02-25.acacia' as any,
  typescript: true,
});
