import { Router, Response, NextFunction } from 'express';
import { supabase } from '../services/supabase';
import { AuthRequest } from '../types';
import { cleanQuery, kindsFor, scopeForRole, searchPlatform } from '../services/search.service';

const router = Router();

/** Signed in or not — search works for both, and shows more when signed in. */
async function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction) {
  const token = req.cookies?.access_token || req.headers.authorization?.split(' ')[1];
  if (token) {
    try {
      const { data: { user } } = await supabase.auth.getUser(token);
      if (user) {
        req.user = user;
        const { data: profile } = await supabase.from('profiles').select('id, role, full_name').eq('id', user.id).maybeSingle();
        req.userProfile = (profile as any) ?? { id: user.id, role: (user.user_metadata?.role as any) || 'user', full_name: null };
      }
    } catch { /* search anonymously */ }
  }
  next();
}

/**
 * GET /search?q=sofa&kinds=product,vendor&limit=6
 * Results grouped by kind, only what the caller may see.
 */
router.get('/', optionalAuth, async (req: AuthRequest, res: Response) => {
  const q = cleanQuery(req.query.q);
  const scope = scopeForRole(req.userProfile?.role, Boolean(req.user));
  if (!q) return res.json({ success: true, data: { q: '', scope, groups: [], total: 0 } });
  const kinds = kindsFor(scope, req.query.kinds);
  const perKind = Math.min(Math.max(parseInt(String(req.query.limit || '6'), 10) || 6, 1), 25);
  try {
    const result = await searchPlatform(q, req.user?.id ?? null, scope, kinds, perKind);
    return res.json({ success: true, data: { q, scope, ...result } });
  } catch (err: any) {
    console.error('[search] failed:', err.message);
    return res.status(500).json({ success: false, error: 'Search is unavailable right now.' });
  }
});

export default router;
