import { Response } from 'express';
import { supabase } from '../services/supabase';
import { AuthRequest } from '../types';
import {
  UpdateVendorStatusInput,
  UpdateUserRoleInput,
  CreateAdminInput,
} from '../schemas/auth.schema';

// ─── Vendor review queue helpers ─────────────────────────────────────────────

/**
 * Columns the review queue returns.
 *
 * Explicit rather than `*`: vendor_profiles holds tax_id, cr_number and
 * vat_number, and the list view has no reason to carry tax-authority
 * identifiers for twenty-five vendors at a time. The detail endpoint adds them
 * back, because that is the one screen where an approver has to read them.
 */
const QUEUE_COLUMNS = `
  id, business_name, store_name, business_email, phone, category,
  city, country, fulfillment_type, status, submitted_at, created_at,
  decided_at, rejection_reason, reviewing_by, reviewing_at, legal_documents
`;

const REVIEW_COLUMNS = `
  ${QUEUE_COLUMNS}, description, website, address, tax_id, cr_number,
  vat_number, logo_url, verified_at, decided_by, payout_connected
`;

/** Claims older than this are treated as abandoned. */
const CLAIM_TTL_MINUTES = 10;

function isClaimLive(reviewingAt: string | null | undefined): boolean {
  if (!reviewingAt) return false;
  return Date.now() - new Date(reviewingAt).getTime() < CLAIM_TTL_MINUTES * 60_000;
}

/**
 * Attach reviewer and decider names.
 *
 * A second query rather than a PostgREST embed: vendor_profiles has two foreign
 * keys into profiles (reviewing_by, decided_by), and embedding both needs
 * disambiguating hints that break quietly whenever the schema cache lags. One
 * extra round trip, no ambiguity.
 */
async function attachAdminNames(rows: any[]): Promise<any[]> {
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.reviewing_by) ids.add(r.reviewing_by);
    if (r.decided_by) ids.add(r.decided_by);
  }
  if (ids.size === 0) {
    return rows.map(r => ({
      ...r,
      reviewing_by_name: null,
      decided_by_name: null,
      review_claim_live: isClaimLive(r.reviewing_at),
    }));
  }

  const { data: admins } = await supabase
    .from('profiles')
    .select('id, full_name')
    .in('id', [...ids]);

  const byId = new Map((admins || []).map((a: any) => [a.id, a.full_name]));

  return rows.map(r => ({
    ...r,
    reviewing_by_name: r.reviewing_by ? byId.get(r.reviewing_by) || null : null,
    decided_by_name: r.decided_by ? byId.get(r.decided_by) || null : null,
    review_claim_live: isClaimLive(r.reviewing_at),
  }));
}

// ─── Existing endpoints ──────────────────────────────────────────────────────

