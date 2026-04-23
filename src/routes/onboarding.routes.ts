import { Router } from 'express';
import { savePreferences, getPreferences } from '../controllers/onboarding.controller';
import { requireAuth }       from '../middleware/auth.middleware';
import { validate }          from '../middleware/validate';
import { onboardingSchema }  from '../schemas/onboarding.schema';

const router = Router();

router.post('/', requireAuth, validate(onboardingSchema), savePreferences);
router.get('/',  requireAuth, getPreferences);

export default router;