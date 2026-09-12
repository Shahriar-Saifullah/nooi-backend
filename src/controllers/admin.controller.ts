import { Response } from 'express';
import { supabase } from '../services/supabase';
import { AuthRequest } from '../types';
import {
  UpdateVendorStatusInput,
  UpdateUserRoleInput,
  CreateAdminInput,
} from '../schemas/auth.schema';

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

    // Prevent modifying super_admin unless requester is super_admin
    const requesterRole = req.userProfile?.role;
    if (role === 'super_admin' && requesterRole !== 'super_admin') {
      return res.status(403).json({
        success: false,
        error: 'Only super administrators can assign the super_admin role',
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
