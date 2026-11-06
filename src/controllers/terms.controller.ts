import { Response } from 'express';
import { AuthRequest } from '../types';
import { supabase } from '../services/supabase';
import {
  TERMS_VERSIONS, REQUIRED_BY_ROLE, TERMS_ROLES,
  acceptancesOf, missingFor, recordAcceptance, requestIp, termsRoleFor,
  type TermsRole, type TermsDocument,
} from '../services/terms.service';

/**
 * GET /terms/status?as=client
 * The caller's terms role, what it requires, and what is still missing.
 * `as=client` checks the shopper documents even for a vendor or admin.
 */
export async function getTermsStatus(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const role = await termsRoleFor(userId, req.query.as === 'client');
    const rows = await acceptancesOf(userId);
    return res.json({
      success: true,
      data: {
        role,
        versions: TERMS_VERSIONS,
        required: REQUIRED_BY_ROLE[role],
        missing: missingFor(role, rows),
        accepted: rows,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * POST /terms/accept { documents?: string[], as?: 'client', context?: string }
 * Accepts the current version of the given documents — or of everything the
 * role requires when none are named. The role is worked out on the server: a
 * shopper can't record a vendor agreement, nor a vendor an employee policy.
 */
export async function acceptTerms(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const role: TermsRole = await termsRoleFor(userId, req.body?.as === 'client');
    const allowed = REQUIRED_BY_ROLE[role];
    const asked: string[] = Array.isArray(req.body?.documents) ? req.body.documents.map(String) : allowed;
    const documents = asked.filter((d): d is TermsDocument => (allowed as string[]).includes(d));
    if (!documents.length) {
      return res.status(400).json({ success: false, error: 'Nothing to accept for this account.' });
    }
    await recordAcceptance(userId, role, documents, {
      context: typeof req.body?.context === 'string' ? req.body.context : null,
      ip: requestIp(req as any),
      userAgent: req.headers['user-agent'] || null,
    });
    const rows = await acceptancesOf(userId);
    return res.json({ success: true, data: { role, missing: missingFor(role, rows), accepted: rows } });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

/** GET /admin/terms-acceptances?user_id=&role=&limit= — the audit trail. */
export async function adminListTermsAcceptances(req: AuthRequest, res: Response) {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '100'), 10) || 100, 1), 500);
    let q = supabase
      .from('terms_acceptances')
      .select('id, user_id, role, document, version, context, ip, user_agent, accepted_at')
      .order('accepted_at', { ascending: false })
      .limit(limit);
    if (typeof req.query.user_id === 'string' && req.query.user_id) q = q.eq('user_id', req.query.user_id);
    if (typeof req.query.role === 'string' && (TERMS_ROLES as string[]).includes(req.query.role)) q = q.eq('role', req.query.role);
    const { data, error } = await q;
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, data: { acceptances: data ?? [], versions: TERMS_VERSIONS } });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
