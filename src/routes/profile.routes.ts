import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { validate }    from '../middleware/validate';
import { updateProfileSchema } from '../schemas/profile.schema';
import { updateLanguage, updateProfile, dismissPlanBanner } from '../controllers/profile.controller';

const router = Router();

router.put('/language/:lang', requireAuth, updateLanguage);
router.put('/',               requireAuth, validate(updateProfileSchema), updateProfile);
router.post('/dismiss-banner', requireAuth, dismissPlanBanner);

export default router;