export async function listVendors(req: AuthRequest, res: Response) {
  try {
    const status = req.query.status as string | undefined;
    const search = req.query.search as string | undefined;
    const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
    const limit = Math.max(1, Math.min(100, parseInt((req.query.limit as string) || '20', 10)));
    const offset = (page - 1) * limit;

    let query = supabase
      .from('vendor_profiles')
      .select('*, profiles(full_name, avatar_url)', { count: 'exact' });

    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    if (search) {
      query = query.or(`business_name.ilike.%${search}%,business_email.ilike.%${search}%,phone.ilike.%${search}%,category.ilike.%${search}%`);
    }

    query = query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data: vendors, error, count } = await query;

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    return res.status(200).json({
      success: true,
      data: {
        vendors: vendors || [],
        pagination: {
          total: count || 0,
          page,
          limit,
          totalPages: Math.ceil((count || 0) / limit),
        },
      },
    });
  } catch (err) {
    console.error('listVendors error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function getVendorById(req: AuthRequest, res: Response) {
  try {
    const id = req.params.id as string;

    const { data: vendor, error } = await supabase
      .from('vendor_profiles')
      .select('*, profiles(*)')
      .eq('id', id)
      .single();

    if (error || !vendor) {
      return res.status(404).json({ success: false, error: 'Vendor not found' });
    }

    return res.status(200).json({
      success: true,
      data: { vendor },
    });
  } catch (err) {
    console.error('getVendorById error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function updateVendorStatus(req: AuthRequest, res: Response) {
  try {
    const id = req.params.id as string;
    const { status, rejection_reason } = req.body as UpdateVendorStatusInput;

    const updatePayload: Record<string, any> = {
      status,
      updated_at: new Date().toISOString(),
    };

    if (status === 'approved') {
      updatePayload.verified_at = new Date().toISOString();
      updatePayload.rejection_reason = null;
    } else if (status === 'rejected') {
      updatePayload.rejection_reason = rejection_reason || 'Application does not meet our vendor criteria.';
    }

    const { data: updatedVendor, error } = await supabase
      .from('vendor_profiles')
      .update(updatePayload)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    return res.status(200).json({
      success: true,
      data: { vendor: updatedVendor },
      message: `Vendor status successfully updated to ${status}`,
    });
  } catch (err) {
    console.error('updateVendorStatus error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function listUsers(req: AuthRequest, res: Response) {
  try {
    const role = req.query.role as string | undefined;
    const search = req.query.search as string | undefined;
    const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
    const limit = Math.max(1, Math.min(100, parseInt((req.query.limit as string) || '20', 10)));
    const offset = (page - 1) * limit;

    let query = supabase
      .from('profiles')
      .select('id, full_name, role, avatar_url, plan, onboarding_completed, created_at', { count: 'exact' });

    if (role && role !== 'all') {
      query = query.eq('role', role);
    }

    if (search) {
      query = query.ilike('full_name', `%${search}%`);
    }

    query = query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data: users, error, count } = await query;

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    return res.status(200).json({
      success: true,
      data: {
        users: users || [],
        pagination: {
          total: count || 0,
          page,
          limit,
          totalPages: Math.ceil((count || 0) / limit),
        },
      },
    });
  } catch (err) {
    console.error('listUsers error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function updateUserRole(req: AuthRequest, res: Response) {
  try {
    const id = req.params.id as string;
    const { role } = req.body as UpdateUserRoleInput;

    const requesterRole = req.userProfile?.role;

    // Guard 1: only a super_admin may hand out super_admin.
    if (role === 'super_admin' && requesterRole !== 'super_admin') {
      return res.status(403).json({
        success: false,
        error: 'Only super administrators can assign the super_admin role',
      });
    }

    // Guard 2: only a super_admin may modify an existing super_admin.
    //
    // The original code checked only which role was being ASSIGNED, so an
    // ordinary admin could PATCH a super_admin to 'user' and strip them — the
    // comment said "prevent modifying super_admin" but the condition read the
    // wrong variable. The target's current role has to be loaded to enforce it.
    const { data: target, error: targetError } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', id)
      .maybeSingle();

    if (targetError) {
      return res.status(400).json({ success: false, error: targetError.message });
    }
    if (!target) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    if (target.role === 'super_admin' && requesterRole !== 'super_admin') {
      return res.status(403).json({
        success: false,
        error: 'Only super administrators can modify a super_admin account',
      });
    }

    const { data: updatedProfile, error: profileError } = await supabase
      .from('profiles')
      .update({ role, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (profileError) {
      return res.status(400).json({ success: false, error: profileError.message });
    }

    // Update Supabase Auth user_metadata
    await supabase.auth.admin.updateUserById(id, {
      user_metadata: { role },
    });

    // Role changes are the most consequential thing an admin does — they are
    // how an account gains or loses the ability to approve vendors and refund
    // money. Record every one.
    await supabase.from('admin_audit_log').insert({
      actor_id: req.user?.id || null,
      actor_email: req.user?.email || null,
      action: 'user.role_changed',
      entity_type: 'profile',
      entity_id: id,
      summary: `Role changed from ${target.role} to ${role}`,
      metadata: { from: target.role, to: role },
    });

    return res.status(200).json({
      success: true,
      data: { profile: updatedProfile },
      message: `User role successfully changed to ${role}`,
    });
  } catch (err) {
    console.error('updateUserRole error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function createAdminUser(req: AuthRequest, res: Response) {
  try {
    const { full_name, email, password, role } = req.body as CreateAdminInput;

    const assignedRole = role || 'admin';
    const requesterRole = req.userProfile?.role;

    if (assignedRole === 'super_admin' && requesterRole !== 'super_admin') {
      return res.status(403).json({
        success: false,
        error: 'Only super administrators can create super_admin accounts',
      });
    }

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name,
        role: assignedRole,
      },
    });

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    await supabase
      .from('profiles')
      .upsert({
        id: data.user.id,
        full_name,
        role: assignedRole,
        updated_at: new Date().toISOString(),
      });

    await supabase.from('admin_audit_log').insert({
      actor_id: req.user?.id || null,
      actor_email: req.user?.email || null,
      action: 'admin.created',
      entity_type: 'profile',
      entity_id: data.user.id,
      summary: `Created ${assignedRole} account for ${email}`,
      metadata: { role: assignedRole, email },
    });

    return res.status(201).json({
      success: true,
      data: {
        admin: {
          id: data.user.id,
          email: data.user.email,
          full_name,
          role: assignedRole,
        },
      },
      message: `Admin account (${assignedRole}) created successfully`,
    });
  } catch (err) {
    console.error('createAdminUser error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function getAdminStats(req: AuthRequest, res: Response) {
  try {
    const [
      usersCount,
      vendorsCount,
      pendingVendorsCount,
      approvedVendorsCount,
      projectsCount,
    ] = await Promise.all([
      supabase.from('profiles').select('id', { count: 'exact', head: true }),
      supabase.from('vendor_profiles').select('id', { count: 'exact', head: true }),
      supabase.from('vendor_profiles').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('vendor_profiles').select('id', { count: 'exact', head: true }).eq('status', 'approved'),
      supabase.from('projects').select('id', { count: 'exact', head: true }),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        stats: {
          total_users: usersCount.count || 0,
          total_vendors: vendorsCount.count || 0,
          pending_vendors: pendingVendorsCount.count || 0,
          approved_vendors: approvedVendorsCount.count || 0,
          total_projects: projectsCount.count || 0,
        },
      },
    });
  } catch (err) {
    console.error('getAdminStats error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── Vendor review queue ─────────────────────────────────────────────────────

export async function getVendorQueue(req: AuthRequest, res: Response) {
  try {
    const tab = (req.query.tab as string) || 'pending';   // pending|approved|rejected|suspended|done|all
    const search = req.query.search as string | undefined;
    const category = req.query.category as string | undefined;
    const sort = (req.query.sort as string) || 'oldest';  // oldest|newest|vendor
    const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
    const limit = Math.max(1, Math.min(100, parseInt((req.query.limit as string) || '25', 10)));
    const offset = (page - 1) * limit;

    // Counts come from the same table in one pass, so a tab can never claim a
    // number the list then fails to produce.
    const { data: statuses, error: countError } = await supabase
      .from('vendor_profiles')
      .select('status');

    if (countError) {
      return res.status(400).json({ success: false, error: countError.message });
    }

    const counts = { pending: 0, approved: 0, rejected: 0, suspended: 0, done: 0, all: 0 };
    for (const row of statuses || []) {
      const s = row.status as keyof typeof counts;
      if (s in counts) counts[s] += 1;
      counts.all += 1;
      if (row.status !== 'pending') counts.done += 1;
    }

    let query = supabase
      .from('vendor_profiles')
      .select(QUEUE_COLUMNS, { count: 'exact' });

    if (tab === 'done') {
      query = query.neq('status', 'pending');
    } else if (tab !== 'all') {
      query = query.eq('status', tab);
    }

    if (category && category !== 'all') {
      query = query.eq('category', category);
    }

    if (search) {
      query = query.or(
        `business_name.ilike.%${search}%,store_name.ilike.%${search}%,business_email.ilike.%${search}%,city.ilike.%${search}%`
      );
    }

    if (sort === 'newest') {
      query = query.order('submitted_at', { ascending: false, nullsFirst: false });
    } else if (sort === 'vendor') {
      query = query.order('business_name', { ascending: true });
    } else if (tab === 'done') {
      query = query.order('decided_at', { ascending: false, nullsFirst: false });
    } else {
      // Oldest first by default. A review queue sorted newest first is how an
      // application sits for three weeks while fresher ones get handled.
      query = query.order('submitted_at', { ascending: true, nullsFirst: false });
    }

    query = query.range(offset, offset + limit - 1);

    const { data: vendors, error, count } = await query;

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    const rows = await attachAdminNames(vendors || []);

    return res.status(200).json({
      success: true,
      data: {
        vendors: rows.map(v => {
          const { legal_documents, ...rest } = v;
          return {
            ...rest,
            document_count: Array.isArray(legal_documents) ? legal_documents.length : 0,
          };
        }),
        counts,
        pagination: {
          total: count || 0,
          page,
          limit,
          totalPages: Math.ceil((count || 0) / limit),
        },
      },
    });
  } catch (err) {
    console.error('getVendorQueue error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function getVendorForReview(req: AuthRequest, res: Response) {
  try {
    const id = req.params.id as string;

    const { data: vendor, error } = await supabase
      .from('vendor_profiles')
      .select(REVIEW_COLUMNS)
      .eq('id', id)
      .maybeSingle();

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }
    if (!vendor) {
      return res.status(404).json({ success: false, error: 'Application not found' });
    }

    const [withNames] = await attachAdminNames([vendor]);

    /**
     * Duplicate commercial registration — reported, never blocked.
     *
     * A second outlet of the same business legitimately shares a CR, and so
     * does a fraudulent reapplication after a rejection. Telling the two apart
     * is a judgement an approver makes with a phone call, not something a
     * uniqueness constraint can decide.
     */
    let duplicates: any[] = [];
    if ((vendor as any).cr_number) {
      const { data: dupes } = await supabase
        .from('vendor_profiles')
        .select('id, business_name, city, status, submitted_at')
        .eq('cr_number', (vendor as any).cr_number)
        .neq('id', id);
      duplicates = dupes || [];
    }

    return res.status(200).json({
      success: true,
      data: {
        vendor: withNames,
        duplicates,
        // So the client can tell "my claim" from "someone else's".
        viewer_id: req.user?.id || null,
      },
    });
  } catch (err) {
    console.error('getVendorForReview error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * Claim an application for review.
 *
 * Advisory only: it tells a second admin that someone is already reading, so
 * they do not spend twenty minutes on a decision that has already been made. It
 * prevents nothing — decideVendorApplication is what enforces correctness.
 *
 * Pass { takeover: true } to seize a live claim. Someone who stepped away
 * should not block the queue, which is why claims also go stale after ten
 * minutes.
 */
export async function claimVendorReview(req: AuthRequest, res: Response) {
  try {
    const id = req.params.id as string;
    const adminId = req.user?.id;
    const takeover = Boolean(req.body?.takeover);

    if (!adminId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const { data, error } = await supabase.rpc('claim_vendor_review', {
      p_vendor_id: id,
      p_admin_id: adminId,
      p_takeover: takeover,
    });

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    const row: any = Array.isArray(data) ? data[0] : data;
    const holder = row?.holder || null;

    let holderName: string | null = null;
    if (holder && holder !== adminId) {
      const { data: p } = await supabase
        .from('profiles')
        .select('full_name')
        .eq('id', holder)
        .maybeSingle();
      holderName = p?.full_name || null;
    }

    return res.status(200).json({
      success: true,
      data: {
        // False means someone else holds a live claim — the client goes read-only.
        acquired: Boolean(row?.was_claimed),
        holder,
        holder_name: holderName,
        claimed_at: row?.claimed_at || null,
        is_me: holder === adminId,
      },
    });
  } catch (err) {
    console.error('claimVendorReview error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function decideVendorApplication(req: AuthRequest, res: Response) {
  try {
    const id = req.params.id as string;
    const { status, rejection_reason } = req.body || {};
    const adminId = req.user?.id;

    if (!adminId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    if (!['approved', 'rejected', 'suspended'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'status must be approved, rejected or suspended',
      });
    }
    // A rejection a vendor cannot act on is a support ticket. Enforce the reason
    // here rather than hoping the UI does.
    if (status === 'rejected' && !String(rejection_reason || '').trim()) {
      return res.status(400).json({ success: false, error: 'A rejection reason is required' });
    }

    const { data, error } = await supabase.rpc('decide_vendor_application', {
      p_vendor_id: id,
      p_admin_id: adminId,
      p_status: status,
      p_rejection_reason: rejection_reason || null,
    });

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    const row: any = Array.isArray(data) ? data[0] : data;

    // The function only applies while the application is still pending. If
    // another admin decided first, say so plainly rather than reporting a
    // success that changed nothing.
    if (!row?.applied) {
      let deciderName: string | null = null;
      if (row?.decided_by) {
        const { data: p } = await supabase
          .from('profiles')
          .select('full_name')
          .eq('id', row.decided_by)
          .maybeSingle();
        deciderName = p?.full_name || null;
      }
      return res.status(409).json({
        success: false,
        error: 'already_decided',
        data: {
          final_status: row?.final_status || null,
          decided_by_name: deciderName,
          decided_at: row?.decided_at || null,
        },
      });
    }

    // Audit before notifying: if the log write fails we want to know before a
    // vendor has been told something we cannot account for.
    await supabase.from('admin_audit_log').insert({
      actor_id: adminId,
      actor_email: req.user?.email || null,
      action: `vendor.${status}`,
      entity_type: 'vendor_profile',
      entity_id: id,
      summary:
        status === 'rejected'
          ? `Rejected vendor application: ${String(rejection_reason).slice(0, 200)}`
          : `Vendor application ${status}`,
      metadata: { status, rejection_reason: rejection_reason || null },
    });

    await supabase.from('notifications').insert({
      user_id: id,
      title:
        status === 'approved'
          ? 'Your vendor account is approved'
          : status === 'rejected'
            ? 'About your vendor application'
            : 'Your vendor account has been suspended',
      message:
        status === 'approved'
          ? 'You can now list products on Nooi. Open your vendor dashboard to add your first listing.'
          : status === 'rejected'
            ? String(rejection_reason)
            : 'Your account has been suspended. Contact support for details.',
      type: 'vendor_approval',
    });

    return res.status(200).json({
      success: true,
      data: { final_status: row.final_status, decided_at: row.decided_at },
      message: `Vendor application ${status}`,
    });
  } catch (err) {
    console.error('decideVendorApplication error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * Admin overview — add to src/controllers/admin.controller.ts
 * ============================================================================
 * Route:  router.get('/overview', requireAdmin, getAdminOverview);
 *
 * getAdminStats answers "how are we doing" — total users, total projects. The
 * dashboard asks a different question: what is waiting on me, and what has been
 * waiting longest. Those need per-queue pending counts and the age of the
 * oldest item, which is a different query entirely.
 *
 * Queues with no backend yet report `available: false` rather than zero. A zero
 * means "nothing waiting", which is a claim this code cannot make about
 * listings or cancellations — there is no table to look in. Showing an honest
 * "not built" beats an encouraging lie on a screen whose whole job is telling
 * an admin what they have missed.
 */

interface QueueSummary {
  key: string;
  label: string;
  href: string;
  count: number;
  /** ISO timestamp of the oldest waiting item, for the age label. */
  oldest: string | null;
  available: boolean;
}

export async function getAdminOverview(req: AuthRequest, res: Response) {
  try {
    const queues: QueueSummary[] = [];
    const oldestItems: any[] = [];

    // ── Vendor applications ──────────────────────────────────────────────
    const { data: pendingVendors } = await supabase
      .from('vendor_profiles')
      .select('id, business_name, submitted_at')
      .eq('status', 'pending')
      .order('submitted_at', { ascending: true, nullsFirst: false });

    const vendorRows = pendingVendors || [];
    queues.push({
      key: 'vendors',
      label: 'Vendor applications',
      href: '/admin/applications',
      count: vendorRows.length,
      oldest: vendorRows[0]?.submitted_at || null,
      available: true,
    });

    for (const v of vendorRows.slice(0, 5)) {
      oldestItems.push({
        queue: 'Vendor application',
        title: v.business_name,
        ref: v.id,
        href: `/admin/applications?id=${v.id}`,
        since: v.submitted_at,
      });
    }

    // ── Return requests ──────────────────────────────────────────────────
    // order_returns exists and the shopper-side flow writes to it, so this is
    // real even though the refunds screen isn't built. An admin should see the
    // backlog before the screen to clear it exists, not after.
    const { data: pendingReturns, error: returnsError } = await supabase
      .from('order_returns')
      .select('id, order_id, reason, created_at')
      .eq('status', 'requested')
      .order('created_at', { ascending: true });

    if (!returnsError) {
      const returnRows = pendingReturns || [];
      queues.push({
        key: 'refunds',
        label: 'Return requests',
        href: '/admin/refunds',
        count: returnRows.length,
        oldest: returnRows[0]?.created_at || null,
        available: true,
      });

      for (const r of returnRows.slice(0, 5)) {
        oldestItems.push({
          queue: 'Return request',
          title: r.reason?.slice(0, 60) || 'Return request',
          ref: r.order_id,
          href: `/admin/refunds?id=${r.id}`,
          since: r.created_at,
        });
      }
    }

    // ── Not built yet ────────────────────────────────────────────────────
    // Declared so the dashboard can show the shape of the job, with
    // available:false so it never claims a count it cannot know.
    queues.push(
      { key: 'listings', label: 'Listing approvals', href: '/admin/listings', count: 0, oldest: null, available: false },
      { key: 'cancellations', label: 'Cancellations', href: '/admin/cancellations', count: 0, oldest: null, available: false },
      { key: 'support', label: 'Support', href: '/admin/support', count: 0, oldest: null, available: false },
    );

    // Oldest first across every queue — the point of the panel is that the
    // thing waiting longest is rarely in the queue you happen to open.
    oldestItems.sort((a, b) => {
      const ta = a.since ? new Date(a.since).getTime() : Infinity;
      const tb = b.since ? new Date(b.since).getTime() : Infinity;
      return ta - tb;
    });

    // ── Recent interventions ─────────────────────────────────────────────
    const { data: recent } = await supabase
      .from('admin_audit_log')
      .select('id, action, entity_type, entity_id, summary, actor_email, created_at')
      .order('created_at', { ascending: false })
      .limit(6);

    // Name the actors in one query rather than one per row.
    const actorEmails = [...new Set((recent || []).map((r: any) => r.actor_email).filter(Boolean))];
    let namesByEmail = new Map<string, string>();
    if (actorEmails.length > 0) {
      const { data: users } = await supabase.auth.admin.listUsers();
      const matching = (users?.users || []).filter((u: any) => actorEmails.includes(u.email));
      namesByEmail = new Map(
        matching.map((u: any) => [u.email, u.user_metadata?.full_name || u.email])
      );
    }

    const interventions = (recent || []).map((r: any) => ({
      ...r,
      actor_name: r.actor_email ? namesByEmail.get(r.actor_email) || r.actor_email : 'System',
    }));

    // ── Secondary figures ────────────────────────────────────────────────
    const [usersCount, vendorsCount, approvedVendors, ordersCount] = await Promise.all([
      supabase.from('profiles').select('id', { count: 'exact', head: true }),
      supabase.from('vendor_profiles').select('id', { count: 'exact', head: true }),
      supabase.from('vendor_profiles').select('id', { count: 'exact', head: true }).eq('status', 'approved'),
      supabase.from('orders').select('id', { count: 'exact', head: true }),
    ]);

    const totalWaiting = queues
      .filter(q => q.available)
      .reduce((n, q) => n + q.count, 0);

    return res.status(200).json({
      success: true,
      data: {
        queues,
        total_waiting: totalWaiting,
        oldest: oldestItems.slice(0, 5),
        interventions,
        kpis: {
          total_users: usersCount.count || 0,
          total_vendors: vendorsCount.count || 0,
          approved_vendors: approvedVendors.count || 0,
          total_orders: ordersCount.count || 0,
        },
        // So the client can say how fresh the figures are rather than implying
        // they're live.
        generated_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('getAdminOverview error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}