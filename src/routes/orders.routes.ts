import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
const router = Router();


router.post('/checkout', requireAuth, (req, res) => res.json({ message: 'checkout - coming soon' }));
router.post('/webhook',              (req, res) => res.json({ message: 'webhook - coming soon' }));
router.get('/',          requireAuth, (req, res) => res.json({ message: 'list orders' }));
router.get('/:id',       requireAuth, (req, res) => res.json({ message: 'get order' }));

export default router;