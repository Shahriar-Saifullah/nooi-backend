import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { supabase } from '../services/supabase';
import { AuthRequest } from '../types';
import { Response } from 'express';

const router = Router();

// GET /notifications - fetch user notifications
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 100);

    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    const unreadCount = (data || []).filter((n) => !n.is_read).length;

    return res.json({
      success: true,
      notifications: data || [],
      unread_count: unreadCount,
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /notifications/:id/read - mark single notification as read
router.patch('/:id/read', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const { data, error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    return res.json({ success: true, notification: data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /notifications/read-all - mark all as read
router.patch('/read-all', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;

    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', userId)
      .eq('is_read', false);

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    return res.json({ success: true, message: 'All notifications marked as read' });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
