import { Response } from 'express';
import { supabase } from '../services/supabase';
import { AuthRequest } from '../types';

// Stub — returns empty list for now
export async function getRecentGenerations(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 4;

    // For now returns empty array with correct structure
    return res.status(200).json({
      success: true,
      data: {
        generations: [],
        total: 0,
        limit,
      },
    });

  } catch (err) {
    console.error('Get recent generations error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}