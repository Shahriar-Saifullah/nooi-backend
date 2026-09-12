import { z } from 'zod';

export const signupSchema = z.object({
  full_name: z.string().min(2, 'Full name must be at least 2 characters'),
  email: z.string().email('Please enter a valid email'),
  password: z.string()
    .min(8, 'Password must be at least 8 characters')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
});

export const loginSchema = z.object({
  email: z.string().email('Please enter a valid email'),
  password: z.string().min(1, 'Password is required'),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email('Please enter a valid email'),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  refresh_token: z.string().min(1, 'Refresh token is required'),
  new_password: z.string()
    .min(8, 'Password must be at least 8 characters')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
});

export const resendVerificationSchema = z.object({
  email: z.string().email('Please enter a valid email'),
});

// Vendor Schemas
export const vendorSignupSchema = z.object({
  full_name: z.string().min(2, 'Full name / contact person must be at least 2 characters'),
  email: z.string().email('Please enter a valid email address'),
  password: z.string()
    .min(8, 'Password must be at least 8 characters')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
  business_name: z.string().min(2, 'Business name must be at least 2 characters'),
  phone: z.string().min(6, 'Phone number is required and must be at least 6 characters'),
  category: z.string().min(2, 'Business category is required (e.g. Furniture, Lighting, Decor, Materials)'),
  business_email: z.string().email('Invalid business email').optional().or(z.literal('')),
  website: z.string().url('Invalid website URL').optional().or(z.literal('')),
  tax_id: z.string().optional(),
  description: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
});

export const updateVendorProfileSchema = z.object({
  business_name: z.string().min(2, 'Business name must be at least 2 characters').optional(),
  phone: z.string().min(6, 'Phone number must be at least 6 characters').optional(),
  category: z.string().min(2, 'Category must be at least 2 characters').optional(),
  business_email: z.string().email('Invalid business email').optional().or(z.literal('')),
  website: z.string().url('Invalid website URL').optional().or(z.literal('')),
  address: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  tax_id: z.string().optional(),
  description: z.string().optional(),
  logo_url: z.string().url('Invalid logo URL').optional().or(z.literal('')),
});

// Admin Schemas
export const updateVendorStatusSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'suspended']),
  rejection_reason: z.string().optional(),
});

export const updateUserRoleSchema = z.object({
  role: z.enum(['user', 'vendor', 'admin', 'super_admin']),
});

export const createAdminSchema = z.object({
  full_name: z.string().min(2, 'Full name must be at least 2 characters'),
  email: z.string().email('Please enter a valid email address'),
  password: z.string()
    .min(8, 'Password must be at least 8 characters')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
  role: z.enum(['admin', 'super_admin']).default('admin'),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type ResendVerificationInput = z.infer<typeof resendVerificationSchema>;
export type VendorSignupInput = z.infer<typeof vendorSignupSchema>;
export type UpdateVendorProfileInput = z.infer<typeof updateVendorProfileSchema>;
export type UpdateVendorStatusInput = z.infer<typeof updateVendorStatusSchema>;
export type UpdateUserRoleInput = z.infer<typeof updateUserRoleSchema>;
export type CreateAdminInput = z.infer<typeof createAdminSchema>;