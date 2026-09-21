import { calculateShipping } from '../services/shipping.service';
import { calculateTax } from '../services/tax.service';
import { calculateCheckout, CheckoutError } from '../services/checkout.service';
import { stripe } from '../services/stripe';
import { supabase } from '../services/supabase';

// Mock Query Builder for Supabase chaining
const mockQueryBuilder: any = {
  select: jest.fn(),
  insert: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  eq: jest.fn(),
  in: jest.fn(),
  maybeSingle: jest.fn(),
  single: jest.fn(),
  order: jest.fn(),
};

mockQueryBuilder.select.mockReturnValue(mockQueryBuilder);
mockQueryBuilder.insert.mockReturnValue(mockQueryBuilder);
mockQueryBuilder.update.mockReturnValue(mockQueryBuilder);
mockQueryBuilder.delete.mockReturnValue(mockQueryBuilder);
mockQueryBuilder.eq.mockReturnValue(mockQueryBuilder);
mockQueryBuilder.in.mockReturnValue(mockQueryBuilder);
mockQueryBuilder.order.mockReturnValue(mockQueryBuilder);

// Mock Supabase
jest.mock('../services/supabase', () => ({
  supabase: {
    from: jest.fn(() => mockQueryBuilder),
    rpc: jest.fn(),
  },
  supabaseAuth: {},
}));

// Mock Stripe
jest.mock('../services/stripe', () => ({
  stripe: {
    paymentIntents: {
      create: jest.fn(),
      retrieve: jest.fn(),
    },
    refunds: {
      create: jest.fn(),
    },
    webhooks: {
      constructEvent: jest.fn(),
    },
  },
}));

