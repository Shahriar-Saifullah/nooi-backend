import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { validate }    from '../middleware/validate';
import { updateProfileSchema } from '../schemas/profile.schema';
import {
  updateLanguage, updateProfile, dismissPlanBanner, getNotificationPrefs, updateNotificationPrefs,
} from '../controllers/profile.controller';

const router = Router();

router.put('/language/:lang', requireAuth, updateLanguage);
router.put('/',               requireAuth, validate(updateProfileSchema), updateProfile);
router.post('/dismiss-banner', requireAuth, dismissPlanBanner);
router.get('/notification-preferences', requireAuth, getNotificationPrefs);
router.put('/notification-preferences', requireAuth, updateNotificationPrefs);

export default router;