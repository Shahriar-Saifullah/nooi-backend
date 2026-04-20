import { Request, Response } from 'express';
import { supabase } from '../services/supabase';
import { SignupInput, LoginInput } from '../schemas/auth.schema';
import { AuthRequest } from '../types';


export async function signup(req: Request, res: Response) {
  try {
    const { full_name, email, password } = req.body as SignupInput;

   
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // auto-confirm for now
      user_metadata: { full_name },
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
          id:        data.user.id,
          email:     data.user.email,
          full_name: data.user.user_metadata.full_name,
        },
      },
      message: 'Account created successfully. Please log in.',
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
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password',
      });
    }

    // Set accessToken in HttpOnly cookie
    res.cookie('access_token', data.session.access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 60 * 60 * 1000, // 1 hour
      path: '/',
    });

    return res.status(200).json({
      success: true,
      data: {
        user: {
          id: data.user.id,
          email: data.user.email,
          full_name: data.user.user_metadata.full_name,
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


import crypto from 'crypto';

export async function googleSignIn(req: Request, res: Response) {
  try {
    // Generate PKCE verifier and challenge
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

    // Store verifier in a temporary cookie (10 minutes)
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

import { createClient } from '@supabase/supabase-js';

export async function authCallback(req: Request, res: Response) {
  try {
    const code = req.query.code as string;
    const verifier = req.cookies['sb-code-verifier'];

    if (!code) {
      return res.status(400).json({ 
        success: false, 
        error: 'Authorization code missing. Please start the login flow from /auth/google.' 
      });
    }

    if (!verifier) {
      return res.status(400).json({ 
        success: false, 
        error: 'Code verifier missing. Your session may have timed out or cookies are blocked.' 
      });
    }

    // Create a temporary client with custom storage to "inject" the verifier
    // This is required because exchangeCodeForSession looks for the verifier in storage.
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
            setItem: () => {},
            removeItem: () => {},
          },
        },
      }
    );

    const { data, error } = await tempSupabase.auth.exchangeCodeForSession(code);
    
    if (error) throw error;

    // Clear the temporary verifier cookie
    res.clearCookie('sb-code-verifier');

    // Set accessToken in HttpOnly cookie
    res.cookie('access_token', data.session.access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 60 * 60 * 1000, // 1 hour
      path: '/',
    });

    return res.status(200).json({
      success: true,
      message: 'Logged in successfully with Google (PKCE Flow)',
      data: {
        user: {
          id: data.user.id,
          email: data.user.email,
          full_name: data.user.user_metadata.full_name,
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
    const user = req.user!;

    return res.status(200).json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          full_name: user.user_metadata?.full_name || 'No Name',
        },
      },
    });
  } catch (err) {
    console.error('GetMe error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}