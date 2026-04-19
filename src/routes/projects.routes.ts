import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
const router = Router();

// Dev 1 will implement these
router.get('/',       requireAuth, (req, res) => res.json({ message: 'list projects' }));
router.post('/',      requireAuth, (req, res) => res.json({ message: 'create project' }));
router.get('/:id',    requireAuth, (req, res) => res.json({ message: 'get project' }));
router.put('/:id',    requireAuth, (req, res) => res.json({ message: 'update project' }));
router.delete('/:id', requireAuth, (req, res) => res.json({ message: 'delete project' }));

export default router;