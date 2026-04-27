import { Response } from 'express';
import { supabase } from '../services/supabase';
import { AuthRequest } from '../types';


export async function updateLanguage(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const lang   = req.params.lang as string;

    if (!['en', 'ar'].includes(lang)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid language. Use /language/en or /language/ar',
      });
    }

    const { error } = await supabase
      .from('profiles')
      .update({
        language:   lang,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId);

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    return res.status(200).json({
      success: true,
      data:    { language: lang },
      message: `Language updated to ${lang === 'en' ? 'English' : 'Arabic'}`,
    });

  } catch (err) {
    console.error('Update language error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function updateProfile(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const { full_name, avatar_url } = req.body;

    const { data, error } = await supabase
      .from('profiles')
      .update({
        ...(full_name  && { full_name }),
        ...(avatar_url && { avatar_url }),
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    return res.status(200).json({
      success: true,
      data: { profile: data },
    });

  } catch (err) {
    console.error('Update profile error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}