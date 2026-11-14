import { Router, Response } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { AuthRequest } from '../types';
import { cleanFavourite, listFavourites, mergeFavourites, setFavourite } from '../services/favourites.service';

const router = Router();

/** GET /favourites — the caller's favourites, newest first. */
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    return res.json({ success: true, data: { items: await listFavourites(req.user!.id) } });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/** PUT /favourites { kind, ref, on } — add or remove one. */
router.put('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const fav = cleanFavourite(req.body);
  if (!fav) return res.status(400).json({ success: false, error: 'Unknown favourite.' });
  try {
    await setFavourite(req.user!.id, fav, req.body?.on !== false);
    return res.json({ success: true, data: { ...fav, on: req.body?.on !== false } });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /favourites/merge { items } — favourites saved before signing in. */
router.post('/merge', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const added = await mergeFavourites(req.user!.id, req.body?.items);
    return res.json({ success: true, data: { added, items: await listFavourites(req.user!.id) } });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
