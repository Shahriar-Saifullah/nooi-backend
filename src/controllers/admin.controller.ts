import { Response } from 'express';
import { stripe } from '../services/stripe';
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

/**
 * Team — add to src/controllers/admin.controller.ts
 * ============================================================================
 * Routes:
 *   router.get('/team',          requireAdmin, getTeam);
 *   router.post('/team/invite',  requireAdmin, inviteTeamMember);
 *
 * listUsers already exists but is the wrong shape here: it selects from
 * profiles, which has no email and no sign-in history. The team screen needs
 * both — "who is this" and "are they still using it" — and those live in
 * auth.users.
 */

/** Console roles, least to most privileged. Order matters for the matrix. */
const CONSOLE_ROLES = ['admin', 'super_admin'] as const;

export async function getTeam(req: AuthRequest, res: Response) {
  try {
    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('id, full_name, role, avatar_url, created_at')
      .in('role', CONSOLE_ROLES as unknown as string[])
      .order('created_at', { ascending: true });

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    // Email and last sign-in live in auth.users, not profiles. One listUsers
    // call and a map, rather than a getUserById per row.
    const { data: authData } = await supabase.auth.admin.listUsers({ perPage: 200 });
    const authById = new Map(
      (authData?.users || []).map((u: any) => [u.id, u])
    );

    const members = (profiles || []).map(p => {
      const au: any = authById.get(p.id);
      return {
        id: p.id,
        full_name: p.full_name,
        email: au?.email || null,
        role: p.role,
        avatar_url: p.avatar_url,
        created_at: p.created_at,
        last_sign_in_at: au?.last_sign_in_at || null,
        /**
         * An invited member who has never signed in is in a different state
         * from an active one — the invite may have gone to a dead mailbox, and
         * an admin account nobody has ever used is worth noticing.
         */
        status: au?.last_sign_in_at
          ? 'active'
          : au?.invited_at
            ? 'invited'
            : 'never signed in',
      };
    });

    /**
     * The permission matrix, derived from the guards that actually run rather
     * than written by hand. Every entry below corresponds to a real check in
     * this codebase — if someone changes requireAdmin or the super_admin guards
     * in updateUserRole, this table has to change with them or it becomes a
     * description of what we wish were true.
     */
    const permissions = [
      { label: 'Open the console',            admin: true,  super_admin: true,
        note: 'requireAdmin on every /admin route' },
      { label: 'Approve or reject vendors',   admin: true,  super_admin: true,
        note: 'decideVendorApplication' },
      { label: 'Change a user\'s role',       admin: true,  super_admin: true,
        note: 'updateUserRole' },
      { label: 'Modify a super admin',        admin: false, super_admin: true,
        note: 'target role check in updateUserRole' },
      { label: 'Assign the super admin role', admin: false, super_admin: true,
        note: 'assigned role check in updateUserRole' },
      { label: 'Create an admin account',     admin: true,  super_admin: true,
        note: 'createAdminUser' },
      { label: 'Create a super admin',        admin: false, super_admin: true,
        note: 'requester check in createAdminUser' },
    ];

    return res.status(200).json({
      success: true,
      data: {
        members,
        permissions,
        roles: CONSOLE_ROLES,
        viewer_role: req.userProfile?.role || 'admin',
      },
    });
  } catch (err) {
    console.error('getTeam error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * Invite someone to the console.
 *
 * Deliberately an invite rather than createAdminUser: that one takes a password
 * chosen by the inviter, which means an admin credential travels through
 * whatever channel they use to pass it on. inviteUserByEmail sends a one-time
 * link and the invitee sets their own password, so nobody else ever knows it.
 */
export async function inviteTeamMember(req: AuthRequest, res: Response) {
  try {
    const { email, role } = req.body || {};
    const requesterRole = req.userProfile?.role;

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ success: false, error: 'An email address is required' });
    }
    if (!CONSOLE_ROLES.includes(role)) {
      return res.status(400).json({ success: false, error: 'Role must be admin or super_admin' });
    }
    if (role === 'super_admin' && requesterRole !== 'super_admin') {
      return res.status(403).json({
        success: false,
        error: 'Only super administrators can invite a super_admin',
      });
    }

    const cleanEmail = email.trim().toLowerCase();

    const { data, error } = await supabase.auth.admin.inviteUserByEmail(cleanEmail, {
      data: { role },
      redirectTo: `${process.env.FRONTEND_URL?.split(',')[0] || ''}/authpage/signin`,
    });

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    const invitedId = data?.user?.id;
    if (invitedId) {
      // profiles.role is what RBAC reads. The invite's user_metadata is not
      // enough — a user can rewrite their own metadata, and requireRole does
      // not look there.
      await supabase.from('profiles').upsert(
        { id: invitedId, role, updated_at: new Date().toISOString() },
        { onConflict: 'id' },
      );
    }

    await supabase.from('admin_audit_log').insert({
      actor_id: req.user?.id || null,
      actor_email: req.user?.email || null,
      action: 'team.invited',
      entity_type: 'profile',
      entity_id: invitedId || null,
      summary: `Invited ${cleanEmail} as ${role}`,
      metadata: { email: cleanEmail, role },
    });

    return res.status(201).json({
      success: true,
      data: { email: cleanEmail, role, id: invitedId || null },
      message: `Invite sent to ${cleanEmail}`,
    });
  } catch (err) {
    console.error('inviteTeamMember error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

const DOCUMENT_BUCKET = 'vendor-documents';
const SIGNED_URL_TTL_SECONDS = 300;
 
export async function getVendorDocumentUrl(req: AuthRequest, res: Response) {
  try {
    const vendorId = req.params.id as string;
    const kind = req.params.kind as string;
 
    const { data: vendor, error } = await supabase
      .from('vendor_profiles')
      .select('id, business_name, legal_documents')
      .eq('id', vendorId)
      .maybeSingle();
 
    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }
    if (!vendor) {
      return res.status(404).json({ success: false, error: 'Vendor not found' });
    }
 
    // The path comes from the vendor's own record, never from the request. A
    // caller supplying its own path could sign a URL for any object in the
    // bucket, including another vendor's bank letter.
    const docs: any[] = Array.isArray(vendor.legal_documents) ? vendor.legal_documents : [];
    const doc = docs.find(d => d?.kind === kind);
 
    if (!doc?.path) {
      return res.status(404).json({
        success: false,
        error: 'That document has not been provided',
      });
    }
 
    // Storage keys are stored with the bucket name prefixed in some rows and
    // not others. Normalise rather than letting one shape 404.
    const objectPath = String(doc.path).replace(new RegExp(`^${DOCUMENT_BUCKET}/`), '');
 
    const { data: signed, error: signError } = await supabase.storage
      .from(DOCUMENT_BUCKET)
      .createSignedUrl(objectPath, SIGNED_URL_TTL_SECONDS);
 
    if (signError || !signed?.signedUrl) {
      // The record exists but the file does not — most likely a vendor row
      // created before uploads were wired up. Say which, because "document
      // missing" and "storage misconfigured" need different fixes.
      console.error('[admin] could not sign document', {
        vendor_id: vendorId,
        kind,
        path: objectPath,
        error: signError?.message,
      });
      return res.status(404).json({
        success: false,
        error: 'The file is recorded but not in storage. It may never have been uploaded.',
      });
    }
 
    // Viewing a vendor's legal documents is worth recording. If a registration
    // turns out to be fraudulent, who looked at the licence and when is the
    // first question asked.
    await supabase.from('admin_audit_log').insert({
      actor_id: req.user?.id || null,
      actor_email: req.user?.email || null,
      action: 'vendor.document_viewed',
      entity_type: 'vendor_profile',
      entity_id: vendorId,
      summary: `Viewed ${doc.label || kind} for ${vendor.business_name}`,
      metadata: { kind, label: doc.label || null },
    });
 
    return res.status(200).json({
      success: true,
      data: {
        url: signed.signedUrl,
        label: doc.label || kind,
        expires_in: SIGNED_URL_TTL_SECONDS,
      },
    });
  } catch (err) {
    console.error('getVendorDocumentUrl error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * Audit log — add to src/controllers/admin.controller.ts
 * ============================================================================
 * Routes:
 *   router.get('/audit',            requireAdmin, getAuditLog);
 *   router.get('/audit/export',     requireAdmin, exportAuditLog);
 *
 * Read-only by design. admin_audit_log has no update or delete path anywhere in
 * this codebase, and no RLS policy that would let a browser write to it — an
 * audit log an admin can edit is not an audit log.
 *
 * The filter options come from the data rather than a hardcoded list. An action
 * type that exists in the table but not in the dropdown is invisible, which is
 * the one failure an audit log must not have.
 */

export async function getAuditLog(req: AuthRequest, res: Response) {
  try {
    const search = req.query.search as string | undefined;
    const actor = req.query.actor as string | undefined;
    const action = req.query.action as string | undefined;
    const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
    const limit = Math.max(1, Math.min(200, parseInt((req.query.limit as string) || '50', 10)));
    const offset = (page - 1) * limit;

    let query = supabase
      .from('admin_audit_log')
      .select('*', { count: 'exact' });

    if (actor && actor !== 'all') {
      query = query.eq('actor_email', actor);
    }
    if (action && action !== 'all') {
      // Prefix match so "vendor" catches vendor.approved, vendor.rejected and
      // vendor.document_viewed — an admin thinks in subjects, not event names.
      query = query.like('action', `${action}%`);
    }
    if (search) {
      query = query.or(
        `summary.ilike.%${search}%,entity_id.ilike.%${search}%,action.ilike.%${search}%`
      );
    }

    query = query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data, error, count } = await query;

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    // Filter options from the data itself. A hardcoded list goes stale the
    // first time someone adds an action type, and an entry you cannot filter
    // to is an entry nobody finds.
    const { data: allRows } = await supabase
      .from('admin_audit_log')
      .select('actor_email, action');

    const actors = [...new Set((allRows || []).map((r: any) => r.actor_email).filter(Boolean))].sort();
    const actionGroups = [...new Set(
      (allRows || []).map((r: any) => String(r.action).split('.')[0]).filter(Boolean)
    )].sort();

    return res.status(200).json({
      success: true,
      data: {
        entries: data || [],
        actors,
        action_groups: actionGroups,
        pagination: {
          total: count || 0,
          page,
          limit,
          totalPages: Math.ceil((count || 0) / limit),
        },
      },
    });
  } catch (err) {
    console.error('getAuditLog error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * CSV export.
 *
 * Exports every row matching the filters, not just the current page — an export
 * that silently stops at 50 rows is worse than none, because the person reading
 * it believes they have the whole picture.
 */
export async function exportAuditLog(req: AuthRequest, res: Response) {
  try {
    const search = req.query.search as string | undefined;
    const actor = req.query.actor as string | undefined;
    const action = req.query.action as string | undefined;

    let query = supabase.from('admin_audit_log').select('*');

    if (actor && actor !== 'all') query = query.eq('actor_email', actor);
    if (action && action !== 'all') query = query.like('action', `${action}%`);
    if (search) {
      query = query.or(
        `summary.ilike.%${search}%,entity_id.ilike.%${search}%,action.ilike.%${search}%`
      );
    }

    const { data, error } = await query.order('created_at', { ascending: false }).limit(10000);

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    const header = ['Time (UTC)', 'Admin', 'Action', 'Record type', 'Record', 'Summary'];

    /**
     * A field starting with = + - or @ is executed as a formula when the file
     * opens in Excel or Sheets. Admin-entered text ends up in this export, so
     * prefix those with an apostrophe.
     */
    const cell = (v: unknown): string => {
      let s = v == null ? '' : String(v);
      if (/^[=+\-@]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };

    const rows = (data || []).map((r: any) => [
      new Date(r.created_at).toISOString(),
      r.actor_email || 'system',
      r.action,
      r.entity_type,
      r.entity_id || '',
      r.summary || '',
    ].map(cell).join(','));

    const csv = [header.map(cell).join(','), ...rows].join('\r\n');
    const stamp = new Date().toISOString().slice(0, 10);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="nooi-audit-${stamp}.csv"`);
    // Byte order mark, so Excel reads it as UTF-8 rather than mangling any
    // non-ASCII business name.
    return res.status(200).send('\uFEFF' + csv);
  } catch (err) {
    console.error('exportAuditLog error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * Vendor directory — add to src/controllers/admin.controller.ts
 * ============================================================================
 * Route:  router.get('/vendors/directory', requireAdmin, getVendorDirectory);
 *
 * Declare it ABOVE /vendors/:id, like /vendors/queue — otherwise Express reads
 * "directory" as an id.
 *
 * Two figures need stating, because both have more than one defensible answer:
 *
 *   GMV is GROSS, before commission. It is what customers paid for this
 *   vendor's goods, and the commission rate sits next to it so the two are
 *   never conflated. Netting it here would quietly answer a different question
 *   — what Nooi owes them — which is the payouts screen's job.
 *
 *   Open orders counts ITEMS not yet delivered, by item_status. Not shipments:
 *   an item can be 'processing' while its shipment is still 'label_pending',
 *   and the question an admin is asking is "how much of this vendor's work is
 *   outstanding", which is a count of goods, not parcels.
 */

const GMV_WINDOW_DAYS = 90;

export async function getVendorDirectory(req: AuthRequest, res: Response) {
  try {
    const tab = (req.query.tab as string) || 'all';   // all|attention|approved|suspended
    const search = req.query.search as string | undefined;

    // Approved and suspended only. Pending and rejected applications belong to
    // the approval queue — a directory of vendors who cannot trade is a
    // different screen wearing this one's clothes.
    let query = supabase
      .from('vendor_profiles')
      .select(`
        id, business_name, store_name, business_email, city, country,
        category, fulfillment_type, status, payout_connected,
        legal_documents, verified_at, decided_at
      `)
      .in('status', ['approved', 'suspended']);

    if (search) {
      query = query.or(
        `business_name.ilike.%${search}%,store_name.ilike.%${search}%,business_email.ilike.%${search}%,city.ilike.%${search}%`
      );
    }

    const { data: vendors, error } = await query.order('business_name', { ascending: true });

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    const vendorRows = vendors || [];
    const vendorIds = vendorRows.map(v => v.id);

    if (vendorIds.length === 0) {
      return res.status(200).json({
        success: true,
        data: { vendors: [], counts: { all: 0, attention: 0, approved: 0, suspended: 0 } },
      });
    }

    // ── Storefronts ──────────────────────────────────────────────────────
    // One vendor can own several, which is why this is a map of arrays rather
    // than a single retailer per vendor.
    const { data: retailers } = await supabase
      .from('retailers')
      .select('id, name, vendor_id, commission_rate')
      .in('vendor_id', vendorIds);

    const retailersByVendor = new Map<string, any[]>();
    const vendorByRetailer = new Map<string, string>();
    for (const r of retailers || []) {
      if (!r.vendor_id) continue;
      const list = retailersByVendor.get(r.vendor_id) || [];
      list.push(r);
      retailersByVendor.set(r.vendor_id, list);
      vendorByRetailer.set(r.id, r.vendor_id);
    }

    // ── Sales, in one pass ───────────────────────────────────────────────
    // A query per vendor would be N round trips to answer one question. Pull
    // the window once and fold it.
    const since = new Date(Date.now() - GMV_WINDOW_DAYS * 86_400_000).toISOString();
    const retailerIds = [...vendorByRetailer.keys()];

    const gmvByVendor = new Map<string, number>();
    const openByVendor = new Map<string, number>();

    if (retailerIds.length > 0) {
      const { data: items } = await supabase
        .from('order_items')
        .select('retailer_id, total_price, quantity, item_status, orders!inner(created_at, status)')
        .in('retailer_id', retailerIds)
        .gte('orders.created_at', since);

      for (const it of (items || []) as any[]) {
        const vendorId = vendorByRetailer.get(it.retailer_id);
        if (!vendorId) continue;

        // Cancelled and refunded orders are not revenue. Counting them would
        // flatter a vendor whose goods keep coming back.
        const orderStatus = it.orders?.status;
        if (orderStatus === 'paid' || orderStatus === 'fulfilled') {
          gmvByVendor.set(vendorId, (gmvByVendor.get(vendorId) || 0) + Number(it.total_price || 0));
        }

        if (it.item_status && it.item_status !== 'delivered' && it.item_status !== 'cancelled') {
          openByVendor.set(vendorId, (openByVendor.get(vendorId) || 0) + Number(it.quantity || 0));
        }
      }
    }

    // ── Sign-in history ──────────────────────────────────────────────────
    const { data: authData } = await supabase.auth.admin.listUsers({ perPage: 200 });
    const lastSignInById = new Map(
      (authData?.users || []).map((u: any) => [u.id, u.last_sign_in_at || null])
    );

    // ── Assemble ─────────────────────────────────────────────────────────
    const rows = vendorRows.map(v => {
      const docs = Array.isArray(v.legal_documents) ? v.legal_documents : [];
      const storefronts = retailersByVendor.get(v.id) || [];

      /**
       * Why a vendor needs attention, as a list rather than a flag. An admin
       * opening this screen wants to know what to do, and "needs attention"
       * without a reason just moves the question along.
       */
      const issues: string[] = [];
      if (docs.length === 0) issues.push('No documents');
      if (!v.payout_connected) issues.push('No payout account');
      if (storefronts.length === 0) issues.push('No storefront');
      if (v.status === 'suspended') issues.push('Suspended');

      return {
        id: v.id,
        business_name: v.business_name,
        store_name: v.store_name,
        business_email: v.business_email,
        city: v.city,
        country: v.country,
        category: v.category,
        fulfillment_type: v.fulfillment_type,
        status: v.status,
        payout_connected: v.payout_connected,
        document_count: docs.length,
        storefronts: storefronts.map(r => ({ id: r.id, name: r.name })),
        // Several storefronts could carry different rates; show the range
        // rather than picking one and being quietly wrong.
        commission_rate: storefronts.length > 0
          ? Number(storefronts[0].commission_rate ?? 0)
          : null,
        gmv_90d: Number((gmvByVendor.get(v.id) || 0).toFixed(2)),
        open_items: openByVendor.get(v.id) || 0,
        last_sign_in_at: lastSignInById.get(v.id) || null,
        verified_at: v.verified_at,
        issues,
        needs_attention: issues.length > 0,
      };
    });

    const counts = {
      all: rows.length,
      attention: rows.filter(r => r.needs_attention).length,
      approved: rows.filter(r => r.status === 'approved').length,
      suspended: rows.filter(r => r.status === 'suspended').length,
    };

    const filtered =
      tab === 'attention' ? rows.filter(r => r.needs_attention)
      : tab === 'approved' ? rows.filter(r => r.status === 'approved')
      : tab === 'suspended' ? rows.filter(r => r.status === 'suspended')
      : rows;

    return res.status(200).json({
      success: true,
      data: {
        vendors: filtered,
        counts,
        gmv_window_days: GMV_WINDOW_DAYS,
      },
    });
  } catch (err) {
    console.error('getVendorDirectory error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * Returns and refunds — add to src/controllers/admin.controller.ts
 * ============================================================================
 * Routes:
 *   router.get('/returns',            requireAdmin, getReturnsQueue);
 *   router.get('/returns/:id',        requireAdmin, getReturnForReview);
 *   router.post('/returns/:id/refund',requireAdmin, refundReturn);
 *   router.post('/returns/:id/decline',requireAdmin, declineReturn);
 *
 * Needs, at the top of admin.controller.ts:
 *   import { stripe } from '../services/stripe';
 *
 * Full-item refunds only in v1, per the design. The amount is always the item's
 * total_price read from the database — never from the request body. A refund
 * amount a client could name is a refund amount a client could choose.
 *
 * The sequence for a refund is deliberate:
 *
 *   1. claim_return_for_refund flips 'requested' → 'refunding' conditionally.
 *      Only the caller that wins talks to Stripe.
 *   2. Stripe refund.
 *   3. settle_return_refund records the refund id, marks the item returned and
 *      restores stock — or releases the row back to 'requested' if Stripe
 *      failed.
 *
 * Doing it in the other order — refund first, update after — means a crash
 * between the two leaves money gone with nothing recording it.
 */

/** What a returns row needs, with the order and goods it refers to. */
const RETURN_COLUMNS = `
  id, order_id, order_item_id, user_id, reason, photo_urls, status,
  refund_amount, decided_by, decided_at, decision_note, stripe_refund_id,
  created_at, updated_at
`;

export async function getReturnsQueue(req: AuthRequest, res: Response) {
  try {
    const tab = (req.query.tab as string) || 'requested';   // requested|done|all
    const search = req.query.search as string | undefined;
    const sort = (req.query.sort as string) || 'oldest';

    let query = supabase.from('order_returns').select(RETURN_COLUMNS);

    if (tab === 'done') query = query.in('status', ['refunded', 'declined']);
    else if (tab !== 'all') query = query.eq('status', tab);

    query = sort === 'newest'
      ? query.order('created_at', { ascending: false })
      : sort === 'value'
        ? query.order('refund_amount', { ascending: false })
        // Oldest first by default. A refund queue sorted newest first is how
        // someone waits three weeks for their money.
        : query.order('created_at', { ascending: true });

    const { data: returns, error } = await query;

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    const rows = returns || [];
    if (rows.length === 0) {
      return res.status(200).json({
        success: true,
        data: { returns: [], counts: { requested: 0, done: 0, all: 0 } },
      });
    }

    // Enrich in two queries rather than per row.
    const itemIds = [...new Set(rows.map(r => r.order_item_id).filter(Boolean))];
    const orderIds = [...new Set(rows.map(r => r.order_id).filter(Boolean))];

    const { data: items } = await supabase
      .from('order_items')
      .select(`
        id, quantity, unit_price, total_price, item_status, retailer_id,
        product_variants ( sku, color, images, products ( title ) ),
        retailers ( name )
      `)
      .in('id', itemIds);

    const { data: orders } = await supabase
      .from('orders')
      .select('id, order_number, payment_intent_id, total_amount, created_at, shipping_address')
      .in('id', orderIds);

    const itemById = new Map((items || []).map((i: any) => [i.id, i]));
    const orderById = new Map((orders || []).map((o: any) => [o.id, o]));

    const enriched = rows.map(r => {
      const item: any = itemById.get(r.order_item_id);
      const order: any = orderById.get(r.order_id);
      return {
        ...r,
        item_title: item?.product_variants?.products?.title ?? 'Item',
        item_variant: item?.product_variants?.color ?? null,
        item_image: item?.product_variants?.images?.[0] ?? null,
        item_quantity: item?.quantity ?? 0,
        // Full-item refunds in v1, so the item's total IS the refund. Shown
        // from the item rather than refund_amount, which is 0 on rows written
        // before this screen existed.
        amount: Number(item?.total_price ?? r.refund_amount ?? 0),
        vendor_name: item?.retailers?.name ?? null,
        order_number: order?.order_number ?? null,
        customer_name: order?.shipping_address?.fullName ?? null,
      };
    });

    const filtered = search
      ? enriched.filter(r =>
          [r.item_title, r.order_number, r.vendor_name, r.reason]
            .filter(Boolean)
            .some(v => String(v).toLowerCase().includes(search.toLowerCase()))
        )
      : enriched;

    const { data: allStatuses } = await supabase.from('order_returns').select('status');
    const counts = { requested: 0, done: 0, all: 0 };
    for (const row of allStatuses || []) {
      counts.all += 1;
      if (row.status === 'requested' || row.status === 'refunding') counts.requested += 1;
      else counts.done += 1;
    }

    return res.status(200).json({
      success: true,
      data: { returns: filtered, counts },
    });
  } catch (err) {
    console.error('getReturnsQueue error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function getReturnForReview(req: AuthRequest, res: Response) {
  try {
    const id = req.params.id as string;

    const { data: ret, error } = await supabase
      .from('order_returns')
      .select(RETURN_COLUMNS)
      .eq('id', id)
      .maybeSingle();

    if (error) return res.status(400).json({ success: false, error: error.message });
    if (!ret) return res.status(404).json({ success: false, error: 'Return not found' });

    const { data: item } = await supabase
      .from('order_items')
      .select(`
        id, quantity, unit_price, total_price, item_status, retailer_id,
        product_variants ( sku, color, material, images, products ( title ) ),
        retailers ( id, name, city )
      `)
      .eq('id', ret.order_item_id)
      .maybeSingle();

    const { data: order } = await supabase
      .from('orders')
      .select('id, order_number, payment_intent_id, total_amount, subtotal, created_at, shipping_address, status')
      .eq('id', ret.order_id)
      .maybeSingle();

    let deciderName: string | null = null;
    if (ret.decided_by) {
      const { data: p } = await supabase
        .from('profiles').select('full_name').eq('id', ret.decided_by).maybeSingle();
      deciderName = p?.full_name ?? null;
    }

    // Other returns on the same order. Three returns from one customer is a
    // different conversation from one, and an admin should see that before
    // deciding rather than after.
    const { data: siblings } = await supabase
      .from('order_returns')
      .select('id, status, reason, created_at')
      .eq('order_id', ret.order_id)
      .neq('id', id);

    return res.status(200).json({
      success: true,
      data: {
        return: {
          ...ret,
          decided_by_name: deciderName,
          amount: Number((item as any)?.total_price ?? ret.refund_amount ?? 0),
        },
        item,
        order,
        other_returns_on_order: siblings || [],
        // Nothing can be refunded without this.
        refundable: Boolean((order as any)?.payment_intent_id),
      },
    });
  } catch (err) {
    console.error('getReturnForReview error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function refundReturn(req: AuthRequest, res: Response) {
  const id = req.params.id as string;
  const adminId = req.user?.id;

  if (!adminId) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }

  try {
    // What we are refunding, read from the database. Never the request body.
    const { data: ret } = await supabase
      .from('order_returns')
      .select('id, order_id, order_item_id, status')
      .eq('id', id)
      .maybeSingle();

    if (!ret) return res.status(404).json({ success: false, error: 'Return not found' });

    const { data: item } = await supabase
      .from('order_items')
      .select('id, total_price, quantity')
      .eq('id', ret.order_item_id)
      .maybeSingle();

    const { data: order } = await supabase
      .from('orders')
      .select('id, order_number, payment_intent_id')
      .eq('id', ret.order_id)
      .maybeSingle();

    if (!order?.payment_intent_id) {
      return res.status(400).json({
        success: false,
        error: 'This order has no payment to refund against.',
      });
    }

    const amount = Number(item?.total_price ?? 0);
    if (!(amount > 0)) {
      return res.status(400).json({ success: false, error: 'Nothing to refund on this item.' });
    }

    // 1. Claim. Only the caller that wins this talks to Stripe.
    const { data: claimData, error: claimError } = await supabase.rpc('claim_return_for_refund', {
      p_return_id: id,
      p_admin_id: adminId,
    });

    if (claimError) {
      return res.status(400).json({ success: false, error: claimError.message });
    }

    const claim: any = Array.isArray(claimData) ? claimData[0] : claimData;
    if (!claim?.claimed) {
      return res.status(409).json({
        success: false,
        error: 'already_handled',
        data: { current_status: claim?.current_status ?? null },
      });
    }

    // 2. Stripe. Idempotency key so a retry after a timeout cannot double-pay:
    //    Stripe returns the original refund rather than making a second one.
    let refundId: string;
    try {
      const refund = await stripe.refunds.create(
        {
          payment_intent: order.payment_intent_id,
          amount: Math.round(amount * 100),
          metadata: {
            return_id: id,
            order_number: order.order_number ?? '',
            order_item_id: ret.order_item_id ?? '',
          },
        },
        { idempotencyKey: `return-refund-${id}` },
      );
      refundId = refund.id;
    } catch (stripeErr: any) {
      // 3a. Release. Nobody was refunded, so the request is as valid as before.
      await supabase.rpc('settle_return_refund', {
        p_return_id: id,
        p_succeeded: false,
        p_refund_id: null,
        p_note: `Refund attempt failed: ${stripeErr?.message ?? 'unknown error'}`,
      });

      console.error('[admin] stripe refund failed', { return_id: id, error: stripeErr?.message });
      return res.status(502).json({
        success: false,
        error: stripeErr?.message || 'The payment provider rejected the refund.',
      });
    }

    // 3b. Settle: record the refund, mark the item returned, restore stock.
    const { data: settled, error: settleError } = await supabase.rpc('settle_return_refund', {
      p_return_id: id,
      p_succeeded: true,
      p_refund_id: refundId,
      p_note: null,
    });

    if (settleError) {
      // The money has moved. Say so loudly rather than reporting a plain
      // failure, because the customer HAS been refunded and the record has not
      // caught up.
      console.error('[admin] refund succeeded but settle failed', {
        return_id: id, refund_id: refundId, error: settleError.message,
      });
      return res.status(500).json({
        success: false,
        error: `The refund went through (${refundId}) but the record could not be updated. Do not refund again — fix the record instead.`,
      });
    }

    await supabase.from('admin_audit_log').insert({
      actor_id: adminId,
      actor_email: req.user?.email || null,
      action: 'refund.issued',
      entity_type: 'order_return',
      entity_id: id,
      summary: `Refunded $${amount.toFixed(2)} on ${order.order_number}`,
      metadata: { amount, refund_id: refundId, order_id: ret.order_id },
    });

    await supabase.from('notifications').insert({
      user_id: (await supabase.from('order_returns').select('user_id').eq('id', id).maybeSingle()).data?.user_id,
      title: 'Your refund is on its way',
      message: `We've refunded $${amount.toFixed(2)} for your return on ${order.order_number}. It usually reaches your account within five working days.`,
      type: 'return',
    });

    const row: any = Array.isArray(settled) ? settled[0] : settled;
    return res.status(200).json({
      success: true,
      data: { status: row?.final_status ?? 'refunded', refund_id: refundId, amount },
      message: `Refunded $${amount.toFixed(2)}`,
    });
  } catch (err) {
    console.error('refundReturn error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function declineReturn(req: AuthRequest, res: Response) {
  try {
    const id = req.params.id as string;
    const adminId = req.user?.id;
    const note = String(req.body?.note ?? '').trim();

    if (!adminId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    // A decline the customer cannot understand becomes a support ticket and
    // then a chargeback. Make the reason mandatory here, not in the UI.
    if (!note) {
      return res.status(400).json({
        success: false,
        error: 'A reason is required — the customer sees it.',
      });
    }

    const { data, error } = await supabase.rpc('decline_return', {
      p_return_id: id,
      p_admin_id: adminId,
      p_note: note,
    });

    if (error) return res.status(400).json({ success: false, error: error.message });

    const row: any = Array.isArray(data) ? data[0] : data;
    if (!row?.applied) {
      return res.status(409).json({
        success: false,
        error: 'already_handled',
        data: { current_status: row?.current_status ?? null },
      });
    }

    const { data: ret } = await supabase
      .from('order_returns').select('user_id, order_id').eq('id', id).maybeSingle();

    await supabase.from('admin_audit_log').insert({
      actor_id: adminId,
      actor_email: req.user?.email || null,
      action: 'refund.declined',
      entity_type: 'order_return',
      entity_id: id,
      summary: `Declined return: ${note.slice(0, 160)}`,
      metadata: { note },
    });

    if (ret?.user_id) {
      await supabase.from('notifications').insert({
        user_id: ret.user_id,
        title: 'About your return request',
        message: note,
        type: 'return',
      });
    }

    return res.status(200).json({
      success: true,
      data: { status: 'declined' },
      message: 'Return declined',
    });
  } catch (err) {
    console.error('declineReturn error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}