import { Response } from 'express';
import { supabase } from '../services/supabase';
import { AuthRequest } from '../types';
import { SWITCHABLE_TYPES } from '../services/notifications.service';


export async function updateLanguage(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const lang   = req.params.lang as string;

    if (!['en', 'ar'].includes(lang)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid language. Use /language/en or /language/ar',
      });
    }

    const { error } = await supabase
      .from('profiles')
      .update({
        language:   lang,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId);

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    return res.status(200).json({
      success: true,
      data:    { language: lang },
      message: `Language updated to ${lang === 'en' ? 'English' : 'Arabic'}`,
    });

  } catch (err) {
    console.error('Update language error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function updateProfile(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const { full_name, avatar_url } = req.body;

    const { data, error } = await supabase
      .from('profiles')
      .update({
        ...(full_name  && { full_name }),
        ...(avatar_url && { avatar_url }),
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    return res.status(200).json({
      success: true,
      data: { profile: data },
    });

  } catch (err) {
    console.error('Update profile error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function dismissPlanBanner(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;

    const { error } = await supabase
      .from('profiles')
      .update({
        plan_banner_dismissed: true,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId);

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    return res.status(200).json({
      success: true,
      message: 'Banner dismissed successfully.',
    });

  } catch (err) {
    console.error('Dismiss banner error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}
// ─── Notification preferences ────────────────────────────────────────────────
// Profile → Notifications. Stored as { type: false } for the types someone has
// turned off; anything missing is on. Essential notifications (refunds,
// cancellations, payment problems, account decisions) ignore these.

/** GET /profile/notification-preferences → { prefs: { order_status: true, ... } } */
export async function getNotificationPrefs(req: AuthRequest, res: Response) {
  const { data, error } = await supabase.from('profiles')
    .select('notification_prefs').eq('id', req.user!.id).maybeSingle();
  if (error) return res.status(400).json({ success: false, error: error.message });
  const stored = (data?.notification_prefs ?? {}) as Record<string, boolean>;
  const prefs = Object.fromEntries(SWITCHABLE_TYPES.map(t => [t, stored[t] !== false]));
  return res.json({ success: true, data: { prefs } });
}

/** PUT /profile/notification-preferences { prefs: { shipment: false, ... } } */
export async function updateNotificationPrefs(req: AuthRequest, res: Response) {
  const incoming = req.body?.prefs;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return res.status(400).json({ success: false, error: 'prefs must be an object' });
  }
  const { data: cur } = await supabase.from('profiles')
    .select('notification_prefs').eq('id', req.user!.id).maybeSingle();
  const next: Record<string, boolean> = { ...((cur?.notification_prefs ?? {}) as Record<string, boolean>) };
  for (const [key, value] of Object.entries(incoming)) {
    if (!(SWITCHABLE_TYPES as readonly string[]).includes(key)) {
      return res.status(400).json({ success: false, error: `Unknown notification type: ${key}` });
    }
    if (typeof value !== 'boolean') {
      return res.status(400).json({ success: false, error: `${key} must be true or false` });
    }
    next[key] = value;
  }
  const { error } = await supabase.from('profiles').update({ notification_prefs: next }).eq('id', req.user!.id);
  if (error) return res.status(400).json({ success: false, error: error.message });
  const prefs = Object.fromEntries(SWITCHABLE_TYPES.map(t => [t, next[t] !== false]));
  return res.json({ success: true, data: { prefs } });
}
