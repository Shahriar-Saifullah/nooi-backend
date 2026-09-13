import { Request } from 'express';
import { User } from '@supabase/supabase-js';
import { UserRole } from './auth.types';

export interface UserProfile {
  id: string;
  role: UserRole;
  full_name: string | null;
  avatar_url?: string | null;
  plan?: string;
  onboarding_completed?: boolean;
  plan_banner_dismissed?: boolean;
  language?: string;
}

export interface AuthRequest extends Request {
  user?: User;
  userProfile?: UserProfile;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}