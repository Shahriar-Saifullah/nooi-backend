import { Response, NextFunction } from 'express';
import { supabase } from '../services/supabase';
import { AuthRequest } from '../types';
import { UserRole } from '../types/auth.types';

const isProd = process.env.NODE_ENV === 'production';

export const cookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: (isProd ? 'none' : 'lax') as 'none' | 'lax',
  path: '/',
};

async function attachUserProfile(req: AuthRequest, userId: string, userMetadata?: any) {
  try {
    const { data: profile } = await supabase
      .from('profiles')
      .select('id, role, full_name, avatar_url, plan, onboarding_completed, plan_banner_dismissed, language')
      .eq('id', userId)
      .single();

    if (profile) {
      req.userProfile = {
        id: profile.id,
        role: (profile.role as UserRole) || 'user',
        full_name: profile.full_name,
        avatar_url: profile.avatar_url,
        plan: profile.plan,
        onboarding_completed: profile.onboarding_completed,
        plan_banner_dismissed: profile.plan_banner_dismissed,
        language: profile.language,
      };
    } else {
      req.userProfile = {
        id: userId,
        role: (userMetadata?.role as UserRole) || 'user',
        full_name: userMetadata?.full_name || null,
      };
    }
  } catch {
    req.userProfile = {
      id: userId,
      role: (userMetadata?.role as UserRole) || 'user',
      full_name: userMetadata?.full_name || null,
    };
  }
}

export async function requireAuth(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  const token =
    req.cookies?.access_token ||
    req.headers.authorization?.split(' ')[1];

  const refreshToken = req.cookies?.refresh_token;

  if (!token && !refreshToken) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }

  if (token) {
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (!error && user) {
      req.user = user;
      await attachUserProfile(req, user.id, user.user_metadata);
      return next();
    }
  }

  if (refreshToken) {
    const { data, error: refreshError } = await supabase.auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (refreshError || !data.session) {
      return res.status(401).json({ success: false, error: 'Session expired, please login again' });
    }

    res.cookie('access_token', data.session.access_token, {
      ...cookieOptions,
      maxAge: 60 * 60 * 1000, 
    });

    res.cookie('refresh_token', data.session.refresh_token, {
      ...cookieOptions,
      maxAge: 60 * 60 * 24 * 30 * 1000, 
    });

    req.user = data.user ?? undefined;
    if (req.user) {
      await attachUserProfile(req, req.user.id, req.user.user_metadata);
    }
    return next();
  }

  return res.status(401).json({ success: false, error: 'Invalid token' });
}

export function requireRole(allowedRoles: UserRole | UserRole[]) {
  const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];

  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user || !req.userProfile) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }

    const currentRole = req.userProfile.role;

    // super_admin has access to admin-protected routes
    const hasRole = roles.includes(currentRole) || (currentRole === 'super_admin' && roles.includes('admin'));

    if (!hasRole) {
      return res.status(403).json({
        success: false,
        error: 'Access denied: insufficient permissions',
        code: 'FORBIDDEN',
        requiredRoles: roles,
        currentRole,
      });
    }

    return next();
  };
}

export const requireVendor = [requireAuth, requireRole('vendor')];
export const requireAdmin = [requireAuth, requireRole(['admin', 'super_admin'])];
export const requireSuperAdmin = [requireAuth, requireRole('super_admin')];