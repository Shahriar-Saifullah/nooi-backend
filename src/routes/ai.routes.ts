import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
const router = Router();


router.post('/suggest', requireAuth, (req, res) => res.json({ message: 'ai suggest - coming soon' }));

export default router;