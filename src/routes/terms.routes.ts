import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { acceptTerms, getTermsStatus } from '../controllers/terms.controller';

const router = Router();

router.get('/status', requireAuth, getTermsStatus);
router.post('/accept', requireAuth, acceptTerms);

export default router;
