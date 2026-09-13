import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

export type LoginDto = z.infer<typeof loginSchema>;

export type UserRole = 'user' | 'vendor' | 'admin' | 'super_admin';

export type VendorStatus = 'pending' | 'approved' | 'rejected' | 'suspended';

export interface VendorProfile {
  id: string;
  business_name: string;
  business_email?: string | null;
  phone: string;
  category: string;
  website?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  tax_id?: string | null;
  description?: string | null;
  logo_url?: string | null;
  status: VendorStatus;
  rejection_reason?: string | null;
  verified_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserResponse {
  id: string;
  email: string;
  full_name: string | null;
  role: UserRole;
  avatar_url?: string | null;
  plan?: string;
  onboarding_completed?: boolean;
  plan_banner_dismissed?: boolean;
  language?: string;
  vendor_profile?: VendorProfile | null;
}

export interface AuthResponse {
  user: UserResponse;
}
