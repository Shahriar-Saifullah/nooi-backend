import { Response, NextFunction } from 'express';
import { supabase } from '../services/supabase';
import { AuthRequest } from '../types';

const isProd = process.env.NODE_ENV === 'production';

const cookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: (isProd ? 'none' : 'lax') as 'none' | 'lax',
  path: '/',
};

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
    return next();
  }

  return res.status(401).json({ success: false, error: 'Invalid token' });
}