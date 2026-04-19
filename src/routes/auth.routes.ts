import { Router } from 'express';
const router = Router();

// Dev 1 will implement these
router.post('/signup',  (req, res) => res.json({ message: 'signup - coming soon' }));
router.post('/login',   (req, res) => res.json({ message: 'login - coming soon' }));
router.post('/logout',  (req, res) => res.json({ message: 'logout - coming soon' }));
router.get('/me',       (req, res) => res.json({ message: 'me - coming soon' }));

export default router;