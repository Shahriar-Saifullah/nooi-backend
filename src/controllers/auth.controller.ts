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


export async function getMe(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;


    const { data: profile, error } = await supabase
      .from('profiles')
      .select('id, full_name, avatar_url, plan, created_at')
      .eq('id', userId)
      .single();

    if (error || !profile) {
      return res.status(404).json({ success: false, error: 'Profile not found' });
    }

    return res.status(200).json({ success: true, data: { profile } });

  } catch (err) {
    console.error('GetMe error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}