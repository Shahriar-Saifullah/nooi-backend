import { Request, Response } from 'express';
import { supabase } from '../services/supabase';
import {
  SignupInput,
  LoginInput,
  ForgotPasswordInput,
  ResetPasswordInput,
  ResendVerificationInput,
} from '../schemas/auth.schema';
import { AuthRequest } from '../types';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';



export async function signup(req: Request, res: Response) {
  try {
    const { full_name, email, password } = req.body as SignupInput;

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name },
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

    return res.status(201).json({
      success: true,
      data: {
        user: {
          id: data.user?.id,
          email: data.user?.email,
          full_name: data.user?.user_metadata.full_name,
        },
      },
      message: 'Account created. Please check your email to verify your account.',
    });

  } catch (err) {
    console.error('Signup error:', err);
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
      .select('full_name, plan, onboarding_completed')
      .eq('id', data.user.id)
      .single();


    res.cookie('access_token', data.session.access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 60 * 60 * 24 * 7 * 1000, // 7 days
      path: '/',
    });


    return res.status(200).json({
      success: true,
      data: {
        user: {
          id: data.user.id,
          email: data.user.email,
          full_name: profile?.full_name ?? null,
          plan: profile?.plan ?? 'free',
          onboarding_completed: profile?.onboarding_completed ?? false,
        },
      },
    });

  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}


export async function logout(req: Request, res: Response) {
  try {
    res.clearCookie('access_token', {
      path: '/',
    });
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
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
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
      return res.status(400).json({
        success: false,
        error: 'Authorization code missing. Please start the login flow from /auth/google.',
      });
    }

    if (!verifier) {
      return res.status(400).json({
        success: false,
        error: 'Code verifier missing. Your session may have timed out or cookies are blocked.',
      });
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

    res.clearCookie('sb-code-verifier');

 
    const { data: profile } = await supabase
      .from('profiles')
      .select('full_name, plan, onboarding_completed')
      .eq('id', data.user.id)
      .single();


    const full_name = profile?.full_name ??
      data.user.user_metadata?.full_name ??
      data.user.user_metadata?.name ??
      null;

  
    res.cookie('access_token', data.session.access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 60 * 60 * 24 * 7 * 1000,
      path: '/',
    });

    return res.status(200).json({
      success: true,
      message: 'Logged in successfully with Google',
      data: {
        user: {
          id: data.user.id,
          email: data.user.email,
          full_name: full_name,
          plan: profile?.plan ?? 'free',
          onboarding_completed: profile?.onboarding_completed ?? false,
        },
      },
    });

  } catch (err: any) {
    console.error('OAuth Callback error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
}


export async function getMe(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('id, full_name, avatar_url, plan, onboarding_completed, language, created_at')
      .eq('id', userId)
      .single();

    if (error || !profile) {
      return res.status(404).json({ success: false, error: 'Profile not found' });
    }

    return res.status(200).json({
      success: true,
      data: {
        user: {
          id: profile.id,
          email: req.user!.email,
          full_name: profile.full_name,
          avatar_url: profile.avatar_url,
          plan: profile.plan,
          onboarding_completed: profile.onboarding_completed,
          language: profile.language ?? 'en',
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

    const { error } = await supabase.auth.resend({
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

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
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