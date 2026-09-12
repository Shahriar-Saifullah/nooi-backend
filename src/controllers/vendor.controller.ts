import { Response } from 'express';
import { supabase } from '../services/supabase';
import { AuthRequest } from '../types';
import { UpdateVendorProfileInput } from '../schemas/auth.schema';

export async function getVendorProfile(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;

    const { data: profile } = await supabase
      .from('profiles')
      .select('id, full_name, role, avatar_url, language, created_at')
      .eq('id', userId)
      .single();

    const { data: vendorProfile, error } = await supabase
      .from('vendor_profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (error || !vendorProfile) {
      return res.status(404).json({
        success: false,
        error: 'Vendor profile not found',
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        profile,
        vendor: vendorProfile,
      },
    });
  } catch (err) {
    console.error('getVendorProfile error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function updateVendorProfile(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const body = req.body as UpdateVendorProfileInput;

    const updateData: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };

    if (body.business_name !== undefined) updateData.business_name = body.business_name;
    if (body.business_email !== undefined) updateData.business_email = body.business_email;
    if (body.phone !== undefined) updateData.phone = body.phone;
    if (body.category !== undefined) updateData.category = body.category;
    if (body.website !== undefined) updateData.website = body.website || null;
    if (body.tax_id !== undefined) updateData.tax_id = body.tax_id || null;
    if (body.description !== undefined) updateData.description = body.description || null;
    if (body.address !== undefined) updateData.address = body.address || null;
    if (body.city !== undefined) updateData.city = body.city || null;
    if (body.country !== undefined) updateData.country = body.country || null;
    if (body.logo_url !== undefined) updateData.logo_url = body.logo_url || null;

    const { data, error } = await supabase
      .from('vendor_profiles')
      .update(updateData)
      .eq('id', userId)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    return res.status(200).json({
      success: true,
      data: { vendor: data },
      message: 'Vendor profile updated successfully',
    });
  } catch (err) {
    console.error('updateVendorProfile error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function getVendorDashboardSummary(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;

    const { data: vendor, error } = await supabase
      .from('vendor_profiles')
      .select('business_name, status, category, verified_at, created_at')
      .eq('id', userId)
      .single();

    if (error || !vendor) {
      return res.status(404).json({ success: false, error: 'Vendor profile not found' });
    }

    return res.status(200).json({
      success: true,
      data: {
        summary: {
          business_name: vendor.business_name,
          category: vendor.category,
          status: vendor.status,
          verified_at: vendor.verified_at,
          total_products: 0,
          total_orders: 0,
          pending_orders: 0,
          total_revenue: 0,
        },
      },
    });
  } catch (err) {
    console.error('getVendorDashboardSummary error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}