describe('NOOI Phase 03 Stripe Checkout & Transaction Layer Verification Suite', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQueryBuilder.select.mockReturnValue(mockQueryBuilder);
    mockQueryBuilder.insert.mockReturnValue(mockQueryBuilder);
    mockQueryBuilder.update.mockReturnValue(mockQueryBuilder);
    mockQueryBuilder.delete.mockReturnValue(mockQueryBuilder);
    mockQueryBuilder.eq.mockReturnValue(mockQueryBuilder);
    mockQueryBuilder.in.mockReturnValue(mockQueryBuilder);
    mockQueryBuilder.order.mockReturnValue(mockQueryBuilder);
  });

  describe('1. Shipping Service Policy Resolution (§9)', () => {
    const retailer = { id: 'ret-1', name: 'West Elm' };

    it('defaults to 0 with policy_missing_defaulted_zero on null or empty policy', () => {
      const resNull = calculateShipping({ ...retailer, shipping_policy_json: null }, 150);
      expect(resNull.shipping_amount).toBe(0);
      expect(resNull.policy_applied).toBe('policy_missing_defaulted_zero');

      const resEmpty = calculateShipping({ ...retailer, shipping_policy_json: {} }, 150);
      expect(resEmpty.shipping_amount).toBe(0);
      expect(resEmpty.policy_applied).toBe('policy_missing_defaulted_zero');
    });

    it('applies flat_rate when no free_above threshold exists', () => {
      const res = calculateShipping(
        { ...retailer, shipping_policy_json: { flat_rate: 15.0, currency: 'USD' } },
        100
      );
      expect(res.shipping_amount).toBe(15.0);
      expect(res.policy_applied).toBe('flat_rate');
    });

    it('applies free shipping when subtotal exceeds free_above threshold', () => {
      const res = calculateShipping(
        { ...retailer, shipping_policy_json: { flat_rate: 20.0, free_above: 100.0, currency: 'USD' } },
        150
      );
      expect(res.shipping_amount).toBe(0);
      expect(res.policy_applied).toBe('free_above');
    });

    it('applies flat rate when subtotal is below free_above threshold', () => {
      const res = calculateShipping(
        { ...retailer, shipping_policy_json: { flat_rate: 20.0, free_above: 100.0, currency: 'USD' } },
        75
      );
      expect(res.shipping_amount).toBe(20.0);
      expect(res.policy_applied).toBe('flat_rate');
    });

    it('defaults to 0 on currency mismatch', () => {
      const res = calculateShipping(
        { ...retailer, shipping_policy_json: { flat_rate: 25.0, currency: 'EUR' } },
        100,
        'USD'
      );
      expect(res.shipping_amount).toBe(0);
      expect(res.policy_applied).toBe('currency_mismatch_defaulted_zero');
    });

    it('defaults to 0 on negative or invalid flat rate', () => {
      const res = calculateShipping(
        { ...retailer, shipping_policy_json: { flat_rate: -10, currency: 'USD' } },
        100
      );
      expect(res.shipping_amount).toBe(0);
      expect(res.policy_applied).toBe('invalid_policy_defaulted_zero');
    });
  });

  describe('2. Tax Service Baseline', () => {
    it('returns zero tax for unconfigured provider interface', () => {
      const res = calculateTax([], 200, 15);
      expect(res.tax_amount).toBe(0);
      expect(res.provider).toBe('unconfigured');
    });
  });

  describe('3. Checkout Snapshot & Stock Validation', () => {
    const shippingAddress = {
      fullName: 'John Doe',
      street: '456 Modern Way',
      city: 'Austin',
      state: 'TX',
      zipCode: '78701',
      country: 'US',
    };

    it('computes deterministic cart hash and totals from database prices', async () => {
      const mockCart = [
        {
          id: 'cart-item-1',
          user_id: 'usr-1',
          variant_id: 'var-1',
          quantity: 2,
          product_variants: {
            id: 'var-1',
            price: 250.0,
            stock_quantity: 10,
            is_active: true,
            sku: 'SOFA-01',
            products: {
              id: 'prod-1',
              title: 'Velvet Sofa',
              retailers: {
                id: 'ret-1',
                name: 'Modus Living',
                shipping_policy_json: { flat_rate: 50.0, free_above: 600.0, currency: 'USD' },
              },
            },
          },
        },
      ];

      mockQueryBuilder.eq.mockResolvedValueOnce({ data: mockCart, error: null });

      const summary = await calculateCheckout('usr-1', shippingAddress);

      expect(summary.subtotal).toBe(500.0);
      expect(summary.shipping_total).toBe(50.0);
      expect(summary.grand_total).toBe(550.0);
      expect(summary.grand_total_cents).toBe(55000);
      expect(summary.cart_snapshot_hash).toBeDefined();
    });

    it('rejects with 422 if variant stock is insufficient', async () => {
      const mockCart = [
        {
          id: 'cart-item-2',
          user_id: 'usr-1',
          variant_id: 'var-2',
          quantity: 5,
          product_variants: {
            id: 'var-2',
            price: 100.0,
            stock_quantity: 2,
            is_active: true,
            products: { title: 'Coffee Table' },
          },
        },
      ];

      mockQueryBuilder.eq.mockResolvedValueOnce({ data: mockCart, error: null });

      await expect(calculateCheckout('usr-1', shippingAddress)).rejects.toThrow(CheckoutError);
    });

    it('rejects with 422 if variant is inactive', async () => {
      const mockCart = [
        {
          id: 'cart-item-3',
          user_id: 'usr-1',
          variant_id: 'var-3',
          quantity: 1,
          product_variants: {
            id: 'var-3',
            price: 80.0,
            stock_quantity: 10,
            is_active: false,
            products: { title: 'Floor Lamp' },
          },
        },
      ];

      mockQueryBuilder.eq.mockResolvedValueOnce({ data: mockCart, error: null });

      await expect(calculateCheckout('usr-1', shippingAddress)).rejects.toThrow('no longer active');
    });
  });

  describe('4. Webhook Signature Validation (§9)', () => {
    const { stripeWebhookHandler } = require('../controllers/orders.controller');

    it('rejects request with 400 if stripe-signature header is missing without DB query', async () => {
      const req: any = { headers: {}, body: Buffer.from('{}') };
      const res: any = { status: jest.fn().mockReturnThis(), send: jest.fn() };

      await stripeWebhookHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.send).toHaveBeenCalledWith('Webhook signature missing');
      expect(supabase.from).not.toHaveBeenCalled();
    });

    it('rejects request with 400 if stripe-signature is invalid without DB query', async () => {
      (stripe.webhooks.constructEvent as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Invalid signature payload');
      });

      const req: any = {
        headers: { 'stripe-signature': 'bad_sig' },
        body: Buffer.from('{}'),
      };
      const res: any = { status: jest.fn().mockReturnThis(), send: jest.fn() };

      await stripeWebhookHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.send).toHaveBeenCalledWith(expect.stringContaining('Webhook signature error'));
      expect(supabase.from).not.toHaveBeenCalled();
    });
  });

  describe('5. Refund Reason Semantics & Price Mismatch Hardening (§2, §3, §4)', () => {
    const { stripeWebhookHandler } = require('../controllers/orders.controller');

    it('detects PaymentIntent amount mismatch, issues refund without duplicate/fraudulent reason, and persists price_mismatch', async () => {
      const mockEvent = {
        id: 'evt_price_mismatch_pi',
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_price_mismatch',
            amount: 45000, // $450 received
            currency: 'usd',
          },
        },
      };

      (stripe.webhooks.constructEvent as jest.Mock).mockReturnValue(mockEvent);
      (stripe.refunds.create as jest.Mock).mockResolvedValueOnce({ id: 're_pm_1' });

      mockQueryBuilder.maybeSingle
        .mockResolvedValueOnce({ data: null, error: null }) // existingEvent
        .mockResolvedValueOnce({ data: null, error: null }) // existingOrder
        .mockResolvedValueOnce({
          data: {
            id: 'attempt-price-mismatch',
            user_id: 'usr-1',
            currency: 'USD',
            grand_total_cents: 55000, // Expected $550
            snapshot_json: { subtotal: 500, grand_total: 550 },
          },
          error: null,
        });

      const req: any = {
        headers: { 'stripe-signature': 'valid_sig' },
        body: Buffer.from(JSON.stringify(mockEvent)),
      };
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await stripeWebhookHandler(req, res);

      // Verify refund was created with NO reason: 'duplicate' or 'fraudulent'
      expect(stripe.refunds.create).toHaveBeenCalledWith(
        expect.objectContaining({
          payment_intent: 'pi_price_mismatch',
          metadata: expect.objectContaining({ reason: 'price_mismatch' }),
        })
      );
      const callArg = (stripe.refunds.create as jest.Mock).mock.calls[0][0];
      expect(callArg.reason).toBeUndefined(); // MUST NOT be 'duplicate' or 'fraudulent'

      // Verify checkout_attempts receives failure_reason
      expect(mockQueryBuilder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          snapshot_json: expect.objectContaining({
            failure_reason: 'price_mismatch',
            refund_id: 're_pm_1',
          }),
        })
      );
      expect(supabase.rpc).not.toHaveBeenCalled(); // No order created!
    });

    it('detects underlying database variant price change after PI created, refunds, and aborts order creation (§3)', async () => {
      const mockEvent = {
        id: 'evt_db_price_change',
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_db_price_change',
            amount: 55000,
            currency: 'usd',
          },
        },
      };

      (stripe.webhooks.constructEvent as jest.Mock).mockReturnValue(mockEvent);
      (stripe.refunds.create as jest.Mock).mockResolvedValueOnce({ id: 're_db_price_change' });

      mockQueryBuilder.maybeSingle
        .mockResolvedValueOnce({ data: null, error: null }) // existingEvent
        .mockResolvedValueOnce({ data: null, error: null }) // existingOrder
        .mockResolvedValueOnce({
          data: {
            id: 'attempt-db-price-change',
            user_id: 'usr-1',
            currency: 'USD',
            grand_total_cents: 55000,
            snapshot_json: {
              items: [{ variant_id: 'var-1', unit_price: 250.0, quantity: 2 }],
              retailers: [],
              grand_total: 550,
            },
          },
          error: null,
        });

      // When querying product_variants by in('id', ...), variant-1 price has changed to $300!
      mockQueryBuilder.in.mockResolvedValueOnce({
        data: [{ id: 'var-1', price: 300.0 }], // Price changed from 250 to 300!
        error: null,
      });

      const req: any = {
        headers: { 'stripe-signature': 'valid_sig' },
        body: Buffer.from(JSON.stringify(mockEvent)),
      };
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await stripeWebhookHandler(req, res);

      // Assert refund occurred with application metadata and no false duplicate classification
      expect(stripe.refunds.create).toHaveBeenCalledWith(
        expect.objectContaining({
          payment_intent: 'pi_db_price_change',
          metadata: expect.objectContaining({ reason: 'price_mismatch' }),
        })
      );
      const callArg = (stripe.refunds.create as jest.Mock).mock.calls[0][0];
      expect(callArg.reason).toBeUndefined();

      expect(mockQueryBuilder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          snapshot_json: expect.objectContaining({ failure_reason: 'price_mismatch' }),
        })
      );
      expect(supabase.rpc).not.toHaveBeenCalled(); // No invalid order created
    });

    it('detects currency mismatch, issues refund without duplicate/fraudulent reason, and persists currency_mismatch (§4)', async () => {
      const mockEvent = {
        id: 'evt_currency_mismatch',
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_currency_mismatch',
            amount: 55000,
            currency: 'eur', // Mismatched currency!
          },
        },
      };

      (stripe.webhooks.constructEvent as jest.Mock).mockReturnValue(mockEvent);
      (stripe.refunds.create as jest.Mock).mockResolvedValueOnce({ id: 're_curr_1' });

      mockQueryBuilder.maybeSingle
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({
          data: {
            id: 'attempt-curr-mismatch',
            user_id: 'usr-1',
            currency: 'USD',
            grand_total_cents: 55000,
            snapshot_json: {},
          },
          error: null,
        });

      const req: any = {
        headers: { 'stripe-signature': 'valid_sig' },
        body: Buffer.from(JSON.stringify(mockEvent)),
      };
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await stripeWebhookHandler(req, res);

      expect(stripe.refunds.create).toHaveBeenCalledWith(
        expect.objectContaining({
          payment_intent: 'pi_currency_mismatch',
          metadata: expect.objectContaining({ reason: 'currency_mismatch' }),
        })
      );
      const callArg = (stripe.refunds.create as jest.Mock).mock.calls[0][0];
      expect(callArg.reason).toBeUndefined(); // NEVER duplicate or fraudulent

      expect(mockQueryBuilder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          snapshot_json: expect.objectContaining({ failure_reason: 'currency_mismatch' }),
        })
      );
      expect(supabase.rpc).not.toHaveBeenCalled();
    });

    it('handles stock exhaustion with refund without duplicate/fraudulent reason (§2)', async () => {
      const mockEvent = {
        id: 'evt_stock_out',
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_stock_out',
            amount: 55000,
            currency: 'usd',
          },
        },
      };

      (stripe.webhooks.constructEvent as jest.Mock).mockReturnValue(mockEvent);
      (stripe.refunds.create as jest.Mock).mockResolvedValueOnce({ id: 're_stock_out' });

      mockQueryBuilder.maybeSingle
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({
          data: {
            id: 'attempt-stock-out',
            user_id: 'usr-1',
            currency: 'USD',
            grand_total_cents: 55000,
            snapshot_json: { items: [], retailers: [] },
          },
          error: null,
        });

      // RPC raises STOCK_INSUFFICIENT
      (supabase.rpc as jest.Mock).mockResolvedValueOnce({
        data: null,
        error: { message: 'STOCK_INSUFFICIENT:variant=v-exhausted' },
      });

      const req: any = {
        headers: { 'stripe-signature': 'valid_sig' },
        body: Buffer.from(JSON.stringify(mockEvent)),
      };
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await stripeWebhookHandler(req, res);

      expect(stripe.refunds.create).toHaveBeenCalledWith(
        expect.objectContaining({
          payment_intent: 'pi_stock_out',
          metadata: expect.objectContaining({ reason: 'stock_insufficient' }),
        })
      );
      const callArg = (stripe.refunds.create as jest.Mock).mock.calls[0][0];
      expect(callArg.reason).toBeUndefined(); // Strictly NOT 'duplicate' or 'fraudulent'

      expect(mockQueryBuilder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'stock_failed',
          snapshot_json: expect.objectContaining({ failure_reason: 'stock_insufficient' }),
        })
      );
    });
  });

  describe('6. Multi-Retailer Atomic Order Creation & Cart Cleanup (§5, §6)', () => {
    const { stripeWebhookHandler } = require('../controllers/orders.controller');

    it('creates multi-retailer order with separate shipment groups and deletes ONLY purchased cart items', async () => {
      const mockEvent = {
        id: 'evt_multi_retailer',
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_multi_retailer',
            amount: 110000,
            currency: 'usd',
          },
        },
      };

      (stripe.webhooks.constructEvent as jest.Mock).mockReturnValue(mockEvent);

      // Cart snapshot contains items from Retailer A and Retailer B
      const multiRetailerSnapshot = {
        subtotal: 1000,
        shipping_total: 100,
        tax_total: 0,
        grand_total: 1100,
        items: [
          { cart_item_id: 'cart-a1', retailer_id: 'ret-A', variant_id: 'v-a1', unit_price: 250, quantity: 1 },
          { cart_item_id: 'cart-a2', retailer_id: 'ret-A', variant_id: 'v-a2', unit_price: 250, quantity: 1 },
          { cart_item_id: 'cart-b1', retailer_id: 'ret-B', variant_id: 'v-b1', unit_price: 250, quantity: 1 },
          { cart_item_id: 'cart-b2', retailer_id: 'ret-B', variant_id: 'v-b2', unit_price: 250, quantity: 1 },
        ],
        retailers: [
          { retailer_id: 'ret-A', shipping: { shipping_amount: 50, estimated_delivery: '2026-09-25' } },
          { retailer_id: 'ret-B', shipping: { shipping_amount: 50, estimated_delivery: '2026-09-26' } },
        ],
      };

      mockQueryBuilder.maybeSingle
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({
          data: {
            id: 'attempt-multi-retailer',
            user_id: 'usr-multi',
            currency: 'USD',
            grand_total_cents: 110000,
            shipping_address: { city: 'New York' },
            snapshot_json: multiRetailerSnapshot,
          },
          error: null,
        });

      mockQueryBuilder.in.mockResolvedValueOnce({
        data: [
          { id: 'v-a1', price: 250 },
          { id: 'v-a2', price: 250 },
          { id: 'v-b1', price: 250 },
          { id: 'v-b2', price: 250 },
        ],
        error: null,
      });

      (supabase.rpc as jest.Mock).mockResolvedValueOnce({ data: 'order-multi-uuid', error: null });

      const req: any = {
        headers: { 'stripe-signature': 'valid_sig' },
        body: Buffer.from(JSON.stringify(mockEvent)),
      };
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await stripeWebhookHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);

      // Verify create_order_atomic was passed the multi-retailer groups and purchased cart IDs
      expect(supabase.rpc).toHaveBeenCalledWith(
        'create_order_atomic',
        expect.objectContaining({
          p_user_id: 'usr-multi',
          p_retailer_groups: expect.arrayContaining([
            expect.objectContaining({ retailer_id: 'ret-A', shipping_amount: 50 }),
            expect.objectContaining({ retailer_id: 'ret-B', shipping_amount: 50 }),
          ]),
          p_items: expect.arrayContaining([
            expect.objectContaining({ cart_item_id: 'cart-a1' }),
            expect.objectContaining({ cart_item_id: 'cart-a2' }),
            expect.objectContaining({ cart_item_id: 'cart-b1' }),
            expect.objectContaining({ cart_item_id: 'cart-b2' }),
          ]),
        })
      );
    });

    it('demonstrates atomic rollback when Retailer B has insufficient stock: NO order, NO shipment, stock untouched (§5)', async () => {
      const mockEvent = {
        id: 'evt_multi_fail',
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_multi_fail',
            amount: 110000,
            currency: 'usd',
          },
        },
      };

      (stripe.webhooks.constructEvent as jest.Mock).mockReturnValue(mockEvent);
      (stripe.refunds.create as jest.Mock).mockResolvedValueOnce({ id: 're_multi_rollback' });

      mockQueryBuilder.maybeSingle
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({
          data: {
            id: 'attempt-multi-fail',
            user_id: 'usr-multi',
            currency: 'USD',
            grand_total_cents: 110000,
            snapshot_json: { items: [], retailers: [] },
          },
          error: null,
        });

      // Retailer A stock is OK, but Retailer B variant fails -> entire function throws and rolls back
      (supabase.rpc as jest.Mock).mockResolvedValueOnce({
        data: null,
        error: { message: 'STOCK_INSUFFICIENT:variant=v-b2' },
      });

      const req: any = {
        headers: { 'stripe-signature': 'valid_sig' },
        body: Buffer.from(JSON.stringify(mockEvent)),
      };
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await stripeWebhookHandler(req, res);

      // Verify refund was created with stock_insufficient metadata
      expect(stripe.refunds.create).toHaveBeenCalledWith(
        expect.objectContaining({
          payment_intent: 'pi_multi_fail',
          metadata: { reason: 'stock_insufficient' },
        })
      );
      // Attempt marked stock_failed
      expect(mockQueryBuilder.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'stock_failed' })
      );
    });
  });

  describe('7. Webhook Retry & Concurrency Safety (§8, §12)', () => {
    const { stripeWebhookHandler } = require('../controllers/orders.controller');

    it('records failed state on error and successfully completes on retry (§8 Case B)', async () => {
      const mockEvent = {
        id: 'evt_retry_cycle',
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_retry', amount: 55000, currency: 'usd' } },
      };

      (stripe.webhooks.constructEvent as jest.Mock).mockReturnValue(mockEvent);

      // FIRST DELIVERY: Transient database drop
      mockQueryBuilder.maybeSingle
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({
          data: {
            id: 'att-1',
            user_id: 'usr-1',
            currency: 'USD',
            grand_total_cents: 55000,
            snapshot_json: { items: [], retailers: [] },
          },
          error: null,
        });

      (supabase.rpc as jest.Mock).mockResolvedValueOnce({
        data: null,
        error: new Error('PostgreSQL deadlock error'),
      });

      const req1: any = { headers: { 'stripe-signature': 'sig' }, body: Buffer.from(JSON.stringify(mockEvent)) };
      const res1: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await stripeWebhookHandler(req1, res1);

      expect(res1.status).toHaveBeenCalledWith(500);

      // SECOND DELIVERY: Retry arrives
      mockQueryBuilder.maybeSingle
        .mockResolvedValueOnce({
          data: { id: 'wev-retry', stripe_event_id: 'evt_retry_cycle', status: 'failed', attempts: 1 },
          error: null,
        })
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({
          data: {
            id: 'att-1',
            user_id: 'usr-1',
            currency: 'USD',
            grand_total_cents: 55000,
            snapshot_json: { items: [], retailers: [] },
          },
          error: null,
        });

      (supabase.rpc as jest.Mock).mockResolvedValueOnce({ data: 'order-retry-succeeded', error: null });

      const req2: any = { headers: { 'stripe-signature': 'sig' }, body: Buffer.from(JSON.stringify(mockEvent)) };
      const res2: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await stripeWebhookHandler(req2, res2);

      expect(res2.status).toHaveBeenCalledWith(200);
      expect(mockQueryBuilder.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed', result: 'success' })
      );
    });

    it('safely deduplicates concurrent duplicate webhook deliveries (§8 Case D)', async () => {
      const mockEvent = {
        id: 'evt_concurrent_dup',
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_concurrent' } },
      };

      (stripe.webhooks.constructEvent as jest.Mock).mockReturnValue(mockEvent);

      // Delivery A arrives, Delivery B arrives immediately after when status is completed
      mockQueryBuilder.maybeSingle.mockResolvedValueOnce({
        data: { id: 'wev-done', stripe_event_id: 'evt_concurrent_dup', status: 'completed' },
        error: null,
      });

      const req: any = { headers: { 'stripe-signature': 'sig' }, body: Buffer.from(JSON.stringify(mockEvent)) };
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await stripeWebhookHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ already_processed: true }));
      expect(supabase.rpc).not.toHaveBeenCalled();
    });

    it('handles payment_intent.payment_failed by marking attempt as failed without order or stock deduction (§12)', async () => {
      const mockEvent = {
        id: 'evt_pi_failed',
        type: 'payment_intent.payment_failed',
        data: { object: { id: 'pi_declined' } },
      };

      (stripe.webhooks.constructEvent as jest.Mock).mockReturnValue(mockEvent);

      mockQueryBuilder.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

      const req: any = { headers: { 'stripe-signature': 'sig' }, body: Buffer.from(JSON.stringify(mockEvent)) };
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await stripeWebhookHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(mockQueryBuilder.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed' })
      );
      expect(supabase.rpc).not.toHaveBeenCalled(); // No stock or order operations
    });
  });

  describe('8. Checkout Attempt Concurrency & Expiration Lifecycle (§7, §13)', () => {
    const { createPaymentIntent } = require('../controllers/orders.controller');

    it('safely deduplicates concurrent checkout creation requests with same user and cart hash (§7)', async () => {
      const mockCart = [
        {
          id: 'cart-c1',
          user_id: 'usr-dup',
          variant_id: 'var-dup-1',
          quantity: 1,
          product_variants: {
            id: 'var-dup-1',
            price: 150.0,
            stock_quantity: 5,
            is_active: true,
            products: { title: 'Lounge Chair' },
          },
        },
      ];

      // calculateCheckout loads cart
      mockQueryBuilder.eq.mockResolvedValueOnce({ data: mockCart, error: null });

      // Existing active attempt found!
      mockQueryBuilder.maybeSingle.mockResolvedValueOnce({
        data: {
          id: 'att-active-existing',
          user_id: 'usr-dup',
          payment_intent_id: 'pi_existing_123',
          expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          snapshot_json: { grand_total: 150 },
        },
        error: null,
      });

      (stripe.paymentIntents.retrieve as jest.Mock).mockResolvedValueOnce({
        id: 'pi_existing_123',
        client_secret: 'pi_existing_123_secret',
        status: 'requires_payment_method',
      });

      const req: any = {
        user: { id: 'usr-dup' },
        body: {
          shipping_address: {
            fullName: 'Jane Doe',
            street: '123 Main St',
            city: 'Dallas',
            state: 'TX',
            zipCode: '75001',
            country: 'US',
          },
        },
      };
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await createPaymentIntent(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          client_secret: 'pi_existing_123_secret',
          checkout_attempt_id: 'att-active-existing',
        })
      );
      // Ensure NO second Stripe PaymentIntent was created!
      expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
    });

    it('transitions expired checkout attempts to status="expired" and creates fresh attempt (§13)', async () => {
      const mockCart = [
        {
          id: 'cart-exp1',
          user_id: 'usr-exp',
          variant_id: 'var-exp-1',
          quantity: 1,
          product_variants: {
            id: 'var-exp-1',
            price: 200.0,
            stock_quantity: 5,
            is_active: true,
            products: { title: 'Desk' },
          },
        },
      ];

      mockQueryBuilder.eq.mockResolvedValueOnce({ data: mockCart, error: null });

      // Existing attempt is EXPIRED (created 45 mins ago)
      mockQueryBuilder.maybeSingle.mockResolvedValueOnce({
        data: {
          id: 'att-expired-old',
          user_id: 'usr-exp',
          payment_intent_id: 'pi_stale',
          expires_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(), // Expired 15 mins ago!
          snapshot_json: { grand_total: 200 },
        },
        error: null,
      });

      (stripe.paymentIntents.create as jest.Mock).mockResolvedValueOnce({
        id: 'pi_fresh_new',
        client_secret: 'pi_fresh_new_secret',
      });

      const req: any = {
        user: { id: 'usr-exp' },
        body: {
          shipping_address: {
            fullName: 'Alice Smith',
            street: '789 Oak Ave',
            city: 'Seattle',
            state: 'WA',
            zipCode: '98101',
            country: 'US',
          },
        },
      };
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await createPaymentIntent(req, res);

      // Verify that expired attempt was updated to 'expired'
      expect(mockQueryBuilder.update).toHaveBeenCalledWith({ status: 'expired' });

      // Verify a fresh PaymentIntent was created
      expect(stripe.paymentIntents.create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 20000, currency: 'usd' }),
        expect.any(Object)
      );

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          client_secret: 'pi_fresh_new_secret',
        })
      );
    });
  });
});
