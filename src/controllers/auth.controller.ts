import { Request, Response } from 'express';
import { supabase, supabaseAuth } from '../services/supabase';
import {
  SignupInput,
  LoginInput,
  ForgotPasswordInput,
  ResetPasswordInput,
  ResendVerificationInput,
  VendorSignupInput,
} from '../schemas/auth.schema';
import { AuthRequest } from '../types';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const isProd = process.env.NODE_ENV === 'production';

export const cookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: (isProd ? 'none' : 'lax') as 'none' | 'lax',
  path: '/',
};

export async function signup(req: Request, res: Response) {
  try {
    const { full_name, email, password } = req.body as SignupInput;

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name, role: 'user' },
        emailRedirectTo: process.env.EMAIL_VERIFY_REDIRECT_URL,
      },
    });

    if (error) {
      if (error.message.includes('already registered')) {
        return res.status(409).json({
          success: false,
          error: 'An account with this email already exists',
        });
      }
      return res.status(400).json({ success: false, error: error.message });
    }

    if (data.user) {
      await supabase.from('profiles').upsert({
        id: data.user.id,
        full_name,
        role: 'user',
        updated_at: new Date().toISOString(),
      });
    }

    return res.status(201).json({
      success: true,
      data: {
        user: {
          id: data.user?.id,
          email: data.user?.email,
          full_name: data.user?.user_metadata.full_name,
          role: 'user',
        },
      },
      message: 'Account created. Please check your email to verify your account.',
    });

  } catch (err) {
    console.error('Signup error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function vendorSignup(req: Request, res: Response) {
  try {
    const {
      full_name,
      email,
      password,
      business_name,
      phone,
      category,
      business_email,
      website,
      tax_id,
      description,
      address,
      city,
      country,
    } = req.body as VendorSignupInput;

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name,
          role: 'vendor',
          business_name,
        },
        emailRedirectTo: process.env.EMAIL_VERIFY_REDIRECT_URL,
      },
    });

    if (error) {
      if (error.message.includes('already registered')) {
        return res.status(409).json({
          success: false,
          error: 'An account with this email already exists',
        });
      }
      return res.status(400).json({ success: false, error: error.message });
    }

    if (!data.user) {
      return res.status(500).json({ success: false, error: 'Failed to create vendor account' });
    }

    // Upsert profile with vendor role
    await supabase
      .from('profiles')
      .upsert({
        id: data.user.id,
        full_name,
        role: 'vendor',
        updated_at: new Date().toISOString(),
      });

    // Create vendor profile record with pending status
    const vendorPayload = {
      id: data.user.id,
      business_name,
      business_email: business_email || email,
      phone,
      category,
      website: website || null,
      tax_id: tax_id || null,
      description: description || null,
      address: address || null,
      city: city || null,
      country: country || null,
      status: 'pending', // Pending admin approval per specification
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { error: vendorError } = await supabase
      .from('vendor_profiles')
      .upsert(vendorPayload);

    if (vendorError) {
      console.error('Error creating vendor profile:', vendorError);
    }

    return res.status(201).json({
      success: true,
      data: {
        user: {
          id: data.user.id,
          email: data.user.email,
          full_name,
          role: 'vendor',
        },
        vendor_profile: vendorPayload,
      },
      message: 'Vendor account created successfully. Your application is pending review.',
    });
  } catch (err) {
    console.error('Vendor signup error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function login(req: Request, res: Response) {
  try {
    const { email, password } = req.body as LoginInput;

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      if (error.message.toLowerCase().includes('email not confirmed')) {
        return res.status(403).json({
          success: false,
          error: 'Please verify your email before signing in.',
          code: 'EMAIL_NOT_VERIFIED',
        });
      }
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password',
      });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('role, full_name, plan, onboarding_completed, language')
      .eq('id', data.user.id)
      .single();

    res.cookie('access_token', data.session.access_token, {
      ...cookieOptions,
      maxAge: 60 * 60 * 24 * 7 * 1000,
    });

    res.cookie('refresh_token', data.session.refresh_token, {
      ...cookieOptions,
      maxAge: 60 * 60 * 24 * 30 * 1000,
    });

    return res.status(200).json({
      success: true,
      data: {
        user: {
          id: data.user.id,
          email: data.user.email,
          full_name: profile?.full_name ?? null,
          role: profile?.role ?? 'user',
          plan: profile?.plan ?? 'free',
          onboarding_completed: profile?.onboarding_completed ?? false,
          language: profile?.language ?? 'en',
        },
      },
    });

  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function vendorLogin(req: Request, res: Response) {
  try {
    const { email, password } = req.body as LoginInput;

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      if (error.message.toLowerCase().includes('email not confirmed')) {
        return res.status(403).json({
          success: false,
          error: 'Please verify your email before signing in.',
          code: 'EMAIL_NOT_VERIFIED',
        });
      }
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password',
      });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('role, full_name, avatar_url, plan, onboarding_completed, language')
      .eq('id', data.user.id)
      .single();

    const role = profile?.role || (data.user.user_metadata?.role as string) || 'user';

    if (role !== 'vendor') {
      return res.status(403).json({
        success: false,
        error: 'This account is not registered as a vendor. Please sign in through the customer portal.',
        code: 'ROLE_MISMATCH',
      });
    }

    // Fetch vendor business profile
    const { data: vendorProfile } = await supabase
      .from('vendor_profiles')
      .select('*')
      .eq('id', data.user.id)
      .single();

    if (vendorProfile?.status === 'rejected') {
      return res.status(403).json({
        success: false,
        error: `Your vendor account application was rejected: ${vendorProfile.rejection_reason || 'Please contact support.'}`,
        code: 'VENDOR_REJECTED',
      });
    }

    if (vendorProfile?.status === 'suspended') {
      return res.status(403).json({
        success: false,
        error: 'Your vendor account has been suspended. Please contact support.',
        code: 'VENDOR_SUSPENDED',
      });
    }

    res.cookie('access_token', data.session.access_token, {
      ...cookieOptions,
      maxAge: 60 * 60 * 24 * 7 * 1000,
    });

    res.cookie('refresh_token', data.session.refresh_token, {
      ...cookieOptions,
      maxAge: 60 * 60 * 24 * 30 * 1000,
    });

    return res.status(200).json({
      success: true,
      data: {
        user: {
          id: data.user.id,
          email: data.user.email,
          full_name: profile?.full_name ?? data.user.user_metadata?.full_name ?? null,
          role: 'vendor',
          avatar_url: profile?.avatar_url ?? null,
          plan: profile?.plan ?? 'free',
          onboarding_completed: profile?.onboarding_completed ?? false,
          language: profile?.language ?? 'en',
          vendor_profile: vendorProfile ?? null,
        },
      },
    });
  } catch (err) {
    console.error('Vendor login error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function adminLogin(req: Request, res: Response) {
  try {
    const { email, password } = req.body as LoginInput;

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      if (error.message.toLowerCase().includes('email not confirmed')) {
        return res.status(403).json({
          success: false,
          error: 'Please verify your email before signing in.',
          code: 'EMAIL_NOT_VERIFIED',
        });
      }
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password',
      });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('role, full_name, avatar_url')
      .eq('id', data.user.id)
      .single();

    const role = profile?.role || (data.user.user_metadata?.role as string);

    if (role !== 'admin' && role !== 'super_admin') {
      return res.status(403).json({
        success: false,
        error: 'Access denied. Administrator privileges required.',
        code: 'FORBIDDEN',
      });
    }

    res.cookie('access_token', data.session.access_token, {
      ...cookieOptions,
      maxAge: 60 * 60 * 24 * 7 * 1000,
    });

    res.cookie('refresh_token', data.session.refresh_token, {
      ...cookieOptions,
      maxAge: 60 * 60 * 24 * 30 * 1000,
    });

    return res.status(200).json({
      success: true,
      data: {
        user: {
          id: data.user.id,
          email: data.user.email,
          full_name: profile?.full_name ?? data.user.user_metadata?.full_name ?? null,
          role,
          avatar_url: profile?.avatar_url ?? null,
        },
      },
    });
  } catch (err) {
    console.error('Admin login error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function logout(req: Request, res: Response) {
  try {
    res.clearCookie('access_token', cookieOptions);
    res.clearCookie('refresh_token', cookieOptions);
    return res.status(200).json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function googleSignIn(req: Request, res: Response) {
  try {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

    res.cookie('sb-code-verifier', verifier, {
      ...cookieOptions,
      maxAge: 10 * 60 * 1000,
    });

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: process.env.SUPABASE_REDIRECT_URL,
        queryParams: {
          code_challenge: challenge,
          code_challenge_method: 'S256',
        },
      },
    });

    if (error) throw error;
    if (data.url) {
      return res.redirect(data.url);
    }

    return res.status(400).json({ success: false, error: 'Could not generate Google login URL' });
  } catch (err: any) {
    console.error('Google Sign-in error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
}

export async function authCallback(req: Request, res: Response) {
  try {
    const code = req.query.code as string;
    const verifier = req.cookies['sb-code-verifier'];

    if (!code) {
      return res.redirect(`${process.env.FRONTEND_URL}/auth/callback?error=missing_code`);
    }

    if (!verifier) {
      return res.redirect(`${process.env.FRONTEND_URL}/auth/callback?error=missing_verifier`);
    }

    const tempSupabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_ANON_KEY!,
      {
        auth: {
          flowType: 'pkce',
          storage: {
            getItem: (key: string) => {
              if (key.endsWith('code-verifier')) return verifier;
              return null;
            },
            setItem: () => { },
            removeItem: () => { },
          },
        },
      }
    );

    const { data, error } = await tempSupabase.auth.exchangeCodeForSession(code);
    if (error) throw error;

    res.clearCookie('sb-code-verifier', cookieOptions);

    const { data: profile } = await supabase
      .from('profiles')
      .select('full_name, plan, onboarding_completed, role')
      .eq('id', data.user.id)
      .single();

    res.cookie('access_token', data.session.access_token, {
      ...cookieOptions,
      maxAge: 60 * 60 * 24 * 7 * 1000,
    });

    res.cookie('refresh_token', data.session.refresh_token, {
      ...cookieOptions,
      maxAge: 60 * 60 * 24 * 30 * 1000,
    });

    return res.redirect(`${process.env.FRONTEND_URL}/auth/callback?status=success`);

  } catch (err: any) {
    console.error('OAuth Callback error:', err);
    return res.redirect(`${process.env.FRONTEND_URL}/auth/callback?error=server_error`);
  }
}

export async function getMe(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('id, full_name, avatar_url, plan, onboarding_completed, plan_banner_dismissed, language, created_at, role')
      .eq('id', userId)
      .single();

    if (error || !profile) {
      return res.status(404).json({ success: false, error: 'Profile not found' });
    }

    let vendorProfile = null;
    if (profile.role === 'vendor') {
      const { data: vProfile } = await supabase
        .from('vendor_profiles')
        .select('*')
        .eq('id', userId)
        .single();
      vendorProfile = vProfile;
    }

    return res.status(200).json({
      success: true,
      data: {
        user: {
          id: profile.id,
          email: req.user!.email,
          full_name: profile.full_name,
          role: profile.role ?? 'user',
          avatar_url: profile.avatar_url,
          plan: profile.plan,
          onboarding_completed: profile.onboarding_completed,
          plan_banner_dismissed: profile.plan_banner_dismissed,  
          language: profile.language ?? 'en',
          vendor_profile: vendorProfile,
        },
      },
    });

  } catch (err) {
    console.error('GetMe error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function resendVerification(req: Request, res: Response) {
  try {
    const { email } = req.body as ResendVerificationInput;

    const { error } = await supabaseAuth.auth.resend({
      type: 'signup',
      email,
      options: { emailRedirectTo: process.env.EMAIL_VERIFY_REDIRECT_URL },
    });

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    return res.status(200).json({
      success: true,
      message: 'Verification email sent. Please check your inbox.',
    });
  } catch (err) {
    console.error('Resend verification error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function forgotPassword(req: Request, res: Response) {
  try {
    const { email } = req.body as ForgotPasswordInput;

    const { error } = await supabaseAuth.auth.resetPasswordForEmail(email, {
      redirectTo: process.env.PASSWORD_RESET_REDIRECT_URL,
    });

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    return res.status(200).json({
      success: true,
      message: 'If an account exists with this email, a reset link has been sent.',
    });
  } catch (err) {
    console.error('Forgot password error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function resetPassword(req: Request, res: Response) {
  try {
    const { token, refresh_token, new_password } = req.body as ResetPasswordInput;

    const userSupabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_ANON_KEY!
    );

    const { error: sessionError } = await userSupabase.auth.setSession({
      access_token: token,
      refresh_token: refresh_token,
    });

    if (sessionError) {
      return res.status(400).json({
        success: false,
        error: 'This password reset link is invalid or has expired. Please request a new one.',
        code: 'INVALID_RESET_LINK',
      });
    }

    const { error: updateError } = await userSupabase.auth.updateUser({
      password: new_password,
    });

    if (updateError) {
      return res.status(400).json({ success: false, error: updateError.message });
    }

    return res.status(200).json({
      success: true,
      message: 'Password reset successfully. You can now sign in with your new password.',
    });

  } catch (err) {
    console.error('Reset password error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function setSession(req: Request, res: Response) {
  try {
    const { access_token, refresh_token } = req.body;

    if (!access_token || !refresh_token) {
      return res.status(400).json({ success: false, error: 'Missing tokens' });
    }

    // Verify the token is valid
    const { data: { user }, error } = await supabase.auth.getUser(access_token);

    if (error || !user) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }

    // Get profile
    const { data: profile } = await supabase
      .from('profiles')
      .select('role, full_name, plan, onboarding_completed')
      .eq('id', user.id)
      .single();

    // Set cookies
    res.cookie('access_token', access_token, {
      ...cookieOptions,
      maxAge: 60 * 60 * 24 * 7 * 1000,
    });

    res.cookie('refresh_token', refresh_token, {
      ...cookieOptions,
      maxAge: 60 * 60 * 24 * 30 * 1000,
    });

    return res.status(200).json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        full_name: profile?.full_name ?? null,
        role: profile?.role ?? 'user',
        onboarding_completed: profile?.onboarding_completed ?? false,
      },
    });

  } catch (err) {
    console.error('Set session error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}