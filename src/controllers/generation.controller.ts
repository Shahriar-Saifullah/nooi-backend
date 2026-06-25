import { Response } from 'express';
import { supabase } from '../services/supabase';
import { AuthRequest } from '../types';

// GET /ai/generations/recent?limit=4
export async function getRecentGenerations(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const limit = Math.min(parseInt((req.query.limit as string) || '4'), 20);

    const { data, error, count } = await supabase
      .from('generations')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('Fetch generations error:', error);
      return res.status(500).json({ success: false, error: 'Failed to load generations' });
    }

    return res.status(200).json({
      success: true,
      data: {
        generations: data ?? [],
        total: count ?? 0,
        limit,
      },
    });

  } catch (err) {
    console.error('Get recent generations error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// POST /ai/generations — called internally by project.controller after a
// successful generateRender so every canvas generation is persisted.
export async function saveGeneration(
  userId: string,
  projectId: string,
  prompt: string,
  imageUrl: string,
  model: string,
  toolType: string = 'prompt-render',
) {
  const { data, error } = await supabase
    .from('generations')
    .insert({
      user_id:   userId,
      project_id: projectId,
      prompt,
      image_url: imageUrl,
      model,
      tool_type: toolType,
    })
    .select()
    .single();

  if (error) {
    // Non-fatal — log but don't crash the render flow
    console.error('Save generation error:', error);
    return null;
  }

  return data;
}