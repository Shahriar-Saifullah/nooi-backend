jest.mock('../services/supabase', () => ({ supabase: {}, supabaseAuth: {} }));
import { validateSettingsPatch } from '../services/settings.service';

describe('Platform settings validation', () => {
  it('accepts sensible values and trims text', () => {
    const r = validateSettingsPatch({ default_commission_rate: '12.5', payout_hold_days: 7, support_email: ' help@nooi.sa ', legal_name: '' });
    expect('patch' in r && r.patch).toEqual({ default_commission_rate: 12.5, payout_hold_days: 7, support_email: 'help@nooi.sa', legal_name: null });
  });
  it.each([
    [{ default_commission_rate: 101 }, /commission/],
    [{ default_commission_rate: -1 }, /commission/],
    [{ payout_hold_days: 2.5 }, /whole number/],
    [{ return_window_days: 400 }, /return window/],
    [{ min_payout_sar: 0 }, /min payout/],
    [{ support_email: 'not-an-email' }, /email/],
  ])('rejects %p', (body, msg) => {
    const r = validateSettingsPatch(body);
    expect('error' in r && r.error).toMatch(msg);
  });
  it('ignores fields it does not know', () => {
    const r = validateSettingsPatch({ id: 5, updated_by: 'x' });
    expect('patch' in r && r.patch).toEqual({});
  });
});
