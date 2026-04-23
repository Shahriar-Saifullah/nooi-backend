import { Response } from 'express';
import { supabase } from '../services/supabase';
import { AuthRequest } from '../types';
import { OnboardingInput } from '../schemas/onboarding.schema';


export async function savePreferences(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const { user_type, project_types, interested_topics } = req.body as OnboardingInput;

    const { error: prefError } = await supabase
      .from('user_preferences')
      .upsert({
        user_id:           userId,
        user_type,
        project_types,
        interested_topics,
        updated_at:        new Date().toISOString(),
      }, { onConflict: 'user_id' });

    if (prefError) {
      return res.status(400).json({ success: false, error: prefError.message });
    }


    const { error: profileError } = await supabase
      .from('profiles')
      .update({ onboarding_completed: true, updated_at: new Date().toISOString() })
      .eq('id', userId);

    if (profileError) {
      return res.status(400).json({ success: false, error: profileError.message });
    }

    return res.status(200).json({
      success: true,
      message: "You're all set! Profile created successfully.",
    });

  } catch (err) {
    console.error('Onboarding error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function getPreferences(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;

    const { data, error } = await supabase
      .from('user_preferences')
      .select('user_type, project_types, interested_topics, created_at')
      .eq('user_id', userId)
      .single();

    if (error || !data) {
      return res.status(404).json({
        success: false,
        error: 'Preferences not found. Onboarding not completed yet.',
      });
    }

    return res.status(200).json({ success: true, data: { preferences: data } });

  } catch (err) {
    console.error('Get preferences error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}