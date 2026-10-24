/**
 * Moyasar: webhook authentication and safe refunds.
 */
jest.mock('../services/supabase', () => ({
  supabase: { from: jest.fn(() => { throw new Error('database must not be touched'); }), rpc: jest.fn() },
  supabaseAuth: {},
}));
jest.mock('../services/stripe', () => ({ stripe: { refunds: { create: jest.fn() } } }));
jest.mock('../services/payments/moyasar', () => {
  const actual = jest.requireActual('../services/payments/moyasar');
  return { ...actual, moyasar: { getPayment: jest.fn(), refundPayment: jest.fn() } };
});

import { moyasarWebhookHandler } from '../controllers/orders.controller';
import { refundOrderPayment } from '../services/payments';
import { moyasar, MoyasarError } from '../services/payments/moyasar';

const mockRes = () => {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

describe('Moyasar webhook', () => {
  const OLD = process.env.MOYASAR_WEBHOOK_SECRET;
  beforeAll(() => { process.env.MOYASAR_WEBHOOK_SECRET = 'whsec-moyasar-test'; });
  afterAll(() => { process.env.MOYASAR_WEBHOOK_SECRET = OLD; });

  it.each([
    ['missing token', { id: 'e1', type: 'payment_paid', data: { id: 'x' } }],
    ['wrong token', { id: 'e1', type: 'payment_paid', secret_token: 'nope', data: { id: 'x' } }],
    ['token of another length', { id: 'e1', type: 'payment_paid', secret_token: 'whsec-moyasar-test-2' }],
  ])('rejects %s with 401 before touching the database', async (_label, body) => {
    const res = mockRes();
    await moyasarWebhookHandler({ body } as any, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('Refunds through Moyasar', () => {
  const pay = moyasar.getPayment as jest.Mock;
  const refund = moyasar.refundPayment as jest.Mock;
  beforeEach(() => { pay.mockReset(); refund.mockReset(); });

  it('refunds the asked amount', async () => {
    pay.mockResolvedValue({ id: 'p', amount: 10000, refunded: 0, status: 'paid' });
    refund.mockResolvedValue({ status: 'refunded', amount: 10000, refunded: 2500 });
    const r = await refundOrderPayment({ provider: 'moyasar', paymentId: 'p', amountMinor: 2500, key: 'k' });
    expect(refund).toHaveBeenCalledWith('p', 2500);
    expect(r.id).toBe('p:refund:2500');
  });

  it('refuses to refund more than is left on the payment', async () => {
    pay.mockResolvedValue({ id: 'p', amount: 10000, refunded: 9000, status: 'paid' });
    await expect(refundOrderPayment({ provider: 'moyasar', paymentId: 'p', amountMinor: 2000, key: 'k' }))
      .rejects.toThrow(/exceed/);
    expect(refund).not.toHaveBeenCalled();
  });

  it('after a timeout, reports success if the refund did land (no double refund on retry)', async () => {
    pay.mockResolvedValueOnce({ id: 'p', amount: 10000, refunded: 0 })
       .mockResolvedValueOnce({ id: 'p', amount: 10000, refunded: 4000 });
    refund.mockRejectedValue(new MoyasarError('Moyasar unreachable: timeout', 0));
    const r = await refundOrderPayment({ provider: 'moyasar', paymentId: 'p', amountMinor: 4000, key: 'k' });
    expect(r.id).toBe('p:refund:4000');
  });

  it('after a timeout, reports failure if the refund did not land', async () => {
    pay.mockResolvedValue({ id: 'p', amount: 10000, refunded: 0 });
    refund.mockRejectedValue(new MoyasarError('Moyasar unreachable: timeout', 0));
    await expect(refundOrderPayment({ provider: 'moyasar', paymentId: 'p', amountMinor: 4000, key: 'k' }))
      .rejects.toThrow(/unreachable/);
  });
});
